import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, listReleases, readMeta, readRelease, readTicket, updateTicket, writeMeta, writeRelease, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import { addNote, approve, approveBeside, decideStuckBeside, handOver, releaseVersion, requestChange, startChat, stopTicket } from '../src/board/actions.js';
import { takeOutOfRelease } from '../src/board/release-tidy.js';
import { addWorktree, gitLater } from '../src/engine/git.js';
import { addWorktree as copyFor } from './support/copy.js';
import { deleteTicket } from '../src/engine/delete.js';
import { leaveOutProblem } from '../src/engine/leave-out.js';
import { moveLocalBase } from '../src/engine/release.js';
import { killAll, trackTask } from '../src/engine/process-group.js';
import { LiveSquad } from '../src/engine/live.js';
import { AppRunner, stopApps } from '../src/engine/run-app.js';
import { dropSetupCopies, runSetupProof, setupCopyDir } from '../src/engine/onboard.js';
import { harnessView } from '../src/engine/harness.js';
import { endRuns } from '../src/commands/console.js';
import { reposOf } from '../src/engine/repos.js';
import { freePort } from './support/tiny-app.js';

/**
 * What can happen now that git runs beside everything else: a second button pressed in the middle of a slow step. Each
 * test starts the slow step for real, with a slow `git` first on the path, presses the other button during it, and looks
 * at what is on disk after.
 */

const POSIX = process.platform !== 'win32';
const realGit = POSIX ? execSync('command -v git', { encoding: 'utf8' }).trim() : 'git';
const startPath = process.env.PATH;
const SLOW_S = 2;

let tmp: string;
let project: string;
let log: string;
let bp: BoardPaths;
const stops: (() => void)[] = [];

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function slowGit(...matches: string[]): void {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cases = matches.map((m) => `  *" ${m} "*) sleep ${SLOW_S} ;;`).join('\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in\n${cases || '  *zzz*) ;;'}\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${startPath}`;
}

const asked = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

/** Until git really is at the slow step the test asks for. */
async function untilGit(what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (asked().some((l) => l.includes(what))) return;
    await sleep(10);
  }
  throw new Error(`git never ran: ${what}`);
}

function board(remote = ''): BoardPaths {
  const b = boardPaths(path.join(project, '.squad'));
  writeMeta(b, {
    project: 'App',
    key: 'AP',
    nextNumber: 10,
    engine: 'live',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote },
    scan: { status: 'done', empty: false },
  });
  return b;
}

const lastMerge = () => sh('git log --merges --format=%s', project).split('\n').filter(Boolean);

/** A ticket at the proof, with its change not saved yet in its own copy. */
function atProof(id: string, file: string, more: Partial<Ticket> = {}): Ticket {
  const wt = copyFor(project, id, 'main');
  put(path.join(wt.dir, file), `${file}\n`);
  const t: Ticket = {
    id,
    title: `Change ${file}`,
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: 'Proof ready to check',
    waiting: { kind: 'proof', summary: 'Ready' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    ...more,
  };
  writeTicket(bp, t);
  return t;
}

/** Keeps the project's `.squad` in git, as a project with documents in git has it after a release. */
function squadInGit(): void {
  sh('git add -f .squad && git commit -qm "project files"', project);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-races-')));
  log = path.join(tmp, 'git-asked.log');
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  put(path.join(project, 'README.md'), '# app\n');
  sh('git add -A && git commit -qm start', project);
  bp = board();
  sh('echo .squad >> .git/info/exclude', project);
});

