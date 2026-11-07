import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * The squad itself, making a first copy on a big project: the card says so, Stop lands during it, a delete and a restart
 * in the middle leave nothing half made in use, and a story then goes on in a whole copy. Every agent run is a fake the
 * test ends. A filter that takes its time makes the checkout slow for real.
 */

type Run = { opts: RunOptions; end(r?: Partial<RunResult>): void };
const runs: Run[] = [];

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      let over = false;
      const end = (r: Partial<RunResult> = {}) => {
        if (over) return;
        over = true;
        resolve({ ok: false, sessionId: opts.sessionId ?? opts.resume ?? '', text: '', error: 'Ended by the test.', ...r });
      };
      runs.push({ opts, end });
      opts.signal?.addEventListener('abort', () => end({ error: 'You stopped the squad.' }));
    }),
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket, decideStuck, stopTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { worktreeRoot } = await import('../src/engine/git.js');
const { deleteTicket } = await import('../src/engine/delete.js');
const { DOING } = await import('../src/engine/plain-doing.js');
const { prepareProject } = await import('../src/engine/setup.js');
const { setupAgain, setupView, stopSetup } = await import('../src/board/first-run.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(what: string, check: () => boolean, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const FILES = 24;

/** A live project whose files come out of a filter that takes a while: its first copy takes about 3 seconds, and can be cut in the middle. */
function bigProject(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.txt'), 'old');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.slow filter=slow\n');
  for (let i = 0; i < FILES; i += 1) fs.writeFileSync(path.join(dir, 'files', `f${i}.slow`), `file ${i}\n`);
  sh(`git init -q -b main && git config filter.slow.clean cat && git config filter.slow.smudge "sh -c 'sleep 0.12; cat'" && git add -A && git commit -q -m start`, dir);
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands: {} });
  return bp;
}

/** A ticket whose plan is approved: its next step makes its copy. */
function readyToBuild(bp: ReturnType<typeof boardPaths>, title: string): string {
  const t = createTicket(bp, { title });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'implement';
    x.live = true;
    x.waiting = null;
    x.status = 'Building';
    x.steps = [{ title: 'Change it', status: 'todo' }];
    x.squad = { phase: 'build', nextAt: new Date().toISOString() };
  });
  return t.id;
}

