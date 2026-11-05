import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-asks-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function inReview() {
  const t = actions.createTicket(bp, { title: 'Limit bookings' });
  return updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.worktree = tmp;
    x.baseCommit = 'abc';
    x.story = 'As a clerk…';
    x.criteria = [{ given: 'a person', when: 'they book a 4th time', then: 'they see an error' }];
  });
}

describe('an agent asks you in the middle of its work', () => {
  it('the Builder and Reviewer are told when to ask, and can answer with a question', () => {
    const t = inReview();
    const meta = readMeta(bp);
    expect(P.buildPrompt(meta, [], t)).toContain('fill "question"');
    expect(P.reviewPrompt(meta, [], t, 1)).toContain('fill "question"');
    expect(Object.keys(P.BUILD_SCHEMA.properties)).toContain('question');
    expect(Object.keys(P.REVIEW_SCHEMA.properties)).toContain('question');
  });

  it('the Reviewer pauses the ticket, and your answer goes back into the same session', async () => {
    const t = inReview();
    const squad = new LiveSquad(bp) as unknown as { review(id: string, answered?: boolean): Promise<void> };
    answers.push({ approved: false, summary: '', comments: [], question: { text: 'Should cancelled bookings count?', options: ['Yes', 'No'], why: 'It changes the limit', kind: 'gap' } });
    await expect(squad.review(t.id)).rejects.toThrow(/Waiting for your answer/);
    let saved = readTicket(bp, t.id)!;
    expect(saved.waiting?.kind).toBe('ask');
    expect(saved.agentQuestion).toMatchObject({ from: 'reviewer', text: 'Should cancelled bookings count?', options: ['Yes', 'No'] });
    expect(saved.live).toBe(false);
    const session = saved.sessions!.review!;

    saved = actions.answerAgent(bp, t.id, 'No');
    expect(saved.squad?.phase).toBe('answered-reviewer');
    expect(saved.waiting).toBeNull();

    answers.push({ approved: true, summary: 'Looks good', comments: [] });
    await squad.review(t.id, true);
    const last = calls.at(-1)!;
    expect(last.resume).toBe(session);
    expect(last.prompt).toContain('The person answered: "No"');
    saved = readTicket(bp, t.id)!;
    expect(saved.reviewRound).toBe(1);
    expect(saved.agentQuestion).toBeUndefined();
    expect(saved.squad?.phase).toBe('proof');
  });

  it('needs an answer, and only when a question waits', () => {
    const t = inReview();
    expect(() => actions.answerAgent(bp, t.id, 'Yes')).toThrow(/no question waiting/);
    updateTicket(bp, t.id, (x) => {
      x.waiting = { kind: 'ask', summary: '' };
      x.agentQuestion = { from: 'builder', text: 'Which table?', options: [], at: '' };
    });
    expect(() => actions.answerAgent(bp, t.id, ' ')).toThrow(/Write your answer/);
    expect(actions.answerAgent(bp, t.id, actions.DECIDE_YOURSELF).squad?.phase).toBe('answered-builder');
  });
});
