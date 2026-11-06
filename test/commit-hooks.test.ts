import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readRelease, readTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import '../src/engine/live.js';
import * as actions from '../src/board/actions.js';
import { HookRefused, addWorktree, commitAll, commitChecked, commitHooks, conventionalWords } from '../src/engine/git.js';
import { problemOf } from '../src/board/problem.js';

/**
 * A project's own commit hooks, with real git. The rule: they are never skipped by themselves on a finished change. A
 * hook that only refused the words or fixed files gets one more try; then it is a stop card, and only the person can go
 * past it, with a reason on the record. A release's own commit and a save of the work so far go on, and say so.
 */

let tmp: string;
let project: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function hook(name: string, body: string, dir = path.join(project, '.git', 'hooks')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Refuses a message unless it has a type, the way commitlint does. */
const COMMITLINT = `grep -qE '^(feat|fix|chore)(\\(.+\\))?: ' "$1" || { echo "subject may not be empty [subject-empty]"; exit 1; }`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hooks-'));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function proofReady(id = 'AP-1', file = 'limit.txt') {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, file), 'limit = 3\n');
  writeTicket(bp, {
    id,
    title: 'Raise the limit',
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: '',
    waiting: { kind: 'proof', summary: '' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
  });
  return wt.dir;
}

async function stopped(saving: Promise<unknown>): Promise<void> {
  await expect(saving).rejects.toBeInstanceOf(actions.HookStopped);
}

describe('Looks right on a repo with commit hooks', () => {
  it('commits as usual when the hook says yes, and the hook really ran', async () => {
    const copy = proofReady();
    hook('pre-commit', `echo ran > "${tmp}/ran"`);
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(fs.existsSync(path.join(tmp, 'ran'))).toBe(true);
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1', copy)).toBe('Raise the limit (AP-1)');
  });

  it('a pre-commit that says no stops the ticket with a card, not a loop on "try again"', async () => {
    proofReady();
    hook('pre-commit', 'echo "lint: 2 errors in limit.txt"; exit 1');
    await stopped(actions.approveBeside(bp, 'AP-1'));
    const t = readTicket(bp, 'AP-1')!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.kind).toBe('hook');
    // Plain words for the person, the hook's own words for engineers.
    expect(t.stuck?.question).toMatch(/own check that runs on every save/);
    expect(t.stuck?.question).not.toContain('lint');
    expect(t.stuck?.detail).toContain('lint: 2 errors in limit.txt');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'yourself', 'save-again', 'skip-hooks', 'plan']);
    expect(problemOf(t)?.title).toBe("The project's own check said no");
    expect(t.mergedAt).toBeUndefined();
    expect(sh('git log --format=%s -1 main', project)).toBe('start');
  });

  it('a commit-msg hook that only refuses the words gets the usual form, with the hook still on', async () => {
    const copy = proofReady();
    hook('commit-msg', COMMITLINT);
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1', copy)).toBe('feat: raise the limit (AP-1)');
  });

  it('a formatter hook that fixed files and said no goes in on the second try, with the fixed files', async () => {
    const copy = proofReady();
    hook('pre-commit', `if ! grep -q formatted limit.txt; then echo formatted >> limit.txt; echo "fixed files, add them"; exit 1; fi`);
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git show HEAD:limit.txt', copy)).toContain('formatted');
    expect(sh('git status --porcelain', copy)).toBe('');
  });

  it('never goes past the hook without the person: Save without this check needs a reason, which stays on the record', async () => {
    const copy = proofReady();
    hook('pre-commit', 'echo no; exit 1');
    await stopped(actions.approveBeside(bp, 'AP-1'));
    const skip = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'skip-hooks');
    expect(() => actions.decideStuck(bp, 'AP-1', skip, {})).toThrow(/Write why/);
    expect(readTicket(bp, 'AP-1')!.waiting?.kind).toBe('stuck');
    const t = actions.decideStuck(bp, 'AP-1', skip, { reason: 'the check needs a licence on this laptop' });
    expect(t.mergedAt).toBeTruthy();
    expect(t.overrides).toEqual([expect.objectContaining({ gate: 'hooks', reason: 'the check needs a licence on this laptop', by: 'Momen' })]);
    expect(t.activity.map((a) => a.text).join('\n')).toContain('Why: the check needs a licence on this laptop');
    expect(sh('git log --format=%s -1', copy)).toBe('Raise the limit (AP-1)');
  });

  it('Try the save again runs the hook once more, and works once an engineer fixed it', async () => {
    proofReady();
    hook('pre-commit', 'exit 1');
    await stopped(actions.approveBeside(bp, 'AP-1'));
    const again = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'save-again');
    await stopped(actions.decideStuckBeside(bp, 'AP-1', again));
    expect(readTicket(bp, 'AP-1')!.stuck?.kind).toBe('hook');
    hook('pre-commit', 'exit 0');
    expect((await actions.decideStuckBeside(bp, 'AP-1', again)).mergedAt).toBeTruthy();
  });

  it("Let the Builder fix it gives the Builder the hook's words, and the checks run again", async () => {
    proofReady();
    hook('pre-commit', 'echo "eslint: no-unused-vars"; exit 1');
    await stopped(actions.approveBeside(bp, 'AP-1'));
    const t = actions.decideStuck(bp, 'AP-1', 0);
    expect(t.squad?.phase).toBe('fix');
    expect(t.stage).toBe('implement');
    expect(t.changeRequest).toContain('eslint: no-unused-vars');
    expect(t.changeRequest).toContain('Do not change or remove the hook');
    expect(t.changeRequest!.split('\n')[0]).toBe("Fix what the project's own check found");
    expect(t.gates?.checks).toBe('pending');
  });

  it('the board keeps answering while a slow hook runs, and a second press is refused', async () => {
    proofReady();
    // It runs until the test lets it end, so no clock decides this, however busy the computer is.
    const go = path.join(tmp, 'go');
    const started = path.join(tmp, 'started');
    hook('pre-commit', `echo x > "${started}"; while [ ! -e "${go}" ]; do sleep 0.05; done`);
    const first = actions.approveBeside(bp, 'AP-1');
    // Back here while the hook runs: the hook runs beside the board.
    let done = false;
    void first.then(() => (done = true));
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toThrow(/being saved/);
    for (let i = 0; i < 2000 && !fs.existsSync(started); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(fs.existsSync(started)).toBe(true);
    expect(done).toBe(false);
    fs.writeFileSync(go, '');
    const t = await first;
    expect(t.mergedAt).toBeTruthy();
    expect(t.activity.map((a) => a.text).join('\n')).toMatch(/Saved the change as commit [0-9a-f]+ on squad\/ap-1/);
  });

  it('a hook that says no from the board gives the same card', async () => {
    proofReady();
    hook('pre-commit', 'echo nope; exit 1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    expect(readTicket(bp, 'AP-1')!.stuck?.detail).toContain('nope');
  });

  it('a hook that hangs is ended at its limit, with everything it started', async () => {
    const copy = proofReady();
    fs.writeFileSync(path.join(copy, 'x'), 'x');
    sh('git add -A', copy);
    hook('pre-commit', `sleep 30 & echo $! > "${tmp}/pid"; wait`);
    // Long enough for the hook to start on a busy computer: the limit is what ends it, not what stops it starting.
    await expect(commitChecked(copy, 'm', 'chore: m', 4000)).rejects.toMatchObject({ timedOut: true });
    const pid = Number(fs.readFileSync(path.join(tmp, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('finds hooks where husky keeps them, and ignores the samples', () => {
    const copy = proofReady();
    expect(commitHooks(copy)).toEqual([]);
    hook('pre-commit', 'exit 1', path.join(project, '.husky-hooks'));
    fs.writeFileSync(path.join(project, '.husky-hooks', 'pre-push.sample'), '#!/bin/sh\n', { mode: 0o755 });
    sh(`git config core.hooksPath "${path.join(project, '.husky-hooks')}"`, project);
    expect(commitHooks(copy)).toEqual(['pre-commit']);
  });

  it('a commit that fails for git\'s own reason keeps its own words, and no hook card', async () => {
    const copy = proofReady();
    sh('git add -A', copy);
    hook('pre-commit', 'exit 0');
    const gitDir = sh('git rev-parse --git-dir', copy);
    fs.writeFileSync(path.join(path.resolve(copy, gitDir), 'index.lock'), '');
    const err = await commitChecked(copy, 'm', 'chore: m').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HookRefused);
    expect((err as Error).message).toMatch(/^git (?:add|commit) failed/);
    fs.rmSync(path.join(path.resolve(copy, gitDir), 'index.lock'));
  });
});

describe('on Builds by itself', () => {
  it('never goes past the hook by itself: the card waits for the person, and the record says the squad did not accept it', async () => {
    const copy = proofReady();
    const auto = await import('../src/board/auto.js');
    const { updateTicket } = await import('../src/board/store.js');
    updateTicket(bp, 'AP-1', (x) => {
      x.track = 'auto';
      x.waiting = null;
      x.proof = [];
    });
    hook('pre-commit', 'echo "lint says no"; exit 1');
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.kind).toBe('hook');
    expect(t.mergedAt).toBeUndefined();
    const texts = t.activity.map((a) => a.text).join('\n');
    expect(texts).toContain("Not accepted by itself: the project's own check said no");
    expect(texts).not.toContain('Checked the proof. Looks right');
    expect(sh('git status --porcelain', copy)).toContain('limit.txt');
  });
});

describe('the words in the usual form', () => {
  it('keeps the id, starts lower case, and stays short enough for a header limit', () => {
    expect(conventionalWords('fix', 'Booking fails on Sunday.', 'AP-7')).toBe('fix: booking fails on Sunday (AP-7)');
    expect(conventionalWords('chore', 'release v1.2.0')).toBe('chore: release v1.2.0');
    const long = conventionalWords('feat', 'x'.repeat(300), 'AP-7');
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith('(AP-7)')).toBe(true);
  });
});

describe('work so far', () => {
  it('saves unfinished work on the ticket\'s own branch even when the hook says no, and says the hook said no', async () => {
    const copy = proofReady();
    hook('pre-commit', 'echo "not finished"; exit 1');
    const r = await commitAll(copy, 'work so far', 'chore: work so far');
    expect(r.commit).toBeTruthy();
    expect(r.hookSaid).toContain('not finished');
    expect(sh('git status --porcelain', copy)).toBe('');
  });

  it('keeps the hook on when it says yes', async () => {
    const copy = proofReady();
    hook('pre-commit', 'exit 0');
    expect((await commitAll(copy, 'work so far', 'chore: work so far')).hookSaid).toBeUndefined();
  });
});

describe('the release notes', () => {
  it('say a save without the check went out without the check', async () => {
    proofReady();
    hook('pre-commit', 'echo no; exit 1');
    await stopped(actions.approveBeside(bp, 'AP-1'));
    const skip = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'skip-hooks');
    const t = actions.decideStuck(bp, 'AP-1', skip, { reason: 'licence missing here' });
    const notes = actions.composeNotes(bp, readRelease(bp, t.release!)!);
    expect(notes).toContain("AP-1 Raise the limit: went out without the project's own check. Momen: licence missing here");
    expect(notes).not.toContain('open review notes');
  });
});

describe('a release on a repo with commit hooks', () => {
  it('still goes out when the hook refuses the release commit, and its log says so', async () => {
    fs.writeFileSync(path.join(project, 'CHANGELOG.md'), '# Changelog\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm log', project);
    proofReady();
    actions.approve(bp, 'AP-1');
    hook('pre-commit', 'echo "lint-staged: command not found"; exit 127');
    const r = await actions.releaseVersion(bp, readTicket(bp, 'AP-1')!.release!);
    expect(r.status).toBe('released');
    expect(sh('git log --format=%s -1 main', project)).toBe(`release ${r.version}`);
    const line = readRelease(bp, r.version)!.log!.find((l) => l.text.includes('own check'));
    expect(line?.ok).toBe(false);
    expect(line?.text).toContain('holds only the version and the changelog');
  });

  it('a commit-msg hook gets the usual form on the release commit', async () => {
    fs.writeFileSync(path.join(project, 'CHANGELOG.md'), '# Changelog\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm log', project);
    proofReady();
    actions.approve(bp, 'AP-1');
    hook('commit-msg', COMMITLINT);
    const r = await actions.releaseVersion(bp, readTicket(bp, 'AP-1')!.release!);
    expect(sh('git log --format=%s -1 main', project)).toBe(`chore: release ${r.version}`);
    expect(readRelease(bp, r.version)!.log!.some((l) => l.text.includes('own check'))).toBe(false);
  });
});
