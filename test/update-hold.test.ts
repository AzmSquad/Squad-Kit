import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * An update waits for a safe moment: while it waits, no new agent run starts in any project, and the running ones
 * finish their step. Every agent run here waits until the test ends it.
 */

const runs: { cwd: string; end(): void }[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      const run = { cwd: opts.cwd, end: () => resolve({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Ended by the test.' }) };
      runs.push(run);
      opts.signal?.addEventListener('abort', run.end);
    }),
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad, agentRuns, holdNewRuns } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { runsNow } = await import('../src/console/updates.js');
type OpenProjects = import('../src/console/open-projects.js').OpenProjects;

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

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-update-hold-')));
  runs.length = 0;
});

afterEach(() => {
  holdNewRuns(false);
  for (const stop of stops.splice(0)) stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('holding new runs for an update', () => {
  it('lets the running step finish, starts nothing new, and carries on when let go', async () => {
    setParallelLimit(1);
    const dir = path.join(tmp, 'roomflow');
    fs.mkdirSync(dir);
    setupProject(dir);
    const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'roomflow');
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct' });
    const first = createTicket(bp, { title: 'Booking page' });
    createTicket(bp, { title: 'Rooms list' });
    stops.push(new LiveSquad(bp).start(25));

    await until('the first run', () => runs.length === 1);
    expect(agentRuns()).toEqual([{ root: bp.root, keys: [first.id] }]);
    // The updating view names it in plain words.
    const projects = { all: () => [{ root: bp.root, bp }] } as unknown as OpenProjects;
    expect(runsNow(projects)).toEqual([{ project: 'roomflow', ticket: first.id, title: 'Booking page' }]);

    holdNewRuns(true);
    runs[0]!.end();
    await until('a safe moment', () => agentRuns().length === 0);
    await sleep(400);
    expect(runs).toHaveLength(1);

    holdNewRuns(false);
    await until('the next run', () => runs.length === 2);
  });
});
