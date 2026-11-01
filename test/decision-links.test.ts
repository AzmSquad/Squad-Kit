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

const { boardPaths, listDecisions, readMeta, readTicket, updateTicket, writeDecision, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { architecture } = await import('../src/board/architecture.js');
const { codeChanged } = await import('../src/board/store.js');
const { detectStack, decidedIn } = await import('../src/board/stack.js');
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

describe('stack and patterns', () => {
  function code() {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { next: '15.1.0', react: '^19.0.0', '@prisma/client': '^6.2.0' }, devDependencies: { prisma: '^6.2.0', vitest: '^3.0.0', '@playwright/test': '^1.49.0', typescript: '^5' } }),
    );
    fs.mkdirSync(path.join(tmp, 'prisma'));
    fs.writeFileSync(path.join(tmp, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "sqlite"\n  url = env("DB")\n}\n');
  }

  it('reads the technologies from the package files and finds the decision that chose each', () => {
    code();
    const stack = detectStack(tmp, readMeta(bp));
    expect(stack.map((t) => t.name).sort()).toEqual(['Next.js', 'Node.js', 'Playwright', 'Prisma', 'React', 'SQLite', 'TypeScript', 'Vitest']);
    expect(stack.find((t) => t.name === 'Next.js')).toMatchObject({ role: 'Framework', icon: 'nextdotjs', version: '15.1' });
    const next = stack.find((t) => t.name === 'Next.js')!;
    expect(decidedIn(next, listDecisions(bp))).toEqual(['ADR-001']);
    expect(decidedIn(stack.find((t) => t.name === 'React')!, listDecisions(bp))).toEqual([]);
  });

  it('a merge queues one read of the code; the Architect fills in why, patterns and the map', async () => {
    code();
    expect(codeChanged(bp)?.status).toBe('pending');
    writeMeta(bp, { ...readMeta(bp), blueprint: { ...readMeta(bp).blueprint!, status: 'running' } });
    expect(codeChanged(bp)?.status).toBe('running');

    answers.push({
      map: [{ area: 'Pages', detail: 'Next.js app router, in src/app/' }],
      stack: [
        { name: 'React', why: 'Draws the screens.', decision: 'ADR-001' },
        { name: 'Vitest', why: 'Runs the unit tests.', decision: 'ADR-099' },
      ],
      patterns: [{ name: 'One rules file per feature', what: 'Form and server share it.', where: ['src/lib/service-rules.ts'], decision: 'ADR-404' }],
    });
    await (new LiveSquad(bp) as unknown as { readBlueprint(): Promise<void> }).readBlueprint();
    expect(calls[0]!.prompt).toContain('Technologies found in the package files: Node.js, TypeScript, Next.js, React, Prisma, Vitest, Playwright, SQLite.');
    expect(calls[0]!.prompt).toContain('- ADR-001: One web app. Chosen: Next.js');

    const meta = readMeta(bp);
    expect(meta.blueprint?.status).toBe('done');
    expect(meta.map).toEqual([{ area: 'Pages', detail: 'Next.js app router, in src/app/' }]);
    // A made-up decision id never shows on the page.
    expect(meta.blueprint?.patterns[0]).toEqual({ name: 'One rules file per feature', what: 'Form and server share it.', where: ['src/lib/service-rules.ts'] });

    const a = architecture(bp);
    expect(a.stack.find((t) => t.name === 'React')).toMatchObject({ why: 'Draws the screens.', decisions: ['ADR-001'] });
    expect(a.stack.find((t) => t.name === 'Vitest')).toMatchObject({ why: 'Runs the unit tests.', decisions: [] });
    expect(a.reading?.status).toBe('done');
  });

  it('React comes with Next.js; a tool picked while building gets a decision the person approves', async () => {
    code();
    let a = architecture(bp);
    expect(a.stack.find((t) => t.name === 'React')).toMatchObject({ decisions: [], via: { name: 'Next.js', decisions: ['ADR-001'] } });
    expect(a.stack.find((t) => t.name === 'Vitest')?.via).toBeUndefined();

    expect(() => actions.draftTechDecision(bp, 'Angular')).toThrow('not in the code');
    expect(actions.draftTechDecision(bp, 'Vitest').status).toBe('writing');
    answers.push({
      title: 'How we test the rules',
      area: 'Rules',
      options: ['Vitest for the rule and server tests', 'Jest'],
      chosen: 'Vitest for the rule and server tests',
      why: 'Fast and works with the TypeScript setup.',
      buildsOn: ['ADR-001', 'ADR-777'],
    });
    await (new LiveSquad(bp) as unknown as { writeTechDecision(t: string): Promise<void> }).writeTechDecision('Vitest');
    expect(calls[0]!.prompt).toContain('The code already uses Vitest, but no saved decision says why.');
    expect(architecture(bp).stack.find((t) => t.name === 'Vitest')?.draft?.status).toBe('ready');

    const d = actions.approveTechDecision(bp, 'Vitest');
    expect(d).toMatchObject({ id: 'ADR-003', title: 'How we test the rules', from: 'Code review', area: 'Rules', buildsOn: ['ADR-001'] });
    a = architecture(bp);
    expect(a.stack.find((t) => t.name === 'Vitest')).toMatchObject({ decisions: ['ADR-003'] });
    expect(a.stack.find((t) => t.name === 'Vitest')?.draft).toBeUndefined();
  });
});

