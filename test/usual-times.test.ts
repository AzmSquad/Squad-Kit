import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import { DEFAULT_USUAL, LEARN_AFTER, durationWords, minutesWords, rangeWords, readUsual, recordUsual, usualFile, usualKey, usualOf, usualWords } from '../src/board/usual.js';
import { endStep, nextPart, startStep, stepDoing, trackStage } from '../src/board/clock.js';
import type { BoardMeta, Ticket } from '../src/board/types.js';

/**
 * Usual times (phase 4): each kind of step learns how long it takes from this project's own history, kept on this
 * computer, with squad-kit's guess until there are a few runs. The clock on a ticket feeds that history.
 */

let tmp: string;
let bp: BoardPaths;

function ticket(over: Partial<Ticket> = {}): Ticket {
  return { id: 'RO-7', title: 'Show room capacity', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: '', waiting: null, createdAt: new Date(Date.now() - 600_000).toISOString(), createdBy: 'Sara', activity: [], ...over };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-usual-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, { project: 'roomflow', key: 'RO', nextNumber: 8, engine: 'demo', user: { name: 'Sara', role: 'PM' }, roles: {} as BoardMeta['roles'], tools: [], speed: 1, map: [], lessons: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bp.localDir, { recursive: true, force: true });
});

describe('usual times', () => {
  it("uses squad-kit's guess until the project has a few runs of a step", () => {
    const u = usualOf({}, 'builder', 'build', 'full');
    expect(u).toEqual({ low: DEFAULT_USUAL.build[0], high: DEFAULT_USUAL.build[1], learned: false, runs: 0 });
    expect(usualWords(u)).toBe('usually 2 to 4 min');
    const two = usualOf({ [usualKey('builder', 'build')]: [600, 600] }, 'builder', 'build');
    expect(two.learned).toBe(false);
    expect(LEARN_AFTER).toBe(3);
  });

  it('learns the middle half of the history once there are enough runs', () => {
    const book = { [usualKey('builder', 'build', 'full')]: [180, 240, 300, 360, 420] };
    const u = usualOf(book, 'builder', 'build', 'full');
    expect(u.learned).toBe(true);
    expect(u.runs).toBe(5);
    expect(u.low).toBe(240);
    expect(u.high).toBe(360);
    expect(usualWords(u)).toBe('usually 4 to 6 min');
  });

  it('keeps each role, step and track apart', () => {
    const book = { [usualKey('builder', 'build', 'express')]: [30, 30, 30] };
    expect(usualOf(book, 'builder', 'build', 'express').learned).toBe(true);
    expect(usualOf(book, 'builder', 'build', 'full').learned).toBe(false);
    expect(usualOf(book, 'builder', 'fix', 'express').learned).toBe(false);
  });

  it("is kept in this computer's folder for the project, not in .squad, and keeps the last 20 runs", () => {
    for (let i = 1; i <= 25; i += 1) recordUsual(bp, usualKey('reviewer', 'review'), i * 10);
    expect(usualFile(bp).startsWith(bp.localDir)).toBe(true);
    expect(fs.existsSync(path.join(bp.squadDir, 'usual-times.json'))).toBe(false);
    const runs = readUsual(bp)[usualKey('reviewer', 'review')]!;
    expect(runs).toHaveLength(20);
    expect(runs[0]).toBe(60);
    expect(runs.at(-1)).toBe(250);
  });

  it('never counts a run under a second, and a broken file means the guesses', () => {
    recordUsual(bp, usualKey('tester', 'proof'), 0.2);
    expect(readUsual(bp)[usualKey('tester', 'proof')]).toBeUndefined();
    fs.writeFileSync(usualFile(bp), 'not json');
    expect(readUsual(bp)).toEqual({});
  });

  it('says times in plain words', () => {
    expect(rangeWords({ low: 20, high: 50 })).toBe('under 1 min');
    expect(rangeWords({ low: 50, high: 80 })).toBe('about 1 min');
    expect(rangeWords({ low: 60, high: 120 })).toBe('1 to 2 min');
    expect(durationWords(40)).toBe('40 s');
    expect(durationWords(150)).toBe('2 min');
    expect(durationWords(3900)).toBe('1 h 5 min');
    expect(minutesWords(40)).toBe('40 seconds');
    expect(minutesWords(60)).toBe('1 minute');
    expect(minutesWords(14 * 60 + 20)).toBe('14 minutes');
  });
});

