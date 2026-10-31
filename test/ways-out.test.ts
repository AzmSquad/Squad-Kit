import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/engine/claude.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
/** What the fake Builder does to the files before it answers. */
let builderWork: ((cwd: string) => void) | null = null;
vi.mock('../src/engine/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/claude.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    if (opts.permissionMode === 'acceptEdits' && builderWork && opts.cwd) builderWork(opts.cwd);
    return { ok: true, structured: answers.shift() ?? { summary: 'done' }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { prDescription } = await import('../src/engine/sync.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  builderWork = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ways-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('every stop has a way out', () => {
  beforeEach(() => {
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
  });

  it('a failed check offers try again, fix it yourself, continue anyway and the plan', () => {
    expect(actions.wayOptions({ gate: 'checks', copy: true }).map((o) => o.do)).toEqual(['retry', 'yourself', 'continue', 'plan']);
    expect(actions.wayOptions({ gate: 'merge', base: 'main', copy: true }).map((o) => o.do)).toEqual(['retry', 'yourself', 'plan']);
    expect(actions.wayOptions({}).map((o) => o.do)).toEqual(['retry', 'plan']);
    expect(actions.wayOptions({ publish: true }).map((o) => o.do)).toEqual(['retry', 'skip-pr']);
  });

  it('only you can continue past a failed check, with a reason that goes on the record', () => {
    expect(readTicket(bp, 'SK-150')!.stuck?.gate).toBe('checks');
    expect(() => actions.decideStuck(bp, 'SK-150', 2, { reason: '  ' })).toThrow(/Write why/);
    const t = actions.decideStuck(bp, 'SK-150', 2, { reason: 'The failing test is broken on main too' });
    expect(t.overrides).toMatchObject([{ gate: 'checks', reason: 'The failing test is broken on main too', by: 'Momen' }]);
    expect(t.gates?.checks).toBe('skipped');
    expect(t.activity[0]!.text).toBe('Decided: Continue anyway. Why: The failing test is broken on main too');

    const pr = prDescription({ ...t, gates: { checks: 'skipped', review: 'pass', proof: 'pass' } }, null, []);
    expect(pr).toContain('Tests, lint and build: failed, continued anyway');
    expect(pr).toContain('### Continued anyway\n- **Failed checks**, by Momen: The failing test is broken on main too');

    const release = actions.ensureDraftRelease(bp, 'minor');
    const notes = actions.composeNotes(bp, { ...release, tickets: ['SK-150'] });
    expect(notes).toContain('### Continued anyway');
    expect(notes).toContain('SK-150 Case notes autosave: went out with failing checks. Momen: The failing test is broken on main too');
  });

  it('try again can carry a note that every agent reads', () => {
    const t = actions.decideStuck(bp, 'SK-150', 0, { note: 'The test server needs the VPN; it is on now' });
    expect(t.notes?.at(-1)).toMatchObject({ kind: 'note', text: 'The test server needs the VPN; it is on now' });
    expect(t.waiting).toBeNull();
  });
});

describe('the live squad never waves a review through', () => {
  beforeEach(() => {
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  });

  it('after the last round it stops and asks you, and "fix the notes" gives two more rounds', async () => {
    const t0 = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t0.id, (x) => {
      x.squad = null;
      x.worktree = tmp;
      x.baseCommit = 'abc';
      x.reviewRound = 1;
      x.sessions = { review: 'r1', build: 'b1' };
      x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
    });
    const squad = new LiveSquad(bp) as unknown as { review(id: string): Promise<void>; reviewFix(id: string): Promise<void> };
    answers.push({ approved: false, summary: '', comments: ['Count cancelled bookings too.'] });
    await squad.review(t0.id);
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.gate).toBe('review');
    expect(t.gates?.review).toBe('fail');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'yourself', 'continue', 'plan']);

    t = actions.decideStuck(bp, t.id, 0);
    expect(t.squad?.phase).toBe('review-fix');
    expect(t.reviewRound).toBe(0);
    await squad.reviewFix(t.id);
    expect(calls.at(-1)!.prompt).toContain('Count cancelled bookings too.');
    expect(calls.at(-1)!.resume).toBe('b1');
    expect(readTicket(bp, t.id)!.squad?.phase).toBe('test');
  });

  it('fix it yourself runs the checks, review and proof again', () => {
    const t0 = actions.createTicket(bp, { title: 'Fix by hand' });
    updateTicket(bp, t0.id, (x) => {
      x.squad = null;
      x.worktree = tmp;
      x.waiting = { kind: 'stuck', summary: '' };
      x.stuck = { gate: 'checks', question: 'Lint fails', options: actions.wayOptions({ gate: 'checks', copy: true }) };
    });
    const t = actions.decideStuck(bp, t0.id, 1);
    expect(t.squad?.phase).toBe('test');
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
    expect(t.activity[0]!.text).toBe("Fixed it myself in the ticket's copy");
  });
});

describe('a branch that clashes with main is not a dead end', () => {
  let project: string;

  beforeEach(() => {
    project = path.join(tmp, 'app');
    fs.mkdirSync(project);
    sh('git init -q -b main', project);
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
    commit(project, 'start');
    bp = boardPaths(path.join(project, '.squad'));
    writeMeta(bp, {
      project: 'App',
      key: 'AP',
      nextNumber: 2,
      engine: 'live',
      runner: 'direct',
      user: { name: 'Momen', role: 'Project manager' },
      roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
      tools: [],
      speed: 1,
      map: [],
      lessons: [],
      commands: {},
      git: { base: 'main', remote: 'origin' },
      scan: { status: 'done', empty: false },
    });
  });

  it('Looks right gives a card, and the Builder settles the clash in the copy', async () => {
    const wt = addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
    // Someone else changed the same line on main meanwhile.
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 4\n');
    commit(project, 'other change');
    writeTicket(bp, {
      id: 'AP-1',
      title: 'Raise the limit',
      ask: 'Allow 3 bookings',
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'review',
      status: 'Proof ready to check',
      waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
      createdAt: new Date().toISOString(),
      createdBy: 'Momen',
      activity: [],
      worktree: wt.dir,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      sessions: { build: 'b1' },
      gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    });

    let t = actions.approve(bp, 'AP-1');
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.gate).toBe('merge');
    expect(t.stuck?.question).toContain('cannot go into main');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'yourself', 'plan']);
    expect(t.release).toBeUndefined();
    expect(sh('git log --format=%s -1 main', project)).toBe('other change');

    t = actions.decideStuck(bp, 'AP-1', 0);
    expect(t.squad?.phase).toBe('update-base');
    builderWork = (cwd) => fs.writeFileSync(path.join(cwd, 'limit.txt'), 'limit = 4\n');
    const squad = new LiveSquad(bp) as unknown as { updateBase(id: string): Promise<void> };
    await squad.updateBase('AP-1');
    expect(calls.at(-1)!.prompt).toContain('- limit.txt');
    t = readTicket(bp, 'AP-1')!;
    expect(t.squad?.phase).toBe('test');
    expect(t.baseCommit).toBe(sh('git rev-parse main', project));
    expect(t.activity.map((a) => a.text)).toContain('Brought the latest main into this ticket. Clashes in limit.txt');

    // After the checks, review and proof, Looks right merges cleanly.
    updateTicket(bp, 'AP-1', (x) => {
      x.squad = null;
      x.stage = 'review';
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.waiting = { kind: 'proof', summary: '' };
    });
    t = actions.approve(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1 main', project)).toBe('Merge Raise the limit (AP-1)');
  });
});
