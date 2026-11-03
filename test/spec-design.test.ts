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
type Steps = { step(id: string, phase: string): Promise<void> };

const SPEC = {
  story: 'As a clerk, I want a daily limit, so one person cannot take every slot.',
  criteria: [{ given: 'a person with 3 bookings today', when: 'they book again', then: 'they see an error' }],
  releaseNote: '**Daily limit.** At most 3 bookings a day.',
};
const DESIGN = {
  decision: { title: 'Count bookings in the database', options: [{ name: 'Query', note: 'Simple', chosen: true }, { name: 'Cache', note: 'Fast', chosen: false }], why: 'Few bookings a day', area: 'Data' },
  steps: ['Add the count query', 'Check it before saving', 'Write the tests'],
  tests: 3,
  screens: 1,
};

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-spec-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function answered(track?: 'express') {
  const t = actions.createTicket(bp, { title: 'Limit bookings', ...(track ? { track } : {}) });
  return updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.questions = [];
    x.activity = [{ at: '', who: 'analyst', text: 'Asked 0 questions' }, ...x.activity];
    x.sessions = { intake: 'i1' };
  });
}

describe('spec and design as two steps', () => {
  it('the Analyst writes the spec, you approve it, then the Architect designs from it', async () => {
    const t0 = answered();
    const squad = new LiveSquad(bp) as unknown as Steps;

    answers.push(SPEC);
    await squad.step(t0.id, 'plan-write');
    let call = calls.at(-1)!;
    expect(call.prompt).toContain('Now write the spec, as the Analyst');
    expect(call.schema).toBe(P.SPEC_SCHEMA);
    expect(call.resume).toBe('i1');
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting?.kind).toBe('spec');
    expect(t.story).toBe(SPEC.story);
    expect(t.decision).toBeUndefined();
    expect(t.steps).toBeUndefined();

    // A change to the spec goes back to the Analyst, not the Architect.
    t = actions.requestChange(bp, t.id, 'Managers have no limit');
    expect(t.squad?.phase).toBe('spec-rewrite');
    answers.push({ ...SPEC, story: 'As a clerk… managers have no limit.' });
    await squad.step(t.id, 'spec-rewrite');
    expect(calls.at(-1)!.prompt).toContain('asked for this change: "Managers have no limit"');
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('spec');

    t = actions.approve(bp, t.id);
    expect(t.specApproved?.by).toBe('Momen');
    expect(t.squad?.phase).toBe('plan-write');
    expect(t.activity[0]!.text).toBe('Approved the spec');

    answers.push(DESIGN);
    await squad.step(t.id, 'plan-write');
    call = calls.at(-1)!;
    expect(call.schema).toBe(P.DESIGN_SCHEMA);
    expect(call.prompt).toContain('Approved spec (do not change it)');
    expect(call.prompt).toContain('managers have no limit');
    t = readTicket(bp, t.id)!;
    expect(t.waiting).toMatchObject({ kind: 'plan', summary: 'The design is ready: is this how to build it?' });
    expect(t.story).toBe('As a clerk… managers have no limit.');
    expect(t.releaseNote).toBe(SPEC.releaseNote);
    expect(t.steps?.map((s) => s.title)).toEqual(DESIGN.steps);

    t = actions.requestChange(bp, t.id, 'Use the cache');
    expect(t.status).toBe('Architect is updating the design');
    expect(t.squad?.phase).toBe('plan-rewrite');
  });

  it('the design schema has no story or criteria, so the approved spec cannot change', () => {
    expect(Object.keys(P.DESIGN_SCHEMA.properties)).not.toContain('story');
    expect(Object.keys(P.DESIGN_SCHEMA.properties)).not.toContain('criteria');
    expect(Object.keys(P.SPEC_SCHEMA.properties)).toEqual(['story', 'criteria', 'releaseNote']);
  });

  it('the Express track keeps one plan with both parts', async () => {
    const t0 = answered('express');
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push({ ...SPEC, ...DESIGN });
    await squad.step(t0.id, 'plan-write');
    expect(calls.at(-1)!.schema).toBe(P.PLAN_SCHEMA);
    expect(readTicket(bp, t0.id)!.squad?.phase).toBe('express-approve');
  });
});