describe('the step clock', () => {
  it('starts with a step and adds its time to the history when it ends well', () => {
    const t = ticket();
    const at = Date.now();
    startStep(t, { who: 'reviewer', step: 'review', limit: 15 }, at - 150_000);
    expect(t.clock).toMatchObject({ who: 'reviewer', step: 'review', limit: 15 });
    endStep(bp, t, at);
    expect(t.clock).toBeUndefined();
    expect(readUsual(bp)[usualKey('reviewer', 'review', 'full')]).toEqual([150]);
  });

  it("times the Builder per plan step: each step that ends adds its own time", () => {
    const t = ticket({ steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'todo' }, { title: 'c', status: 'todo' }] });
    const at = Date.now() - 600_000;
    startStep(t, { who: 'builder', step: 'build' }, at);
    expect(t.clock?.part).toBe(2);
    nextPart(bp, t, 2, at + 10_000);
    expect(readUsual(bp)[usualKey('builder', 'build')]).toBeUndefined();
    nextPart(bp, t, 3, at + 120_000);
    expect(t.clock?.part).toBe(3);
    expect(t.clock?.since).toBe(new Date(at + 120_000).toISOString());
    endStep(bp, t, at + 300_000);
    expect(readUsual(bp)[usualKey('builder', 'build')]).toEqual([120, 180]);
  });

  it('keeps the latest action as the last progress', () => {
    const t = ticket();
    startStep(t, { who: 'builder', step: 'fix' });
    stepDoing(t, 'Editing src/booking.tsx', Date.parse('2026-11-03T10:44:00Z'));
    expect(t.clock).toMatchObject({ doing: 'Editing src/booking.tsx', doingAt: '2026-11-03T10:44:00.000Z' });
  });

  it('is no step while the ticket waits for you, and goes on with its time when the same step starts again', () => {
    const waiting = ticket({ waiting: { kind: 'questions', summary: '2 questions' } });
    startStep(waiting, { who: 'analyst', step: 'questions' });
    expect(waiting.clock).toBeUndefined();
    const t = ticket();
    startStep(t, { who: 'tester', step: 'proof' }, Date.now() - 60_000);
    const since = t.clock!.since;
    startStep(t, { who: 'tester', step: 'proof', limit: 20 });
    expect(t.clock).toMatchObject({ since, limit: 20 });
  });
});

describe('stage times', () => {
  it('adds up the time in each stage as the ticket moves, and back again', () => {
    const t = ticket({ stage: 'tickets' });
    const at = Date.parse(t.createdAt);
    trackStage(t, 'tickets', at + 30_000);
    t.stage = 'specs';
    trackStage(t, 'tickets', at + 30_000);
    t.stage = 'implement';
    trackStage(t, 'specs', at + 270_000);
    t.stage = 'test';
    trackStage(t, 'implement', at + 400_000);
    t.stage = 'implement';
    trackStage(t, 'test', at + 460_000);
    expect(t.stageTimes?.spent).toEqual({ tickets: 30, specs: 240, implement: 130, test: 60 });
    expect(t.stageTimes?.stage).toBe('implement');
  });

  it('is kept by every ticket update, and a ticket from before starts counting now', () => {
    writeTicket(bp, ticket({ stage: 'test' }));
    updateTicket(bp, 'RO-7', (x) => (x.status = 'Running test'));
    const first = readTicket(bp, 'RO-7')!;
    expect(first.stageTimes?.stage).toBe('test');
    expect(Date.now() - Date.parse(first.stageTimes!.since)).toBeLessThan(5000);
    updateTicket(bp, 'RO-7', (x) => (x.stage = 'review'));
    const moved = readTicket(bp, 'RO-7')!;
    expect(moved.stageTimes?.stage).toBe('review');
    expect(moved.stageTimes?.spent.test).toBeGreaterThanOrEqual(0);
    // This computer's record, not the project's.
    expect(fs.readFileSync(path.join(bp.ticketsDir, 'RO-7', 'ticket.md'), 'utf8')).not.toContain('stageTimes');
  });
});
