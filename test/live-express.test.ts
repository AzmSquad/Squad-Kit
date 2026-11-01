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
    const structured = {
      story: 'As a clerk, I want the right word, so the page reads well.',
      criteria: [{ given: 'the login page', when: 'it opens', then: 'it says Sign in' }],
      steps: ['Fix the word', 'Add a test'],
      tests: 1,
      screens: 0,
      releaseNote: '**Typo.** Fixed.',
    };
    return { ok: true, structured, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-live-express-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the live squad on the Express track', () => {
  it('asks no questions, writes the plan, and approves it on its own', async () => {
    const t = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    const squad = new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> };
    await squad.step(t.id, 'analyst-read');
    expect(calls).toHaveLength(0);
    expect(readTicket(bp, t.id)!.squad?.phase).toBe('plan-write');

    await squad.step(t.id, 'plan-write');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('Express track');
    expect(readTicket(bp, t.id)!.squad?.phase).toBe('express-approve');

    await squad.step(t.id, 'express-approve');
    const after = readTicket(bp, t.id)!;
    expect(after.waiting).toBeNull();
    expect(after.stage).toBe('implement');
    expect(after.squad?.phase).toBe('build');
  });
});
