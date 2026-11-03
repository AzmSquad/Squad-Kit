import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';
import { begin, finish, newSetup, nextProofStep, resetFrom, setupOver, setupUsual, learnSetupTime, stepOf } from '../src/board/setup-state.js';
import {
  approveOverview,
  closeTalk,
  corrections,
  overviewView,
  readAgainWithTalk,
  readTalk,
  sendTalk,
  setupAgain,
  setupLine,
  setupQuality,
  setupView,
  startTalk,
  stopSetup,
} from '../src/board/first-run.js';
import { readingNow, readStarted, resumeSetup } from '../src/engine/onboard.js';
import { readSaid } from '../src/engine/onboard-live.js';
import { stepLines } from '../src/commands/overview.js';

/** The setup's steps and their states, in the engine, on the board and in the terminal; and the person's moves on them. */

let tmp: string;
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-steps-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fresh(): BoardPaths {
  const dir = path.join(tmp, 'p');
  fs.mkdirSync(dir, { recursive: true });
  setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'p').bp;
}

describe('the setup state', () => {
  it('times each step, and runs the steps after the read in order until the overview', () => {
    const t0 = Date.parse('2026-11-03T07:00:00Z');
    const s = newSetup('repo', t0, t0 + 1400);
    expect(stepOf(s, 'files')).toMatchObject({ state: 'done', seconds: 1 });
    expect(nextProofStep(s)).toBeNull();
    begin(s, 'read', 'Starting…', t0 + 2000);
    expect(nextProofStep(s)).toBeNull();
    finish(s, 'read', 'done', { note: 'Read 15 files' }, t0 + 102_000);
    expect(stepOf(s, 'read')).toMatchObject({ state: 'done', seconds: 100, note: 'Read 15 files' });
    expect(nextProofStep(s)).toBe('commands');
    begin(s, 'commands', undefined, t0 + 103_000);
    expect(nextProofStep(s)).toBeNull();
    finish(s, 'commands', 'failed', { error: 'npm install failed', output: 'ERR' }, t0 + 110_000);
    // A failure never blocks: the tests come next.
    expect(nextProofStep(s)).toBe('tests');
    finish(s, 'tests', 'skipped', { note: 'No tests' }, t0 + 110_000);
    expect(stepOf(s, 'tests').seconds).toBe(0);
    finish(s, 'app', 'done', {}, t0 + 111_000);
    expect(nextProofStep(s)).toBe('overview');
    finish(s, 'overview', 'done', {}, t0 + 111_000);
    finish(s, 'tool', 'done', {}, t0 + 111_000);
    expect(setupOver(s)).toBe(true);

    // Try again from the tests: they and the steps after them run again; the read stays done.
    s.readyAt = 'x';
    resetFrom(s, 'tests');
    expect(s.steps.map((x) => x.state)).toEqual(['done', 'done', 'done', 'failed', 'todo', 'todo', 'todo']);
    expect(s.readyAt).toBeUndefined();
    // A stopped step waits for the person: nothing runs after it.
    stepOf(s, 'tests').state = 'stopped';
    expect(nextProofStep(s)).toBeNull();
  });

  it("learns the usual time from this computer's setups, after a few", () => {
    const bp = fresh();
    expect(setupUsual(bp, 'read')).toEqual({ low: 120, high: 300, learned: false });
    for (const seconds of [60, 80, 100]) learnSetupTime(bp, { id: 'read', state: 'done', seconds });
    expect(setupUsual(bp, 'read')).toMatchObject({ low: 70, high: 90, learned: true });
    // A failed step teaches nothing.
    learnSetupTime(bp, { id: 'tests', state: 'failed', seconds: 999 });
    expect(setupUsual(bp, 'tests').learned).toBe(false);
  });

  it('says each step in plain words on the board and in the terminal, with its time and the usual time', () => {
    const bp = fresh();
    readStarted(bp, { label: 'Claude Code', ready: true });
    readingNow(bp, 'Reading roomflow/store.py', 9);
    const v = setupView(bp)!;
    expect(v.steps.map((s) => s.label)).toEqual([
      'Project memory created',
      'Claude Code is ready',
      'The Architect is reading your code',
      'Finding how to test and run it',
      'Trying the tests',
      'Opening the app once',
      'Your project overview',
    ]);
    const read = v.steps[2]!;
    // The project has fewer files in git than the Architect opened: the count alone.
    expect(read).toMatchObject({ state: 'now', note: 'Reading roomflow/store.py · 9 files', usual: 'usually 2 to 5 min' });
    expect(v.reads).toEqual(['Reading roomflow/store.py']);
    expect(v.steps[3]!.note).toBe("In squad-kit's own copy. Your folder is not touched.");
    expect(setupLine(v)).toBe('Getting to know the project: step 3 of 7 · The Architect is reading your code');
    const lines = stepLines(read, Date.parse(read.since!) + 100_000).map(strip);
    expect(lines[0]).toBe('  … The Architect is reading your code  1 min · usually 2 to 5 min');
    expect(lines[1]).toBe('      Reading roomflow/store.py · 9 files');

    // An AI tool that is not installed says so, with Try again.
    const other = fresh2();
    readStarted(other, { label: 'Claude Code', ready: false });
    const tool = setupView(other)!.steps[1]!;
    expect(tool).toMatchObject({ label: 'Claude Code is not ready', state: 'failed', ways: [{ do: 'again', step: 'read', label: 'Try again', command: 'squad setup --again read' }] });
    expect(tool.error).toContain('Install it and sign in once');
    expect(stepLines(tool).map(strip)).toContain('      Try again: squad setup --again read');
  });

  it('a board closed in the middle of a step runs it again from its start', () => {
    const bp = fresh();
    const meta = readMeta(bp);
    finish(meta.setup!, 'read', 'done');
    begin(meta.setup!, 'tests');
    writeMeta(bp, meta);
    resumeSetup(bp);
    expect(stepOf(readMeta(bp).setup!, 'tests').state).toBe('todo');
    expect(nextProofStep(readMeta(bp).setup)).toBe('commands');
  });
});

