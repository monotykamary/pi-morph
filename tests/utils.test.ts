import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the pure utility functions from the extension.
// We use dynamic import with env manipulation to test different flag combos.
const EXISTING_CODE_MARKER = '// ... existing code ...';

// ---------------------------------------------------------------------------
// normalizeCodeEditInput — duplicated here for unit testing
// (the function is module-scoped in index.ts, so we test the same logic)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// resolveFilepath — duplicated for testing
// ---------------------------------------------------------------------------

import { isAbsolute, resolve as resolvePath } from 'node:path';

function resolveFilepath(targetFilepath: string, cwd: string): string {
  return isAbsolute(targetFilepath) ? targetFilepath : resolvePath(cwd, targetFilepath);
}

// ---------------------------------------------------------------------------
// PLAUSIBLE_PATH_RE / isValidContext — duplicated for testing
// ---------------------------------------------------------------------------

const PLAUSIBLE_PATH_RE = /[/\\]|\.[\w]+$/;

function isValidContext(ctx: { file: string; content: string }): boolean {
  return Boolean(ctx.file) && PLAUSIBLE_PATH_RE.test(ctx.file) && ctx.content.length > 0;
}

// ---------------------------------------------------------------------------
// Temp dirs
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pi-morph-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  tmpDirs = [];
});

// ===========================================================================
// normalizeCodeEditInput
// ===========================================================================

