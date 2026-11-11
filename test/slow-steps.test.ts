import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readTicket, updateTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick } from '../src/board/engine.js';
import { keepWaiting, restartStep, stopTicket } from '../src/board/actions.js';
import { liveNow } from '../src/board/now.js';
import { readUsual, usualKey } from '../src/board/usual.js';
import { parseMinutes } from '../src/commands/now.js';
import { Hono } from 'hono';
import { mountBoardApi } from '../src/console/api/board.js';
import { buildPaths } from '../src/core/paths.js';

/**
 * Time limits you can see (phase 7), on the sample board's squad: a step past twice its usual time gets the "Taking
 * longer than usual" card, and its buttons work: Give it 10 more minutes, Stop and try again, Stop. The sample squad
 * keeps the same clocks as the live one, so its cards show who works, since when and the usual time.
 */

let tmp: string;
let bp: BoardPaths;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-slow-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 1 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bp.localDir, { recursive: true, force: true });
});

describe('a slow step on the sample board', () => {
  it('gets the "Taking longer than usual" card with why, what it does and what happens at the limit', () => {
    tick(bp);
    const t = readTicket(bp, 'SK-153')!;
    expect(t.quiet).toMatchObject({ kind: 'long', detail: 'The Builder has been on this step for 14 minutes. It usually takes 2 to 4 minutes.' });
    // Its own run of the tests failed in this step, as on the story the owner watched: the same reason, and calm.
    expect(t.activity[0]!.text).toBe('Taking longer than usual: the tests failed once, so the Builder is fixing them. Still working.');
    const n = liveNow(t, readUsual(bp));
    expect(n.line).toBe('Builder · step 6 of 6 · fixing a failed test');
    const s = n.slow!;
    expect(s.title).toBe('Taking longer than usual');
    expect(s.where).toBe('SK-153 · step 6 of 6');
    expect(s.text).toBe('The tests failed once, so the Builder is fixing them.');
    expect(s).toMatchObject({ calm: true, line: 'Longer than usual · 14 min · still working', why: { kind: 'own-fail', short: 'fixing a failed test' } });
    expect(s.note).toBeUndefined();
    expect(s.facts.map((f) => f.label)).toEqual(['How long', 'Doing now', 'Last progress', 'Time limit', 'Your part']);
    expect(s.limit).toBe("squad-kit gives the Builder up to 60 min for all its steps together (31 min used so far). If it isn't done by then, squad-kit stops it and asks you what to do.");
    // A step within its usual time gets no card.
    expect(readTicket(bp, 'SK-145')!.quiet).toBeUndefined();
  });

  it('Give it 10 more minutes: the card goes, and stays away while the time runs', () => {
    tick(bp);
    const t = keepWaiting(bp, 'SK-153', 10);
    expect(t.quiet).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Gave it 10 more minutes');
    expect(Date.parse(t.quietSnoozedUntil!) - Date.now()).toBeGreaterThan(9 * 60_000);
    updateTicket(bp, 'SK-153', (x) => (x.squad!.nextAt = new Date(Date.now() + 60_000).toISOString()));
    // The next look, five seconds on, keeps it quiet.
    tick(bp);
    expect(readTicket(bp, 'SK-153')!.quiet).toBeUndefined();
  });

  it('Stop and try again: the step stops and starts again at once, with a fresh clock and no card', async () => {
    tick(bp);
    const before = readTicket(bp, 'SK-153')!;
    restartStep(bp, 'SK-153');
    expect(readTicket(bp, 'SK-153')!.status).toBe('Stopping, then trying again…');
    await sleep(5);
    tick(bp);
    const t = readTicket(bp, 'SK-153')!;
    expect(t.stopRequested).toBeUndefined();
    expect(t.retryOnStop).toBeUndefined();
    expect(t.quiet).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.squad).toBeTruthy();
    expect(t.clock).toMatchObject({ who: 'builder', step: 'build', part: 6 });
    // A fresh clock: what failed before it is not on it.
    expect(t.clock?.failed).toBeUndefined();
    expect(Date.parse(t.clock!.since)).toBeGreaterThan(Date.parse(before.clock!.since));
    expect(t.activity[0]!.text).toBe('Stopped the step and started it again, with the work so far');
  });

  it('Stop: the ticket parks with a way to carry on, and nothing is lost', () => {
    stopTicket(bp, 'SK-153');
    tick(bp);
    const t = readTicket(bp, 'SK-153')!;
    expect(t.squad).toBeNull();
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.question).toBe('You stopped the squad. Nothing was lost; the work so far is kept.');
    expect(t.stuck?.options[0]).toMatchObject({ do: 'retry', name: 'Carry on' });
    expect(t.clock).toBeUndefined();
    expect(liveNow(t, {}).state).toBe('you');
  });

  it('refuses the buttons when nothing runs', () => {
    expect(() => restartStep(bp, 'SK-139')).toThrow(/not running|waits for you/);
    expect(() => keepWaiting(bp, 'SK-149')).toThrow('SK-149 is not running right now.');
    expect(() => keepWaiting(bp, 'SK-153', 0)).toThrow('Give it between 1 and 120 more minutes.');
  });

  it('reads the time for squad wait --more', () => {
    expect(parseMinutes('10m')).toBe(10);
    expect(parseMinutes('1h')).toBe(60);
    expect(parseMinutes('15')).toBe(15);
    expect(parseMinutes(undefined)).toBe(10);
    expect(() => parseMinutes('soon')).toThrow('"soon" is not a time');
  });
});