afterEach(async () => {
  process.env.PATH = startPath;
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!POSIX)('1. work the person rejected never merges', () => {
  it("Something's wrong during the save is refused in plain words", async () => {
    atProof('AP-1', 'one.txt');
    slowGit('add -A');
    const going = approveBeside(bp, 'AP-1');
    await untilGit('add -A');
    expect(() => requestChange(bp, 'AP-1', 'The button is wrong')).toThrow(/AP-1 is being saved/);
    await going;
    expect(readTicket(bp, 'AP-1')!.changeRequest).toBeUndefined();
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  }, 30_000);

  it('Delete during the save is refused in plain words', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('add -A');
    const going = approveBeside(bp, 'AP-1');
    await untilGit('add -A');
    await expect(deleteTicket(bp, 'AP-1')).rejects.toThrow(/AP-1 is being saved/);
    await going;
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  }, 30_000);

  it('Hand over during the save is refused in plain words', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('add -A');
    const going = approveBeside(bp, 'AP-1');
    await untilGit('add -A');
    await expect(handOver(bp, 'AP-1', { to: 'Sara' })).rejects.toThrow(/AP-1 is being saved/);
    await going;
    expect(readTicket(bp, 'AP-1')!.owner).toBe('Momen');
  }, 30_000);

  it('a talk during the save is refused in plain words', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('add -A');
    const going = approveBeside(bp, 'AP-1');
    await untilGit('add -A');
    expect(() => startChat(bp, 'AP-1', 'analyst')).toThrow(/AP-1 is being saved/);
    await going;
    expect(readTicket(bp, 'AP-1')!.chat?.open).toBeFalsy();
  }, 30_000);

  it('the state is read again right before the merge: a ticket that moved on does not go in', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('add -A');
    const main = sh('git rev-parse main', project);
    const going = approveBeside(bp, 'AP-1');
    await untilGit('add -A');
    // As another window of the app would, which knows nothing of this save.
    updateTicket(bp, 'AP-1', (t) => {
      t.waiting = null;
      t.live = true;
      t.status = 'Builder is fixing what you found';
    });
    await expect(going).rejects.toThrow(/AP-1 changed while it was saved, so it did not go in/);
    expect(sh('git rev-parse main', project)).toBe(main);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeUndefined();
  }, 30_000);

  it("a press during the merge does not leave the code in the base and the ticket rejected", async () => {
    atProof('AP-1', 'one.txt');
    slowGit('merge --ff-only');
    let said: unknown;
    const going = approveBeside(bp, 'AP-1');
    const pressing = untilGit('merge --ff-only').then(() => {
      try {
        requestChange(bp, 'AP-1', 'The button is wrong');
      } catch (err) {
        said = err;
      }
    });
    await going;
    await pressing;
    expect(said).toBeInstanceOf(Error);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.changeRequest).toBeUndefined();
    expect(t.stage).toBe('release');
    expect(t.mergedAt).toBeTruthy();
  }, 30_000);

  it('Try the save again: Delete during it is refused too', async () => {
    atProof('AP-1', 'one.txt');
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    put(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    await expect(approveBeside(bp, 'AP-1')).rejects.toThrow(/See the ways out/);
    const again = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'save-again');
    fs.rmSync(hook);
    slowGit('add -A');
    const going = decideStuckBeside(bp, 'AP-1', again);
    await untilGit('add -A');
    await expect(deleteTicket(bp, 'AP-1')).rejects.toThrow(/AP-1 is being saved/);
    await going;
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  }, 30_000);
});