let n = 0;
function fresh2(): BoardPaths {
  const dir = path.join(tmp, `q${(n += 1)}`);
  fs.mkdirSync(dir);
  setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'q').bp;
}

describe("the person's moves on the setup", () => {
  it('Stop before the read starts: the read waits, stopped, until Start again', () => {
    const bp = fresh();
    const v = stopSetup(bp);
    expect(v.steps.find((s) => s.id === 'tool')).toMatchObject({ state: 'stopped', ways: [{ label: 'Start again', step: 'read' }] });
    const again = setupAgain(bp, 'read');
    expect(again.steps.filter((s) => s.state === 'stopped')).toEqual([]);
    expect(readMeta(bp).scan?.status).toBe('pending');
  });

  it('Stop while a step runs asks the engine to end it', () => {
    const bp = fresh();
    readStarted(bp, { label: 'Claude Code', ready: true });
    expect(stopSetup(bp).stopping).toBe(true);
    expect(() => setupAgain(bp, 'read')).toThrow('A step is still running');
  });

  it('asks Quality once: Best is the default, the answer is the Quality setting', () => {
    const bp = fresh();
    expect(setupView(bp)).toMatchObject({ quality: 'best', qualityAsked: false });
    expect(setupQuality(bp, 'thrifty')).toMatchObject({ quality: 'thrifty', qualityAsked: true });
    expect(readMeta(bp).quality).toBe('thrifty');
    expect(() => setupQuality(bp, 'cheap')).toThrow('"cheap" is not a Quality setting');
  });

  it('keeps the rules proposed until the overview is approved, and approval waits for the setup', () => {
    const bp = fresh();
    expect(() => approveOverview(bp)).toThrow('still getting to know the project');
    expect(overviewView(bp).handover).toBe('reading');
    const meta = readMeta(bp);
    for (const st of meta.setup!.steps) if (st.state === 'todo') finish(meta.setup!, st.id, 'done');
    writeMeta(bp, meta);
    expect(overviewView(bp).handover).toBe('ready');
    expect(approveOverview(bp).handover).toBe('approved');
    // Read it again: the overview is checked again.
    setupAgain(bp, 'read');
    expect(overviewView(bp).handover).toBe('reading');
  });

  it('Something is wrong: a talk with the Architect, then the read again with what the person said', () => {
    const bp = fresh();
    expect(() => readAgainWithTalk(bp)).toThrow('Tell the Architect what is wrong first');
    expect(startTalk(bp)).toMatchObject({ open: true, thinking: true, messages: [] });
    sendTalk(bp, 'The login does check passwords');
    expect(() => sendTalk(bp, 'and more')).toThrow('still answering');
    const t = readTalk(bp)!;
    // The Architect answered.
    t.thinking = false;
    t.messages.push({ who: 'architect', text: 'I see.', at: new Date().toISOString() });
    fs.writeFileSync(path.join(bp.localDir, 'overview-talk.json'), JSON.stringify(t));
    expect(corrections(readTalk(bp))).toBe('- The login does check passwords');
    expect(readSaid(bp)).toBe('');
    readAgainWithTalk(bp);
    expect(readSaid(bp)).toBe('- The login does check passwords');
    expect(readTalk(bp)!.open).toBe(false);
    expect(readMeta(bp).scan?.status).toBe('pending');
    expect(closeTalk(bp)!.open).toBe(false);
  });
});