describe('a new decision and the tickets planned before it', () => {
  type Squad = { checkImpact(adr: string): Promise<void> };
  function planned(title: string, extra: Record<string, unknown> = {}) {
    const t = actions.createTicket(bp, { title });
    return updateTicket(bp, t.id, (x) => {
      x.squad = null;
      x.live = false;
      x.stage = 'implement';
      x.steps = [{ title: 'Build the hours screen with plain HTML', status: 'done' }];
      x.work = { steps: 1, tests: 1, screens: 1 };
      Object.assign(x, extra);
    });
  }

  it('the Architect marks the plans it changes; you update one, keep one, and a merged one gets a follow-up', async () => {
    const hours = planned('Opening hours', { worktree: '/tmp/wt-hours', waiting: { kind: 'stuck', summary: 'Stopped' } });
    const staff = planned('Staff', { mergedAt: '2026-10-31T10:00:00.000Z', stage: 'release' });
    const other = planned('Outbox');
    const follower = planned('Booking page', { follows: ['ADR-002'] });
    writeMeta(bp, { ...readMeta(bp), impactChecks: [{ adr: 'ADR-002', status: 'pending' }] });

    answers.push({
      tickets: [
        { id: hours.id, affected: true, why: 'Its screen uses the old plain look.', change: 'Build the screen with the shared Mawid parts.' },
        { id: staff.id, affected: true, why: 'The staff screen was merged with the old look.', change: 'Restyle the staff screen.' },
        { id: other.id, affected: false, why: 'No screen.', change: '' },
      ],
    });
    await (new LiveSquad(bp) as unknown as Squad).checkImpact('ADR-002');
    expect(calls[0]!.prompt).toContain('ADR-002: Plain CSS');
    expect(calls[0]!.prompt).toContain(`- ${hours.id}: Opening hours (being built)`);
    expect(calls[0]!.prompt).toContain(`- ${staff.id}: Staff (merged into the main branch already)`);
    expect(calls[0]!.prompt).not.toContain(follower.id);
    const check = readMeta(bp).impactChecks![0]!;
    expect(check).toMatchObject({ status: 'done', affected: [hours.id, staff.id] });
    expect(check.checked).toContain(other.id);
    expect(readTicket(bp, other.id)!.outdated).toBeUndefined();
    expect(actions.inbox(bp).map((t) => t.id)).toEqual(expect.arrayContaining([hours.id, staff.id]));

    const updated = actions.updateForDecision(bp, hours.id, 'ADR-002');
    expect(updated).toMatchObject({ stage: 'specs', replanFor: 'ADR-002', changeRequest: 'Follow ADR-002: Build the screen with the shared Mawid parts.', waiting: null });
    expect(updated.squad?.phase).toBe('plan-rewrite');
    expect(updated.outdated).toBeUndefined();

    const follow = actions.updateForDecision(bp, staff.id, 'ADR-002');
    expect(follow.title).toBe('Bring "Staff" in line with ADR-002');
    expect(follow.ask).toContain('Restyle the staff screen.');
    expect(readTicket(bp, staff.id)!.activity[0]!.text).toBe(`Made ${follow.id} to bring it in line with ADR-002`);

    expect(() => actions.keepPlan(bp, other.id, 'ADR-002', 'fine')).toThrow('nothing to update');
  });

  it('an accepted ticket whose pull request could not merge is redone, not followed up', () => {
    const t = planned('Staff', { stage: 'release', release: 'v0.2.0', pr: { id: 6, url: 'u', repo: 'Mawid', host: 'azure' }, worktree: '/tmp/wt-staff', outdated: [{ adr: 'ADR-002', why: 'old look', change: 'Use the shared parts.', at: '' }] });
    const r = actions.updateForDecision(bp, t.id, 'ADR-002');
    expect(r).toMatchObject({ stage: 'specs', replanFor: 'ADR-002' });
    expect(r.pr).toBeUndefined();
    expect(r.release).toBeUndefined();
  });

  it('keeping a plan needs a reason, and approving a design queues the check', () => {
    const t = planned('Hours', { outdated: [{ adr: 'ADR-001', why: 'x', change: 'y', at: '' }] });
    expect(() => actions.keepPlan(bp, t.id, 'ADR-001', ' ')).toThrow('why the plan stays');
    expect(actions.keepPlan(bp, t.id, 'ADR-001', 'Admin screen, the look does not matter').activity[0]!.text).toBe(
      'Kept the plan with ADR-001: Admin screen, the look does not matter',
    );
    expect(actions.checkTicketsAgainst(bp, 'ADR-001')).toEqual({ adr: 'ADR-001', status: 'pending' });
    expect(() => actions.checkTicketsAgainst(bp, 'ADR-404')).toThrow('not a saved decision');
  });
});