const makingArea = (bp: ReturnType<typeof boardPaths>) => path.join(worktreeRoot(bp.root), '.making');
const leftInMaking = (bp: ReturnType<typeof boardPaths>) => (fs.existsSync(makingArea(bp)) ? fs.readdirSync(makingArea(bp)) : []);
const copyDir = (bp: ReturnType<typeof boardPaths>, id: string) => path.join(worktreeRoot(bp.root), id.toLowerCase());
const copies = (bp: ReturnType<typeof boardPaths>) => sh('git worktree list', bp.root).split('\n').length - 1;
const isWhole = (dir: string) => {
  expect(fs.readdirSync(path.join(dir, 'files'))).toHaveLength(FILES);
  expect(sh('git status --porcelain', dir)).toBe('');
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-big-live-')));
  fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), { force: true });
  runs.length = 0;
  setParallelLimit(5);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  vi.restoreAllMocks();
  await sleep(600);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a first save of a big folder with no git', () => {
  const realGit = execSync('command -v git', { encoding: 'utf8' }).trim();
  const startPath = process.env.PATH;
  const SLOW_S = 2;

  afterEach(() => {
    process.env.PATH = startPath;
  });

  /** Too big to save on the board's time: one big file, and `git add -A` takes a while. */
  function bigFolder(): string {
    const dir = path.join(tmp, 'big-plain');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'video.bin'), 'x'.repeat(60 * 1024 * 1024));
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" add -A "*) sleep ${SLOW_S} ;;\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${startPath}`;
    return dir;
  }

  const step = (bp: ReturnType<typeof boardPaths>) => readMeta(bp).setup!.steps.find((s) => s.id === 'files')!;

  it('goes in the background as a setup step the person can see, in plain words, and the read waits for it', async () => {
    const dir = bigFolder();
    const started = performance.now();
    const { bp } = prepareProject(dir);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(() => sh('git rev-parse --verify HEAD', dir)).toThrow();
    writeMeta(bp, { ...readMeta(bp), runner: 'direct' });
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      worst = Math.max(worst, performance.now() - last);
      last = performance.now();
    }, 10);
    stops.push(new LiveSquad(bp).start(25));
    await until('the step', () => step(bp).state === 'now');
    expect(step(bp).note).toBe('Saving your files for the first time. On a big project this takes a while.');
    expect(step(bp).note).not.toMatch(/\b(git|commit)\b/i);
    expect(setupView(bp)!.steps.find((s) => s.id === 'files')!.label).toBe('Saving your files');
    expect(readMeta(bp).scan?.status).toBe('pending');
    expect(runs).toHaveLength(0);
    await until('the save', () => step(bp).state === 'done');
    clearInterval(timer);
    expect(worst).toBeLessThan(1500);
    expect(sh('git log -1 --format=%s', dir)).toBe('start the project');
    expect(sh('git ls-files', dir).split('\n').sort()).toEqual(['app.py', 'video.bin']);
    expect(setupView(bp)!.steps.find((s) => s.id === 'files')!.label).toBe('Project memory created');
    // And the read goes on from there.
    await until('the read', () => runs.length === 1);
  }, 45_000);

  it('Stop ends it, Start again goes on, and nothing else starts in between', async () => {
    const dir = bigFolder();
    const { bp } = prepareProject(dir);
    writeMeta(bp, { ...readMeta(bp), runner: 'direct' });
    stops.push(new LiveSquad(bp).start(25));
    await until('the step', () => step(bp).state === 'now');
    stopSetup(bp);
    await until('the stop', () => step(bp).state === 'stopped');
    expect(() => sh('git rev-parse --verify HEAD', dir)).toThrow();
    await sleep(200);
    expect(runs).toHaveLength(0);
    expect(setupView(bp)!.steps.find((s) => s.id === 'files')!.ways.map((w) => w.label)).toEqual(['Start again']);
    setupAgain(bp, 'files');
    await until('the save', () => step(bp).state === 'done');
    expect(sh('git log -1 --format=%s', dir)).toBe('start the project');
  }, 45_000);

  it('a restart in the middle: it runs again, and saves once', async () => {
    const dir = bigFolder();
    const { bp } = prepareProject(dir);
    writeMeta(bp, { ...readMeta(bp), runner: 'direct' });
    const close = new LiveSquad(bp).start(25);
    await until('the step', () => step(bp).state === 'now');
    close();
    await sleep(100);
    stops.push(new LiveSquad(bp).start(25));
    await until('the save', () => step(bp).state === 'done');
    expect(sh('git rev-list --count HEAD', dir)).toBe('1');
  }, 45_000);

  it('a small folder is saved at once, as before', () => {
    const dir = path.join(tmp, 'small-plain');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    const { bp } = prepareProject(dir);
    expect(sh('git log -1 --format=%s', dir)).toBe('start the project');
    expect(step(bp).state).toBe('done');
  });
});

describe.skipIf(process.platform === 'win32')('a story’s first copy on a big project', () => {
  it('the card says a copy is being made, and the story goes on in the whole copy', async () => {
    const bp = bigProject('card');
    const id = readyToBuild(bp, 'A change');
    const squad = new LiveSquad(bp);
    stops.push(squad.start(25));
    await until('the card', () => readTicket(bp, id)!.status === DOING.copy);
    expect(DOING.copy).toBe('Making a copy of the code. On a big project this takes a while.');
    // Nothing is at the real place yet, and the ticket does not point at anything.
    expect(fs.existsSync(copyDir(bp, id))).toBe(false);
    expect(readTicket(bp, id)!.worktree).toBeUndefined();
    await until('the Builder', () => runs.length === 1);
    expect(runs[0]!.opts.cwd).toBe(copyDir(bp, id));
    isWhole(copyDir(bp, id));
    expect(readTicket(bp, id)!.status).not.toBe(DOING.copy);
    expect(readTicket(bp, id)!.activity.some((a) => a.text === 'Made a clean copy of the project')).toBe(true);
  }, 45_000);

  it('Stop lands during the copy, nothing half made stays in use, and Carry on makes it whole', async () => {
    const bp = bigProject('stop');
    const id = readyToBuild(bp, 'A change');
    const squad = new LiveSquad(bp);
    stops.push(squad.start(25));
    await until('the card', () => readTicket(bp, id)!.status === DOING.copy);
    await until('git at work', () => leftInMaking(bp).some((n) => fs.existsSync(path.join(makingArea(bp), n, id.toLowerCase(), '.git'))));
    await sleep(200);
    const at = Date.now();
    stopTicket(bp, id);
    await until('the stop', () => readTicket(bp, id)!.stuck?.question === 'You stopped the squad. Nothing was lost; the work so far is kept.');
    expect(Date.now() - at).toBeLessThan(5000);
    expect(readTicket(bp, id)!.worktree).toBeUndefined();
    expect(fs.existsSync(copyDir(bp, id))).toBe(false);
    expect(runs).toHaveLength(0);
    await until('the half copy gone', () => leftInMaking(bp).length === 0);
    expect(copies(bp)).toBe(0);

    decideStuck(bp, id, 0);
    await until('the Builder', () => runs.length === 1);
    isWhole(copyDir(bp, id));
  }, 60_000);

  it('a ticket deleted during its copy goes, with all of it', async () => {
    const bp = bigProject('deleted');
    const id = readyToBuild(bp, 'A change');
    const squad = new LiveSquad(bp);
    stops.push(squad.start(25));
    await until('git at work', () => leftInMaking(bp).some((n) => fs.existsSync(path.join(makingArea(bp), n, id.toLowerCase(), '.git'))));
    await deleteTicket(bp, id);
    expect(readTicket(bp, id)).toBeNull();
    expect(fs.existsSync(copyDir(bp, id))).toBe(false);
    expect(leftInMaking(bp)).toEqual([]);
    expect(copies(bp)).toBe(0);
    expect(sh(`git branch --list "squad/*"`, bp.root)).toBe('');
    expect(runs).toHaveLength(0);
  }, 45_000);

  it('a restart in the middle: no half copy is used, and the step makes it again and goes on', async () => {
    const bp = bigProject('restart');
    const id = readyToBuild(bp, 'A change');
    const close = new LiveSquad(bp).start(25);
    await until('git at work', () => leftInMaking(bp).some((n) => fs.existsSync(path.join(makingArea(bp), n, id.toLowerCase(), '.git'))));
    close();
    expect(fs.existsSync(copyDir(bp, id))).toBe(false);
    stops.push(new LiveSquad(bp).start(25));
    await until('the Builder', () => runs.length === 1, 40_000);
    isWhole(copyDir(bp, id));
    await until('nothing left half made', () => leftInMaking(bp).length === 0);
  }, 60_000);

  it('two stories starting at once in one project each get a whole copy, and no word about a lock', async () => {
    const bp = bigProject('both');
    const a = readyToBuild(bp, 'One');
    const b = readyToBuild(bp, 'Two');
    stops.push(new LiveSquad(bp).start(25));
    await until('both Builders', () => runs.length === 2, 40_000);
    isWhole(copyDir(bp, a));
    isWhole(copyDir(bp, b));
    for (const id of [a, b]) expect(readTicket(bp, id)!.stuck).toBeUndefined();
  }, 60_000);

  it('too little room on the disk: a plain card with Try again, and nothing started', async () => {
    const bp = bigProject('full');
    const id = readyToBuild(bp, 'A change');
    const disk = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 } as Awaited<ReturnType<typeof fs.promises.statfs>>);
    stops.push(new LiveSquad(bp).start(25));
    await until('the card', () => Boolean(readTicket(bp, id)!.stuck));
    const stuck = readTicket(bp, id)!.stuck!;
    expect(stuck.question).toMatch(/^A copy of this project's code needs about 1 MB of free disk space, and this computer has 1 MB free\. Free up some space, then press Try again\.$/);
    expect(stuck.options[0]!.name).toBe('Try again');
    expect(runs).toHaveLength(0);
    disk.mockRestore();

    decideStuck(bp, id, 0);
    await until('the Builder', () => runs.length === 1);
    isWhole(copyDir(bp, id));
  }, 60_000);
});