describe.skipIf(!POSIX)('2. the project’s files stay real while the person’s own copy moves', () => {
  it('a look during the merge sees the real settings and tickets, and what is saved during it stays', async () => {
    const done = atProof('AP-0', 'zero.txt', { stage: 'implement', status: 'Old', waiting: null });
    squadInGit();
    atProof('AP-1', 'one.txt');
    // On disk and not in git yet: what the person changed since the last save of these files.
    writeMeta(bp, { ...readMeta(bp), atOnce: 3 });
    updateTicket(bp, done.id, (t) => (t.stage = 'test'));
    slowGit('merge --ff-only');
    const going = approveBeside(bp, 'AP-1');
    let setting: number | undefined;
    let stage: string | undefined;
    const during = untilGit('merge --ff-only').then(() => {
      setting = readMeta(bp).atOnce;
      stage = readTicket(bp, 'AP-0')!.stage;
      writeMeta(bp, { ...readMeta(bp), atOnce: 4 });
    });
    await going;
    await during;
    expect(setting).toBe(3);
    expect(stage).toBe('test');
    expect(readMeta(bp).atOnce).toBe(4);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  }, 30_000);

  it('a release moving the base during an accept never writes the old files over the real ones', async () => {
    atProof('AP-0', 'zero.txt', { stage: 'implement', status: 'Old', waiting: null });
    squadInGit();
    atProof('AP-1', 'one.txt');
    writeMeta(bp, { ...readMeta(bp), atOnce: 3 });
    const releaseCopy = path.join(tmp, 'release-copy');
    sh(`git worktree add -q -b rel "${releaseCopy}" main`, project);
    put(path.join(releaseCopy, 'rel.txt'), 'rel\n');
    // A release carries the project's own files too.
    fs.appendFileSync(path.join(releaseCopy, '.squad', 'config.yaml'), '# with the release\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm rel', releaseCopy);
    const head = sh('git rev-parse HEAD', releaseCopy);
    slowGit('merge --ff-only');
    const going = approveBeside(bp, 'AP-1');
    const lines: { ok: boolean; text: string }[] = [];
    const moving = untilGit('merge --ff-only').then(() => moveLocalBase(project, 'main', head, 'v1.0.0', '.squad', lines));
    await going;
    await moving;
    expect(readMeta(bp).atOnce).toBe(3);
    expect(sh('git merge-base --is-ancestor rel main && echo yes', project)).toBe('yes');
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  }, 30_000);

  it('squad-kit’s own look in the person’s folder takes its turn: a merge never runs into the lock git holds for it', async () => {
    atProof('AP-0', 'zero.txt', { stage: 'release', status: 'Merged', waiting: null, localSetup: { status: 'pending', dir: project, command: 'true' } });
    atProof('AP-1', 'one.txt');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const lock = path.join(project, '.git', 'index.lock');
    // git diff writes a fresh index when it can, and holds its lock while it does.
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in\n  *" --relative "*) : > "${lock}"; sleep 4; rm -f "${lock}" ;;\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    stops.push(new LiveSquad(bp).start(25));
    await untilGit('--relative');
    const t = await approveBeside(bp, 'AP-1');
    expect(t.status).toMatch(/^Merged into main/);
    expect(t.mergedAt).toBeTruthy();
  }, 30_000);
});

describe.skipIf(!POSIX)('3. a restart or a quit never kills a move half way', () => {
  it('a kill of everything that runs cannot land in the middle of the merge', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('merge --ff-only');
    const going = approveBeside(bp, 'AP-1');
    const killing = untilGit('merge --ff-only').then(() => killAll());
    const t = await going;
    await killing;
    expect(t.mergedAt).toBeTruthy();
    expect(fs.existsSync(path.join(project, 'one.txt'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.git', 'index.lock'))).toBe(false);
  }, 30_000);

  it('a git beside everything else that is still running is asked to end before it is killed', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const told = path.join(tmp, 'told.txt');
    const ready = path.join(tmp, 'ready.txt');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntrap 'echo term >> "${told}"; exit 143' TERM\n: > "${ready}"\nsleep 30 &\nwait $!\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    const running = gitLater(project, ['add', '-A'], { allowFail: true });
    while (!fs.existsSync(ready)) await sleep(10);
    await endRuns(100);
    await running;
    expect(fs.readFileSync(told, 'utf8')).toContain('term');
  }, 30_000);
});

describe.skipIf(!POSIX)('4. taking a ticket out of a release', () => {
  /** Two tickets in the draft, merged. */
  const twoAccepted = () => {
    atProof('AP-1', 'one.txt');
    approve(bp, 'AP-1');
    atProof('AP-2', 'two.txt');
    approve(bp, 'AP-2');
  };

  it('a ticket accepted and notes edited during the check stay', async () => {
    twoAccepted();
    atProof('AP-3', 'three.txt');
    slowGit('revert');
    const version = readTicket(bp, 'AP-1')!.release!;
    const taking = takeOutOfRelease(bp, version, 'AP-1');
    await untilGit('revert');
    approve(bp, 'AP-3');
    writeRelease(bp, { ...readRelease(bp, version)!, notes: 'Notes written during the check' });
    const after = await taking;
    expect(after.tickets).toEqual(['AP-2', 'AP-3']);
    expect(readRelease(bp, version)!.tickets).toEqual(['AP-2', 'AP-3']);
    expect(readRelease(bp, version)!.out).toEqual(['AP-1']);
    expect(readRelease(bp, version)!.notes).toBe('Notes written during the check');
  }, 30_000);

  it('Release pressed during the check waits for it, and does not ship what was taken out', async () => {
    twoAccepted();
    slowGit('revert');
    const version = readTicket(bp, 'AP-1')!.release!;
    const taking = takeOutOfRelease(bp, version, 'AP-1');
    await untilGit('revert');
    const sent = await releaseVersion(bp);
    await taking;
    expect(sent.tickets).toEqual(['AP-2']);
    expect(() => sh(`git show ${sent.version}:one.txt`, project)).toThrow();
    expect(sh(`git show ${sent.version}:two.txt`, project)).toBe('two.txt');
  }, 45_000);
});

describe.skipIf(!POSIX)('5. Stop on Your apps', () => {
  const runners: AppRunner[] = [];
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    put(path.join(project, 'server.js'), `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');\n`);
    sh('git add -A && git commit -qm server', project);
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
  });

  afterEach(async () => {
    for (const r of runners.splice(0)) r.stopAll();
    stopApps(bp);
    await sleep(200);
  });

  const answers = () => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);

  it.each([
    ['its settings being copied', '--ignored'],
    ['its copy being brought up to date', 'checkout --force'],
    ['the list of what it needs being read', 'ls-tree -r'],
  ])('during %s, the app never starts', async (_, step) => {
    const r = new AppRunner(bp, { waitMs: 20_000 });
    runners.push(r);
    r.start();
    expect((await r.settled()).state).toBe('running');
    await r.stop();
    slowGit(step);
    fs.rmSync(log, { force: true });
    r.start();
    await untilGit(step);
    await r.stop();
    await sleep(1800);
    expect((await r.statusOf()).state).toBe('stopped');
    expect(await answers()).toBe(false);
  }, 45_000);
});

