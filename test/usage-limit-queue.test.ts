import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Claude's usage limit pauses the whole queue (E5): every project shares one AI account, so no new step starts
 * anywhere until the limit resets. Then the work carries on by itself from the same step, and the wait never counts
 * as a failed try. The clock is a fake one: the test moves it past the reset time.
 */

type Answer = (opts: RunOptions) => Promise<RunResult>;
const runs: RunOptions[] = [];
let answers: Answer[] = [];
/** Runs the test leaves going; they end when it ends. */
const open: (() => void)[] = [];
const hang: Answer = (opts) =>
  new Promise((resolve) => {
    const end = () => resolve({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Ended by the test.' });
    open.push(end);
    opts.signal?.addEventListener('abort', end);
  });
const limited = (message: string): Answer => async (opts) => ({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Claude stopped.', detail: message });

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    return (answers.shift() ?? hang)(opts);
  },
}));

const { boardPaths, readMeta, readTicket, writeMeta, listTickets } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { activePause, endPause, limitText } = await import('../src/engine/usage-limit.js');
const { mountSupportApi } = await import('../src/console/api/support.js');
const { Hono } = await import('hono');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits on real time (the fake clock only moves when the test says). */
async function until(what: string, check: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function liveProject(name: string, titles: string[]) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct' });
  for (const title of titles) createTicket(bp, { title });
  return bp;
}

// 12:00 UTC: London is on GMT in November, so "3:40pm (Europe/London)" is 15:40 UTC.
const NOON = Date.parse('2026-11-03T12:00:00Z');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-limit-queue-')));
  runs.length = 0;
  answers = [];
  endPause();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const end of open.splice(0)) end();
  vi.useRealTimers();
  endPause();
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the usage-limit pause', () => {
  it('holds every project until the reset time, then carries on by itself from the same step, with no failed try', async () => {
    setParallelLimit(1);
    const alpha = liveProject('alpha', ['alpha one', 'alpha two']);
    const beta = liveProject('beta', ['beta one']);
    answers = [limited("You've hit your session limit · resets 3:40pm (Europe/London)")];
    stops.push(new LiveSquad(alpha).start(25), new LiveSquad(beta).start(25));
    // The new tickets are due a few seconds from now.
    vi.setSystemTime(NOON + 60_000);

    await until('the first run', () => runs.length === 1);
    await until('the pause', () => activePause() !== null);
    const pause = activePause()!;
    expect(pause.name).toBe('Claude');
    expect(pause.resetsAt).toBe('2026-11-03T15:40:00.000Z');
    expect(pause.until).toBe('2026-11-03T15:40:30.000Z');

    // The ticket that hit it waits on the same step, says when it carries on, and no failure is counted.
    const text = limitText(pause);
    const hit = [...listTickets(alpha), ...listTickets(beta)].find((t) => t.status === text && t.activity.some((a) => a.text.includes('from this same step')))!;
    expect(hit).toBeDefined();
    expect(hit.squad?.phase).toBe('analyst-read');
    expect(hit.stuck).toBeUndefined();
    expect(hit.waiting).toBeNull();
    expect(hit.fails ?? 0).toBe(0);

    // Nothing else starts, in this project or the other one, and every ready ticket says why it waits.
    await until('every ticket to say it waits', () => [...listTickets(alpha), ...listTickets(beta)].every((t) => t.status === text));
    await sleep(300);
    expect(runs).toHaveLength(1);

    // A minute after the reset, the squad carries on by itself, the same step first.
    vi.setSystemTime(Date.parse('2026-11-03T15:41:00Z'));
    await until('the run after the reset', () => runs.length === 2);
    expect(activePause()).toBeNull();
    await until('the card to say what it said before', () => !(readTicket(alpha, hit.id) ?? readTicket(beta, hit.id))!.status.includes('usage limit'));
    const after = readTicket(alpha, hit.id) ?? readTicket(beta, hit.id);
    expect(after?.stuck).toBeUndefined();
    expect(after?.fails ?? 0).toBe(0);
  }, 30_000);

  it('without a reset time looks again every 10 minutes, and Try now carries on at once', async () => {
    const bp = liveProject('gamma', ['gamma one']);
    answers = [limited('Claude AI usage limit reached'), limited('Claude AI usage limit reached')];
    stops.push(new LiveSquad(bp).start(25));
    vi.setSystemTime(NOON + 60_000);

    await until('the first run', () => runs.length === 1);
    await until('the pause', () => activePause() !== null);
    expect(activePause()?.resetsAt).toBeUndefined();
    const [t] = listTickets(bp);
    await until('the card', () => readTicket(bp, t!.id)!.status === "Claude's usage limit is reached. The squad carries on by itself when the limit resets");

    // Ten minutes on: one look, the limit is still there, so it waits again.
    vi.setSystemTime(NOON + 60_000 + 10 * 60_000 + 1000);
    await until('the second look', () => runs.length === 2);
    await until('the next wait', () => activePause() !== null);
    await sleep(200);
    expect(runs).toHaveLength(2);

    // Try now, as the board's button does it: one call, and the step runs again at once.
    const app = new Hono();
    mountSupportApi(app, { projects: { get: () => undefined, summaries: () => [] } as never });
    const res = await app.request('/api/v1/app/usage-limit/try-now', { method: 'POST' });
    expect(await res.json()).toEqual({ pause: null });
    await until('the run after Try now', () => runs.length === 3);
    expect(readTicket(bp, t!.id)?.fails ?? 0).toBe(0);
  }, 30_000);
});
