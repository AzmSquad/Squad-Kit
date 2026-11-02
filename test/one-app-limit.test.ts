import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * One app, many projects (ADR-001): each project runs its own squad, and the tickets running at once are limited
 * across all of them, because they use the same AI accounts. Every agent run here waits until the test ends it.
 */

const runs: { cwd: string; over: boolean; end(): void }[] = [];
let inFlight = 0;
let most = 0;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const run = {
        cwd: opts.cwd,
        over: false,
        end: () => {
          if (run.over) return;
          run.over = true;
          inFlight -= 1;
          resolve({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Ended by the test.' });
        },
      };
      runs.push(run);
      opts.signal?.addEventListener('abort', run.end);
    }),
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad, ticketsRunning } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { parallelLimit, readSettings, setParallelLimit } = await import('../src/core/settings.js');
const { setPersonLevel } = await import('../src/engine/levels.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A live project whose Architect has read it, with three tickets ready for the Analyst. */
function liveProject(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct' });
  for (const title of ['one', 'two', 'three']) createTicket(bp, { title: `${name} ${title}` });
  return bp;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-one-app-')));
  fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), { force: true });
  runs.length = 0;
  inFlight = most = 0;
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the limit of tickets at once', () => {
  it('is the person’s, kept in settings.yaml beside their model levels; a board’s own number counts until then', () => {
    expect(parallelLimit()).toBe(2);
    expect(parallelLimit(4)).toBe(4);
    setPersonLevel('builder', { level: 'strongest' });
    setParallelLimit(3);
    expect(parallelLimit(4)).toBe(3);
    expect(() => setParallelLimit(9)).toThrow('from 1 to 5');
    const file = yaml.load(fs.readFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    expect(file).toEqual({ levels: { builder: { level: 'strongest' } }, parallel: 3 });
    // Setting a level later keeps the limit.
    setPersonLevel('tester', { level: 'fast' });
    expect(readSettings().parallel).toBe(3);
  });

  it('holds across the squads of two projects, and a free place goes to the squad that waits', async () => {
    setParallelLimit(2);
    const alpha = new LiveSquad(liveProject('alpha'));
    const beta = new LiveSquad(liveProject('beta'));
    stops.push(alpha.start(25), beta.start(25));

    await until('two runs', () => runs.length === 2);
    await sleep(300);
    expect(runs).toHaveLength(2);
    expect(ticketsRunning()).toBe(2);

    // One run ends: the squad with fewer tickets running gets the place, so both projects move at the same time.
    const first = alpha.ticketsRunning() === 2 ? alpha : beta;
    const other = first === alpha ? beta : alpha;
    runs[0]!.end();
    await until('a third run', () => runs.length === 3);
    await sleep(200);
    expect(first.ticketsRunning()).toBe(1);
    expect(other.ticketsRunning()).toBe(1);
    expect(ticketsRunning()).toBe(2);

    // The person raises the limit: one more starts, no restart needed.
    setParallelLimit(3);
    await until('a fourth run', () => runs.length === 4);
    await sleep(200);
    expect(ticketsRunning()).toBe(3);

    // Every ticket of both projects gets its turn, never more than the limit at once.
    const end = Date.now() + 8000;
    while ((runs.length < 6 || inFlight > 0) && Date.now() < end) {
      runs.find((r) => !r.over)?.end();
      await sleep(120);
    }
    expect(runs).toHaveLength(6);
    expect(most).toBe(3);
  });

  it('does not count the Architect reading a new project', async () => {
    setParallelLimit(1);
    const busy = new LiveSquad(liveProject('busy'));
    stops.push(busy.start(25));
    await until('a ticket run', () => runs.length === 1);

    // A new project: its first read starts at once, though the one place is taken.
    const fresh = liveProject('fresh');
    writeMeta(fresh, { ...readMeta(fresh), scan: { status: 'pending' } });
    stops.push(new LiveSquad(fresh).start(25));
    await until('the first read', () => runs.length === 2);
    expect(ticketsRunning()).toBe(1);
    expect(runs[1]!.cwd).toBe(fresh.root);
  }, 20_000);
});
