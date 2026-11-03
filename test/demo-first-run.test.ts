import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, listDecisions, listTickets, readMeta, type BoardPaths } from '../src/board/store.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { playDemoSetup } from '../src/board/demo-setup.js';
import { approveOverview, overviewView, readTalk, sendTalk, setupAgain, setupView, startTalk, stopSetup, ticketFromIdea } from '../src/board/first-run.js';
import { readOverview } from '../src/board/overview.js';

/**
 * The sample board shows the first run and the Overview with sample data, as it does every other screen: the seeded
 * board is long past its setup, with its Overview approved; `squad demo --first-run` starts at the first open and
 * plays the setup to the handover, with no AI.
 */

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-demo-first-')));
  fs.mkdirSync(path.join(tmp, '.squad'), { recursive: true });
  saveConfig(path.join(tmp, '.squad', 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: 'Case portal' } });
  bp = boardPaths(path.join(tmp, '.squad'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Plays the sample setup on a clock the test moves. */
function play(until: number, from: number, stepMs = 500): number {
  let at = from;
  while (at < until) {
    playDemoSetup(bp, readMeta(bp), at);
    at += stepMs;
  }
  return at;
}

describe('the first run on the sample board', () => {
  it('the seeded board is long past its setup: every step done, the Overview approved and its home', () => {
    seedDemoBoard(bp);
    const v = setupView(bp)!;
    expect(v.steps.every((s) => s.state === 'done')).toBe(true);
    expect(v.approved).toBe(true);
    const o = overviewView(bp);
    expect(o).toMatchObject({ handover: 'approved', proposed: 0, users: expect.stringContaining('Court clerks') });
    expect(o.parts.length).toBeGreaterThan(4);
    expect(o.ideas).toHaveLength(3);
    expect(o.proof?.app?.shot).toBe('setup-app.png');
    expect(fs.existsSync(path.join(bp.proofDir, 'setup-app.png'))).toBe(true);
    // Its released and accepted tickets show as what it can do since the read.
    expect(o.since.length).toBeGreaterThan(0);
  });

  it('--first-run plays the setup step by step, then the Overview waits with its rules proposed', () => {
    seedDemoBoard(bp, { firstRun: true, speed: 4 });
    expect(listTickets(bp)).toEqual([]);
    expect(listDecisions(bp)).toEqual([]);
    const start = Date.now();
    expect(setupView(bp)!.steps.map((s) => s.state)).toEqual(['done', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);

    let at = play(start + 3000, start);
    expect(setupView(bp)!.steps.find((s) => s.id === 'read')!.state).toBe('now');
    expect(readMeta(bp).scan?.status).toBe('running');
    at = play(start + 9000, at);
    const reading = setupView(bp)!;
    expect(reading.steps.find((s) => s.id === 'read')!.note).toMatch(/ of 214 files$/);
    expect(reading.reads.length).toBeGreaterThan(0);

    play(start + 40_000, at);
    const v = setupView(bp)!;
    expect(v.ready).toBe(true);
    expect(v.steps.every((s) => s.state === 'done')).toBe(true);
    expect(v.steps.find((s) => s.id === 'tests')!.note).toBe('Ran your tests: 18 pass');
    const o = overviewView(bp);
    expect(o.handover).toBe('ready');
    expect(o.proposed).toBe(5);
    expect(listDecisions(bp).every((d) => d.proposed && !d.approvedBy)).toBe(true);

    // Approve, then the first ticket from an idea: the sample squad takes it from there.
    approveOverview(bp);
    expect(listDecisions(bp).every((d) => !d.proposed)).toBe(true);
    const t = ticketFromIdea(bp, 2);
    expect(t.title).toBe('Bulk assign cases to a clerk');
    expect(readOverview(bp).ideas[1]!.ticket).toBe(t.id);
  });

  it('Stop and Start again, and Read it again on the sample Overview', () => {
    seedDemoBoard(bp, { firstRun: true, speed: 4 });
    const start = Date.now();
    play(start + 3000, start);
    stopSetup(bp);
    playDemoSetup(bp, readMeta(bp), start + 3500);
    expect(setupView(bp)!.steps.find((s) => s.id === 'read')!.state).toBe('stopped');
    setupAgain(bp, 'read');
    play(start + 40_000, start + 4000);
    expect(setupView(bp)!.ready).toBe(true);

    // The seeded board reads its project again: new rules come as proposals; the ones approved before stay.
    seedDemoBoard(bp, { speed: 4 });
    const approved = listDecisions(bp).length;
    setupAgain(bp, 'read');
    play(Date.now() + 40_000, Date.now());
    expect(overviewView(bp).handover).toBe('ready');
    expect(listDecisions(bp).filter((d) => d.proposed)).toHaveLength(3);
    expect(listDecisions(bp)).toHaveLength(approved + 3);
  });

  it('the sample Architect answers "Something is wrong"', () => {
    seedDemoBoard(bp, { firstRun: true, speed: 4 });
    startTalk(bp);
    playDemoSetup(bp, readMeta(bp), Date.now() + 1000);
    expect(readTalk(bp)!.messages.at(-1)).toMatchObject({ who: 'architect' });
    sendTalk(bp, 'Judges do not upload documents');
    playDemoSetup(bp, readMeta(bp), Date.now() + 3000);
    expect(readTalk(bp)).toMatchObject({ thinking: false });
    expect(readTalk(bp)!.messages.at(-1)!.text).toContain('read the project again');
  });
});
