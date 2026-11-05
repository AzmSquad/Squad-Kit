import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Only squad-kit's own plain words reach a person's stop. A raw error ("TypeError: …", "write EPIPE", "status code
 * 529", the AI tool's own output) becomes the plain technical stop, and its exact words go to the engineer details
 * and the app log. The agents here are fakes.
 */

let result: Partial<RunResult> = { ok: true };
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ sessionId: opts.resume ?? opts.sessionId ?? 'r-1', text: '', ...result }) as RunResult,
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { StepError } = await import('../src/board/problem.js');
const { TECHNICAL_STOP, ownRunWords } = await import('../src/engine/plain-stop.js');
const { claudeTool } = await import('../src/modules/claude/index.js');
const { recentLines } = await import('../src/core/app-log.js');

type Squad = { launch(key: string, job: () => Promise<void>): void; running: Set<string>; review(id: string): Promise<void> };

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
beforeEach(() => {
  result = { ok: true };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-plain-stop-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ticket() {
  const t = actions.createTicket(bp, { title: 'Limit bookings' });
  return updateTicket(bp, t.id, (x) => {
    x.squad = { phase: 'review', nextAt: new Date().toISOString() };
    x.stage = 'review';
    x.worktree = tmp;
    x.baseCommit = 'abc';
    x.story = 'As a clerk…';
  });
}

async function stepThatThrows(err: unknown) {
  const t = ticket();
  const s = new LiveSquad(bp) as unknown as Squad;
  s.launch(t.id, async () => {
    throw err;
  });
  await vi.waitFor(() => expect(s.running.has(t.id)).toBe(false), { timeout: 10_000 });
  return readTicket(bp, t.id)!;
}

describe('a stop shows only squad-kit’s own words', () => {
  for (const raw of ["TypeError: Cannot read properties of undefined (reading 'id')", 'write EPIPE', 'Request failed with status code 529', 'The thing broke at /Users/sara/app/x.js']) {
    it(`"${raw}" becomes the plain technical stop, the exact words kept for engineers`, async () => {
      const t = await stepThatThrows(new Error(raw));
      expect(t.stuck?.question).toBe(TECHNICAL_STOP);
      expect(t.stuck?.detail).toContain(raw);
      expect(t.stuck?.options[0]?.do).toBe('retry');
      expect(t.activity.map((a) => a.text).join('\n')).not.toContain(raw);
    });
  }

  it("squad-kit's own plain step message reaches the stop as it is", async () => {
    const t = await stepThatThrows(new StepError('The Reviewer kept asking for things it may not do, so squad-kit stopped it.', 'question: asks the person for a secret'));
    expect(t.stuck?.question).toBe('The Reviewer kept asking for things it may not do, so squad-kit stopped it.');
    expect(t.stuck?.detail).toBe('question: asks the person for a secret');
  });

  it("an agent run that did not finish: the AI tool's raw words become plain; its own plain sentences stay", async () => {
    const t = ticket();
    const s = new LiveSquad(bp) as unknown as Squad;
    result = { ok: false, error: 'Request failed with status code 529', detail: 'at Socket.emit (node:events:518:28)' };
    s.launch(t.id, () => s.review(t.id));
    await vi.waitFor(() => expect(s.running.has(t.id)).toBe(false), { timeout: 10_000 });
    expect(readTicket(bp, t.id)!.stuck?.question).toBe('The Reviewer stopped before it finished, on something technical. Press Try again.');
    expect(readTicket(bp, t.id)!.stuck?.detail).toContain('status code 529');
    expect(recentLines(60_000).join('\n')).toContain('status code 529');

    const t2 = ticket();
    result = { ok: false, error: 'Claude is busy right now. Wait a few minutes, then press Try again.', detail: 'API Error: 529 overloaded' };
    s.launch(t2.id, () => s.review(t2.id));
    await vi.waitFor(() => expect(s.running.has(t2.id)).toBe(false), { timeout: 10_000 });
    expect(readTicket(bp, t2.id)!.stuck?.question).toBe('Claude is busy right now. Wait a few minutes, then press Try again.');
  });

  it('knows its own sentences, and only those', () => {
    expect(ownRunWords('You stopped the squad.')).toBe(true);
    expect(ownRunWords('It took longer than 20 minutes, so squad-kit stopped it.')).toBe(true);
    expect(ownRunWords('Claude Code did not start in 30 seconds. Check that it opens in a terminal and is logged in, then press Try again.')).toBe(true);
    expect(ownRunWords("Claude Code is not logged in. Run `claude` in a terminal, log in, then press Try again.", claudeTool)).toBe(true);
    expect(ownRunWords("Claude Code is not logged in. Run `claude` in a terminal, log in, then press Try again.")).toBe(false);
    for (const raw of ['TypeError: x is not a function', 'write EPIPE', 'Error: spawn claude ENOENT', 'The agent stopped early (end_of_stream).']) expect(ownRunWords(raw, claudeTool), raw).toBe(false);
  });
});
