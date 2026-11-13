import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * In the live squad: the Analyst proposes a kind and a reason for each "done when", squad-kit locks what someone sees,
 * the Express plan does the same, the Reviewer is asked what it checked for a Not on a screen line, and a rewrite of
 * the spec keeps the kinds the person left. The agents are fakes.
 */

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
const { NO_APP_WHY, SEES_WHY } = await import('../src/board/proof-lock.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Steps = { step(id: string, phase: string): Promise<void> };

const SPEC = {
  story: 'As a customer, I want to pay by card, so my booking is kept.',
  criteria: [
    { given: 'I confirm a booking', when: 'I pay by card', then: 'I see Paid and my receipt number', proof: { kind: 'api', why: 'The answer is the proof.' } },
    { given: 'the payment goes through', when: 'it is saved', then: 'the booking is saved as paid, with its amount', proof: { kind: 'data', why: 'Nothing new on a screen: the bookings table shows it.' } },
    { given: 'a card', when: 'it is used', then: 'card numbers are never saved', proof: { kind: 'none', why: 'Nothing to show. The Reviewer checks the code.' } },
  ],
  releaseNote: '**Pay by card.**',
};

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-kinds-spec-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', commands: { start: 'npm run dev', url: 'http://localhost:3000', test: 'npm test' } });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function answered(track?: 'express') {
  const t = actions.createTicket(bp, { title: 'Pay by card when booking', ...(track ? { track } : {}) });
  return updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.questions = [];
    x.activity = [{ at: '', who: 'analyst', text: 'Asked 0 questions' }, ...x.activity];
    x.sessions = { intake: 'i1' };
  });
}

describe('the proof kinds in the spec', () => {
  it("takes the Analyst's kinds, locks what someone sees, and a rewrite keeps the person's choices", async () => {
    const t0 = answered();
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push(SPEC);
    await squad.step(t0.id, 'plan-write');
    expect(calls.at(-1)!.prompt).toContain('- proof, for each "done when"');
    const items = (P.SPEC_SCHEMA.properties.criteria as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(items.proof).toBeDefined();
    let t = readTicket(bp, t0.id)!;
    expect(t.criteria!.map((c) => c.proof)).toEqual([
      { kind: 'screen', why: SEES_WHY, locked: true },
      { kind: 'data', why: 'Nothing new on a screen: the bookings table shows it.' },
      { kind: 'none', why: 'Nothing to show. The Reviewer checks the code.' },
    ]);
    // The person asks for a change: the Analyst is told the kinds as they are now.
    t = actions.requestChange(bp, t.id, 'Say the amount in riyals');
    answers.push(SPEC);
    await squad.step(t.id, t.squad!.phase);
    expect(calls.at(-1)!.prompt).toContain('How each "done when" is proved now, as the person left it');
    expect(calls.at(-1)!.prompt).toContain('1. Screen (squad-kit keeps this one)');
  });

  it('a command-line project: no lock, and every line is a test or nothing to show', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'npm test', build: 'npm run build' } });
    const t0 = answered();
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push(SPEC);
    await squad.step(t0.id, 'plan-write');
    expect(calls.at(-1)!.prompt).toContain('This project has no\n  app to start (a command-line tool or a library)');
    expect(readTicket(bp, t0.id)!.criteria!.map((c) => c.proof)).toEqual([
      { kind: 'test', why: NO_APP_WHY },
      { kind: 'test', why: NO_APP_WHY },
      { kind: 'none', why: 'Nothing to show. The Reviewer checks the code.' },
    ]);
  });

  it('the Express plan proposes the kinds too', async () => {
    const t0 = answered('express');
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push({ ...SPEC, steps: ['Add payments', 'Write the tests'], tests: 2, screens: 1 });
    await squad.step(t0.id, 'plan-write');
    expect(calls.at(-1)!.prompt).toContain('- proof, for each "done when"');
    expect(readTicket(bp, t0.id)!.criteria![1]!.proof?.kind).toBe('data');
  });

  it('asks the Reviewer what it checked for each Not on a screen line', () => {
    const t = answered();
    const x = updateTicket(bp, t.id, (y) => {
      y.story = SPEC.story;
      y.criteria = SPEC.criteria.map(({ proof, ...c }) => ({ ...c, proof: proof as { kind: 'api' } }));
      y.baseCommit = 'abc';
    });
    const prompt = P.reviewPrompt(readMeta(bp), [], x, 1);
    expect(prompt).toContain('say in noneChecks');
    expect(prompt).toContain('3. Card numbers are never saved Reason: Nothing to show. The Reviewer checks the code.');
    expect(Object.keys(P.REVIEW_SCHEMA.properties)).toContain('noneChecks');
    // An old spec: no word about it.
    const old = updateTicket(bp, t.id, (y) => (y.criteria = SPEC.criteria.map(({ proof: _p, ...c }) => c)));
    expect(P.reviewPrompt(readMeta(bp), [], old, 1)).not.toContain('noneChecks');
  });
});