describe('the sample squad keeps the clocks', () => {
  it("shows the right line through a ticket's steps and learns the usual times from them", () => {
    // The sample squad plays its steps on the clock; the test moves the clock a second at a time.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      updateTicket(bp, 'SK-150', (x) => {
        // From "Case notes autosave": build the last two steps, then the checks, the proof and the review.
        x.waiting = null;
        x.stuck = undefined;
        x.live = true;
        x.work = { steps: 4, tests: 3, screens: 1 };
        x.squad = { phase: 'build', nextAt: new Date().toISOString(), index: 2 };
      });
      const seen: string[] = [];
      for (let i = 0; i < 400 && !readTicket(bp, 'SK-150')!.waiting; i += 1) {
        vi.setSystemTime(Date.now() + 1000);
        tick(bp);
        const n = liveNow(readTicket(bp, 'SK-150')!, readUsual(bp));
        const who = n.line.split(' · ').slice(0, 2).join(' · ');
        if (n.state === 'working' && seen.at(-1) !== who) seen.push(who);
      }
      const done = readTicket(bp, 'SK-150')!;
      expect(done.waiting?.kind).toBe('proof');
      expect(done.clock).toBeUndefined();
      expect(seen[0]).toBe('Builder · step 3 of 4');
      expect(seen).toContain('Builder · step 4 of 4');
      expect(seen.some((l) => l.startsWith('squad-kit'))).toBe(true);
      expect(seen.some((l) => l.startsWith('Tester'))).toBe(true);
      expect(seen.at(-1)).toMatch(/^Reviewer/);
      // Each step that ended well is in the project's history now, by role, step and track.
      const book = readUsual(bp);
      expect(book[usualKey('builder', 'build', 'full')]).toHaveLength(2);
      for (const key of [usualKey('squad', 'checks'), usualKey('tester', 'proof'), usualKey('reviewer', 'review')]) expect(book[key], key).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the board API', () => {
  const app = () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    return a;
  };
  const post = (a: Hono, url: string, body: unknown = {}) => a.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('puts the live status on every ticket, and answers a status question in one call', async () => {
    const a = app();
    const board = (await (await a.request('/api/v1/board')).json()) as { tickets: { id: string; now?: { line: string } }[] };
    expect(board.tickets.find((t) => t.id === 'SK-153')?.now?.line).toBe('Builder · step 6 of 6 · fixing a failed test');
    const one = (await (await a.request('/api/v1/tickets/SK-145')).json()) as { now: { state: string; time: string } };
    expect(one.now).toMatchObject({ state: 'working', time: '1 min · usually 2 to 4 min' });
    const status = (await (await a.request('/api/v1/tickets/SK-151/status')).json()) as { line: string };
    expect(status.line).toBe('Analyst · reading the ticket');
    const answer = await post(a, '/api/v1/tickets/SK-145/status/ask', { text: 'متى يخلص؟' });
    expect(await answer.json()).toMatchObject({ lang: 'ar', topic: 'when', instant: true });
    expect((await post(a, '/api/v1/tickets/SK-145/status/ask', { text: ' ' })).status).toBe(400);
  });

  it('has one call for each button of the slow card', async () => {
    const a = app();
    tick(bp);
    expect((await post(a, '/api/v1/tickets/SK-153/keep-waiting', { minutes: 10 })).status).toBe(200);
    expect(readTicket(bp, 'SK-153')!.quiet).toBeUndefined();
    expect((await post(a, '/api/v1/tickets/SK-153/restart')).status).toBe(200);
    expect(readTicket(bp, 'SK-153')!).toMatchObject({ stopRequested: true, retryOnStop: true });
    expect((await post(a, '/api/v1/tickets/SK-139/restart')).status).toBe(400);
  });
});
