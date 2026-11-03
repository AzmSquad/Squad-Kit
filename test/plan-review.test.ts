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
const { parsePart } = await import('../src/commands/board.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Steps = { step(id: string, phase: string): Promise<void> };

const SPEC = {
  story: 'As a clerk, I want a daily limit, so one person cannot take every slot.',
  criteria: [
    { given: 'a person with 3 bookings today', when: 'they book again', then: 'they see an error' },
    { given: 'a manager', when: 'they book', then: 'there is no limit' },
  ],
  releaseNote: '**Daily limit.**',
};
const DESIGN = { steps: ['Add the count query', 'Check it before saving', 'Write the tests'], tests: 3, screens: 0, decision: { title: 'Count in the database', options: [{ name: 'Query', note: '', chosen: true }, { name: 'Cache', note: '', chosen: false }], why: 'Simple', area: 'Data' } };

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-review-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function specWaiting() {
  const t = actions.createTicket(bp, { title: 'Limit bookings' });
  updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.questions = [];
    x.activity = [{ at: '', who: 'analyst', text: 'Asked 0 questions' }, ...x.activity];
    x.sessions = { intake: 'i1' };
  });
  answers.push(SPEC);
  await (new LiveSquad(bp) as unknown as Steps).step(t.id, 'plan-write');
  return readTicket(bp, t.id)!;
}

describe('review a plan like a document', () => {
  it('comments on parts go back at once, your own edits survive the rewrite, and the change shows', async () => {
    const t0 = await specWaiting();
    let t = actions.editPlan(bp, t0.id, { part: 'story', text: 'As a clerk, I want at most 3 bookings a day per person.' });
    expect(t.story).toBe('As a clerk, I want at most 3 bookings a day per person.');
    expect(() => actions.editPlan(bp, t0.id, { part: 'step', index: 0, text: 'x' })).toThrow(/cannot be edited now/);
    expect(() => actions.sendBack(bp, t0.id, [])).toThrow(/at least one comment/);

    t = actions.sendBack(bp, t0.id, [
      { part: 'criterion', index: 1, text: 'Managers have a limit of 10' },
      { part: 'story', text: 'Say who sets the limit' },
    ]);
    expect(t.squad?.phase).toBe('spec-rewrite');
    expect(t.planReview?.before?.criteria?.[1]?.then).toBe('there is no limit');
    expect(t.changeRequest).toContain('- On done when 2 ("Given a manager, when they book, then there is no limit."): Managers have a limit of 10');
    expect(t.changeRequest).toContain('Keep their wording exactly:\n- the story: "As a clerk, I want at most 3 bookings a day per person."');

    answers.push({ ...SPEC, criteria: [SPEC.criteria[0], { given: 'a manager', when: 'they book an 11th time', then: 'they see an error' }] });
    await (new LiveSquad(bp) as unknown as Steps).step(t.id, 'spec-rewrite');
    expect(calls.at(-1)!.prompt).toContain('The person read your spec.\nThe person reviewed it and left these comments:');
    t = readTicket(bp, t.id)!;
    expect(t.waiting?.kind).toBe('spec');
    expect(t.story).toBe('As a clerk, I want at most 3 bookings a day per person.');
    expect(t.criteria?.[1]?.when).toBe('they book an 11th time');
    expect(t.activity.find((a) => a.who === 'analyst')!.text).toBe('Updated the spec: with your 2 comments');

    t = actions.approve(bp, t.id);
    expect(t.planReview).toBeUndefined();
  });

  it('the design: steps can be edited, the approved spec cannot, and Start over writes it again from zero', async () => {
    const t0 = await specWaiting();
    actions.approve(bp, t0.id);
    answers.push(DESIGN);
    await (new LiveSquad(bp) as unknown as Steps).step(t0.id, 'plan-write');
    let t = actions.editPlan(bp, t0.id, { part: 'step', index: 1, text: 'Check the limit before saving, in one place' });
    expect(t.steps?.[1]?.title).toBe('Check the limit before saving, in one place');
    expect(() => actions.editPlan(bp, t0.id, { part: 'story', text: 'x' })).toThrow(/cannot be edited now/);

    t = actions.startOver(bp, t0.id, 'Use the booking service instead of the database');
    expect(t.squad?.phase).toBe('plan-rewrite');
    expect(t.status).toBe('Architect is writing a new design');
    expect(t.story).toBe(SPEC.story);
    expect(t.decision).toBeUndefined();
    expect(t.steps).toBeUndefined();
    expect(t.planReview).toBeUndefined();
    answers.push(DESIGN);
    await (new LiveSquad(bp) as unknown as Steps).step(t.id, 'plan-rewrite');
    expect(calls.at(-1)!.prompt).toContain("Start over from zero. Drop your earlier version completely; the person's new direction is:\nUse the booking service");
    expect(readTicket(bp, t.id)!.activity[0]!.text).toBe('Updated the design: started over with your new direction');
  });

  it('the terminal reads parts the way people write them', () => {
    expect(parsePart('story')).toEqual({ part: 'story' });
    expect(parsePart('Step 2')).toEqual({ part: 'step', index: 1 });
    expect(parsePart('done when 1')).toEqual({ part: 'criterion', index: 0 });
    expect(parsePart('the plan')).toBeNull();
  });
});
