import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AcpLaunch, AcpRunOptions } from '../src/engine/acp-runner.js';
import type { RunOptions } from '../src/modules/claude/direct.js';

/**
 * Stop works everywhere (E1): a step that was stopped never starts Claude Code again, not even its direct way after
 * ACP could not start.
 */

let acpRun: (launch: AcpLaunch, opts: AcpRunOptions) => Promise<never>;
const direct: RunOptions[] = [];

vi.mock('../src/engine/acp-runner.js', async (orig) => {
  const real = await orig<typeof import('../src/engine/acp-runner.js')>();
  return { ...real, runAcp: (launch: AcpLaunch, opts: AcpRunOptions) => acpRun(launch, opts) };
});
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  claudeBinary: () => '/no/such/claude',
  runClaude: async (opts: RunOptions) => {
    direct.push(opts);
    return { ok: true, sessionId: 's', text: '' };
  },
}));
// The real direct runner below must never find a real Claude Code.
vi.mock('../src/core/claude-binary.js', () => ({ resolveClaudeBinary: () => null }));

const { AcpStartError } = await import('../src/engine/acp-runner.js');
const { claudeTool } = await import('../src/modules/claude/index.js');

beforeEach(() => {
  direct.length = 0;
});

describe('Stop', () => {
  it('never falls back to claude -p after a Stop during the ACP start', async () => {
    const stop = new AbortController();
    acpRun = async () => {
      stop.abort();
      throw new AcpStartError('The ACP adapter did not start: stopped');
    };
    const fallbacks: string[] = [];
    const r = await claudeTool.run({ cwd: '/tmp', prompt: 'go', permissions: ['read'], signal: stop.signal, onFallback: (why) => fallbacks.push(why) });
    expect(r).toMatchObject({ ok: false, error: 'You stopped the squad.' });
    expect(direct).toHaveLength(0);
    expect(fallbacks).toEqual([]);
  });

  it('still falls back when ACP could not start and nobody pressed Stop', async () => {
    acpRun = async () => {
      throw new AcpStartError('Claude Code did not start in 30 seconds.');
    };
    const fallbacks: string[] = [];
    const r = await claudeTool.run({ cwd: '/tmp', prompt: 'go', permissions: ['read'], onFallback: (why) => fallbacks.push(why) });
    expect(r.ok).toBe(true);
    expect(direct).toHaveLength(1);
    expect(fallbacks).toEqual(['Claude Code did not start in 30 seconds.']);
  });

  it('the direct way starts nothing once stopped', async () => {
    const { runClaude } = await vi.importActual<typeof import('../src/modules/claude/direct.js')>('../src/modules/claude/direct.js');
    const before = process.env.PATH;
    // No Claude Code to find, whatever happens.
    process.env.PATH = '/nowhere';
    try {
      const stopped = new AbortController();
      stopped.abort();
      let spawned = false;
      const r = await runClaude({ cwd: '/tmp', prompt: 'go', signal: stopped.signal, onSpawn: () => (spawned = true) });
      expect(r).toMatchObject({ ok: false, error: 'You stopped the squad.' });
      expect(spawned).toBe(false);
    } finally {
      process.env.PATH = before;
    }
  });
});
