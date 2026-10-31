import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/engine/claude.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/engine/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/claude.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listDecisions, readMeta, readTicket, updateTicket, writeDecision, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { architecture } = await import('../src/board/architecture.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Steps = { step(id: string, phase: string): Promise<void> };

const base = { options: ['a', 'b'], approvedBy: 'Momen', date: '2026-10-30T10:00:00.000Z', checkedBy: null };

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-links-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  for (const d of listDecisions(bp)) fs.rmSync(path.join(bp.decisionsDir, `${d.id}.yaml`));
  writeDecision(bp, { ...base, id: 'ADR-001', title: 'One web app', why: 'Simple', chosen: 'Next.js', from: 'Project scan', tickets: [] });
  writeDecision(bp, { ...base, id: 'ADR-002', title: 'Plain CSS', why: 'Built on ADR-001', chosen: 'CSS modules', from: 'Project scan', tickets: [], area: 'Interface' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function designed() {
  const t = actions.createTicket(bp, { title: 'Modern look' });
  return updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.questions = [];
    x.story = 'As an owner, I want a modern look.';
    x.criteria = [{ given: 'a', when: 'b', then: 'c' }];
    x.specApproved = { by: 'Momen', at: '' };
    x.sessions = { intake: 'i1' };
  });
}

describe('decision links', () => {
  it('the design says which decisions it follows and which one it replaces; approving links them', async () => {
    const t0 = designed();
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push({
      decision: {
        title: 'UI components',
        options: [{ name: 'PrimeReact', note: 'Rich', chosen: true }, { name: 'Plain CSS', note: 'As now', chosen: false }],
        why: 'A modern look fast',
        area: 'Interface',
        replaces: 'ADR-002',
      },
      follows: ['ADR-001', 'ADR-999'],
      steps: ['Add the library', 'Restyle', 'Write the tests'],
      tests: 2,
      screens: 1,
    });
    await squad.step(t0.id, 'plan-write');
    expect(calls.at(-1)!.prompt).toContain('follows: the ids of the saved decisions');
    let t = readTicket(bp, t0.id)!;
    expect(t.follows).toEqual(['ADR-001']);
    expect(t.decision?.replaces).toBe('ADR-002');

    t = actions.approve(bp, t.id);
    expect(t.decision?.adr).toBe('ADR-003');
    expect(t.activity[0]!.text).toContain('Decision saved as ADR-003, replacing ADR-002');
    const all = listDecisions(bp);
    const get = (id: string) => all.find((d) => d.id === id)!;
    expect(get('ADR-001').tickets).toEqual([t.id]);
    expect(get('ADR-002').replacedBy).toBe('ADR-003');
    expect(get('ADR-003')).toMatchObject({ area: 'Interface', buildsOn: ['ADR-001'], replaces: 'ADR-002', tickets: [t.id] });

    // A replaced decision is no longer a rule for the next ticket.
    const next = actions.createTicket(bp, { title: 'Booking page' });
    const ctx = P.buildPrompt(readMeta(bp), listDecisions(bp), readTicket(bp, next.id)!);
    const rules = ctx.split('Replaced decisions')[0]!;
    expect(rules).toContain('ADR-003 UI components');
    expect(rules).not.toContain('ADR-002 Plain CSS');
    expect(ctx).toContain('- ADR-002 Plain CSS, replaced by ADR-003');
  });

  it('the architecture view puts each ticket in order with what it made and followed', () => {
    const t0 = designed();
    updateTicket(bp, t0.id, (x) => {
      x.work = { steps: 3, tests: 1, screens: 1 };
      x.follows = ['ADR-001'];
    });
    const a = architecture(bp);
    const t = a.tickets.find((x) => x.id === t0.id)!;
    expect(t).toMatchObject({ state: 'designed', follows: ['ADR-001'] });
    expect(a.tickets.map((x) => Number(x.id.replace(/\D/g, '')))).toEqual([...a.tickets.map((x) => Number(x.id.replace(/\D/g, '')))].sort((x, y) => x - y));
    // An older decision that names another in its why counts as built on it.
    expect(a.decisions.find((d) => d.id === 'ADR-002')!.buildsOn).toEqual(['ADR-001']);
  });
});
