import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A change to the test command is the engine's to settle: squad-kit tries the new one in the ticket's copy and keeps
 * what works, and a project manager reads one plain line with no command in it. Only when it truly cannot tell does the
 * person get one plain sentence. Real commands in a folder; the AI tool is a fake.
 */

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId }) as RunResult,
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { hidesFailures, judgeTestChange, testsRan } = await import('../src/engine/test-change.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = { checks(id: string): Promise<void> };

const pass = (n?: number) => ({ ok: true, output: n === undefined ? 'all good' : `Tests  ${n} passed` });
const fail = (output = 'boom') => ({ ok: false, output });
const change = { from: 'npm test', to: 'npm run test:all' };

/** The runs squad-kit asks for, answered by command. */
function runs(to: { ok: boolean; output: string }, from: { ok: boolean; output: string }) {
  const asked: string[] = [];
  return {
    asked,
    run: async (command: string) => {
      asked.push(command);
      return command === change.to ? to : from;
    },
  };
}

describe('deciding a change to the test command', () => {
  it('keeps the new one when it passes and runs at least as many tests', async () => {
    expect(await judgeTestChange(change, runs(pass(12), pass(12)).run)).toMatchObject({ keep: 'new' });
    expect(await judgeTestChange(change, runs(pass(14), pass(12)).run)).toMatchObject({ keep: 'new' });
  });

  it('keeps the new one when the current one no longer runs at all', async () => {
    expect(await judgeTestChange(change, runs(pass(5), fail('sh: jest: command not found')).run)).toMatchObject({ keep: 'new' });
  });

  it('keeps the new one when the current one never said what it ran', async () => {
    expect(await judgeTestChange(change, runs(pass(5), pass()).run)).toMatchObject({ keep: 'new' });
  });

  it('keeps the current one when the new one fails, and does not run the current one for that', async () => {
    const r = runs(fail(), pass(12));
    expect(await judgeTestChange(change, r.run)).toMatchObject({ keep: 'current', why: 'the new way did not pass' });
    expect(r.asked).toEqual([change.to]);
  });

  it('keeps the current one when the new one runs no tests, or fewer', async () => {
    expect(await judgeTestChange(change, runs(pass(0), pass(12)).run)).toMatchObject({ keep: 'current', why: 'the new way ran no tests' });
    expect(await judgeTestChange(change, runs(pass(3), pass(12)).run)).toMatchObject({ keep: 'current', why: 'the new way runs fewer tests' });
  });

  it('never lets a new command leave out the tests that fail', async () => {
    // 10 pass and 2 fail today; the new command passes by running only the 10.
    const failing = fail(' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 10 passed (12)');
    expect(await judgeTestChange(change, runs(pass(10), failing).run)).toMatchObject({ keep: 'current', why: 'the new way runs fewer tests' });
    expect(await judgeTestChange(change, runs(pass(12), failing).run)).toMatchObject({ keep: 'new' });
  });

  it('never runs a command that would pass whatever the tests do', async () => {
    for (const to of ['npm test || true', 'npm test; echo done', 'vitest run --passWithNoTests', 'gradle check -x test', 'mvn test -Dmaven.test.failure.ignore=true']) {
      const r = runs(pass(12), pass(12));
      expect(await judgeTestChange({ from: change.from, to }, r.run), to).toMatchObject({ keep: 'current', why: 'the new way could hide failing tests' });
      expect(r.asked).toEqual([]);
    }
    expect(hidesFailures('npm test && npm run test:e2e')).toBe(false);
    expect(hidesFailures(`node -e "a(); b()"`)).toBe(false);
  });

  it('stays with a current one that works when the new one does not say what it ran', async () => {
    expect(await judgeTestChange(change, runs(pass(), pass(12)).run)).toMatchObject({ keep: 'current' });
    expect(await judgeTestChange(change, runs(pass(), pass()).run)).toMatchObject({ keep: 'current' });
  });

  it('asks only when the current one fails and the new one passes without saying what it ran', async () => {
    expect(await judgeTestChange(change, runs(pass(), fail()).run)).toMatchObject({ ask: true });
  });

  it('counts the failing tests too, across the common runners', () => {
    expect(testsRan('Tests:       2 failed, 10 passed, 12 total')).toBe(12);
    expect(testsRan(' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 10 passed (12)')).toBe(12);
    expect(testsRan('10 passing (2s)\n  2 failing')).toBe(12);
    expect(testsRan('=== 2 failed, 10 passed in 1.2s ===')).toBe(12);
    expect(testsRan('Failed!  - Failed:     2, Passed:    10')).toBe(12);
    expect(testsRan('# pass 10\n# fail 2')).toBe(12);
    expect(testsRan('Tests  12 passed (12)')).toBe(12);
    expect(testsRan('it worked')).toBeNull();
  });
});

describe('at the checks', () => {
  let tmp: string;
  let wt: string;
  let bp: ReturnType<typeof boardPaths>;
  const get = (id: string) => readTicket(bp, id)!;
  const squad = () => new LiveSquad(bp) as unknown as Squad;
  const words = (t: Ticket) => t.activity.map((a) => a.text);

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-test-change-')));
    wt = path.join(tmp, 'copy');
    fs.mkdirSync(wt);
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function ready(from: string, to: string, more: Partial<NonNullable<Ticket['testChange']>> = {}): Ticket {
    writeMeta(bp, { ...readMeta(bp), commands: { test: from } });
    const t0 = actions.createTicket(bp, { title: 'Limit bookings', ask: 'One person blocks the whole day.' });
    return updateTicket(bp, t0.id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.waiting = null;
      x.squad = null;
      x.worktree = wt;
      x.sessions = { intake: 'i-1', build: 'b-1' };
      x.story = 'As a clerk, I want at most 3 bookings a day per person.';
      x.criteria = [{ given: 'a person with 3 bookings', when: 'they book again', then: 'it is refused' }];
      x.steps = [{ title: 'Refuse the fourth booking', status: 'done' }];
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.testChange = { from, to, at: new Date().toISOString(), ...more };
    });
  }

  const say = (n: number) => `echo "Tests  ${n} passed"`;

  it('keeps a new command that works by itself, says so in plain words, and runs the checks with it', async () => {
    const t0 = ready(say(3), say(5));
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(readMeta(bp).commands?.test).toBe(say(5));
    expect(t.testChange).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(actions.inbox(bp).map((x) => x.id)).not.toContain(t.id);
    expect(words(t)).toContain('squad-kit keeps the new way of testing: the new way works and runs every test');
    expect(words(t).join(' ')).not.toContain('echo');
    // The commands are for engineers.
    expect(t.testDecided).toMatchObject({ from: say(3), to: say(5), kept: 'new', by: 'squad', ran: 'new: passed, 5 tests; current: passed, 3 tests' });
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '5 tests pass, test OK', ran: [{ name: 'test', command: say(5), ok: true, tests: 5 }] });
  });

  it('keeps the current command when the new one does not work, and nobody is asked', async () => {
    const t0 = ready(say(3), 'exit 3');
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(readMeta(bp).commands?.test).toBe(say(3));
    expect(t.testChange).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(words(t)).toContain('squad-kit keeps the current way of testing: the new way did not pass');
    expect(t.testDecided).toMatchObject({ kept: 'current', by: 'squad' });
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '3 tests pass, test OK' });
  });

  it('asks in one plain sentence only when it truly cannot tell, and goes on with the current one meanwhile', async () => {
    const t0 = ready('exit 3', 'echo fine');
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(t.testChange).toMatchObject({ from: 'exit 3', to: 'echo fine', ask: true });
    expect(actions.inbox(bp).map((x) => x.id)).toContain(t.id);
    expect(words(t)).toContain('squad-kit cannot tell which way of testing to keep, so it asks you. The checks keep the current way for now');
    expect(words(t).join(' ')).not.toMatch(/exit 3|echo fine/);
    expect(readMeta(bp).commands?.test).toBe('exit 3');
    expect(t.gates?.checks).toBe('fail');
    // Asked once: the next checks do not try it again.
    const before = t.activity.length;
    updateTicket(bp, t.id, (x) => {
      x.stage = 'test';
      x.live = true;
    });
    await squad().checks(t.id);
    expect(words(get(t.id)).slice(0, get(t.id).activity.length - before).join(' ')).not.toContain('cannot tell');

    const chosen = actions.decideTestCommand(bp, t.id, true);
    expect(readMeta(bp).commands?.test).toBe('echo fine');
    expect(chosen.testChange).toBeUndefined();
    expect(chosen.testDecided).toMatchObject({ kept: 'new', by: 'you' });
  });

  it('drops a change another ticket already made', async () => {
    const t0 = ready(say(3), say(5));
    writeMeta(bp, { ...readMeta(bp), commands: { test: say(5) } });
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(t.testChange).toBeUndefined();
    expect(t.testDecided).toBeUndefined();
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '5 tests pass, test OK' });
  });
});
