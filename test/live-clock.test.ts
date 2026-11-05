import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * The live squad's clock (phases 4 and 7): each step records when it started and its latest action, the Builder's
 * clock moves with its plan steps, finished steps teach the usual times, a step past twice its usual time gets the
 * "Taking longer than usual" card, and Stop and try again starts the step again. Every agent run is a fake.
 */

type Run = { opts: RunOptions; end(r?: Partial<RunResult>): void };
const runs: Run[] = [];
let answer: ((opts: RunOptions) => Partial<RunResult> | null) | null = null;

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      let over = false;
      const run: Run = {
        opts,
        end: (r = {}) => {
          if (over) return;
          over = true;
          resolve({ ok: false, sessionId: opts.sessionId ?? opts.resume ?? '', text: '', error: 'Ended by the test.', ...r });
        },
      };
      runs.push(run);
      opts.signal?.addEventListener('abort', () => run.end({ error: 'You stopped the squad.' }));
      const now = answer?.(opts);
      if (now) run.end(now);
    }),
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket, keepWaiting, restartStep } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { addWorktree } = await import('../src/engine/git.js');
const { liveNow } = await import('../src/board/now.js');
const { readUsual, usualKey } = await import('../src/board/usual.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A live project with one commit, its Architect done, and a ticket with its own copy of the code. */
function liveTicket(name: string, over: Parameters<typeof updateTicket>[2] = () => {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'page.txt'), 'old');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'start'], { cwd: dir });
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands: {} });
  const t = createTicket(bp, { title: 'Show room capacity' });
  const wt = addWorktree(bp.root, t.id, 'main');
  updateTicket(bp, t.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.squad = null;
    over(x);
  });
  return { bp, id: t.id, wt };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-live-clock-')));
  fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), { force: true });
  runs.length = 0;
  answer = null;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the Builder on the clock', () => {
  it("times each plan step, keeps the latest action on the card, and teaches the project's usual time", async () => {
    const { bp, id, wt } = liveTicket('builder', (x) => {
      x.steps = [{ title: 'Read the booking page', status: 'todo' }, { title: 'Show how many fit', status: 'todo' }, { title: 'Tests', status: 'todo' }] as typeof x.steps;
      x.work = { steps: 3, tests: 1, screens: 0 };
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const later = (s: number) => vi.setSystemTime(Date.now() + s * 1000);
    let during: { line?: string; time?: string; doing?: string } = {};
    answer = (opts) => {
      if (opts.cwd !== wt.dir) return null;
      later(61);
      opts.onText?.('>> step 1');
      later(61);
      opts.onText?.('>> step 2');
      opts.onTool?.({ name: 'Edit', input: { file_path: path.join(wt.dir, 'src', 'booking.tsx') } });
      const t = readTicket(bp, id)!;
      const n = liveNow(t, readUsual(bp));
      during = { line: n.line, time: n.time, doing: t.clock?.doing };
      later(61);
      opts.onText?.('>> step 3');
      later(61);
      return { ok: true, structured: { summary: 'Done' } };
    };
    await (new LiveSquad(bp) as unknown as { build(id: string): Promise<void> }).build(id);
    expect(during).toEqual({ line: 'Builder · step 2 of 3 · writing the code', time: '1 s · usually 2 to 4 min', doing: 'Writing the code' });
    const done = readTicket(bp, id)!;
    expect(done.clock).toBeUndefined();
    expect(done.stage).toBe('test');
    // Step 1 took from the start to ">> step 2", then one minute each.
    expect(readUsual(bp)[usualKey('builder', 'build', 'full')]).toEqual([122, 61, 61]);
  });
});

describe('a slow step in the live squad', () => {
  it('gets the Taking longer card past twice its usual time, and Give it 10 more minutes keeps it quiet', async () => {
    const { bp, id } = liveTicket('slow', (x) => {
      x.stage = 'review';
      x.squad = { phase: 'review', nextAt: new Date().toISOString() };
    });
    setParallelLimit(2);
    const squad = new LiveSquad(bp);
    stops.push(squad.start(25));
    await until('the Reviewer', () => runs.length === 1);
    await until('its clock', () => readTicket(bp, id)!.clock?.who === 'reviewer');
    expect(readTicket(bp, id)!.clock).toMatchObject({ step: 'review', limit: 15 });
    updateTicket(bp, id, (x) => (x.clock!.since = new Date(Date.now() - 20 * 60_000).toISOString()));
    const look = squad as unknown as { lastWatch: number; watch(): void };
    look.lastWatch = 0;
    look.watch();
    const slow = readTicket(bp, id)!;
    expect(slow.quiet).toMatchObject({ kind: 'long', detail: 'The Reviewer has been on this step for 20 minutes. It usually takes 2 to 4 minutes.' });
    expect(liveNow(slow, readUsual(bp)).slow?.limit).toBe('If you do nothing, squad-kit stops this step at 15 minutes. All work is kept.');

    keepWaiting(bp, id, 10);
    look.lastWatch = 0;
    look.watch();
    expect(readTicket(bp, id)!.quiet).toBeUndefined();
  });

  it('Stop and try again ends the running step and starts it again at once', async () => {
    const { bp, id } = liveTicket('again', (x) => {
      x.stage = 'review';
      x.squad = { phase: 'review', nextAt: new Date().toISOString() };
    });
    stops.push(new LiveSquad(bp).start(25));
    await until('the Reviewer', () => runs.length === 1);
    restartStep(bp, id);
    await until('the Reviewer again', () => runs.length === 2);
    const t = readTicket(bp, id)!;
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.retryOnStop).toBeUndefined();
    expect(t.stopRequested).toBeUndefined();
    expect(t.activity.some((a) => a.text === 'Stopped the step and started it again, with the work so far')).toBe(true);
  });
});
