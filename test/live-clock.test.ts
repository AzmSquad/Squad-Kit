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
const { LiveSquad, planStepOf } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { addWorktree } = await import('./support/copy.js');
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
    // The history keeps the stage each step ran in, for the tracker's work times.
    expect(done.history?.map((h) => [h.step, h.stage])).toEqual([['build', 'implement']]);
    // Step 1 took from the start to ">> step 2", then one minute each.
    expect(readUsual(bp)[usualKey('builder', 'build', 'full')]).toEqual([122, 61, 61]);
  });

  /** A Builder of three plan steps; `act` plays what it says, and each look notes the plan step in progress then (from 1). */
  async function builderSays(name: string, act: (opts: RunOptions, look: () => void) => void): Promise<number[]> {
    const { bp, id, wt } = liveTicket(name, (x) => {
      x.steps = [{ title: 'Read the booking page', status: 'todo' }, { title: 'Show how many fit', status: 'todo' }, { title: 'Tests', status: 'todo' }] as typeof x.steps;
      x.work = { steps: 3, tests: 1, screens: 0 };
    });
    const seen: number[] = [];
    answer = (opts) => {
      if (opts.cwd !== wt.dir) return null;
      act(opts, () => seen.push((readTicket(bp, id)!.steps ?? []).findIndex((s) => s.status === 'doing') + 1));
      return { ok: true, structured: { summary: 'Done' } };
    };
    await (new LiveSquad(bp) as unknown as { build(id: string): Promise<void> }).build(id);
    return seen;
  }

  it("follows the Builder's own to-do list, as ACP's plan update gives it, step by step", async () => {
    const seen = await builderSays('plan', (opts, look) => {
      const plan = (...status: ('pending' | 'in_progress' | 'completed')[]) => opts.onPlan?.(status.map((s, i) => ({ content: `Step ${i + 1}`, status: s })));
      plan('pending', 'pending', 'pending');
      look();
      plan('completed', 'in_progress', 'pending');
      look();
      plan('completed', 'completed', 'in_progress');
      look();
      // A list that is not the plan's steps says nothing about them.
      opts.onPlan?.([{ content: 'Something else', status: 'in_progress' }]);
      look();
    });
    expect(seen).toEqual([1, 2, 3, 3]);
  });

  it('reads the step numbers on its to-do list, so an item of its own does not throw it off; with none, one item per step', async () => {
    const seen = await builderSays('numbered', (opts, look) => {
      type Status = 'pending' | 'in_progress' | 'completed';
      const plan = (...items: [string, Status][]) => opts.onPlan?.(items.map(([content, status]) => ({ content, status })));
      // Four items for three steps: the numbers say where it is, and "Check everything" is its own.
      plan(['1. Start from the booking page', 'completed'], ['2. Show how many fit', 'in_progress'], ['3. Tests', 'pending'], ['Check everything', 'pending']);
      look();
      plan(['Step 1: Start from the booking page', 'completed'], ['Step 2: Show how many fit', 'completed'], ['Step 3: Tests', 'pending'], ['Check everything', 'pending']);
      look();
      // Only forward: a number it has gone past, and one the plan does not have, change nothing.
      plan(['1) Start from the booking page', 'in_progress'], ['9) Ship it', 'in_progress']);
      look();
    });
    expect(seen).toEqual([2, 3, 3]);

    const plain = await builderSays('unnumbered', (opts, look) => {
      const plan = (...status: ('pending' | 'in_progress' | 'completed')[]) => opts.onPlan?.(status.map((st, i) => ({ content: ['Read the page', 'Count', 'Tests', 'Check everything'][i]!, status: st })));
      // No numbers, and an item more than the plan's steps: today's rule, so it says nothing.
      plan('completed', 'in_progress', 'pending', 'pending');
      look();
      // No numbers, one item per step: by their order.
      plan('completed', 'in_progress', 'pending');
      look();
    });
    expect(plain).toEqual([0, 2]);

    // The ways a step number is written, and words that only start with a number.
    const at = (content: string, count = 5) => planStepOf([{ content, status: 'in_progress' }], count);
    expect(['1. Start', 'Step 2: Count', 'step 3 - Warn', '4) Same in the API', '(5) Tests'].map((c) => at(c))).toEqual([0, 1, 2, 3, 4]);
    expect(['1.5x faster pictures', '10 tests to add', 'Steps 1 to 3', 'Check everything'].map((c) => at(c, 12))).toEqual([null, null, null, null]);
    expect(planStepOf([{ content: '1. Start', status: 'completed' }, { content: '2. Count', status: 'completed' }, { content: 'Check everything', status: 'in_progress' }], 3)).toBe(2);
  });

  it('reads ">> step N" cut in two, or said through a command, never goes back, and skips a step the plan does not have', async () => {
    const seen = await builderSays('pieces', (opts, look) => {
      opts.onText?.('Reading the page first.\n>> st');
      opts.onText?.('ep 2\nNow the count.');
      look();
      opts.onTool?.({ name: 'Bash', input: { command: 'echo ">> step 3"' } });
      look();
      opts.onText?.('Back to >> step 1 for a moment.');
      look();
      opts.onText?.('>> step 9');
      look();
    });
    expect(seen).toEqual([2, 3, 3, 3]);
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
