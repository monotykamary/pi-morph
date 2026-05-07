import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createMockPi, getHandler, makeCtx, type MockPi } from './helpers/mock-pi.js';

// ---------------------------------------------------------------------------
// Extension loading helper
// ---------------------------------------------------------------------------

let tmpEnv: Record<string, string | undefined> = {};

function saveEnv(keys: string[]) {
  for (const k of keys) tmpEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const [k, v] of Object.entries(tmpEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  tmpEnv = {};
}

async function loadExtension(): Promise<(pi: any) => void> {
  vi.resetModules();
  const mod = await import('../extensions/index.js');
  return mod.default;
}

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

describe('extension registration', () => {
  it('registers morph_edit tool when MORPH_EDIT is not false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_EDIT']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    delete process.env.MORPH_EDIT;

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).toContain('morph_edit');
  });

  it('does not register morph_edit when MORPH_EDIT=false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_EDIT']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    process.env.MORPH_EDIT = 'false';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).not.toContain('morph_edit');
  });

  it('registers warpgrep_codebase_search when MORPH_WARPGREP is not false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_WARPGREP']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    delete process.env.MORPH_WARPGREP;

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).toContain('warpgrep_codebase_search');
  });

  it('does not register warpgrep_codebase_search when MORPH_WARPGREP=false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_WARPGREP']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    process.env.MORPH_WARPGREP = 'false';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).not.toContain('warpgrep_codebase_search');
  });

  it('registers warpgrep_github_search when MORPH_WARPGREP_GITHUB is not false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_WARPGREP_GITHUB']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    delete process.env.MORPH_WARPGREP_GITHUB;

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).toContain('warpgrep_github_search');
  });

  it('does not register warpgrep_github_search when MORPH_WARPGREP_GITHUB=false', async () => {
    saveEnv(['MORPH_API_KEY', 'MORPH_WARPGREP_GITHUB']);
    process.env.MORPH_API_KEY = 'sk-test-key';
    process.env.MORPH_WARPGREP_GITHUB = 'false';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).not.toContain('warpgrep_github_search');
  });

  it('registers all 3 tools by default with API key', async () => {
    saveEnv(['MORPH_API_KEY']);
    process.env.MORPH_API_KEY = 'sk-test-key';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    expect(pi._registeredTools).toContain('morph_edit');
    expect(pi._registeredTools).toContain('warpgrep_codebase_search');
    expect(pi._registeredTools).toContain('warpgrep_github_search');
  });

  it('registers all 3 tools even without API key (error thrown at runtime)', async () => {
    saveEnv(['MORPH_API_KEY']);
    delete process.env.MORPH_API_KEY;

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    // Tools are still registered — they throw helpful errors at execution time
    expect(pi._registeredTools).toContain('morph_edit');
    expect(pi._registeredTools).toContain('warpgrep_codebase_search');
    expect(pi._registeredTools).toContain('warpgrep_github_search');
  });
});

describe('session_start', () => {
  it('notifies warning when MORPH_API_KEY not set', async () => {
    saveEnv(['MORPH_API_KEY']);
    delete process.env.MORPH_API_KEY;

    const factory = await loadExtension();
    const pi = createMockPi();
    const notify = vi.fn();
    const ctx = makeCtx({ ui: { notify } });

    factory(pi as any);

    const handler = getHandler(pi, 'session_start');
    expect(handler).toBeDefined();
    await handler!({}, ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('MORPH_API_KEY not set'),
      'warning'
    );
  });

  it('notifies info when MORPH_API_KEY is set', async () => {
    saveEnv(['MORPH_API_KEY']);
    process.env.MORPH_API_KEY = 'sk-test-key';

    const factory = await loadExtension();
    const pi = createMockPi();
    const notify = vi.fn();
    const ctx = makeCtx({ ui: { notify } });

    factory(pi as any);

    const handler = getHandler(pi, 'session_start');
    await handler!({}, ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Morph plugin'), 'info');
  });
});

describe('before_agent_start routing hints', () => {
  it('injects routing hints when MORPH_API_KEY is set', async () => {
    saveEnv(['MORPH_API_KEY']);
    process.env.MORPH_API_KEY = 'sk-test-key';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    const handler = getHandler(pi, 'before_agent_start');
    expect(handler).toBeDefined();

    const result = await handler!({ systemPrompt: 'You are a helpful assistant.' }, {});

    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain('Morph plugin routing hints:');
    expect(result.systemPrompt).toContain('Prefer morph_edit');
  });

  it('injects unavailable hint when MORPH_API_KEY is not set', async () => {
    saveEnv(['MORPH_API_KEY']);
    delete process.env.MORPH_API_KEY;

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    const handler = getHandler(pi, 'before_agent_start');
    const result = await handler!({ systemPrompt: 'You are a helpful assistant.' }, {});

    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain('Morph remote tools are currently unavailable');
  });

  it('does not duplicate routing hints if already present', async () => {
    saveEnv(['MORPH_API_KEY']);
    process.env.MORPH_API_KEY = 'sk-test-key';

    const factory = await loadExtension();
    const pi = createMockPi();
    factory(pi as any);

    const handler = getHandler(pi, 'before_agent_start');
    const result = await handler!(
      { systemPrompt: 'You are a helpful assistant.\n\nMorph plugin routing hints:\n- stuff' },
      {}
    );

    // Should not return modified system prompt when hints already present
    expect(result).toBeUndefined();
  });
});
