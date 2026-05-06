# pi-morph-plugin

[Pi](https://pi.dev) extension for [Morph](https://morphllm.com). Four capabilities:

- **Fast Apply** — 10,500+ tok/s code editing with lazy markers
- **WarpGrep** — fast agentic codebase search, +4% on SWE-Bench Pro, -15% cost
- **Public Repo Context** — grounded context search for public GitHub repos without cloning
- **Compaction** — 25,000+ tok/s context compression in sub-2s, +0.6% on SWE-Bench Pro

On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task accuracy by **6%**, reduces cost, and is net **28% faster**.

---

## Quick Start

### 1. Get a Morph API key

Sign up at [morphllm.com/dashboard](https://morphllm.com/dashboard/api-keys) and configure it:

**Option A: Environment variable** (recommended for quick setup)

```bash
export MORPH_API_KEY="sk-..."
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) so it persists.

**Option B: auth.json** (recommended for persistent config)

Add to `~/.pi/agent/auth.json`:

```json
{
  "morph": { "type": "api_key", "key": "sk-..." }
}
```

The environment variable takes priority over auth.json.

### 2. Install the plugin

```bash
pi install git:github.com/morphllm/pi-morph-plugin
```

Or install locally in your project:

```bash
pi install -l git:github.com/morphllm/pi-morph-plugin
```

### 3. Start Pi

```bash
pi
```

You should see `morph_edit`, `warpgrep_codebase_search`, and `warpgrep_github_search` in the available tools. Compaction runs automatically when context exceeds the threshold.

---

## Tools

### Fast Apply (`morph_edit`)

10,500+ tok/s code merging. The LLM writes partial snippets with lazy markers (`// ... existing code ...`), Morph merges them into the full file.

Best for large files (300+ lines) and multiple scattered changes. For small exact replacements, use Pi's built-in `edit` tool.

### WarpGrep (`warpgrep_codebase_search`)

Fast agentic codebase search. Runs multi-turn ripgrep + file reads to find relevant code contexts. Sub-6s per query. Best for exploratory queries ("how does X work?", "where is Y handled?").

### Public Repo Context (`warpgrep_github_search`)

Search public GitHub repositories without cloning. Pass an `owner/repo` or GitHub URL and a search query. Returns relevant file contexts from Morph's indexed public repo search.

### Compaction

Context compression via the Morph Compact API. When Pi's built-in compaction triggers (context exceeds threshold), this extension intercepts it and uses the Morph Compact API instead of default LLM summarization. Compresses in ~250ms at 25,000+ tok/s.

---

## Configuration

All configuration is via environment variables.

| Variable                        | Default    | Description                                                  |
| ------------------------------- | ---------- | ------------------------------------------------------------ |
| `MORPH_API_KEY`                 | _required_ | Your Morph API key                                           |
| `MORPH_COMPACT_RATIO`           | `0.3`      | Target compression ratio (0.05-1.0, lower = more aggressive) |
| `MORPH_COMPACT_PRESERVE_RECENT` | `1`        | Number of recent messages to keep uncompacted                |
| `MORPH_COMPACT`                 | `true`     | Set `false` to disable compaction                            |
| `MORPH_EDIT`                    | `true`     | Set `false` to disable Fast Apply                            |
| `MORPH_WARPGREP`                | `true`     | Set `false` to disable WarpGrep                              |
| `MORPH_WARPGREP_GITHUB`         | `true`     | Set `false` to disable public repo search                    |

Pi's compaction threshold is configured in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

---

## Development

```bash
npm install
```

To test locally:

```bash
pi -e ./extensions/index.ts
```

Or symlink into your pi extensions directory:

```bash
ln -s $(pwd)/extensions/index.ts ~/.pi/agent/extensions/morph-plugin.ts
```

## License

[MIT](LICENSE)