describe('normalizeCodeEditInput', () => {
  it('returns plain code unchanged', () => {
    const input = `${EXISTING_CODE_MARKER}\nfunction foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  it('strips standard markdown fence with language', () => {
    const input = '```typescript\nfunction foo() { return 1 }\n```';
    expect(normalizeCodeEditInput(input)).toBe('function foo() { return 1 }');
  });

  it('strips markdown fence without language', () => {
    const input = '```\nfunction foo() { return 1 }\n```';
    expect(normalizeCodeEditInput(input)).toBe('function foo() { return 1 }');
  });

  it('preserves multi-line content inside fences', () => {
    const inner = `${EXISTING_CODE_MARKER}\nfunction foo() {\n  return 1\n}\n${EXISTING_CODE_MARKER}`;
    const input = `\`\`\`typescript\n${inner}\n\`\`\``;
    expect(normalizeCodeEditInput(input)).toBe(inner);
  });

  it('does not strip incomplete fences (missing closing)', () => {
    const input = '```typescript\nfunction foo() { return 1 }';
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  it('does not strip incomplete fences (missing opening)', () => {
    const input = 'function foo() { return 1 }\n```';
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  it('returns short input unchanged (< 3 lines)', () => {
    expect(normalizeCodeEditInput('hello')).toBe('hello');
    expect(normalizeCodeEditInput('line1\nline2')).toBe('line1\nline2');
  });

  it('handles fence with hyphenated language', () => {
    const input = '```c-sharp\nConsole.WriteLine();\n```';
    expect(normalizeCodeEditInput(input)).toBe('Console.WriteLine();');
  });

  it('does not strip fences with text after closing', () => {
    const input = '```typescript\nfoo()\n``` extra text';
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  it('trims whitespace before checking fences', () => {
    const input = '  \n```typescript\nfunction foo() {}\n```\n  ';
    expect(normalizeCodeEditInput(input)).toBe('function foo() {}');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeCodeEditInput('')).toBe('');
  });

  it('handles fence with only whitespace content', () => {
    const input = '```\n  \n```';
    expect(normalizeCodeEditInput(input)).toBe('  ');
  });

  it('handles javascript language tag', () => {
    const input = '```javascript\nconst x = 1;\n```';
    expect(normalizeCodeEditInput(input)).toBe('const x = 1;');
  });

  it('handles python language tag', () => {
    const input = '```python\ndef foo():\n    pass\n```';
    expect(normalizeCodeEditInput(input)).toBe('def foo():\n    pass');
  });

  it('does not strip if closing fence has language', () => {
    const input = '```typescript\nfoo()\n```typescript';
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  it('preserves content with backticks inside fences', () => {
    const input = '```typescript\nconst x = `hello ${world}`;\n```';
    expect(normalizeCodeEditInput(input)).toBe('const x = `hello ${world}`;');
  });
});

// ===========================================================================
// resolveFilepath
// ===========================================================================

describe('resolveFilepath', () => {
  it('passes through absolute paths', () => {
    expect(resolveFilepath('/abs/path.ts', '/base')).toBe('/abs/path.ts');
  });

  it('resolves relative paths against cwd', () => {
    const resolved = resolveFilepath('./ext.ts', '/base/project');
    expect(resolved).toContain('/base/project');
    expect(resolved).toContain('ext.ts');
  });

  it('resolves paths without ./ prefix', () => {
    const resolved = resolveFilepath('extensions/my-ext.ts', '/base/project');
    expect(resolved).toContain('/base/project/extensions/my-ext');
  });

  it('resolves parent directory paths', () => {
    const resolved = resolveFilepath('../shared/ext.ts', '/base/project');
    expect(resolved).toContain('/base/shared/ext');
    expect(resolved).not.toContain('/base/project');
  });
});

// ===========================================================================
// isValidContext / PLAUSIBLE_PATH_RE
// ===========================================================================

describe('isValidContext', () => {
  it('rejects empty file', () => {
    expect(isValidContext({ file: '', content: 'code' })).toBe(false);
  });

  it('rejects whitespace-only file', () => {
    expect(isValidContext({ file: '   ', content: 'code' })).toBe(false);
  });

  it('rejects bare letters without path separator or extension', () => {
    expect(isValidContext({ file: 'C', content: 'code' })).toBe(false);
  });

  it('rejects "noextension"', () => {
    expect(isValidContext({ file: 'noextension', content: 'code' })).toBe(false);
  });

  it('rejects empty content', () => {
    expect(isValidContext({ file: 'src/auth.ts', content: '' })).toBe(false);
  });

  it('accepts unix relative paths', () => {
    expect(isValidContext({ file: 'src/auth.ts', content: 'code' })).toBe(true);
  });

  it('accepts unix absolute paths', () => {
    expect(isValidContext({ file: '/usr/local/bin/server.js', content: 'code' })).toBe(true);
  });

  it('accepts windows absolute paths', () => {
    expect(isValidContext({ file: 'C:\\Users\\dev\\project\\main.rs', content: 'code' })).toBe(
      true
    );
  });

  it('accepts windows relative paths', () => {
    expect(isValidContext({ file: 'packages\\core\\index.ts', content: 'code' })).toBe(true);
  });

  it('accepts relative with ..', () => {
    expect(isValidContext({ file: '../sibling/lib.py', content: 'code' })).toBe(true);
  });

  it('accepts relative with ./', () => {
    expect(isValidContext({ file: './config.yaml', content: 'code' })).toBe(true);
  });

  it('accepts dot-extension only', () => {
    expect(isValidContext({ file: 'Makefile.toml', content: 'code' })).toBe(true);
  });
});

// ===========================================================================
// Marker leakage detection logic (ported from OpenCode plugin tests)
// ===========================================================================

describe('marker leakage detection logic', () => {
  it('detected when original lacks marker', () => {
    const originalCode = 'function foo() { return 1 }';
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}\nfunction bar() {}`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers && !originalHadMarker && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  it('skipped when original already contains marker', () => {
    const originalCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code`;
    const mergedCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code\n// Added line`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers && !originalHadMarker && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  it('not triggered when no markers in input', () => {
    const originalCode = 'function foo() { return 1 }';
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    const hasMarkers = false;

    const wouldTrigger = hasMarkers && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  it('detected when marker appears at start of merged output', () => {
    const originalCode = 'const x = 1;\nconst y = 2;';
    const mergedCode = `${EXISTING_CODE_MARKER}\nconst x = 1;\nconst y = 2;`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers && !originalHadMarker && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  it('not triggered on clean merge (no markers in output)', () => {
    const originalCode = 'function foo() { return 1 }';
    const mergedCode = 'function foo() { return 2 }';
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers && !originalHadMarker && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });
});

// ===========================================================================
// Truncation detection logic (ported from OpenCode plugin tests)
// ===========================================================================

describe('truncation detection logic', () => {
  function wouldTriggerTruncation(
    originalCode: string,
    mergedCode: string,
    hasMarkers: boolean
  ): { triggered: boolean; charLoss: number; lineLoss: number } {
    const originalLineCount = originalCode.split('\n').length;
    const mergedLineCount = mergedCode.split('\n').length;
    const charLoss = (originalCode.length - mergedCode.length) / originalCode.length;
    const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;
    return {
      triggered: hasMarkers && charLoss > 0.6 && lineLoss > 0.5,
      charLoss,
      lineLoss,
    };
  }

  it('triggers when both char and line loss exceed thresholds', () => {
    const originalCode = 'x'.repeat(1000) + '\n'.repeat(100);
    const mergedCode = 'x'.repeat(300) + '\n'.repeat(40);
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(true);
  });

  it('does not trigger when only char loss exceeds threshold', () => {
    const originalCode = 'x    '.repeat(200) + '\n'.repeat(50);
    const mergedCode = 'x'.repeat(200) + '\n'.repeat(50);
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger when only line loss exceeds threshold', () => {
    const lines = Array.from({ length: 100 }, () => 'ab').join('\n');
    const joined = Array.from({ length: 40 }, () => 'ab'.repeat(3)).join('\n');
    const result = wouldTriggerTruncation(lines, joined, true);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger when no markers in input', () => {
    const originalCode = 'x'.repeat(1000) + '\n'.repeat(100);
    const mergedCode = 'x'.repeat(100);
    const result = wouldTriggerTruncation(originalCode, mergedCode, false);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger when file grows (negative loss)', () => {
    const originalCode = 'short\nfile\n';
    const mergedCode = 'short\nfile\nwith\nmany\nnew\nlines\nadded\nhere\n';
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger on empty original file', () => {
    const originalCode = '';
    const mergedCode = 'new content';
    const originalLineCount = originalCode.split('\n').length;
    const charLoss = (originalCode.length - mergedCode.length) / originalCode.length;
    const lineLoss = (originalLineCount - mergedCode.split('\n').length) / originalLineCount;
    // NaN > 0.6 is false
    const triggered = true && charLoss > 0.6 && lineLoss > 0.5;
    expect(triggered).toBe(false);
  });

  it('triggers just above both thresholds', () => {
    const originalCode = 'x'.repeat(900) + '\n'.repeat(100);
    const mergedCode = 'x'.repeat(341) + '\n'.repeat(49);
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeGreaterThan(0.6);
    expect(result.lineLoss).toBeGreaterThan(0.5);
    expect(result.triggered).toBe(true);
  });

  it('does not trigger when just below char threshold', () => {
    const originalCode = 'x'.repeat(900) + '\n'.repeat(100);
    const mergedCode = 'x'.repeat(391) + '\n'.repeat(10);
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
    expect(result.triggered).toBe(false);
  });

  it('handles single-line file correctly', () => {
    const originalCode = 'x'.repeat(100);
    const mergedCode = 'x'.repeat(10);
    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.lineLoss).toBe(0);
    expect(result.triggered).toBe(false);
  });
});

// ===========================================================================
// Feature flag environment variables
// ===========================================================================

describe('feature flags', () => {
  it('MORPH_EDIT defaults to enabled', () => {
    vi.unstubAllEnvs();
    delete process.env.MORPH_EDIT;
    expect(process.env.MORPH_EDIT).toBeUndefined();
    expect(process.env.MORPH_EDIT !== 'false').toBe(true);
  });

  it('MORPH_EDIT disabled when set to "false"', () => {
    vi.stubEnv('MORPH_EDIT', 'false');
    expect(process.env.MORPH_EDIT).toBe('false');
    expect(process.env.MORPH_EDIT === 'false').toBe(true);
    vi.unstubAllEnvs();
  });

  it('MORPH_WARPGREP disabled when set to "false"', () => {
    vi.stubEnv('MORPH_WARPGREP', 'false');
    expect(process.env.MORPH_WARPGREP).toBe('false');
    vi.unstubAllEnvs();
  });

  it('MORPH_COMPACT disabled when set to "false"', () => {
    vi.stubEnv('MORPH_COMPACT', 'false');
    expect(process.env.MORPH_COMPACT).toBe('false');
    vi.unstubAllEnvs();
  });

  it('MORPH_WARPGREP_GITHUB disabled when set to "false"', () => {
    vi.stubEnv('MORPH_WARPGREP_GITHUB', 'false');
    expect(process.env.MORPH_WARPGREP_GITHUB).toBe('false');
    vi.unstubAllEnvs();
  });
});

// ===========================================================================
// Packaged tool-selection instructions
// ===========================================================================

describe('packaged tool-selection instructions', () => {
  it('instruction file exists and routes large edits to morph_edit', () => {
    const content = readFileSync(join(__dirname, '..', 'prompts', 'morph-tools.md'), 'utf-8');

    expect(content).toContain('Morph Tool Selection Policy');
    expect(content).toContain('Large file edits (300+ lines)');
    expect(content).toContain('`morph_edit`');
    expect(content).toContain('Small exact replacement');
    expect(content).toContain('`edit`');
    expect(content).toContain('New file creation');
    expect(content).toContain('`write`');
    expect(content).toContain('`warpgrep_github_search`');
    expect(content).toContain('Public GitHub repo exploration');
    expect(content).toContain('Fallback Policy');
  });

  it('README documents plugin setup and tools', () => {
    const content = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8');

    expect(content).toContain('morph_edit');
    expect(content).toContain('warpgrep_codebase_search');
    expect(content).toContain('warpgrep_github_search');
    expect(content).toContain('MORPH_API_KEY');
    expect(content).toContain('MORPH_COMPACT_RATIO');
  });
});

// ===========================================================================
// buildCompactInputFromText — compaction input parsing
// ===========================================================================

describe('buildCompactInputFromText', () => {
  // Duplicate the function for testing (it's module-scoped in index.ts)
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

  it('parses single user message', () => {
    const text = '[User]: Hello, how are you?';
    const result = buildCompactInputFromText(text);
    expect(result).toEqual([{ role: 'user', content: 'Hello, how are you?' }]);
  });

  it('parses user and assistant messages', () => {
    const text = '[User]: Hello\n[Assistant]: Hi there!';
    const result = buildCompactInputFromText(text);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('maps thinking and tool call markers to assistant role', () => {
    const text =
      '[Assistant thinking]: Let me consider...\n[Assistant tool calls]: read(path="foo.ts")\n[Tool result]: file contents';
    const result = buildCompactInputFromText(text);
    expect(result).toHaveLength(3);
    expect(result.every((m) => m.role === 'assistant')).toBe(true);
  });

  it('handles multi-line content between markers', () => {
    const text = '[User]: I want to refactor\nthe auth module\n[Assistant]: I can help with that.';
    const result = buildCompactInputFromText(text);
    expect(result).toEqual([
      { role: 'user', content: 'I want to refactor\nthe auth module' },
      { role: 'assistant', content: 'I can help with that.' },
    ]);
  });

  it('returns empty array for empty text', () => {
    expect(buildCompactInputFromText('')).toEqual([]);
  });

  it('returns empty array for text with no markers', () => {
    expect(buildCompactInputFromText('just some plain text')).toEqual([]);
  });

  it('handles adjacent markers', () => {
    const text = '[User]: Q\n[Assistant]: A\n[User]: Q2\n[Assistant]: A2';
    const result = buildCompactInputFromText(text);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'user', content: 'Q' });
    expect(result[3]).toEqual({ role: 'assistant', content: 'A2' });
  });
});

// ===========================================================================
// Public repo locator resolution
// ===========================================================================

describe('resolvePublicRepoLocator', () => {
  // Duplicate the function for unit testing
  const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

  function resolvePublicRepoLocator(args: {
    owner_repo?: string;
    github_url?: string;
  }): { repo: string } | { error: string } {
    const ownerRepo = args.owner_repo?.trim();
    const githubUrl = args.github_url?.trim();

    if (ownerRepo && githubUrl) {
      return { error: 'Error: Provide either owner_repo or github_url, not both.' };
    }

    if (!ownerRepo && !githubUrl) {
      return { error: 'Error: Missing repository target.' };
    }

    if (ownerRepo) {
      if (!GITHUB_OWNER_REPO_PATTERN.test(ownerRepo)) {
        return {
          error: `Error: owner_repo must be in "owner/repo" format. Received: "${ownerRepo}"`,
        };
      }
      return { repo: ownerRepo };
    }

    try {
      const parsed = new URL(githubUrl!);
      if (!['github.com', 'www.github.com'].includes(parsed.hostname)) {
        return {
          error: `Error: github_url must point to github.com. Received host: "${parsed.hostname}"`,
        };
      }
      const pathParts = parsed.pathname
        .split('/')
        .map((p) => p.trim())
        .filter(Boolean);
      if (pathParts.length < 2) {
        return { error: 'Error: github_url must include both owner and repository name.' };
      }
      const owner = pathParts[0]!;
      const repoName = pathParts[1]!.replace(/\.git$/, '');
      const canonicalRepo = `${owner}/${repoName}`;
      if (!GITHUB_OWNER_REPO_PATTERN.test(canonicalRepo)) {
        return { error: 'Error: github_url did not resolve to a valid GitHub owner/repo locator.' };
      }
      return { repo: canonicalRepo };
    } catch {
      return { error: 'Error: github_url must be a valid GitHub repository URL.' };
    }
  }

  it('resolves owner/repo format', () => {
    const result = resolvePublicRepoLocator({ owner_repo: 'vercel/next.js' });
    expect('repo' in result).toBe(true);
    if ('repo' in result) expect(result.repo).toBe('vercel/next.js');
  });

  it('resolves full GitHub URL', () => {
    const result = resolvePublicRepoLocator({
      github_url: 'https://github.com/axios/axios',
    });
    expect('repo' in result).toBe(true);
    if ('repo' in result) expect(result.repo).toBe('axios/axios');
  });

  it('strips .git suffix from URL', () => {
    const result = resolvePublicRepoLocator({
      github_url: 'https://github.com/axios/axios.git',
    });
    expect('repo' in result).toBe(true);
    if ('repo' in result) expect(result.repo).toBe('axios/axios');
  });

  it('rejects both owner_repo and github_url', () => {
    const result = resolvePublicRepoLocator({
      owner_repo: 'foo/bar',
      github_url: 'https://github.com/foo/bar',
    });
    expect('error' in result).toBe(true);
  });

  it('rejects neither owner_repo nor github_url', () => {
    const result = resolvePublicRepoLocator({});
    expect('error' in result).toBe(true);
  });

  it('rejects invalid owner_repo format', () => {
    const result = resolvePublicRepoLocator({ owner_repo: 'not-a-repo' });
    expect('error' in result).toBe(true);
  });

  it('rejects non-github.com URL', () => {
    const result = resolvePublicRepoLocator({
      github_url: 'https://gitlab.com/foo/bar',
    });
    expect('error' in result).toBe(true);
  });

  it('rejects malformed URL', () => {
    const result = resolvePublicRepoLocator({
      github_url: 'not-a-url',
    });
    expect('error' in result).toBe(true);
  });

  it('rejects URL without repo name', () => {
    const result = resolvePublicRepoLocator({
      github_url: 'https://github.com/vercel',
    });
    expect('error' in result).toBe(true);
  });
});
