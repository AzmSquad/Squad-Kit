import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { boardPaths, readMeta, writeMeta, readTicket, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import { GitSaidTooMuch, GitStopped, NoRoomForCopy, addWorktree, changedFiles, clearHalfCopies, commitAll, commitChecked, git, gitLater, gitRecords, mergeIntoBase, netGitLater, moveBase, mergeWouldClash, putBackTracked, removeWorktree, addSnapshot, dropSnapshot, stageAll, stageAllLater, worktreeRoot, writeChangesOf } from '../src/engine/git.js';
import { AppRunner, copyEnvFiles, stopApps, updateCopy } from '../src/engine/run-app.js';
import { countFiles, firstLook, gitState } from '../src/engine/first-look.js';
import { ticketChanges } from '../src/engine/changes.js';
import { workSoFar } from '../src/engine/handover.js';
import { cleanBranches } from '../src/engine/branches.js';
import { moveLocalBase } from '../src/engine/release.js';
import { watchLane } from '../src/engine/lane.js';
import { ownWords } from '../src/engine/plain-stop.js';
import { DOING } from '../src/engine/plain-doing.js';
import { readStarted } from '../src/engine/onboard.js';
import { deleteTicket } from '../src/engine/delete.js';
import { approveBeside, decideStuckBeside, releaseVersion } from '../src/board/actions.js';
import { mountAppApi } from '../src/console/api/app.js';
import type { OpenProjects } from '../src/console/open-projects.js';
import { stopLeftovers } from '../src/engine/leftovers.js';
import { freePort } from './support/tiny-app.js';

/**
 * A project of any size: the long git steps run beside everything else, so no page waits for them, and half a copy of
 * the code can never be worked in. Real git and real files, with no huge repo: a filter that takes its time makes a
 * checkout slow for real, and a `git` first on the path slows one command, to see a timer keep ticking while it runs.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const POSIX = process.platform !== 'win32';
const realGit = POSIX ? execSync('command -v git', { encoding: 'utf8' }).trim() : 'git';
const startPath = process.env.PATH;

let tmp: string;
let project: string;
let log: string;
const stops: (() => void)[] = [];

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** The worst wait of a timer while the work runs: what a page would wait. */
async function worstWait(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return Math.max(worst, performance.now() - last);
}

/** A slow step that kept the timer waiting would show this long a gap; running beside everything else it shows none near it. */
const SLOW_S = 2;
const NO_FREEZE_MS = 1500;

/** `git` first on the path: says what it was asked, and takes SLOW_S on the commands that match, and on them only. */
function slowGit(...matches: string[]): void {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cases = matches.map((m) => `  *" ${m} "*) sleep ${SLOW_S} ;;`).join('\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in\n${cases || '  *zzz*) ;;'}\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${startPath}`;
}

const asked = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const makingArea = (root: string) => path.join(worktreeRoot(root), '.making');
const leftInMaking = (root: string) => (fs.existsSync(makingArea(root)) ? fs.readdirSync(makingArea(root)) : []);

/** Until nothing is left half made: it goes beside everything else, after a Stop has landed. */
async function untilClear(root: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (leftInMaking(root).length && Date.now() < end) await sleep(50);
  expect(leftInMaking(root)).toEqual([]);
}

/** A project whose files come out of a filter that takes `each` seconds a file: its first copy really takes a while. */
const SLOW_FILES = 20;

function slowCheckout(files = SLOW_FILES, each = 0.12): void {
  put(path.join(project, '.gitattributes'), '*.slow filter=slow\n');
  for (let i = 0; i < files; i += 1) put(path.join(project, 'files', `f${i}.slow`), `file ${i}\n`);
  sh(`git config filter.slow.clean cat && git config filter.slow.smudge "sh -c 'sleep ${each}; cat'"`, project);
  sh('git add -A && git commit -qm "slow files"', project);
}

function isWhole(dir: string, files: number): void {
  expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  expect(fs.readdirSync(path.join(dir, 'files'))).toHaveLength(files);
  expect(sh('git status --porcelain', dir)).toBe('');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-big-')));
  log = path.join(tmp, 'git-asked.log');
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  put(path.join(project, 'README.md'), '# app\n');
  sh('git add -A && git commit -qm start', project);
});