describe.skipIf(!POSIX)('6. two moves of the person’s own copy', () => {
  it('two Looks right at once both go in, and neither says the person’s copy has changes', async () => {
    atProof('AP-1', 'one.txt');
    atProof('AP-2', 'two.txt');
    slowGit('merge --ff-only');
    const [a, b] = await Promise.all([approveBeside(bp, 'AP-1'), approveBeside(bp, 'AP-2')]);
    for (const t of [a, b]) {
      expect(t.status).toMatch(/^Merged into main/);
      expect(t.mergedAt).toBeTruthy();
    }
    expect(fs.existsSync(path.join(project, 'one.txt'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'two.txt'))).toBe(true);
  }, 30_000);

  it('a release that cannot move the person’s own copy keeps git’s words and commands out of its log', async () => {
    const other = path.join(tmp, 'other');
    sh(`git worktree add -q -b rel "${other}" main`, project);
    put(path.join(other, 'README.md'), '# from the release\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm rel', other);
    const head = sh('git rev-parse HEAD', other);
    // The base moved on while it went out, and the person changed the same file.
    put(path.join(project, 'more.txt'), 'more\n');
    sh('git add more.txt && git -c user.name=t -c user.email=t@t commit -qm more', project);
    put(path.join(project, 'README.md'), '# mine\n');
    const lines: { ok: boolean; text: string }[] = [];
    await moveLocalBase(project, 'main', head, 'v1.0.0', undefined, lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ok).toBe(false);
    expect(lines[0]!.text).not.toMatch(/Run:|fatal|error:|would be overwritten|Not possible/i);
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# mine\n');
  });
});

describe.skipIf(!POSIX)('7. Stop on a ticket that merged', () => {
  const autoTicket = () =>
    atProof('AP-1', 'one.txt', { track: 'auto', stage: 'review', waiting: null, live: true, status: 'Accepting', squad: { phase: 'accept', nextAt: new Date().toISOString() } });

  const noStopCard = (t: Ticket) => {
    expect(t.mergedAt).toBeTruthy();
    expect(t.stopRequested).toBeUndefined();
    expect(t.stuck).toBeUndefined();
    expect(t.status).toMatch(/^Merged into main/);
    expect(t.activity.some((a) => /stopped the squad/i.test(a.text))).toBe(false);
  };

  it('Stop pressed during a Builds by itself merge never puts "You stopped the squad" on it', async () => {
    autoTicket();
    slowGit('merge --ff-only');
    stops.push(new LiveSquad(bp).start(25));
    await untilGit('merge --ff-only');
    try {
      stopTicket(bp, 'AP-1');
    } catch {
      // It is not running any more: nothing to stop.
    }
    const end = Date.now() + 20_000;
    while (!readTicket(bp, 'AP-1')!.mergedAt && Date.now() < end) await sleep(20);
    await sleep(400);
    noStopCard(readTicket(bp, 'AP-1')!);
  }, 30_000);

  it('a Stop left on a merged ticket goes quietly', async () => {
    atProof('AP-1', 'one.txt');
    await approveBeside(bp, 'AP-1');
    updateTicket(bp, 'AP-1', (t) => (t.stopRequested = true));
    stops.push(new LiveSquad(bp).start(25));
    await sleep(500);
    noStopCard(readTicket(bp, 'AP-1')!);
  }, 30_000);
});

