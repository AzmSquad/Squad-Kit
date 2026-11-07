import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { MergeState, RepoHost } from '../src/modules/code-host/types.js';

/**
 * A merge that clashes on a track where the squad merges by itself (RO-8). While the base keeps moving, squad-kit brings
 * it in again by itself, 3 times in all, counted on the ticket; only then does the person get a stop, in one plain
 * sentence. A base that did not move stops at once. A story that is landing goes first. Fake agents and a fake code host,
 * real git.
 */

const calls: RunOptions[] = [];
/** What the fake Builder does to the files before it answers. */
let builderWork: ((cwd: string) => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    if (opts.permissionMode === 'acceptEdits' && builderWork && opts.cwd) builderWork(opts.cwd);
    return { ok: true, structured: { summary: 'done' }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

/** Set for the tests of a pull request: what the code host says after a merge it refused. */
const h = vi.hoisted(() => ({ host: null as unknown }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => h.host,
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const { withProblem } = await import('../src/board/problem.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

type Squad = { step(id: string, phase: string): Promise<void> };
const squad = () => new LiveSquad(bp) as unknown as Squad;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);
const ticket = (id: string) => readTicket(bp, id)!;
const texts = (id: string) => ticket(id).activity.map((a) => a.text);
const fixes = () => calls.filter((c) => c.prompt.includes('these files have clash markers'));

const SAVED = 'The change is saved, but it cannot go into main yet: newer work changed the same lines.';
const tryLine = (n: number) => `It clashes with newer changes, so squad-kit brings in the newest code and runs the checks, the review and the proof again (try ${n} of 3)`;
const STORY = { id: 'BR-1', item: 'S-14', story: 'As a clerk, I want a limit.', criteria: [{ given: 'a room', when: 'I book it', then: 'the limit holds' }], approvedBy: 'Momen' };

/** A story built in its own copy, past the checks, the review and the proof. Builds by itself unless `full`. */
function built(full = false, remote?: string): string {
  const t = full ? actions.createTicket(bp, { title: 'Set the limit' }) : actions.createTicket(bp, { title: 'Set the limit', fromBreakdown: STORY });
  const wt = addWorktree(project, t.id, 'main', remote);
  fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
  updateTicket(bp, t.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.squad = null;
    x.live = false;
    x.sessions = { intake: 'i-1', build: 'b-1', review: 'r-1' };
    x.steps = [{ title: 'Set the limit', status: 'done' }];
    x.work = { steps: 1, tests: 1, screens: 0 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
  });
  return t.id;
}

/** Someone else's story merged: main has a new value on the same line. */
let moves = 10;
function mainMoves(): void {
  moves += 1;
  fs.writeFileSync(path.join(project, 'limit.txt'), `limit = ${moves}\n`);
  commit(project, `other change ${moves}`);
}

/** The Builder settles the clash and the checks, the review and the proof pass again, as the live squad runs them. */
async function settled(id: string, value: string, squadNow: Squad = squad()): Promise<void> {
  builderWork = (cwd) => fs.writeFileSync(path.join(cwd, 'limit.txt'), `limit = ${value}\n`);
  await squadNow.step(id, 'update-base');
  expect(ticket(id).squad?.phase).toBe('test');
  updateTicket(bp, id, (x) => {
    x.squad = null;
    x.stage = 'review';
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
  });
}

beforeEach(() => {
  calls.length = 0;
  builderWork = null;
  h.host = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-clash-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  commit(project, 'start');
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
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
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('a merge that clashes while main keeps moving', () => {
  it('brings main in again by itself, and the next merge goes in', async () => {
    const id = built();
    mainMoves();
    let t = auto.acceptByItself(bp, id);
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(1);
    expect(texts(id)[0]).toBe(tryLine(1));
    await settled(id, 'a');

    // RO-13 merged meanwhile, on the same line: RO-8's story, and no stop for the person.
    mainMoves();
    t = auto.acceptByItself(bp, id);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(2);
    expect(texts(id)[0]).toBe(tryLine(2));
    await settled(id, 'b');

    t = auto.acceptByItself(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.waiting).toBeNull();
    expect(sh('git show main:limit.txt', project)).toBe('limit = b');
    expect(fixes()).toHaveLength(2);
  });

  it('after 3 times in all it is a plain stop, with its ways out', async () => {
    const id = built();
    for (const [n, value] of ['a', 'b', 'c'].entries()) {
      mainMoves();
      const t = auto.acceptByItself(bp, id);
      expect(t.squad?.phase).toBe('update-base');
      expect(texts(id)[0]).toBe(tryLine(n + 1));
      await settled(id, value);
    }
    mainMoves();
    const before = sh('git rev-parse main', project);
    const t = auto.acceptByItself(bp, id);
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'Clashes with main and needs one decision' });
    expect(t.stuck).toMatchObject({ gate: 'merge', question: SAVED });
    expect(t.squad ?? null).toBeNull();
    expect(t.retryPhase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(3);
    expect(texts(id)[0]).toBe('It still clashes after the newest code came in 3 times, so it waits for you');
    expect(sh('git rev-parse main', project)).toBe(before);
    expect(fixes()).toHaveLength(3);
    expect(t.stuck!.options[0]).toMatchObject({ do: 'retry', name: 'Let the Builder bring in the newest code' });
  });

  it('when main has not moved since it came in, a second clash stops at once', async () => {
    const id = built();
    mainMoves();
    auto.acceptByItself(bp, id);
    // As if it came in and its merge did not stay: this main is the one it took in last, and the branch still clashes.
    updateTicket(bp, id, (x) => {
      x.baseCommit = sh('git rev-parse main', project);
      x.squad = null;
      x.stage = 'review';
    });
    const t = auto.acceptByItself(bp, id);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.question).toBe(SAVED);
    expect(t.selfAccept?.baseTries).toBe(1);
    expect(texts(id)[0]).toBe('It still clashes, and the code has not moved since it last came in, so it waits for you');
    expect(fixes()).toHaveLength(0);
  });

  it('the count survives a restart, and a ticket from before the count has had one try', async () => {
    const id = built();
    mainMoves();
    auto.acceptByItself(bp, id);
    await settled(id, 'a');
    mainMoves();
    auto.acceptByItself(bp, id);
    // The app restarts: a new board and a new squad, with only what is on the ticket's files.
    bp = boardPaths(path.join(project, '.squad'));
    expect(ticket(id).selfAccept?.baseTries).toBe(2);
    await settled(id, 'b', new LiveSquad(bp) as unknown as Squad);
    mainMoves();
    let t = auto.acceptByItself(bp, id);
    expect(texts(id)[0]).toBe(tryLine(3));
    bp = boardPaths(path.join(project, '.squad'));
    await settled(id, 'c', new LiveSquad(bp) as unknown as Squad);
    mainMoves();
    t = auto.acceptByItself(bp, id);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.selfAccept?.baseTries).toBe(3);

    const old = built();
    updateTicket(bp, old, (x) => {
      x.selfAccept = { baseTried: '2026-11-04T10:00:00.000Z' };
      x.baseCommit = sh('git rev-parse main~1', project);
    });
    mainMoves();
    expect(auto.acceptByItself(bp, old).selfAccept?.baseTries).toBe(2);
    expect(texts(old)[0]).toBe(tryLine(2));
  });

  it('pressing the way out at the stop starts the count again, with that try first', async () => {
    const id = built();
    mainMoves();
    auto.acceptByItself(bp, id);
    updateTicket(bp, id, (x) => {
      x.selfAccept = { baseTried: '2026-11-04T10:00:00.000Z', baseTries: 3 };
      x.squad = null;
      x.stage = 'review';
    });
    mainMoves();
    const stop = auto.acceptByItself(bp, id);
    expect(stop.waiting?.kind).toBe('stuck');
    const t = actions.decideStuck(bp, id, 0, {});
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(1);
    await settled(id, 'a');
    mainMoves();
    expect(auto.acceptByItself(bp, id).squad?.phase).toBe('update-base');
    expect(texts(id)[0]).toBe(tryLine(2));
  });

  it('a track where the person accepts keeps the card at the first clash', () => {
    const id = built(true);
    mainMoves();
    const t = actions.acceptProof(bp, ticket(id));
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.question).toBe(SAVED);
    expect(t.selfAccept).toBeUndefined();
    auto.bringInAgain(bp, id);
    expect(ticket(id).waiting?.kind).toBe('stuck');
    expect(fixes()).toHaveLength(0);
  });
});

describe('the words', () => {
  it('one clean sentence for the person, with git in the activity and the engineer details only', () => {
    const id = built(true);
    mainMoves();
    const t = actions.acceptProof(bp, ticket(id));
    const branch = t.branch!;
    expect(t.stuck?.question).toBe(SAVED);
    expect(t.stuck?.question).not.toContain(branch);
    expect(t.stuck?.question).not.toContain('already in');
    expect(t.stuck?.detail).toBe(`${branch} clashes with changes already in main.`);
    expect(texts(id)).toContain(`Could not merge into main: ${branch} clashes with changes already in main.`);
    expect(withProblem(t).stuck!.title).toBeTruthy();
    expect(t.stuck!.options[0]!.note).toBe('It brings the newer work into this ticket and fixes the clash. Then the checks run again.');
    expect(t.waiting?.summary).toBe('Clashes with main and needs one decision');
  });

  it('a pull request and a merge tried again say the same, in one sentence', () => {
    const id = built(true);
    updateTicket(bp, id, (x) => {
      x.stage = 'release';
      x.pr = { id: 7, url: 'https://code.example.test/pr/7', repo: 'app', host: 'example' };
    });
    expect(actions.pullRequestClashed(bp, id).stuck?.question).toBe('Pull request 7 cannot go into main yet: newer work changed the same lines.');
    updateTicket(bp, id, (x) => {
      x.stage = 'release';
      delete x.pr;
    });
    expect(actions.pullRequestClashed(bp, id).stuck?.question).toBe('The change cannot go into main yet: newer work changed the same lines.');
  });
});

describe('a story that is landing goes first', () => {
  /** Another story at its merge step. */
  function landing(phase = 'accept'): string {
    const other = actions.createTicket(bp, { title: 'Another story', fromBreakdown: { ...STORY, item: 'S-15' } });
    updateTicket(bp, other.id, (x) => {
      x.stage = 'review';
      x.live = true;
      x.status = auto.ACCEPTING;
      x.squad = { phase, nextAt: new Date().toISOString() };
    });
    return other.id;
  }

  it('waits for it before main comes in, and then main comes in with its work', async () => {
    const id = built();
    mainMoves();
    auto.acceptByItself(bp, id);
    const other = landing();
    await squad().step(id, 'update-base');
    let t = ticket(id);
    expect(fixes()).toHaveLength(0);
    expect(t.status).toBe(`Waits for ${other} to merge, then brings in the newest code`);
    expect(t.squad?.phase).toBe('update-base');
    expect(Date.parse(t.squad!.nextAt)).toBeLessThan(Date.now() + 20_000);
    expect(t.live).toBe(true);
    expect(texts(id)[0]).toBe(`${other} is about to merge into main, so this story waits for it, then brings in the newest code`);
    // Nothing came in yet.
    expect(sh('git status --short', t.worktree!)).not.toContain('UU');

    // Looked at again while it is still landing: the same wait, said once.
    const said = texts(id).length;
    await squad().step(id, 'update-base');
    expect(texts(id)).toHaveLength(said);

    // It landed, and it moved main.
    updateTicket(bp, other, (x) => {
      x.squad = null;
      x.stage = 'release';
      x.live = false;
    });
    mainMoves();
    builderWork = (cwd) => fs.writeFileSync(path.join(cwd, 'limit.txt'), 'limit = a\n');
    await squad().step(id, 'update-base');
    t = ticket(id);
    expect(fixes()).toHaveLength(1);
    expect(t.squad?.phase).toBe('test');
    expect(t.selfAccept?.landingSince).toBeUndefined();
    expect(t.baseCommit).toBe(sh('git rev-parse main', project));
  });

  it('never waits longer than the limit, nor for a story that is stopped', async () => {
    const id = built();
    mainMoves();
    auto.acceptByItself(bp, id);
    const other = landing('publish');
    expect(auto.landingFirst(bp, ticket(id))).toBe(other);
    updateTicket(bp, other, (x) => (x.waiting = { kind: 'stuck', summary: 'x' }));
    expect(auto.landingFirst(bp, ticket(id))).toBeNull();
    updateTicket(bp, other, (x) => (x.waiting = null));
    expect(auto.waitForLanding(bp, id)).toBe(true);
    updateTicket(bp, id, (x) => (x.selfAccept = { ...x.selfAccept, landingSince: new Date(Date.now() - auto.MAX_LANDING_WAIT_MS - 1000).toISOString() }));
    expect(auto.waitForLanding(bp, id)).toBe(false);
    expect(ticket(id).selfAccept?.landingSince).toBeUndefined();
  });

  it('a story on a track where the person accepts does not wait', () => {
    const id = built(true);
    landing();
    expect(auto.waitForLanding(bp, id)).toBe(false);
  });
});

describe('with a pull request on the code host', () => {
  let remote: string;
  let state: MergeState;
  const host = (): RepoHost => ({
    host: 'example',
    label: 'Example Repos',
    repo: 'app',
    abilities: { attachImages: false },
    gitEnv: () => ({}),
    findPullRequest: async () => null,
    openPullRequest: async () => ({ id: 7, url: 'https://code.example.test/pr/7' }),
    attachImage: async () => '',
    updateDescription: async () => undefined,
    mergeState: async () => state,
    merge: async () => {
      throw new Error('The pull request has merge conflicts');
    },
    close: async () => undefined,
    refusedPush: () => false,
  });

  /** Someone else's story merged on the code host, and this computer does not know it yet. */
  function teamMoves(): void {
    const other = path.join(tmp, `other-${moves}`);
    sh(`git clone -q ${remote} ${other}`, tmp);
    moves += 1;
    fs.writeFileSync(path.join(other, 'limit.txt'), `limit = ${moves}\n`);
    commit(other, `team change ${moves}`);
    sh('git push -q origin main', other);
  }

  beforeEach(() => {
    remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main ${remote}`, tmp);
    sh(`git remote add origin ${remote} && git push -q origin main`, project);
    h.host = host();
    state = 'clash';
  });

  /** The squad accepted it, and the code host says the pull request clashes. */
  async function acceptedAndRefused(id: string): Promise<void> {
    const t = auto.acceptByItself(bp, id);
    expect(t.squad?.phase).toBe('publish');
    await squad().step(id, 'publish');
  }

  it('brings in the newest code while the team moves it, then stops when it has not moved', async () => {
    const id = built(false, 'origin');
    teamMoves();
    await acceptedAndRefused(id);
    let t = ticket(id);
    expect(t.waiting).toBeNull();
    expect(t.pr).toBeUndefined();
    expect(t.squad?.phase).toBe('update-base');
    expect(texts(id)[0]).toBe(tryLine(1));
    await settled(id, 'a');

    teamMoves();
    await acceptedAndRefused(id);
    t = ticket(id);
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(2);
    expect(texts(id)[0]).toBe(tryLine(2));
    await settled(id, 'b');

    // The host still says it clashes, and nothing new came: the person gets the plain stop.
    await acceptedAndRefused(id);
    t = ticket(id);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.gate).toBe('merge');
    expect(t.stuck?.question).toBe('Pull request 7 cannot go into main yet: newer work changed the same lines.');
    expect(t.selfAccept?.baseTries).toBe(2);
    expect(texts(id)[0]).toBe('It still clashes, and the code has not moved since it last came in, so it waits for you');
  });
});