afterEach(async () => {
  process.env.PATH = startPath;
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!POSIX)('a first copy of the code', () => {
  it('runs beside everything else, with parallel checkout, and only ever shows whole in its real place', async () => {
    slowCheckout(6, 0.3);
    slowGit('worktree add');
    const dir = path.join(worktreeRoot(project), 'ap-1');
    let early = true;
    const worst = await worstWait(async () => {
      const made = addWorktree(project, 'AP-1', 'main').then((r) => {
        early = false;
        return r;
      });
      // While it is made there is nothing at the real place at all, so nothing can take half of it for a copy.
      while (early) {
        expect(fs.existsSync(dir)).toBe(false);
        await sleep(40);
      }
      await made;
    });
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    isWhole(dir, 6);
    expect(asked().find((l) => l.includes('worktree add'))).toContain('checkout.workers=0');
    expect(sh('git worktree list', project)).toContain(dir);
    await untilClear(project);
  });

  it('a Stop ends it at once, its own child process too, and leaves nothing half made in use', async () => {
    slowCheckout();
    const stop = new AbortController();
    const dir = path.join(worktreeRoot(project), 'ap-1');
    const making = addWorktree(project, 'AP-1', 'main', undefined, undefined, { signal: stop.signal });
    await sleep(800);
    const half = fs.readdirSync(makingArea(project)).find((n) => !n.endsWith('.json'))!;
    expect(fs.existsSync(path.join(makingArea(project), half, 'ap-1', '.git'))).toBe(true);
    const pid = (JSON.parse(fs.readFileSync(path.join(makingArea(project), `${half}.json`), 'utf8')) as { pid: number }).pid;
    const at = Date.now();
    stop.abort();
    await expect(making).rejects.toBeInstanceOf(GitStopped);
    expect(Date.now() - at).toBeLessThan(5000);
    expect(fs.existsSync(dir)).toBe(false);
    await untilClear(project);
    // Nothing of its group runs on, git's own child that does the checkout included.
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
  });

  it('after a Stop the next try makes it whole, from the newest base: the branch of the half copy had no work on it', async () => {
    slowCheckout();
    const stop = new AbortController();
    const making = addWorktree(project, 'AP-1', 'main', undefined, undefined, { signal: stop.signal });
    await sleep(800);
    stop.abort();
    await expect(making).rejects.toBeInstanceOf(GitStopped);
    put(path.join(project, 'newer.txt'), 'newer\n');
    sh('git add newer.txt && git commit -qm newer', project);
    const main = sh('git rev-parse main', project);
    const wt = await addWorktree(project, 'AP-1', 'main');
    expect(wt.baseCommit).toBe(main);
    expect(sh('git rev-parse HEAD', wt.dir)).toBe(main);
    isWhole(wt.dir, SLOW_FILES);
  }, 30_000);

  it('a branch with work on it stays when its copy is made again', async () => {
    slowCheckout(4, 0.05);
    sh('git branch squad/ap-1', project);
    const dir = path.join(tmp, 'other-copy');
    sh(`git worktree add -q "${dir}" squad/ap-1`, project);
    put(path.join(dir, 'work.txt'), 'work\n');
    sh('git add work.txt && git -c user.name=t -c user.email=t@t commit -qm work', dir);
    sh(`git worktree remove --force "${dir}"`, project);
    const stop = new AbortController();
    stop.abort();
    await expect(addWorktree(project, 'AP-1', 'main', undefined, undefined, { signal: stop.signal })).rejects.toBeInstanceOf(GitStopped);
    await untilClear(project);
    expect(sh('git show squad/ap-1:work.txt', project)).toBe('work');
    expect(fs.existsSync(path.join((await addWorktree(project, 'AP-1', 'main')).dir, 'work.txt'))).toBe(true);
  });

  it('a crash in the middle: half a copy is only ever out of the way, and the next start removes it and makes it again', async () => {
    slowCheckout();
    const dir = path.join(worktreeRoot(project), 'ap-1');
    // A squad-kit of its own, killed in the middle of its copy, with git still running after it.
    const script = path.join(tmp, 'copy.mts');
    fs.writeFileSync(script, `import { addWorktree } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};\nawait addWorktree(${JSON.stringify(project)}, 'AP-1', 'main');\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    const end = Date.now() + 20_000;
    let half = '';
    while (!half && Date.now() < end) {
      const name = leftInMaking(project).find((n) => !n.endsWith('.json'));
      if (name && fs.existsSync(path.join(makingArea(project), name, 'ap-1', '.git'))) half = name;
      else await sleep(50);
    }
    expect(half).toBeTruthy();
    await sleep(300);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const left = path.join(makingArea(project), half, 'ap-1');
    // Half made for real: git's folder link is there, and not all the files are.
    expect(fs.existsSync(path.join(left, '.git'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    const note = JSON.parse(fs.readFileSync(path.join(makingArea(project), `${half}.json`), 'utf8')) as { pid: number };
    const wt = await addWorktree(project, 'AP-1', 'main');
    expect(() => process.kill(-note.pid, 0)).toThrow();
    isWhole(wt.dir, SLOW_FILES);
    await untilClear(project);
    expect(sh('git worktree list', project).split('\n')).toHaveLength(2);
  }, 45_000);

  it('another squad-kit on this computer at the same copy: this one waits for it, and takes the whole copy', async () => {
    slowCheckout();
    slowGit();
    const script = path.join(tmp, 'copy.mts');
    fs.writeFileSync(script, `import { addWorktree } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};\nawait addWorktree(${JSON.stringify(project)}, 'AP-1', 'main');\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    const ended = new Promise<number | null>((r) => child.once('exit', r));
    const end = Date.now() + 20_000;
    while (!leftInMaking(project).some((n) => !n.endsWith('.json') && fs.existsSync(path.join(makingArea(project), n, 'ap-1', '.git'))) && Date.now() < end) await sleep(50);
    const wt = await addWorktree(project, 'AP-1', 'main');
    expect(await ended).toBe(0);
    isWhole(wt.dir, SLOW_FILES);
    expect(asked().filter((l) => l.includes('worktree add'))).toHaveLength(1);
  }, 45_000);

  it('a copy from before these notes: whole, it is used as it is; half made, it is made again', async () => {
    const whole = path.join(worktreeRoot(project), 'ap-1');
    fs.mkdirSync(path.dirname(whole), { recursive: true });
    sh(`git worktree add -q -b squad/ap-1 "${whole}" main`, project);
    put(path.join(whole, 'work.txt'), 'not saved yet\n');
    expect((await addWorktree(project, 'AP-1', 'main')).dir).toBe(whole);
    expect(fs.readFileSync(path.join(whole, 'work.txt'), 'utf8')).toBe('not saved yet\n');

    // What a kill left in the middle of git's first checkout: its link is there, and the index it writes last is not.
    const half = path.join(worktreeRoot(project), 'ap-2');
    sh(`git worktree add -q --no-checkout -b squad/ap-2 "${half}" main`, project);
    expect(fs.existsSync(path.join(half, '.git'))).toBe(true);
    const wt = await addWorktree(project, 'AP-2', 'main');
    expect(fs.existsSync(path.join(wt.dir, 'README.md'))).toBe(true);
    expect(sh('git status --porcelain', wt.dir)).toBe('');
  });

  it('what a restart left half made is cleared when the board starts, with no story asking for it', async () => {
    slowCheckout();
    const stop = new AbortController();
    const making = addWorktree(project, 'AP-1', 'main', undefined, undefined, { signal: stop.signal });
    await sleep(800);
    stop.abort();
    await making.catch(() => undefined);
    await clearHalfCopies(project);
    await untilClear(project);
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
  });

  it('two stories starting at once in one repo both get a whole copy, with no word about a lock', async () => {
    slowCheckout(8, 0.1);
    const [a, b] = await Promise.all([addWorktree(project, 'AP-1', 'main'), addWorktree(project, 'AP-2', 'main')]);
    isWhole(a.dir, 8);
    isWhole(b.dir, 8);
    expect(sh('git branch --list "squad/*"', project)).toContain('squad/ap-2');
    await untilClear(project);
  });

  it('a pushed branch: two copies at once may write the settings at the same moment, and neither fails', async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main main:squad/ap-1 main:squad/ap-2 && git fetch -q origin`, project);
    const lock = path.join(project, '.git', 'config.lock');
    fs.writeFileSync(lock, '');
    setTimeout(() => fs.rmSync(lock, { force: true }), 700);
    const [a, b] = await Promise.all([addWorktree(project, 'AP-1', 'main'), addWorktree(project, 'AP-2', 'main')]);
    expect(a.pushed).toBe('origin/squad/ap-1');
    expect(b.pushed).toBe('origin/squad/ap-2');
  });

  it('asked for twice at once, one copy is made', async () => {
    slowCheckout(6, 0.1);
    slowGit();
    const dir = path.join(worktreeRoot(project), 'ap-1');
    const [a, b] = await Promise.all([addWorktree(project, 'AP-1', 'main'), addWorktree(project, 'AP-1', 'main')]);
    expect(a.dir).toBe(dir);
    expect(b.dir).toBe(dir);
    expect(asked().filter((l) => l.includes('worktree add'))).toHaveLength(1);
    isWhole(dir, 6);
  });

  it('a throwaway copy is made and dropped the same way', async () => {
    slowGit('worktree add', 'worktree remove');
    let dir = '';
    const worst = await worstWait(async () => {
      dir = await addSnapshot(project, 'look-back', sh('git rev-parse HEAD', project));
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
      await dropSnapshot(project, dir);
    });
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(fs.existsSync(dir)).toBe(false);
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
  });
});

describe.skipIf(!POSIX)('git’s own lock files', () => {
  it('a git beside everything else waits for the git that holds the lock', async () => {
    put(path.join(project, 'new.txt'), 'new\n');
    const lock = path.join(project, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    setTimeout(() => fs.rmSync(lock, { force: true }), 900);
    await gitLater(project, ['add', '-A']);
    expect(sh('git diff --cached --name-only', project)).toBe('new.txt');
  });

  it('a git that cannot wait gets its own short wait, for a lock on the settings', () => {
    const lock = path.join(project, '.git', 'config.lock');
    fs.writeFileSync(lock, '');
    // Another process lets go of it: this one waits on the board's time, so no timer of its own could.
    spawn('sh', ['-c', `sleep 0.1; rm -f "${lock}"`], { stdio: 'ignore' });
    git(project, ['config', 'squad.test', 'yes']);
    expect(sh('git config squad.test', project)).toBe('yes');
  });

  it('a Stop ends the wait for a lock too', async () => {
    fs.writeFileSync(path.join(project, '.git', 'index.lock'), '');
    const stop = new AbortController();
    const trying = gitLater(project, ['add', '-A'], { signal: stop.signal });
    await sleep(300);
    stop.abort();
    await expect(trying).rejects.toBeInstanceOf(GitStopped);
  });
});

describe.skipIf(!POSIX)('removing a copy', () => {
  it('runs beside everything else, and is out of its real place at once', async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    slowGit('worktree remove');
    let gone: boolean | null = null;
    const worst = await worstWait(async () => {
      const removing = removeWorktree(project, wt.dir);
      // The move comes first: half a removal is never at the real place, where it would look like a copy.
      while (leftInMaking(project).length === 0 && fs.existsSync(wt.dir)) await sleep(5);
      gone = !fs.existsSync(wt.dir);
      await removing;
    });
    expect(gone).toBe(true);
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
    expect(leftInMaking(project)).toEqual([]);
  });

  it('a crash in the middle of it: the half removed copy goes at the next start, and never counts as a copy', async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    slowGit('worktree remove');
    // The process dies once it moved the copy aside: its git and the rest of the removal never happen.
    const script = path.join(tmp, 'remove.mts');
    fs.writeFileSync(script, `import { removeWorktree } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};\nvoid removeWorktree(${JSON.stringify(project)}, ${JSON.stringify(wt.dir)});\nsetTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(leftInMaking(project).length).toBeGreaterThan(0);
    process.env.PATH = startPath;
    await clearHalfCopies(project);
    await untilClear(project);
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
    expect(sh('git rev-parse --verify squad/ap-1', project)).toBeTruthy();
    const again = await addWorktree(project, 'AP-1', 'main');
    expect(fs.existsSync(path.join(again.dir, 'README.md'))).toBe(true);
  }, 30_000);

  it('leaves alone a folder git does not know as a copy of this repo', async () => {
    const other = path.join(tmp, 'somebody-elses');
    put(path.join(other, 'keep.txt'), 'keep\n');
    await removeWorktree(project, other);
    expect(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

/** A board with one ticket at the proof, its work saved or not as the test wants. */
function liveBoard(remote = ''): BoardPaths {
  const bp = boardPaths(path.join(project, '.squad'));
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
    commands: { start: 'node server.js' },
    git: { base: 'main', remote },
    scan: { status: 'done', empty: false },
  });
  sh('echo .squad >> .git/info/exclude', project);
  return bp;
}

function ticketOn(bp: BoardPaths, id: string, wt: { dir: string; branch: string; baseCommit: string }, more: Partial<Ticket> = {}): Ticket {
  const t: Ticket = {
    id,
    title: `Change for ${id}`,
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    ...more,
  };
  writeTicket(bp, t);
  return t;
}

describe.skipIf(!POSIX)('Looks right and a release', () => {
  let bp: BoardPaths;

  beforeEach(async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main`, project);
    bp = liveBoard('origin');
    put(path.join(project, 'package.json'), '{ "name": "app", "version": "1.0.0" }\n');
    sh('git add -A && git commit -qm pkg && git push -q origin main', project);
    const wt = await addWorktree(project, 'AP-1', 'main');
    put(path.join(wt.dir, 'one.txt'), 'one\n');
    ticketOn(bp, 'AP-1', wt, { stage: 'review', status: 'Proof ready to check', waiting: { kind: 'proof', summary: 'Ready' }, gates: { checks: 'pass', review: 'pass', proof: 'pass' } });
  });

  it('Looks right: its save holds up nothing', async () => {
    slowGit('add -A', 'commit');
    const worst = await worstWait(() => approveBeside(bp, 'AP-1'));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'release' });
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
    expect(fs.readFileSync(path.join(project, 'one.txt'), 'utf8')).toBe('one\n');
  }, 30_000);

  it('Looks right on a merge that clashes still gives the clash card, and moves nothing', async () => {
    const t = readTicket(bp, 'AP-1')!;
    put(path.join(t.worktree!, 'package.json'), '{ "name": "ours" }\n');
    put(path.join(project, 'package.json'), '{ "name": "theirs" }\n');
    sh('git add -A && git commit -qm theirs', project);
    const main = sh('git rev-parse main', project);
    const after = await approveBeside(bp, 'AP-1');
    expect(after.waiting?.kind).toBe('stuck');
    expect(after.stuck?.gate).toBe('merge');
    expect(sh('git rev-parse main', project)).toBe(main);
  }, 30_000);

  it('a release to a slow remote, from a copy that takes a while, holds up nothing', async () => {
    await approveBeside(bp, 'AP-1');
    slowGit('push', 'worktree add');
    let version = '';
    const worst = await worstWait(async () => {
      version = (await releaseVersion(bp)).version;
    });
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(sh(`git rev-parse refs/tags/${version}`, path.join(tmp, 'remote.git'))).toBeTruthy();
    expect(sh('git rev-parse main', project)).toBe(sh('git rev-parse main', path.join(tmp, 'remote.git')));
  }, 45_000);

  it('work accepted while a release makes its copy waits for the next release, its code too', async () => {
    await approveBeside(bp, 'AP-1');
    const wt = await addWorktree(project, 'AP-2', 'main');
    put(path.join(wt.dir, 'two.txt'), 'two\n');
    ticketOn(bp, 'AP-2', wt, { stage: 'review', status: 'Proof ready to check', waiting: { kind: 'proof', summary: 'Ready' }, gates: { checks: 'pass', review: 'pass', proof: 'pass' } });
    slowGit('worktree add');
    const going = releaseVersion(bp);
    await sleep(200);
    await approveBeside(bp, 'AP-2');
    expect(fs.existsSync(path.join(project, 'two.txt'))).toBe(true);
    const release = await going;
    expect(release.tickets).toEqual(['AP-1']);
    expect(sh(`git show ${release.version}:one.txt`, project)).toBe('one');
    expect(() => sh(`git show ${release.version}:two.txt`, project)).toThrow();
    // Your own copy keeps it, with the release merged in.
    expect(sh('git show main:two.txt', project)).toBe('two');
    expect(sh(`git merge-base --is-ancestor ${release.version} main && echo yes`, project)).toBe('yes');
  }, 45_000);

  it('past the project’s own check, with a reason: that save holds up nothing either', async () => {
    sh('mkdir -p .git/hooks && printf "#!/bin/sh\nexit 1\n" > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit', project);
    await expect(approveBeside(bp, 'AP-1')).rejects.toThrow(/See the ways out/);
    const t = readTicket(bp, 'AP-1')!;
    const skip = t.stuck!.options.findIndex((o) => o.do === 'skip-hooks');
    slowGit('add -A', 'commit');
    const worst = await worstWait(() => decideStuckBeside(bp, 'AP-1', skip, { reason: 'The check is broken on main too' }));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
    expect(readTicket(bp, 'AP-1')!.overrides?.[0]?.reason).toBe('The check is broken on main too');
  }, 45_000);
});

describe.skipIf(!POSIX)('Your apps: Start', () => {
  const runners: AppRunner[] = [];
  let bp: BoardPaths;
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    put(path.join(project, 'server.js'), `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');\n`);
    sh('git add -A && git commit -qm server', project);
    bp = liveBoard();
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
  });

  afterEach(async () => {
    for (const r of runners.splice(0)) r.stopAll();
    stopApps(bp);
    await sleep(200);
  });

  const runner = () => {
    const r = new AppRunner(bp, { waitMs: 20_000 });
    runners.push(r);
    return r;
  };

  it('makes its copy beside everything else, says so, and a second press starts no second copy', async () => {
    slowCheckout();
    slowGit();
    const r = runner();
    const worst = await worstWait(async () => {
      r.start();
      expect(() => r.start()).toThrow(/is starting already/);
      await sleep(600);
      expect((await r.statusOf()).step).toBe('copy');
      await r.settled();
    });
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect((await r.statusOf()).state).toBe('running');
    expect(asked().filter((l) => l.includes('worktree add'))).toHaveLength(1);
    await r.stop();
  }, 30_000);

  it('Stop lands during the copy, nothing half made stays in use, and the next Start makes a whole one', async () => {
    slowCheckout();
    const r = runner();
    r.start();
    await sleep(900);
    const at = Date.now();
    await r.stop();
    expect(Date.now() - at).toBeLessThan(5000);
    expect((await r.statusOf()).state).toBe('stopped');
    expect(fs.existsSync((await r.statusOf()).dir)).toBe(false);
    r.start();
    expect((await r.settled()).state).toBe('running');
    isWhole((await r.statusOf()).dir, SLOW_FILES);
    await r.stop();
  }, 45_000);

  it('a copy that is there is only brought up to date, beside everything else', async () => {
    const dir = path.join(bp.localDir, 'apps', 'copy');
    slowGit('checkout --force');
    const repo = { path: '.', base: 'main', remote: '', commands: {} };
    expect((await updateCopy(bp.root, repo, dir)).fresh).toBe(true);
    let fresh = true;
    const worst = await worstWait(async () => {
      fresh = (await updateCopy(bp.root, repo, dir)).fresh;
    });
    expect(fresh).toBe(false);
    expect(worst).toBeLessThan(NO_FREEZE_MS);
  });

  it('what is left in its place that is no copy goes, beside everything else, and a whole copy comes', async () => {
    const dir = path.join(bp.localDir, 'apps', 'copy');
    put(path.join(dir, 'left-over.txt'), 'x\n');
    const repo = { path: '.', base: 'main', remote: '', commands: {} };
    expect((await updateCopy(bp.root, repo, dir)).fresh).toBe(true);
    expect(fs.existsSync(path.join(dir, 'left-over.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'server.js'))).toBe(true);
  });

  it('says plainly when the disk has too little room, and the next press can go on', async () => {
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 } as Awaited<ReturnType<typeof fs.promises.statfs>>);
    const r = runner();
    r.start();
    const after = await r.settled();
    expect(after.state).toBe('failed');
    expect(after.error).toMatch(/needs about 1 MB of free disk space, and this computer has 1 MB free\. Free up some space, then press Try again\./);
    expect(after.error).not.toMatch(/\b(git|commit|branch|port|pid)\b/i);
  });
});

describe.skipIf(!POSIX)('deleting a ticket with a copy', () => {
  it('runs beside everything else and takes its copy and its branch', async () => {
    const bp = liveBoard();
    const wt = await addWorktree(project, 'AP-1', 'main');
    ticketOn(bp, 'AP-1', wt);
    slowGit('worktree remove');
    const worst = await worstWait(() => deleteTicket(bp, 'AP-1'));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(readTicket(bp, 'AP-1')).toBeNull();
    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(sh('git branch --list squad/ap-1', project)).toBe('');
    expect(sh('git worktree list', project).split('\n')).toHaveLength(1);
  });
});

describe.skipIf(!POSIX)('git over the network', () => {
  let bare: string;

  beforeEach(() => {
    bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main`, project);
  });

  it('never holds up the board, and a slow remote gives up in its own words', async () => {
    slowGit('fetch');
    const worst = await worstWait(() => netGitLater(project, ['fetch', 'origin', 'main']));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    await expect(netGitLater(project, ['fetch', 'origin', 'main'], { timeoutMs: 100 })).rejects.toThrow(/git fetch gave up after 1 second\./);
  });

  it('a release looking at the person’s own folder before it moves the base holds up nothing', async () => {
    const bp = liveBoard('origin');
    const log2: { ok: boolean; text: string }[] = [];
    slowGit('--untracked-files=no');
    // The step of a release that moves the person's own copy, on the branch they have out.
    put(path.join(tmp, 'x'), '');
    const moved = path.join(tmp, 'moved');
    sh(`git worktree add -q -b rel "${moved}" main`, project);
    put(path.join(moved, 'rel.txt'), 'rel\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm rel', moved);
    const head = sh('git rev-parse HEAD', moved);
    const worst = await worstWait(() => moveLocalBase(project, 'main', head, 'v1.0.0', undefined, log2));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(sh('git rev-parse main', project)).toBe(head);
    expect(log2.some((l) => l.ok && /now has the release/.test(l.text))).toBe(true);
    expect(readMeta(bp).git?.remote).toBe('origin');
  });

  it('cleaning old branches on the remote holds up nothing', async () => {
    const bp = liveBoard('origin');
    slowGit('fetch');
    const worst = await worstWait(() => cleanBranches(bp, { remote: true }));
    expect(worst).toBeLessThan(NO_FREEZE_MS);
  });
});

describe.skipIf(!POSIX)('the steps that read every file', () => {
  const copy = async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    put(path.join(wt.dir, 'README.md'), '# changed\n');
    put(path.join(wt.dir, 'new.txt'), 'new\n');
    return wt;
  };

  it('staging everything', async () => {
    const wt = await copy();
    slowGit('add -A', '--others');
    expect(await worstWait(() => stageAllLater(wt.dir))).toBeLessThan(NO_FREEZE_MS);
    expect(sh('git diff --cached --name-only', wt.dir).split('\n').sort()).toEqual(['README.md', 'new.txt']);
  });

  it('saving the work so far, and a save with no hooks', async () => {
    const wt = await copy();
    slowGit('add -A', 'commit');
    let saved: string | null = null;
    expect(await worstWait(async () => {
      saved = (await commitAll(wt.dir, 'Work so far')).commit;
    })).toBeLessThan(NO_FREEZE_MS);
    expect(saved).toBeTruthy();
    expect(sh('git status --porcelain', wt.dir)).toBe('');
    put(path.join(wt.dir, 'more.txt'), 'more\n');
    sh('git add -A', wt.dir);
    expect(await worstWait(() => commitChecked(wt.dir, 'More', 'feat: more'))).toBeLessThan(NO_FREEZE_MS);
    expect(sh('git log -1 --format=%s', wt.dir)).toBe('More');
  });

  it('the hook files of a whole copy are read as they come, and a Stop in the hooks puts every file back beside everything else', async () => {
    const wt = await copy();
    sh('mkdir -p .git/hooks && printf "#!/bin/sh\\nsleep 30\\n" > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit', project);
    sh('git add -A', wt.dir);
    slowGit('checkout-index');
    const stop = new AbortController();
    let threw: unknown;
    const worst = await worstWait(async () => {
      const saving = commitChecked(wt.dir, 'Work', 'feat: work', 60_000, { signal: stop.signal });
      await sleep(400);
      stop.abort();
      threw = await saving.catch((err: unknown) => err);
    });
    expect((threw as Error).name).toBe('CommitStopped');
    expect(worst).toBeLessThan(NO_FREEZE_MS);
    expect(fs.readFileSync(path.join(wt.dir, 'README.md'), 'utf8')).toBe('# changed\n');
  }, 30_000);

  it('the changed files, against the files on disk and the new ones', async () => {
    const wt = await copy();
    slowGit('--name-only', '--others');
    let files: string[] = [];
    expect(await worstWait(async () => {
      files = await changedFiles(wt.dir, wt.baseCommit);
    })).toBeLessThan(NO_FREEZE_MS);
    expect(files.sort()).toEqual(['README.md', 'new.txt']);
    expect((await workSoFar(wt.dir, wt.baseCommit)).sort()).toEqual(['README.md', 'new.txt']);
  });

  it('the Changes tab', async () => {
    const bp = liveBoard();
    const wt = await copy();
    ticketOn(bp, 'AP-1', wt);
    slowGit('diff', '--others');
    let names: string[] = [];
    expect(await worstWait(async () => {
      names = (await ticketChanges(bp, 'AP-1')).files.map((f) => f.path);
    })).toBeLessThan(NO_FREEZE_MS);
    expect(names.sort()).toEqual(['README.md', 'new.txt']);
  });

  it('putting back what a setup rewrote', async () => {
    const wt = await copy();
    fs.rmSync(path.join(wt.dir, 'new.txt'));
    slowGit('--name-only', 'checkout HEAD');
    let back: string[] = [];
    expect(await worstWait(async () => {
      back = await putBackTracked(wt.dir);
    })).toBeLessThan(NO_FREEZE_MS);
    expect(back).toEqual(['README.md']);
    expect(fs.readFileSync(path.join(wt.dir, 'README.md'), 'utf8')).toBe('# app\n');
  });

  it('a merge moves the person’s own copy, as one piece', async () => {
    const wt = await copy();
    fs.rmSync(path.join(wt.dir, 'new.txt'));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm change', wt.dir);
    expect(mergeIntoBase(project, 'main', 'squad/ap-1', 'Merge it').moved).toBe(true);
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# changed\n');
  });

  it('moving the base says why when it cannot, as before', async () => {
    const wt = await copy();
    fs.rmSync(path.join(wt.dir, 'new.txt'));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm change', wt.dir);
    const head = sh('git rev-parse HEAD', wt.dir);
    put(path.join(project, 'README.md'), '# mine\n');
    const moved = moveBase(project, 'main', head);
    expect(moved.moved).toBe(false);
    expect(moved.note).toMatch(/was not moved .*Run: git merge --ff-only/);
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# mine\n');
  });

  it('looking at what an agent may not change', async () => {
    const wt = await copy();
    slowGit('ls-files');
    expect(await worstWait(() => watchLane(wt.dir, ['.squad/', 'CLAUDE.md']))).toBeLessThan(NO_FREEZE_MS);
  });

  it('finding the .env files, and copying them', async () => {
    put(path.join(project, '.env'), 'A=1\n');
    sh('echo .env >> .git/info/exclude', project);
    const to = path.join(tmp, 'to');
    fs.mkdirSync(to);
    slowGit('--ignored');
    let files: string[] = [];
    expect(await worstWait(async () => {
      files = await copyEnvFiles(project, to);
    })).toBeLessThan(NO_FREEZE_MS);
    expect(files).toEqual(['.env']);
  });
});

describe.skipIf(!POSIX)('Add project: what it found', () => {
  it('reads the whole project beside everything else', async () => {
    slowGit('status', 'ls-files');
    expect(await worstWait(() => firstLook(project))).toBeLessThan(NO_FREEZE_MS);
    expect(await worstWait(() => gitState(project))).toBeLessThan(NO_FREEZE_MS);
  });

  it('the setup’s first look holds up nothing either', async () => {
    const bp = liveBoard();
    writeMeta(bp, { ...readMeta(bp), setup: { kind: 'repo', startedAt: new Date().toISOString(), steps: [{ id: 'tool', state: 'todo' }, { id: 'read', state: 'todo' }] } });
    slowGit('status', 'ls-files');
    expect(await worstWait(() => readStarted(bp, { label: 'Claude', ready: true }))).toBeLessThan(NO_FREEZE_MS);
  });

  it('says the true count of a project over 5000 files, in a way a person reads it', async () => {
    const dir = path.join(project, 'src');
    fs.mkdirSync(dir);
    for (let i = 0; i < 5200; i += 1) fs.writeFileSync(path.join(dir, `f${i}.ts`), '');
    sh('git add -A && git commit -qm many', project);
    const look = await firstLook(project);
    expect(look.files).toBe(5201);
    expect(look.found).toBe('A TypeScript project with 5,201 files.');
    expect(await countFiles(project)).toBe(5201);
  });

  it('says the true count of a folder that is not in git too', async () => {
    const dir = path.join(tmp, 'plain');
    for (let i = 0; i < 5100; i += 1) put(path.join(dir, `d${i % 50}`, `f${i}.py`), '');
    const look = await firstLook(dir);
    expect(look.files).toBe(5100);
    expect(look.found).toBe('A Python project with 5,100 files, not in git yet.');
  });

  it('a look does not take a lock on the person’s own files', async () => {
    put(path.join(project, 'README.md'), '# mine\n');
    slowGit('status');
    const looking = gitState(project);
    await sleep(100);
    // Their own git goes on while squad-kit looks.
    sh(`"${realGit}" add README.md`, project);
    expect((await looking).unsaved).toBe(1);
  });
});

describe.skipIf(!POSIX)('the folder browser', () => {
  it('opens at once: only what it found reads the whole project, in a call of its own', async () => {
    const app = new Hono();
    mountAppApi(app, { projects: {} as OpenProjects });
    slowGit('status', 'ls-files');
    let listing: { canAdd: boolean; look?: unknown } | undefined;
    const started = performance.now();
    const res = await app.request(`/api/v1/app/folders?path=${encodeURIComponent(project)}`);
    listing = (await res.json()) as typeof listing;
    expect(performance.now() - started).toBeLessThan(NO_FREEZE_MS);
    expect(listing).toMatchObject({ canAdd: true });
    expect(listing!.look).toBeUndefined();
    expect(asked().some((l) => / (status|ls-files) /.test(l))).toBe(false);
    const look = (await (await app.request(`/api/v1/app/folders/look?path=${encodeURIComponent(project)}`)).json()) as { found: string };
    expect(look.found).toBe('A project with 1 file.');
  });

  it('adding a new project does not look at every process on the computer for its copies, as it has none', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho ps >> "${log}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    expect(await stopLeftovers([path.join(tmp, 'no-copies-yet')])).toEqual([]);
    expect(asked()).toEqual([]);
  });
});

describe.skipIf(!POSIX)('git’s output on a big project', () => {
  /** Real index entries, enough that listing the index says more than 32 MB, with no file on disk and no blob: fast to make. */
  function hugeIndex(dir: string, env?: NodeJS.ProcessEnv): void {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '' , encoding: 'utf8' }).trim();
    const long = Array.from({ length: 8 }, () => 'x'.repeat(100)).join('/');
    const lines: string[] = [];
    for (let i = 0; i < 40_000; i += 1) lines.push(`100644 ${blob}\t${long}/f${i}`);
    execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: lines.join('\n'), maxBuffer: 1 << 26, env: { ...process.env, ...env } });
  }

  function nestedRepo(): string {
    const sub = path.join(project, 'sub');
    fs.mkdirSync(sub);
    sh('git init -q -b main && git commit -q --allow-empty -m one', sub);
    sh('git add sub', project);
    sh('git -c user.name=t -c user.email=t@t commit -qm "add sub"', project);
    sh('git commit -q --allow-empty -m two', sub);
    return sub;
  }

  it('a list of everything over the old limit still finds the nested repo, so it stays out of the save', () => {
    nestedRepo();
    hugeIndex(project);
    const said = execFileSync('git', ['ls-files', '-z', '--stage'], { cwd: project, maxBuffer: 1 << 28 });
    expect(said.length).toBeGreaterThan(32 * 1024 * 1024);
    stageAll(project);
    expect(sh('git diff --cached --name-only -- sub', project)).toBe('');
  }, 60_000);

  it('the same beside everything else', async () => {
    nestedRepo();
    hugeIndex(project);
    await stageAllLater(project);
    expect(sh('git diff --cached --name-only -- sub', project)).toBe('');
  }, 60_000);

  it('a safety check says so when git cannot answer: it never quietly finds nothing', async () => {
    const notRepo = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(notRepo);
    expect(() => stageAll(notRepo)).toThrow(/git ls-files failed/);
    await expect(stageAllLater(notRepo)).rejects.toThrow(/git ls-files failed/);
  });

  it('a git beside everything else hands on an answer over the old limit, and a record at a time', async () => {
    hugeIndex(project);
    expect((await gitLater(project, ['ls-files', '-z', '--stage'])).length).toBeGreaterThan(32 * 1024 * 1024);
    let n = 0;
    await gitRecords(project, ['ls-files', '-z', '--stage'], '\0', () => (n += 1));
    expect(n).toBeGreaterThanOrEqual(40_000);
  }, 60_000);

  it('an answer longer than the caller wants ends git, and never comes back as nothing', async () => {
    await expect(gitLater(project, ['log', '--format=%H%H%H'], { allowFail: true, mostBytes: 10 })).rejects.toBeInstanceOf(GitSaidTooMuch);
  });

  it('a merge that says more than the old limit is still a clash, not a failure', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" merge-tree "*) head -c 40000000 /dev/zero; exit 1 ;;\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    sh(`"${realGit}" branch other`, project);
    put(path.join(project, 'x.txt'), 'x\n');
    sh(`"${realGit}" add -A && "${realGit}" commit -qm x`, project);
    sh(`"${realGit}" checkout -q other`, project);
    put(path.join(project, 'y.txt'), 'y\n');
    sh(`"${realGit}" add -A && "${realGit}" commit -qm y && "${realGit}" checkout -q main`, project);
    expect(mergeWouldClash(project, 'main', 'other')).toBe(true);
  });

  it('a huge change is a list of files on the Changes tab, never "no changes"', async () => {
    const bp = liveBoard();
    const wt = await addWorktree(project, 'AP-1', 'main');
    ticketOn(bp, 'AP-1', wt);
    fs.writeFileSync(path.join(wt.dir, 'README.md'), `${'a line of text that is long enough\n'.repeat(2_400_000)}`);
    const c = await ticketChanges(bp, 'AP-1');
    expect(c.files.map((f) => f.path)).toEqual(['README.md']);
    expect(c.files[0]!.status).toBe('changed');
    expect(c.files[0]!.patch).toBe('');
    expect(c.cut).toBe(true);
  }, 60_000);

  it('a huge change is in full in the file the Reviewer reads, and is never told as no change', async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(wt.dir, 'README.md'), `${'a line of text that is long enough\n'.repeat(1_100_000)}`);
    const file = path.join(tmp, 'changes', 'CHANGES.diff');
    await writeChangesOf(wt.dir, wt.baseCommit, file, 'app');
    expect(fs.statSync(file).size).toBeGreaterThan(32 * 1024 * 1024);
    const end = fs.readFileSync(file, 'utf8').slice(-200);
    expect(end).toContain('New files in app/:');
    expect(fs.readFileSync(file, 'utf8').slice(0, 200)).not.toContain('Nothing changed');
  }, 60_000);

  it('no change at all still says so', async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    const file = path.join(tmp, 'changes', 'CHANGES.diff');
    await writeChangesOf(wt.dir, wt.baseCommit, file, 'app');
    expect(fs.readFileSync(file, 'utf8')).toBe('Nothing changed in the files git already has.\n\nNew files in app/:\n- none\n');
  });
});

describe.skipIf(!POSIX)('room on the disk for a first copy', () => {
  const FREE = 10 * 1024 * 1024;
  const fakeDisk = (free: number) => vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: free / 4096, bsize: 4096 } as Awaited<ReturnType<typeof fs.promises.statfs>>);

  beforeEach(() => {
    put(path.join(project, 'big.bin'), 'x'.repeat(30 * 1024 * 1024));
    sh('git add -A && git commit -qm big', project);
  });

  it('too little: stops with how much is needed and how much is free, in plain words, and makes nothing', async () => {
    fakeDisk(FREE);
    slowGit();
    const dir = path.join(worktreeRoot(project), 'ap-1');
    const err = await addWorktree(project, 'AP-1', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRoomForCopy);
    const words = (err as Error).message;
    expect(words).toBe("A copy of this project's code needs about 31 MB of free disk space, and this computer has 10 MB free. Free up some space, then press Try again.");
    expect(words).not.toMatch(/\b(git|commit|branch|yaml|port|pid)\b/i);
    // It reaches the card as it is, with Try again.
    expect(ownWords(err)).toBe(words);
    expect(fs.existsSync(dir)).toBe(false);
    expect(asked().some((l) => l.includes('worktree add'))).toBe(false);
    expect(sh('git branch --list squad/ap-1', project)).toBe('');
  });

  it('enough: the copy is made, and working out the size holds up nothing', async () => {
    fakeDisk(1024 * 1024 * 1024);
    slowGit('ls-tree');
    let made = '';
    expect(await worstWait(async () => {
      made = (await addWorktree(project, 'AP-1', 'main')).dir;
    })).toBeLessThan(NO_FREEZE_MS);
    expect(fs.statSync(path.join(made, 'big.bin')).size).toBe(30 * 1024 * 1024);
  });

  it('a size it cannot work out never stops a project', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('no disk to ask'));
    expect(fs.existsSync(path.join((await addWorktree(project, 'AP-1', 'main')).dir, 'big.bin'))).toBe(true);
  });

  it('a list of files it cannot read never stops a project either', async () => {
    fakeDisk(FREE);
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" ls-tree "*) exit 1 ;;\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    expect(fs.existsSync(path.join((await addWorktree(project, 'AP-1', 'main')).dir, 'big.bin'))).toBe(true);
  });

  it('a disk that fills up during the copy says so plainly too', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" worktree add "*) echo "fatal: cannot write: No space left on device" >&2; exit 128 ;;\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    const err = await addWorktree(project, 'AP-1', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRoomForCopy);
    expect((err as Error).message).toBe('The disk filled up while squad-kit made its copy of the code. Free up some space, then press Try again.');
    await untilClear(project);
  });
});

describe('the words on the card', () => {
  it('say in plain words that a copy is being made and that it takes a while', () => {
    expect(DOING.copy).toBe('Making a copy of the code. On a big project this takes a while.');
    expect(DOING.copy).not.toMatch(/\b(git|commit|branch|worktree)\b/i);
  });
});
