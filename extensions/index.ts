/**
 * Pi Morph Plugin
 *
 * Integrates Morph SDK for Fast Apply, WarpGrep codebase search, public repo
 * context search, and context compaction.
 *
 * Tools:
 *   - morph_edit: 10,500+ tok/s code editing with lazy markers
 *   - warpgrep_codebase_search: fast agentic local codebase search
 *   - warpgrep_github_search: grounded context search for public GitHub repos
 *
 * Compaction:
 *   - session_before_compact hook: uses Morph Compact API (~250ms)
 *     for context compression instead of default LLM summarization
 *
 * @see https://docs.morphllm.com/quickstart
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  convertToLlm,
  serializeConversation,
  withFileMutationQueue,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { Text } from '@mariozechner/pi-tui';
import { renderDiff } from '@mariozechner/pi-coding-agent';
import { MorphClient, WarpGrepClient, CompactClient } from '@morphllm/morphsdk';
import type { WarpGrepResult } from '@morphllm/morphsdk';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as Diff from 'diff';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const morphApiKeyEnv = process.env.MORPH_API_KEY;
const MORPH_API_URL = 'https://api.morphllm.com';
const MORPH_TIMEOUT = 30000;
const MORPH_WARP_GREP_TIMEOUT = 60000;
const MORPH_COMPACT_TIMEOUT = 60000;
const GITHUB_RESOLVER_TIMEOUT = 10000;
const GITHUB_REPO_API_URL = 'https://api.github.com/repos';
const GITHUB_REPO_SEARCH_URL = 'https://api.github.com/search/repositories';
const GITHUB_REPO_SUGGESTION_LIMIT = 5;

/** Canonical marker string used for lazy edit placeholders */
const EXISTING_CODE_MARKER = '// ... existing code ...';
const MORPH_ROUTING_HINT_HEADER = 'Morph plugin routing hints:';

/** Approximate: ~3 characters per token (rough estimate for threshold math) */

/** Context lines for diff display */
const DIFF_CONTEXT_LINES = 4;
const CHARS_PER_TOKEN = 3;

/** Feature flags — users can disable specific capabilities. All default to true. */
const MORPH_EDIT_ENABLED = process.env.MORPH_EDIT !== 'false';
const MORPH_WARPGREP_ENABLED = process.env.MORPH_WARPGREP !== 'false';
const MORPH_WARPGREP_GITHUB_ENABLED = process.env.MORPH_WARPGREP_GITHUB !== 'false';
const MORPH_COMPACT_ENABLED = process.env.MORPH_COMPACT !== 'false';

/** Compaction config */
const COMPACT_RATIO = parseFloat(process.env.MORPH_COMPACT_RATIO || '0.3');
const COMPACT_PRESERVE_RECENT = parseInt(process.env.MORPH_COMPACT_PRESERVE_RECENT || '1', 10);

/** Plugin version */
const PLUGIN_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Deferred SDK client initialization
// ---------------------------------------------------------------------------

/**
 * Resolved API key — set in session_start from env var or auth.json fallback.
 *
 * Resolution order:
 *   1. MORPH_API_KEY environment variable
 *   2. auth.json entry for "morph" provider (via ctx.modelRegistry.getApiKeyForProvider)
 */
let morphApiKey: string | undefined = morphApiKeyEnv;

/** Lazy client factories — created on demand after API key is resolved. */
const getMorph = () =>
  morphApiKey ? new MorphClient({ apiKey: morphApiKey, timeout: MORPH_TIMEOUT }) : null;

const getWarpGrep = () =>
  morphApiKey
    ? new WarpGrepClient({
        morphApiKey: morphApiKey,
        morphApiUrl: MORPH_API_URL,
        timeout: MORPH_WARP_GREP_TIMEOUT,
      })
    : null;

const getCompactClient = () =>
  morphApiKey
    ? new CompactClient({
        morphApiKey: morphApiKey,
        morphApiUrl: MORPH_API_URL,
        timeout: MORPH_COMPACT_TIMEOUT,
      })
    : null;

// ---------------------------------------------------------------------------
// Diff generation (custom format matching renderDiff expectations)
// ---------------------------------------------------------------------------

/**
 * Generate a unified diff with line numbers, matching the format that pi's
 * renderDiff component expects: "+<linenum> <content>", "-<linenum> <content>",
 * " <linenum> <content>".
 */
function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines: number = DIFF_CONTEXT_LINES,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split('\n');
    if (raw[raw.length - 1] === '') {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ');
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;
          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;
        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join('\n'), firstChangedLine };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Normalize code_edit input from LLM tool calls.
 * Strips a single outer markdown fence pair using line-based parsing.
 */
function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split('\n');
  if (lines.length < 3) return codeEdit;
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (/^```[\w-]*$/.test(firstLine!) && /^```$/.test(lastLine!)) {
    return lines.slice(1, -1).join('\n');
  }
  return codeEdit;
}

