import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { approved: true, summary: 'Fine', comments: [] }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { STEPS, agentInstructions, readAgent, writeAgent, agentsDir } = await import('../src/engine/agents.js');
const { corePrompts } = await import('../src/engine/core-prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-steps-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('team instructions per step', () => {
  it('are saved under a step heading and read back', () => {
    writeAgent(bp, 'builder', { instructions: 'Use our logger.', steps: { build: 'Small commits of thought.', fix: 'Never turn a test off.' } });
    const file = fs.readFileSync(path.join(agentsDir(bp), 'builder.md'), 'utf8');
    expect(file).toContain('Use our logger.\n\n## Step: build\nSmall commits of thought.\n');
    const a = readAgent(bp, 'builder');
    expect(a.instructions).toBe('Use our logger.');
    expect(a.steps).toEqual({ build: 'Small commits of thought.', fix: 'Never turn a test off.' });
    // Changing one step keeps the others.
    writeAgent(bp, 'builder', { steps: { fix: 'Fix the cause, not the test.' } });
    expect(readAgent(bp, 'builder').steps).toEqual({ build: 'Small commits of thought.', fix: 'Fix the cause, not the test.' });
    expect(() => writeAgent(bp, 'builder', { steps: { review: 'x' } })).toThrow(/no step "review"/);
  });

  it('each step gets the general rules plus its own, added to the core prompt', () => {
    writeAgent(bp, 'builder', { instructions: 'Use our logger.', steps: { fix: 'Never turn a test off.' } });
    const a = readAgent(bp, 'builder');
    expect(agentInstructions(a, 'fix')).toContain('Use our logger.\n\nFor the Fixes step:\nNever turn a test off.');
    expect(agentInstructions(a, 'build')).not.toContain('Never turn a test off.');
    expect(agentInstructions({ ...a, instructions: '<!-- a comment -->', steps: {} }, 'build')).toBe('');
    // A comment split by another goes too: one pass would leave "<!-- b -->".
    expect(agentInstructions({ ...a, instructions: '<!<!-- a -->-- b -->', steps: {} }, 'build')).toBe('');
  });

  it('the live squad tells each run which step it is in', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    writeAgent(bp, 'reviewer', { steps: { review: 'Check every query for the tenant filter.' } });
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, (x) => {
      x.squad = null;
      x.worktree = tmp;
      x.baseCommit = 'abc';
      x.story = 'As a clerk…';
      x.criteria = [{ given: 'a', when: 'b', then: 'c' }];
    });
    await (new LiveSquad(bp) as unknown as { review(id: string): Promise<void> }).review(t.id);
    expect(calls.at(-1)!.appendSystemPrompt).toContain('For the Review step:\nCheck every query for the tenant filter.');
  });

  it('shows every core prompt read only, filled in from a real ticket', async () => {
    for (const role of ['analyst', 'architect', 'builder', 'reviewer', 'tester'] as const) {
      const core = await corePrompts(bp, role);
      expect(core.prompts.map((p) => p.step)).toEqual(STEPS[role].map((s) => s.id));
      for (const p of core.prompts) expect(p.prompt.length).toBeGreaterThan(40);
    }
    const build = (await corePrompts(bp, 'builder', 'SK-150')).prompts.find((p) => p.step === 'build')!;
    expect(build.prompt).toContain('Case notes autosave');
    expect(build.prompt).toContain('>> step');
  });
});