describe.skipIf(!POSIX)('8. a second press', () => {
  it('Looks right again during the merge is refused, and it goes in once', async () => {
    atProof('AP-1', 'one.txt');
    slowGit('merge --ff-only');
    const first = approveBeside(bp, 'AP-1');
    const second = untilGit('merge --ff-only').then(() => approveBeside(bp, 'AP-1'));
    expect((await first).mergedAt).toBeTruthy();
    await expect(second).rejects.toThrow(/being saved|not waiting for an approval/);
    expect(lastMerge()).toHaveLength(1);
    expect(readTicket(bp, 'AP-1')!.status).toMatch(/^Merged into main/);
  }, 30_000);

  it('Looks right again while its merge waits its turn is refused in plain words', async () => {
    atProof('AP-1', 'one.txt');
    const other = path.join(tmp, 'other');
    sh(`git worktree add -q -b rel "${other}" main`, project);
    put(path.join(other, 'rel.txt'), 'rel\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm rel', other);
    const head = sh('git rev-parse HEAD', other);
    slowGit('--untracked-files=no');
    const lines: { ok: boolean; text: string }[] = [];
    // A release moving the base holds its turn for a moment, looking at the person's own folder first.
    const moving = moveLocalBase(project, 'main', head, 'v1.0.0', undefined, lines);
    await untilGit('--untracked-files=no');
    const first = approveBeside(bp, 'AP-1');
    await untilGit('commit');
    await sleep(100);
    await expect(approveBeside(bp, 'AP-1')).rejects.toThrow(/AP-1 is being saved/);
    expect((await first).mergedAt).toBeTruthy();
    await moving;
    expect(lastMerge()).toHaveLength(1);
    expect(lines.every((l) => l.ok)).toBe(true);
  }, 30_000);

  it('Delete pressed twice: one delete, and neither says it is not fully deleted', async () => {
    const wt = await addWorktree(project, 'AP-1', 'main');
    put(path.join(wt.dir, 'one.txt'), 'one\n');
    writeTicket(bp, { ...atProof('AP-2', 'two.txt'), id: 'AP-1', worktree: wt.dir, branch: wt.branch, baseCommit: wt.baseCommit, waiting: null, title: 'One' });
    slowGit('worktree remove');
    const [a, b] = await Promise.all([deleteTicket(bp, 'AP-1'), deleteTicket(bp, 'AP-1')]);
    expect(a.id).toBe('AP-1');
    expect(b.id).toBe('AP-1');
    expect(readTicket(bp, 'AP-1')).toBeNull();
    expect(sh('git branch --list squad/ap-1', project)).toBe('');
  }, 30_000);
});

describe.skipIf(!POSIX)('9. two leave-out checks at once', () => {
  it('neither removes the other’s copy, and neither says a false "cannot be left out"', async () => {
    atProof('AP-1', 'one.txt');
    approve(bp, 'AP-1');
    atProof('AP-2', 'two.txt');
    approve(bp, 'AP-2');
    slowGit('revert');
    const [a, b] = await Promise.all([leaveOutProblem(project, 'main', [readTicket(bp, 'AP-1')!]), leaveOutProblem(project, 'main', [readTicket(bp, 'AP-2')!])]);
    expect(a).toBeNull();
    expect(b).toBeNull();
  }, 30_000);
});