/** Resolve a possibly-relative path against a base directory. */
function resolveFilepath(targetFilepath: string, cwd: string): string {
  return isAbsolute(targetFilepath) ? targetFilepath : resolvePath(cwd, targetFilepath);
}

/** Minimal check for a plausible file path on any OS. */
const PLAUSIBLE_PATH_RE = /[/\\]|\.[\w]+$/;

function isValidContext(ctx: { file: string; content: string }): boolean {
  return Boolean(ctx.file) && PLAUSIBLE_PATH_RE.test(ctx.file) && ctx.content.length > 0;
}

// ---------------------------------------------------------------------------
// WarpGrep result formatting
// ---------------------------------------------------------------------------

function formatWarpGrepResult(result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed: ${result.error || 'search returned no error details.'}`;
  }
  if (!result.contexts || result.contexts.length === 0) {
    return 'No relevant code found. Try rephrasing your search term.';
  }

  const valid = result.contexts.filter(isValidContext);
  if (valid.length === 0) {
    const sample = result.contexts.slice(0, 3).map((c) => c.file);
    return `Search returned malformed file contexts (file values: ${JSON.stringify(sample)}).
Fallback: use \`grep\` + \`read\` for local code search.`;
  }

  const parts: string[] = ['Relevant context found:'];

  for (const ctx of valid) {
    const rangeStr =
      !ctx.lines || ctx.lines === '*' ? '*' : ctx.lines.map(([s, e]) => `${s}-${e}`).join(',');
    parts.push(`- ${ctx.file}:${rangeStr}`);
  }

  parts.push('\nFile contents:\n');

  for (const ctx of valid) {
    const rangeStr =
      !ctx.lines || ctx.lines === '*'
        ? ''
        : ` lines="${ctx.lines.map(([s, e]) => `${s}-${e}`).join(',')}"`;
    parts.push(`<file path="${ctx.file}"${rangeStr}>`);
    parts.push(ctx.content);
    parts.push('</file>\n');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public repo context (GitHub search) helpers
// ---------------------------------------------------------------------------

type PublicRepoContextSearchArgs = {
  search_term: string;
  owner_repo?: string;
  github_url?: string;
  branch?: string;
};

type GitHubRepo = string; // "owner/repo"

type GitHubRepoSuggestion = {
  fullName: string;
  htmlUrl: string;
  description?: string;
  stars: number;
  ownerLogin: string;
  name: string;
};

type GitHubRepoLookupResult =
  | { status: 'found'; fullName: string; defaultBranch?: string; htmlUrl?: string }
  | { status: 'not_found'; detail: string }
  | { status: 'unavailable'; detail: string };

const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function tokenizeSuggestionQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function buildGitHubSuggestionQueries(repo: GitHubRepo, searchTerm: string): string[] {
  const [owner, repoName] = repo.split('/');
  const searchTokens = tokenizeSuggestionQuery(searchTerm).slice(0, 3);
  const queries = new Set<string>();
  if (owner) queries.add(`user:${owner}`);
  if (owner && repoName) queries.add(`${repoName} user:${owner}`);
  if (repoName) queries.add(repoName);
  if (searchTokens.length > 0 && repoName) {
    queries.add(`${repoName} ${searchTokens.join(' ')}`);
  }
  return Array.from(queries).slice(0, 4);
}

function formatPublicRepoResolutionFailure(
  repo: GitHubRepo,
  detail?: string,
  suggestions: GitHubRepoSuggestion[] = []
): string {
  const parts: string[] = [
    `Repository not found: ${repo}\n\nThis repository does not exist or is private. Do NOT keep guessing other repo names.`,
  ];
  if (suggestions.length > 0) {
    const list = suggestions
      .map((s) => `- ${s.fullName}${s.description ? ` - ${s.description}` : ''}`)
      .join('\n');
    parts.push(
      `Public repos found under this org:\n${list}\n\nIf one of these looks right, retry with that owner_repo.`
    );
  }
  parts.push(
    `If the package or SDK is closed-source or private:\n- Check the ecosystem registry or package page for repository metadata before guessing more names\n- Use the registry that matches the environment: npm for Node/TypeScript, crates.io for Rust, PyPI for Python, pkg.go.dev for Go, etc.\n- The real source repo may be under a different org or name\n- Stop trying variations and report that the source is not publicly available`
  );
  return parts.join('\n\n');
}

function resolvePublicRepoLocator(
  args: PublicRepoContextSearchArgs
): { repo: GitHubRepo } | { error: string } {
  const ownerRepo = args.owner_repo?.trim();
  const githubUrl = args.github_url?.trim();

  if (ownerRepo && githubUrl) {
    return {
      error: `Error: Provide either owner_repo or github_url, not both.

Use owner_repo for values like "owner/repo" or github_url for full URLs like "https://github.com/owner/repo".`,
    };
  }

  if (!ownerRepo && !githubUrl) {
    return {
      error: `Error: Missing repository target.

Provide exactly one of:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"`,
    };
  }

  if (ownerRepo) {
    if (!GITHUB_OWNER_REPO_PATTERN.test(ownerRepo)) {
      return {
        error: `Error: owner_repo must be a GitHub repository in "owner/repo" format.

Received: "${ownerRepo}"

Examples:
- "owner/repo"
- "org/project"
- "team/package"

If you have a full URL, use github_url instead.`,
      };
    }
    return { repo: ownerRepo };
  }

  let parsed: URL;
  try {
    parsed = new URL(githubUrl!);
  } catch {
    return {
      error: `Error: github_url must be a valid GitHub repository URL.

Received: "${githubUrl}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  if (!['github.com', 'www.github.com'].includes(parsed.hostname)) {
    return {
      error: `Error: github_url must point to github.com.

Received host: "${parsed.hostname}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  const pathParts = parsed.pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (pathParts.length < 2) {
    return {
      error: `Error: github_url must include both owner and repository name.

Received: "${githubUrl}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  const owner = pathParts[0]!;
  const repoName = pathParts[1]!.replace(/\.git$/, '');
  const canonicalRepo = `${owner}/${repoName}`;

  if (!GITHUB_OWNER_REPO_PATTERN.test(canonicalRepo)) {
    return {
      error: `Error: github_url did not resolve to a valid GitHub owner/repo locator.

Received: "${githubUrl}"`,
    };
  }

  return { repo: canonicalRepo };
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pi-morph-plugin',
  };
}

async function withGitHubTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_RESOLVER_TIMEOUT);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupGitHubRepository(repo: GitHubRepo): Promise<GitHubRepoLookupResult> {
  return withGitHubTimeout(async (signal) => {
    try {
      const response = await fetch(`${GITHUB_REPO_API_URL}/${repo}`, {
        headers: githubHeaders(),
        signal,
      });
      if (response.status === 404)
        return { status: 'not_found', detail: 'GitHub repository not found' };
      if (!response.ok)
        return {
          status: 'unavailable',
          detail: `GitHub repo lookup failed with status ${response.status}`,
        };
      const body = (await response.json()) as {
        full_name?: string;
        default_branch?: string;
        html_url?: string;
      };
      return {
        status: 'found',
        fullName: body.full_name || repo,
        defaultBranch: body.default_branch,
        htmlUrl: body.html_url,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown GitHub repo lookup error';
      return { status: 'unavailable', detail: message };
    }
  });
}

async function fetchGitHubRepoSuggestions(
  repo: GitHubRepo,
  searchTerm: string
): Promise<GitHubRepoSuggestion[]> {
  return withGitHubTimeout(async (signal) => {
    const queries = buildGitHubSuggestionQueries(repo, searchTerm);
    const results = await Promise.all(
      queries.map(async (query) => {
        const url = new URL(GITHUB_REPO_SEARCH_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('sort', 'stars');
        url.searchParams.set('order', 'desc');
        url.searchParams.set('per_page', String(GITHUB_REPO_SUGGESTION_LIMIT));
        const response = await fetch(url.toString(), {
          headers: githubHeaders(),
          signal,
        });
        if (!response.ok) return [];
        const body = (await response.json()) as {
          items?: Array<{
            full_name?: string;
            html_url?: string;
            description?: string | null;
            stargazers_count?: number;
            name?: string;
            owner?: { login?: string };
          }>;
        };
        return (body.items || []).filter(
          (item) => item.full_name && item.html_url && item.name && item.owner?.login
        );
      })
    );

    const candidates = new Map<string, GitHubRepoSuggestion>();
    for (const items of results) {
      for (const item of items) {
        if (!candidates.has(item.full_name!)) {
          candidates.set(item.full_name!, {
            fullName: item.full_name!,
            htmlUrl: item.html_url!,
            description: item.description || undefined,
            stars: item.stargazers_count || 0,
            ownerLogin: item.owner!.login!,
            name: item.name!,
          });
        }
      }
    }
    return Array.from(candidates.values()).slice(0, GITHUB_REPO_SUGGESTION_LIMIT);
  });
}

// ---------------------------------------------------------------------------
// System prompt routing hints
// ---------------------------------------------------------------------------

function buildMorphSystemRoutingHint(): string | null {
  if (!morphApiKey) {
    return [
      MORPH_ROUTING_HINT_HEADER,
      '- Morph remote tools are currently unavailable because MORPH_API_KEY is not configured.',
      '- Use native edit/write/grep tools until Morph credentials are configured.',
    ].join('\n');
  }

  const lines = [MORPH_ROUTING_HINT_HEADER];

  if (MORPH_EDIT_ENABLED) {
    lines.push('- Prefer morph_edit for large or scattered edits inside existing files.');
    lines.push('- Use native edit for small exact replacements.');
    lines.push('- Use write for brand new files.');
  }

  if (MORPH_WARPGREP_ENABLED) {
    lines.push('- Use warpgrep_codebase_search for exploratory local codebase questions.');
  }

  if (MORPH_WARPGREP_GITHUB_ENABLED) {
    lines.push('- Use warpgrep_github_search for public GitHub source questions.');
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function morphPlugin(pi: ExtensionAPI) {
  // Notify user on startup
  pi.on('session_start', async (_event, ctx) => {
    // Resolve API key: env var takes priority, then auth.json fallback
    if (!morphApiKey && ctx.modelRegistry) {
      try {
        const authKey = await ctx.modelRegistry.getApiKeyForProvider('morph');
        if (authKey) {
          morphApiKey = authKey;
        }
      } catch {
        // auth.json not available or provider not configured — that's fine
      }
    }

    if (!morphApiKey) {
      ctx.ui.notify(
        'Morph: MORPH_API_KEY not set — tools disabled. Set MORPH_API_KEY or add "morph" to auth.json to enable.',
        'warning'
      );
    } else {
      const features = [
        MORPH_EDIT_ENABLED && 'edit',
        MORPH_WARPGREP_ENABLED && 'warpgrep',
        MORPH_WARPGREP_GITHUB_ENABLED && 'warpgrep-github',
        MORPH_COMPACT_ENABLED && 'compact',
      ].filter(Boolean);
      ctx.ui.notify(`Morph plugin v${PLUGIN_VERSION} loaded [${features.join(', ')}]`, 'info');
    }
  });

  // Reset API key on session switch so auth.json re-resolves
  pi.on('session_shutdown', async () => {
    morphApiKey = morphApiKeyEnv; // Reset to env var, auth.json will be re-checked on next session_start
  });

  // -------------------------------------------------------------------------
  // System prompt routing hints — inject on every turn
  // -------------------------------------------------------------------------
  pi.on('before_agent_start', async (event) => {
    const hint = buildMorphSystemRoutingHint();
    if (!hint) return;

    // Avoid duplicating if already present
    if (event.systemPrompt.includes(MORPH_ROUTING_HINT_HEADER)) return;

    return {
      systemPrompt: event.systemPrompt + '\n\n' + hint,
    };
  });

  // -------------------------------------------------------------------------
  // Tool: morph_edit (Fast Apply)
  // -------------------------------------------------------------------------
  if (MORPH_EDIT_ENABLED) {
    pi.registerTool({
      name: 'morph_edit',
      label: 'Morph Fast Apply',
      description: `Edit existing files using partial code snippets with "// ... existing code ..." markers. Morph's AI merges your changes into the full file.

WHEN TO USE morph_edit vs edit:
- morph_edit: large files (300+ lines), multiple scattered changes, complex refactoring, whitespace-sensitive edits
- native edit: small exact string replacements, simple renames, single-line fixes (faster, no API call)
- native write: creating new files from scratch

FORMAT — use "// ... existing code ..." to represent unchanged sections:
// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...

CRITICAL RULES:
- ALWAYS wrap changes with markers at start AND end (omitting markers DELETES surrounding code)
- Include 1-2 unique context lines around each edit to anchor the location precisely
- Write a specific 'instructions' param: "I am adding X to function Y" not "update code"
- Preserve exact indentation
- For deletions: show surrounding context, omit the deleted lines
- Batch multiple edits to the same file in one call

DISAMBIGUATION — when a file has repeated patterns, include enough unique context:
  BAD:  just "return result;" (matches many places)
  GOOD: include the unique function signature above it

FALLBACK: If morph_edit fails (API error, timeout), use the native 'edit' tool with exact oldString/newString matching.`,

      promptSnippet:
        'Edit existing files using partial code snippets with lazy markers (Morph Fast Apply)',
      promptGuidelines: [
        'Use morph_edit for large or scattered edits inside existing files; use native edit for small exact replacements.',
        'If morph_edit fails due to API error or timeout, fall back to native edit.',
        'Do not use morph_edit for creating new files — use write instead.',
      ],

      parameters: Type.Object({
        target_filepath: Type.String({
          description: 'Path of the file to modify',
        }),
        instructions: Type.String({
          description:
            "Brief first-person description of what you're changing. Used to disambiguate uncertainty in the edit.",
        }),
        code_edit: Type.String({
          description:
            'The code changes wrapped with "// ... existing code ..." markers for unchanged sections',
        }),
      }),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { target_filepath, instructions, code_edit } = params;
        const normalizedCodeEdit = normalizeCodeEditInput(code_edit);

        if (!morphApiKey) {
          throw new Error(
            `MORPH_API_KEY not configured. Set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys

Alternatively, use the native 'edit' tool for this change.`
          );
        }

        const absolutePath = resolveFilepath(target_filepath, ctx.cwd);

        // Use withFileMutationQueue to serialize parallel writes to same file
        return withFileMutationQueue(absolutePath, async () => {
          // Read the original file
          let originalCode: string;
          try {
            originalCode = await readFile(absolutePath, 'utf8');
          } catch (err) {
            const error = err as NodeJS.ErrnoException;
            if (error.code === 'ENOENT') {
              // File doesn't exist — if no markers, treat as new file creation
              if (!normalizedCodeEdit.includes(EXISTING_CODE_MARKER)) {
                await mkdir(dirname(absolutePath), { recursive: true });
                await writeFile(absolutePath, normalizedCodeEdit, 'utf8');
                const newLines = normalizedCodeEdit.split('\n').length;
                // Generate a diff showing all new content as added
                const renderableDiff = generateDiffString('', normalizedCodeEdit);
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Created new file: ${target_filepath}\n\nLines: ${newLines}`,
                    },
                  ],
                  details: {
                    created: true,
                    path: target_filepath,
                    lines: newLines,
                    diff: renderableDiff.diff,
                    firstChangedLine: renderableDiff.firstChangedLine,
                  },
                };
              }
              throw new Error(
                `File not found: ${target_filepath}\n\nThe file doesn't exist and the code_edit contains lazy markers.
For new files, provide the complete content without "${EXISTING_CODE_MARKER}" markers.`
              );
            }
            throw new Error(`Error reading file ${target_filepath}: ${error.message}`);
          }

          // Pre-flight marker check
          const hasMarkers = normalizedCodeEdit.includes(EXISTING_CODE_MARKER);
          const originalLineCount = originalCode.split('\n').length;

          if (!hasMarkers && originalLineCount > 10) {
            throw new Error(
              `Missing "${EXISTING_CODE_MARKER}" markers.

Your code_edit would replace the entire file (${originalLineCount} lines) because it contains no markers.
This is almost certainly unintended and would cause code loss.

To fix, wrap your changes with markers:
${EXISTING_CODE_MARKER}
YOUR_CHANGES_HERE
${EXISTING_CODE_MARKER}

If you truly want to replace the entire file, use the 'write' tool instead.`
            );
          }

          // Call Morph SDK to merge the edit
          const startTime = Date.now();
          const result = await getMorph()!.fastApply.applyEdit(
            {
              originalCode,
              codeEdit: normalizedCodeEdit,
              instruction: instructions,
              filepath: target_filepath,
            },
            {
              morphApiUrl: MORPH_API_URL,
              generateUdiff: true,
            }
          );
          const apiDuration = Date.now() - startTime;

          if (!result.success || !result.mergedCode) {
            throw new Error(
              `Morph API failed: ${result.error}\n\nSuggestion: Try using the native 'edit' tool instead with exact string replacement.`
            );
          }

          const mergedCode = result.mergedCode;

          // Guard: Marker leakage detection
          const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);
          if (hasMarkers && !originalHadMarker && mergedCode.includes(EXISTING_CODE_MARKER)) {
            throw new Error(
              `Morph API produced unsafe output for ${target_filepath}.

Detected placeholder marker text ("${EXISTING_CODE_MARKER}") in merged output.
This means the merge model treated markers as literal code instead of expanding them.

No file changes were written.

Options:
1. Retry with more concrete surrounding context in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller, more targeted edits`
            );
          }

          // Guard: Catastrophic truncation detection
          const mergedLineCount = mergedCode.split('\n').length;
          const charLoss = (originalCode.length - mergedCode.length) / originalCode.length;
          const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;

          if (hasMarkers && charLoss > 0.6 && lineLoss > 0.5) {
            throw new Error(
              `Morph API produced a potentially destructive merge for ${target_filepath}.

Original: ${originalLineCount} lines (${originalCode.length} chars)
Merged:   ${mergedLineCount} lines (${mergedCode.length} chars)
Loss:     ${Math.round(charLoss * 100)}% characters, ${Math.round(lineLoss * 100)}% lines

Because markers were provided, this large shrink is likely unintended.
No file changes were written.

Options:
1. Retry with more precise anchors in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller edits`
            );
          }

          // Write the merged result
          await writeFile(absolutePath, mergedCode, 'utf8');

          // Generate diff for TUI rendering (custom format with line numbers
          // that renderDiff expects) and for text output
          const udiff = result.udiff || 'No changes detected';
          const { linesAdded, linesRemoved } = result.changes;
          const mergedLines = mergedCode.split('\n').length;
          const renderableDiff = generateDiffString(originalCode, mergedCode);

          // Truncate udiff if very long for text output
          const truncation = truncateHead(udiff, {
            maxLines: 80,
            maxBytes: 4000,
          });

          let diffText = truncation.content;
          if (truncation.truncated) {
            diffText += `\n... (diff truncated)`;
          }

          return {
            content: [
              {
                type: 'text',
                text: `Applied edit to ${target_filepath}

+${linesAdded} -${linesRemoved} lines | ${originalLineCount} -> ${mergedLines} total | ${apiDuration}ms

\`\`\`diff
${diffText}
\`\`\``,
              },
            ],
            details: {
              provider: 'morph',
              version: PLUGIN_VERSION,
              path: target_filepath,
              linesAdded,
              linesRemoved,
              originalLines: originalLineCount,
              mergedLines,
              durationMs: apiDuration,
              diff: renderableDiff.diff,
              firstChangedLine: renderableDiff.firstChangedLine,
            },
          };
        });
      },

      // Custom TUI rendering
      renderCall(args, theme, _context) {
        const text = new Text('', 0, 0);
        let content = theme.fg('toolTitle', theme.bold('morph_edit '));
        content += theme.fg('muted', args.target_filepath);
        if (args.instructions) {
          content +=
            ' ' +
            theme.fg(
              'dim',
              `"${args.instructions.slice(0, 60)}${args.instructions.length > 60 ? '...' : ''}"`
            );
        }
        text.setText(content);
        return text;
      },

      renderResult(result, { expanded }, theme, context) {
        const text = new Text('', 0, 0);
        const d = result.details as
          | {
              created?: boolean;
              path?: string;
              linesAdded?: number;
              linesRemoved?: number;
              durationMs?: number;
              originalLines?: number;
              mergedLines?: number;
              lines?: number;
              diff?: string;
              firstChangedLine?: number;
            }
          | undefined;

        if (context.isError) {
          text.setText(theme.fg('error', 'Morph: failed'));
          return text;
        }

        if (d?.created) {
          const summary =
            theme.fg('success', '✓ ') +
            theme.fg('accent', `Morph: ${d.path}`) +
            theme.fg('muted', ` (new, ${d.mergedLines || d.lines} lines)`);

          if (expanded && d.diff) {
            const diffComponent = new Text('', 0, 0);
            const renderedDiff = renderDiff(d.diff, { filePath: d.path });
            diffComponent.setText(summary + '\n' + renderedDiff);
            return diffComponent;
          }

          text.setText(summary);
          return text;
        }

        if (d?.linesAdded !== undefined) {
          // Build summary line
          let content =
            theme.fg('success', '✓ ') +
            theme.fg('accent', `Morph: ${d.path}`) +
            theme.fg('muted', ` +${d.linesAdded}/-${d.linesRemoved}`);
          if (d.durationMs) {
            content += theme.fg('dim', ` (${d.durationMs}ms)`);
          }
          if (expanded) {
            content += '\n' + theme.fg('dim', `${d.originalLines} → ${d.mergedLines} lines`);
          }
          text.setText(content);

          // When expanded and we have a diff, render it
          if (expanded && d.diff) {
            const diffComponent = new Text('', 0, 0);
            const renderedDiff = renderDiff(d.diff, { filePath: d.path });
            diffComponent.setText('\n' + renderedDiff);
            return diffComponent;
          }

          return text;
        }

        // Fallback
        text.setText(theme.fg('success', '✓ Morph: edit applied'));
        return text;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Tool: warpgrep_codebase_search (local codebase search)
  // -------------------------------------------------------------------------
  if (MORPH_WARPGREP_ENABLED) {
    pi.registerTool({
      name: 'warpgrep_codebase_search',
      label: 'WarpGrep Codebase Search',
      description: `Fast agentic codebase search. Uses ripgrep, file reading, and directory listing across multiple turns to find relevant code contexts.

Use this for exploratory searches like "Find the authentication flow", "How does error handling work", "Where is the database connection configured". Returns relevant file sections with line numbers.

For exact keyword searches (specific function names, variable names), prefer grep directly.`,

      promptSnippet: 'Search the local codebase with natural language queries (WarpGrep)',
      promptGuidelines: [
        'Use warpgrep_codebase_search for exploratory local codebase questions, not exact keyword lookups.',
        'For exact keyword/function name searches, use grep instead of warpgrep_codebase_search.',
      ],

      parameters: Type.Object({
        search_term: Type.String({
          description: 'Natural language search query describing what to find in the codebase',
        }),
      }),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!morphApiKey) {
          throw new Error(
            `MORPH_API_KEY not configured. Set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`
          );
        }

        const startTime = Date.now();

        try {
          const generator = getWarpGrep()!.execute({
            searchTerm: params.search_term,
            repoRoot: ctx.cwd,
            streamSteps: true,
          });

          let turnCount = 0;
          let result: WarpGrepResult;

          for (;;) {
            const { value, done } = await generator.next();
            if (done) {
              result = value;
              break;
            }
            turnCount = (value as { turn: number }).turn;
          }

          const duration = Date.now() - startTime;
          const contextCount = result.contexts?.length ?? 0;

          // Truncate result if too large
          const rawOutput = formatWarpGrepResult(result);
          const truncation = truncateHead(rawOutput, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          let output = truncation.content;
          if (truncation.truncated) {
            output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
          }

          return {
            content: [{ type: 'text', text: output }],
            details: {
              provider: 'morph',
              version: PLUGIN_VERSION,
              contextCount,
              turnCount,
              durationMs: duration,
            },
          };
        } catch (err) {
          const error = err as Error;
          throw new Error(
            `WarpGrep search failed: ${error.message}\n\nTry rephrasing your search term or using grep for exact keyword searches.`
          );
        }
      },

      renderCall(args, theme, _context) {
        const text = new Text('', 0, 0);
        text.setText(
          theme.fg('toolTitle', theme.bold('warpgrep ')) +
            theme.fg('muted', `"${args.search_term}"`)
        );
        return text;
      },

      renderResult(result, { expanded }, theme, context) {
        const text = new Text('', 0, 0);
        const d = result.details as
          | { contextCount?: number; turnCount?: number; durationMs?: number }
          | undefined;

        if (context.isError) {
          text.setText(theme.fg('error', 'WarpGrep: search failed'));
          return text;
        }

        if (d?.contextCount === 0) {
          text.setText(theme.fg('warning', 'WarpGrep: no results'));
          return text;
        }

        let content =
          theme.fg('success', '✓ ') +
          theme.fg('accent', `WarpGrep: ${d?.contextCount ?? '?'} contexts`);
        if (expanded && d) {
          content += theme.fg('dim', ` | ${d.turnCount} turns, ${d.durationMs}ms`);
        }
        text.setText(content);
        return text;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Tool: warpgrep_github_search (public repo context)
  // -------------------------------------------------------------------------
  if (MORPH_WARPGREP_GITHUB_ENABLED) {
    pi.registerTool({
      name: 'warpgrep_github_search',
      label: 'WarpGrep GitHub Search',
      description: `Grounded code context search for public GitHub repositories. Uses Morph's hosted WarpGrep to search indexed public repos without cloning them locally.

PREFER this tool over web search or docs fetching when the question is about how an open-source library or SDK works internally. If the user asks how something works in a library or package from any ecosystem, find its GitHub repo and search it here instead of fetching docs URLs.

Use this when:
- User asks how an external library/SDK works (auth, retries, sessions, internals)
- You need to understand implementation details of any open-source dependency
- Docs URLs are failing or returning 404s — search the source instead
- User asks about a framework or tool they didn't provide a repo for — infer the canonical GitHub repo from the matching ecosystem

This tool is for public remote repos. For the current checked-out workspace, use warpgrep_codebase_search instead.

Provide exactly one repository locator:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"`,

      promptSnippet: 'Search public GitHub repos for code context without cloning (WarpGrep)',
      promptGuidelines: [
        'Use warpgrep_github_search for public GitHub source questions, not for the current local repo.',
        'Use warpgrep_codebase_search for the local checked-out repo, not warpgrep_github_search.',
      ],

      parameters: Type.Object({
        search_term: Type.String({
          description:
            'Natural language query describing what to find or understand in the public repository',
        }),
        owner_repo: Type.Optional(
          Type.String({
            description: 'GitHub repository in "owner/repo" format, for example "owner/repo"',
          })
        ),
        github_url: Type.Optional(
          Type.String({
            description: 'Full GitHub repository URL, for example "https://github.com/owner/repo"',
          })
        ),
        branch: Type.Optional(
          Type.String({
            description: 'Optional branch name to search instead of the repository default branch',
          })
        ),
      }),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!morphApiKey) {
          throw new Error(
            `MORPH_API_KEY not configured. Set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`
          );
        }

        const locator = resolvePublicRepoLocator(params);
        if ('error' in locator) {
          throw new Error(locator.error);
        }
        const repo = locator.repo;

        const startTime = Date.now();
        const repoLookup = await lookupGitHubRepository(repo);

        if (repoLookup.status === 'not_found') {
          const suggestions = await fetchGitHubRepoSuggestions(repo, params.search_term).catch(
            () => []
          );
          throw new Error(formatPublicRepoResolutionFailure(repo, repoLookup.detail, suggestions));
        }

        try {
          const result = await getWarpGrep()!.searchGitHub({
            searchTerm: params.search_term,
            github: repo,
            branch: params.branch,
          });

          const duration = Date.now() - startTime;
          const contextCount = result.contexts?.length ?? 0;

          if (!result.success) {
            const suggestions = await fetchGitHubRepoSuggestions(repo, params.search_term).catch(
              () => []
            );
            throw new Error(formatPublicRepoResolutionFailure(repo, result.error, suggestions));
          }

          // Truncate result if too large
          const rawOutput = `Repository: ${repo}\n\n${formatWarpGrepResult(result)}`;
          const truncation = truncateHead(rawOutput, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          let output = truncation.content;
          if (truncation.truncated) {
            output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
          }

          return {
            content: [{ type: 'text', text: output }],
            details: {
              provider: 'morph',
              version: PLUGIN_VERSION,
              repo,
              contextCount,
              durationMs: duration,
            },
          };
        } catch (err) {
          if ((err as Error).message.includes('Repository not found')) {
            throw err;
          }
          const error = err as Error;
          const duration = Date.now() - startTime;
          const suggestions = await fetchGitHubRepoSuggestions(repo, params.search_term).catch(
            () => []
          );
          throw new Error(formatPublicRepoResolutionFailure(repo, error.message, suggestions));
        }
      },

      renderCall(args, theme, _context) {
        const text = new Text('', 0, 0);
        const repo = args.owner_repo || args.github_url || '';
        text.setText(
          theme.fg('toolTitle', theme.bold('warpgrep-github ')) +
            theme.fg('muted', repo ? `${repo} ` : '') +
            theme.fg('dim', `"${args.search_term}"`)
        );
        return text;
      },

      renderResult(result, { expanded }, theme, context) {
        const text = new Text('', 0, 0);
        const d = result.details as
          | { repo?: string; contextCount?: number; durationMs?: number }
          | undefined;

        if (context.isError) {
          const repo = d?.repo ?? '';
          text.setText(theme.fg('error', `Public repo: failed${repo ? ` (${repo})` : ''}`));
          return text;
        }

        if (d?.contextCount === 0) {
          const repo = d?.repo ?? '';
          text.setText(theme.fg('warning', `Public repo: no results${repo ? ` (${repo})` : ''}`));
          return text;
        }

        let content =
          theme.fg('success', '✓ ') +
          theme.fg('accent', `Public repo: ${d?.repo ?? '?'} (${d?.contextCount ?? '?'} contexts)`);
        if (expanded && d) {
          content += theme.fg('dim', ` | ${d.durationMs}ms`);
        }
        text.setText(content);
        return text;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Custom compaction via Morph Compact API
  // -------------------------------------------------------------------------
  if (MORPH_COMPACT_ENABLED && morphApiKey) {
    pi.on('session_before_compact', async (event, ctx) => {
      const { preparation, signal } = event;
      const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore } =
        preparation;

      // Combine all messages for compaction
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

      if (allMessages.length === 0) return;

      // Convert messages to Morph Compact API format
      // Use pi's convertToLlm to handle all custom message types,
      // then serialize to text and parse into per-role chunks for Morph
      const llmMessages = convertToLlm(allMessages);
      const conversationText = serializeConversation(llmMessages);
      const compactMessages = buildCompactInputFromText(conversationText);

      if (compactMessages.length === 0) return;

      ctx.ui.notify(
        `Morph compact: compressing ${allMessages.length} messages (~${tokensBefore.toLocaleString()} tokens)...`,
        'info'
      );

      try {
        const result = await getCompactClient()!.compact({
          messages: compactMessages,
          compressionRatio: COMPACT_RATIO,
          preserveRecent: COMPACT_PRESERVE_RECENT,
        });

        // Morph Compact returns either per-message results or a single output
        let summary: string;

        if (
          result.messages &&
          result.messages.length > 0 &&
          result.messages.length === compactMessages.length
        ) {
          // Per-message compaction — merge into a single summary
          summary = result.messages.map((m) => m.content).join('\n\n');
        } else {
          summary = result.output;
        }

        if (!summary.trim()) {
          ctx.ui.notify('Morph compact: summary was empty, using default compaction', 'warning');
          return;
        }

        ctx.ui.notify(
          `Morph compact: ${allMessages.length} messages compressed (${Math.round(result.usage.compression_ratio * 100)}% kept, ${result.usage.processing_time_ms}ms)`,
          'info'
        );

        return {
          compaction: {
            summary,
            firstKeptEntryId,
            tokensBefore,
            details: {
              provider: 'morph',
              version: PLUGIN_VERSION,
              compressionRatio: result.usage.compression_ratio,
              processingTimeMs: result.usage.processing_time_ms,
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
            },
          },
        };
      } catch (err) {
        const error = err as Error;
        ctx.ui.notify(
          `Morph compact failed: ${error.message}. Falling back to default compaction.`,
          'warning'
        );
        // Return undefined to fall back to default compaction
        return;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: Build compact input from serialized conversation text
// ---------------------------------------------------------------------------

/**
 * Parse the serialized conversation text (from serializeConversation) into
 * per-role content blocks for the Morph Compact API.
 *
 * The serialized format looks like:
 *   [User]: text
 *   [Assistant thinking]: text
 *   [Assistant]: text
 *   [Assistant tool calls]: text
 *   [Tool result]: text
 *
 * We split on these markers to create role/content pairs.
 */
function buildCompactInputFromText(text: string): Array<{ role: string; content: string }> {
  const lines = text.split('\n');
  const result: Array<{ role: string; content: string }> = [];
  let currentRole = '';
  let currentContent: string[] = [];

  const rolePattern =
    /^\[(User|Assistant thinking|Assistant tool calls|Assistant|Tool result)\]:\s*/;

  for (const line of lines) {
    const match = line.match(rolePattern);
    if (match) {
      // Flush previous block
      if (currentRole && currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content) {
          result.push({ role: mapRole(currentRole), content });
        }
      }
      currentRole = match[1]!;
      currentContent = [line.slice(match[0].length)];
    } else {
      currentContent.push(line);
    }
  }

  // Flush final block
  if (currentRole && currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content) {
      result.push({ role: mapRole(currentRole), content });
    }
  }

  return result.filter((m) => m.content.length > 0);
}

function mapRole(marker: string): string {
  switch (marker) {
    case 'User':
      return 'user';
    case 'Assistant':
    case 'Assistant thinking':
    case 'Assistant tool calls':
    case 'Tool result':
      return 'assistant';
    default:
      return 'user';
  }
}