describe.skipIf(!POSIX)('10. a hand over', () => {
  it('a note written during its push stays', async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main`, project);
    writeMeta(bp, { ...readMeta(bp), git: { base: 'main', remote: 'origin' }, documentsInGit: true });
    atProof('AP-1', 'one.txt', { waiting: { kind: 'stuck', summary: 'Stopped' }, stage: 'implement' });
    slowGit('push');
    const going = handOver(bp, 'AP-1', { to: 'Sara', note: 'From me' });
    await untilGit('push');
    addNote(bp, 'AP-1', { text: 'Written during the push' });
    await going;
    const notes = readTicket(bp, 'AP-1')!.notes!.map((n) => n.text);
    expect(notes).toContain('From me');
    expect(notes).toContain('Written during the push');
  }, 30_000);
});

describe.skipIf(!POSIX)('11. two rare races', () => {
  it('an accept while the remote is asked about the next number is never lost', async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main`, project);
    writeMeta(bp, { ...readMeta(bp), git: { base: 'main', remote: 'origin' } });
    atProof('AP-1', 'one.txt');
    approve(bp, 'AP-1');
    const version = readTicket(bp, 'AP-1')!.release!;
    sh(`git -c user.name=t -c user.email=t@t tag -a ${version} -m theirs && git push -q origin ${version} && git tag -d ${version}`, project);
    atProof('AP-2', 'two.txt');
    slowGit('ls-remote');
    const going = releaseVersion(bp);
    // The second time the remote is asked: the number after the one a teammate took.
    const end = Date.now() + 20_000;
    while (asked().filter((l) => l.includes('ls-remote')).length < 2 && Date.now() < end) await sleep(10);
    approve(bp, 'AP-2');
    const sent = await going;
    expect(sent.tickets).toEqual(['AP-1']);
    const t = readTicket(bp, 'AP-2')!;
    expect(listReleases(bp).find((r) => r.version === t.release)?.tickets).toContain('AP-2');
    expect(readRelease(bp, t.release!)!.status).toBe('draft');
  }, 45_000);

  it('the setup’s copy is not removed under a step that just took it as whole', async () => {
    const meta = readMeta(bp);
    const repo = reposOf(meta)[0]!;
    const steps = ['files', 'tool', 'read', 'commands', 'tests', 'app', 'overview'].map((id) => ({ id, state: id === 'commands' ? ('todo' as const) : ('done' as const) }));
    writeMeta(bp, { ...meta, setup: { kind: 'repo', startedAt: new Date().toISOString(), steps: steps as never } });
    const dir = setupCopyDir(bp, repo);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh(`git worktree add -q --detach "${dir}" main`, project);
    slowGit('worktree remove');
    trackTask(dropSetupCopies(bp));
    await runSetupProof(bp, { signal: new AbortController().signal, shoot: async () => ({}) });
    await sleep(2500);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  }, 30_000);
});

describe('the Harness page', () => {
  it('has a row for the room a first copy needs on the disk', () => {
    const view = harnessView();
    const rows = [...view.stages.flatMap((s) => s.gates), ...view.alwaysOn];
    const row = rows.find((r) => r.id === 'room-for-copy');
    expect(row).toBeTruthy();
    expect(row!.name).toBe('Room on the disk');
    expect(`${row!.what} ${row!.fail ?? row!.then ?? ''}`).not.toMatch(/\b(git|commit|branch|yaml|port|pid)\b/i);
  });
});

describe.skipIf(!POSIX)('a fetch beside another fetch', () => {
  it('a release merged with a teammate’s work takes the base, never what another fetch left in git’s note of the last fetch', async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, tmp);
    sh(`git remote add origin "${bare}" && git push -q origin main`, project);
    writeMeta(bp, { ...readMeta(bp), git: { base: 'main', remote: 'origin' } });
    // A branch of someone else's work, which must not reach the base.
    const mate = path.join(tmp, 'mate');
    sh(`git clone -q "${bare}" "${mate}"`, tmp);
    sh('git checkout -q -b other && echo other > other.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm other && git push -q origin other && git checkout -q main', mate);
    sh('echo team > team.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm team && git push -q origin main', mate);
    atProof('AP-1', 'one.txt');
    approve(bp, 'AP-1');
    // The moment right after a fetch ends: another fetch in the same repo has written its own note over it.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n"${realGit}" "$@"\ncode=$?\ncase " $* " in\n  *" fetch "*) "${realGit}" fetch -q origin other ;;\nesac\nexit $code\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    const sent = await releaseVersion(bp);
    expect(sent.unpushed ?? []).toEqual([]);
    expect(sh('git show main:one.txt', bare)).toBe('one.txt');
    expect(sh('git show main:team.txt', bare)).toBe('team');
    expect(() => sh('git show main:other.txt', bare)).toThrow();
  }, 45_000);
});
