import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { DRAG, installPlaywright, quickNpx, runsIn } from './support/fake-playwright.js';

import { inGuard } from './support/in-guard.js';
/**
 * A check that failed once for no reason in the code, or that already failed before the story started, does not send
 * a small story on a long detour. A failed check runs once more first. When the same command already failed on code
 * nobody had touched, the Builder is told, and the gate stays as it is. And the count on the gate is the true count.
 * The AI tool is a fake that answers at once.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { failedOnceLine, runChecks, testCount } = await import('../src/engine/checks.js');
const { testsRan } = await import('../src/engine/test-change.js');
const { knownFailures } = await import('../src/engine/known-failures.js');
const { buildGuard } = await import('../src/engine/project-guard.js');
const { tailLines } = await import('../src/core/app-log.js');
const P = await import('../src/engine/prompts.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = { checks(id: string): Promise<void> };

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-again-')));
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

const squad = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const commands = (c: Record<string, string>) => writeMeta(bp, { ...readMeta(bp), commands: c });
const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);
const logged = () => tailLines(500).join('\n');

/** Fails the first time it runs in this copy, with a line to read, then passes with a summary. */
const FLAKY = `if [ -f ran-once ]; then echo "Tests  34 passed"; else touch ran-once; echo "drag test timed out"; exit 1; fi`;
/** Counts its runs in a file, and always fails. */
const FAILS = 'echo run >> runs.txt; echo "the booking test failed"; exit 1';
const runs = () => fs.readFileSync(path.join(wt, 'runs.txt'), 'utf8').trim().split('\n').length;

function built(title = 'Limit bookings'): Ticket {
  const t0 = actions.createTicket(bp, { title, ask: 'One person blocks the whole day.' });
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
  });
}

/** What squad-kit saw when it ran the tests on untouched code, in its first run. */
function setupSaw(command: string, output = 'the drag test failed'): void {
  const meta = readMeta(bp);
  meta.setup = { kind: 'project', startedAt: new Date().toISOString(), steps: [], proof: { tests: [{ ok: false, command, repo: '.', output }] } } as never;
  writeMeta(bp, meta);
}

describe('a failed check runs once more before the Builder is called', () => {
  it('passes the second time: the story goes on, with one plain line, no failed try and no Builder', async () => {
    commands({ test: FLAKY, lint: 'true' });
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(builds()).toHaveLength(0);
    expect(t.tries).toBe(0);
    expect(t.fails ?? 0).toBe(0);
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '34 tests pass, test, lint OK' });
    expect(t.activity.map((a) => a.text)).toContain('A test failed once and passed when run again.');
    expect(t.squad?.phase).toBe('review');
    // For engineers, in the Developer tab's list of checks.
    expect(t.gates?.ran).toEqual([
      { name: 'test', command: FLAKY, ok: true, tests: 34, failedOnce: true },
      { name: 'lint', command: 'true', ok: true },
    ]);
    // The Reviewer reads it too, and the first failure is in the log.
    expect(P.reviewPrompt(readMeta(bp), [], t, 1)).toContain('it failed once first, and passed when run again');
    expect(logged()).toContain('test failed once and passed when run again');
    expect(logged()).toContain('drag test timed out');
  });

  it('fails the second time too: one failed try, and the Builder reads the last output', async () => {
    commands({ test: FAILS });
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(runs()).toBe(2);
    expect(t.tries).toBe(1);
    expect(t.fails).toBe(1);
    expect(t.gates?.ran?.[0]).toEqual({ name: 'test', command: FAILS, ok: false });
    expect(t.activity.map((a) => a.text)).not.toContain('A test failed once and passed when run again.');
    expect(builds()).toHaveLength(1);
    expect(builds()[0]!.prompt).toContain('the booking test failed');
  });

  it('every check gets it, each with its own plain line, and only the failed one runs twice', async () => {
    const flaky = (name: string) => `if [ -f ${name} ]; then echo fine; else touch ${name}; exit 1; fi`;
    const started: string[] = [];
    const results = await runChecks(wt, { test: 'echo "Tests  1 passed"', lint: flaky('lint-ran'), build: flaky('build-ran') }, (name) => started.push(name));
    expect(results.map((r) => [r.name, r.ok, r.failedFirst !== undefined])).toEqual([
      ['test', true, false],
      ['lint', true, true],
      ['build', true, true],
    ]);
    expect(started).toEqual(['test', 'lint', 'lint', 'build', 'build']);
    expect(failedOnceLine('lint')).toBe('The code check failed once and passed when run again.');
    expect(failedOnceLine('build')).toBe('The build failed once and passed when run again.');
    expect(failedOnceLine('start')).toBe('The app did not start the first time, and started when run again.');
  });

  it('the app start gets it too', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    fs.writeFileSync(path.join(wt, 'app.js'), `const fs = require('fs');
if (!fs.existsSync('started-once')) { fs.writeFileSync('started-once', ''); process.exit(3); }
require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');
`);
    const [r] = await runChecks(wt, { start: 'node app.js', url: `http://127.0.0.1:${port}` }, undefined, {}, 20_000);
    expect(r).toMatchObject({ name: 'start', ok: true });
    expect(r!.failedFirst).toContain('The app stopped while starting');
  });

  it('never after a Stop, or for a command squad-kit had to end, or for a file the guard blocked', async () => {
    const stop = new AbortController();
    const [stopped] = await runChecks(wt, { test: 'echo run >> stopped.txt; sleep 30' }, () => setTimeout(() => stop.abort(), 150), { signal: stop.signal });
    expect(stopped!.ok).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'stopped.txt'), 'utf8').trim().split('\n')).toHaveLength(1);

    const [silent] = await runChecks(wt, { test: 'echo run >> silent.txt; sleep 30' }, undefined, { silentMs: 300 });
    expect(silent!.ok).toBe(false);
    expect(silent!.output).toContain('printed nothing');
    expect(fs.readFileSync(path.join(wt, 'silent.txt'), 'utf8').trim().split('\n')).toHaveLength(1);

  });

  it.skipIf(process.platform !== 'darwin' || inGuard)('nor for a file the guard blocked: it would only fail the same way', async () => {
    const home = path.join(tmp, 'home');
    const guard = buildGuard({ cwd: wt, root: tmp, cache: path.join(tmp, 'cache'), extraWrite: [path.join(tmp, 'cache')], extraRead: [path.join(tmp, 'cache')], home, platform: 'darwin' });
    const secret = path.join(home, '.ssh', 'id_rsa');
    const [r] = await runChecks(wt, { test: `echo run >> blocked.txt; echo "Error: EPERM: operation not permitted, open '${secret}'"; exit 1` }, undefined, { guard });
    expect(r!.ok).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'blocked.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the second try runs only the tests that failed', () => {
  const log = () => path.join(tmp, 'runs.log');
  let putBack = () => {};
  beforeAll(() => (putBack = quickNpx(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-npx-')))));
  afterAll(() => putBack());
  const shelves = (text: string) => {
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'shelves.txt'), text);
  };

  const all = 'copy test';
  const alone = 'copy test tests/e2e/shelves\\.spec\\.ts:387';

  it('the failed test passes on its own: that decides nothing, all 70 run once more, and that pass counts', async () => {
    installPlaywright(wt, log());
    shelves('broken');
    fs.writeFileSync(path.join(wt, 'passes-alone'), '');
    fs.writeFileSync(path.join(wt, 'fails-once'), '');
    const started: string[] = [];
    const [r] = await runChecks(wt, { test: 'npx playwright test' }, (name) => started.push(name));
    expect(runsIn(log())).toEqual([all, alone, all]);
    expect(started).toEqual(['test', 'test']);
    expect(r).toMatchObject({ name: 'test', ok: true });
    expect(r!.failedFirst).toContain('1 failed');
    expect(testCount(r!.output)).toBe(70);
    // Through the story: the same plain line as any test that failed once, and no Builder.
    commands({ test: 'npx playwright test' });
    fs.rmSync(log());
    fs.rmSync(path.join(wt, 'ran-all-once'));
    const t0 = built();
    await squad().checks(t0.id);
    expect(get(t0.id).gates).toMatchObject({ checks: 'pass', checksText: '70 tests pass, test OK' });
    expect(get(t0.id).activity.map((a) => a.text)).toContain('A test failed once and passed when run again.');
    expect(builds()).toHaveLength(0);
    expect(runsIn(log())).toEqual([all, alone, all]);
  });

  it('it passes on its own but fails beside the others: the whole run decides, so the check fails and the Builder fixes it', async () => {
    installPlaywright(wt, log());
    shelves('broken');
    fs.writeFileSync(path.join(wt, 'passes-alone'), '');
    const [r] = await runChecks(wt, { test: 'npx playwright test' });
    expect(runsIn(log())).toEqual([all, alone, all]);
    expect(r!.ok).toBe(false);
    expect(r!.failedFirst).toBeUndefined();
    expect(r!.output).toContain('Running 70 tests using 1 worker');
    // Through the story: a failed try, as ever, and no story goes past a test that fails with the others.
    commands({ test: 'npx playwright test' });
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(t.tries).toBe(1);
    expect(t.gates?.checks).toBe('fail');
    expect(t.activity.map((a) => a.text)).not.toContain('A test failed once and passed when run again.');
    expect(builds()).toHaveLength(1);
  });

  it('still failing on its own: the check fails at once, with what the whole first run printed, and the suite does not run again', async () => {
    installPlaywright(wt, log());
    shelves('broken');
    const [r] = await runChecks(wt, { test: 'npx playwright test' });
    expect(runsIn(log())).toEqual(['copy test', 'copy test tests/e2e/shelves\\.spec\\.ts:387']);
    expect(r!.ok).toBe(false);
    expect(r!.output).toContain('Running 70 tests using 1 worker');
    expect(r!.output).toContain('69 passed (2.8m)');
    expect(r!.output).not.toContain('Running 1 test');
  });

  it('a chain whose first part failed reruns the whole command: the second part never ran', async () => {
    installPlaywright(wt, log());
    shelves('fine');
    // Vitest fails first, so Playwright never runs.
    fs.writeFileSync(path.join(wt, 'node_modules', '.bin', 'vitest'), `#!/bin/sh\necho "vitest $*" >> '${log()}'\nprintf ' FAIL  src/sum.test.ts > sums > adds\\n Test Files  1 failed (1)\\n      Tests  1 failed | 3 passed (4)\\n'\nexit 1\n`, { mode: 0o755 });
    const [r] = await runChecks(wt, { test: 'npx vitest run && npx playwright test' });
    expect(r!.ok).toBe(false);
    expect(runsIn(log())).toEqual(['vitest run', 'vitest run']);
  });

  it('a failure it cannot name, or a tool not in the copy: the whole command again, as before', async () => {
    commands({ test: FAILS });
    await squad().checks(built().id);
    expect(runs()).toBe(2);
    // The output names the test, but no Playwright is installed here.
    shelves('broken');
    const out = path.join(tmp, 'out.txt');
    fs.writeFileSync(out, `Running 70 tests using 1 worker\n  1 failed\n    ${DRAG} \n  69 passed (2.8m)\n`);
    const [r] = await runChecks(wt, { test: `echo run >> runs2.txt; cat '${out}'; exit 1` });
    expect(r!.ok).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'runs2.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('a check that already failed before the story started', () => {
  it('the Builder is told in plain facts, with what it printed then', async () => {
    commands({ test: FAILS });
    setupSaw(FAILS);
    const t0 = built();
    await squad().checks(t0.id);
    const prompt = builds()[0]!.prompt!;
    expect(prompt).toContain(`These checks already failed before this story started: test (${FAILS}). Fix what this story broke. Do not change other screens or rules to make an old failure pass, unless the plan asks.`);
    expect(prompt).toContain('the drag test failed');
  });

  it('another command is not the same failure, so the prompt stays as it was', async () => {
    commands({ test: FAILS });
    setupSaw('npm run other');
    const t0 = built();
    await squad().checks(t0.id);
    expect(builds()[0]!.prompt).not.toContain('already failed before this story started');
    expect(P.fixChecksPrompt([{ name: 'test', command: 'x', output: 'y' }])).not.toContain('already failed');
  });

  it('skips no gate: the checks still fail, so the plain stop comes with its ways out', async () => {
    commands({ test: FAILS });
    setupSaw(FAILS);
    const t0 = built();
    for (let i = 0; i < 3; i += 1) await squad().checks(t0.id);
    const t = get(t0.id);
    expect(t.gates?.checks).toBe('fail');
    expect(t.stage).not.toBe('review');
    expect(t.stuck).toMatchObject({ gate: 'checks', question: 'The checks still fail after 3 tries: the tests did not pass.' });
    expect(t.stuck?.options.map((o) => o.do)).toContain('retry');
    expect(t.stuck?.options.map((o) => o.do)).toContain('continue');
  });

  it('once the command passes on a story, it is no longer known to fail; the first run keeps what it saw', async () => {
    commands({ test: 'echo "Tests  2 passed"' });
    setupSaw('echo "Tests  2 passed"');
    const t0 = built();
    expect(knownFailures(bp, t0, [{ name: 'test', command: 'echo "Tests  2 passed"' }])).toHaveLength(1);
    await squad().checks(t0.id);
    expect(knownFailures(bp, t0, [{ name: 'test', command: 'echo "Tests  2 passed"' }])).toEqual([]);
    expect(readMeta(bp).setup?.proof?.tests?.[0]).toMatchObject({ ok: false, passedSince: expect.any(String) });
  });

  it('a pass after a failure does not say it is gone: it may fail again next time', async () => {
    commands({ test: FLAKY });
    setupSaw(FLAKY);
    const t0 = built();
    await squad().checks(t0.id);
    expect(knownFailures(bp, t0, [{ name: 'test', command: FLAKY }])).toHaveLength(1);
  });
});

describe('the number of tests on the gate', () => {
  const COLORS = '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m3 passed\x1b[39m\x1b[22m\x1b[90m (3)\x1b[39m\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m34 passed\x1b[39m\x1b[22m\x1b[90m (34)\x1b[39m\n\x1b[2m   Start at \x1b[22m 05:55:56\n';

  it('real vitest output, with the colors it prints when CI is set: 34, never the 3 test files', () => {
    expect(testCount(COLORS)).toBe(34);
    expect(testCount(' Test Files  3 passed (3)\n      Tests  34 passed (34)\n   Start at  04:34:04\n')).toBe(34);
    expect(testCount(' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 33 passed | 2 skipped (36)\n')).toBe(33);
  });

  it('jest', () => {
    expect(testCount('Test Suites: 3 passed, 3 total\nTests:       34 passed, 34 total\nSnapshots:   0 total\nTime:        1.2 s\n')).toBe(34);
    expect(testCount('Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 2 skipped, 33 passed, 36 total\n')).toBe(33);
  });

  it('pytest', () => {
    expect(testCount('tests/test_a.py ....\n============================= 34 passed in 0.12s =============================\n')).toBe(34);
    expect(testCount('==== 1 failed, 33 passed, 2 skipped, 1 warning in 1.20s (0:00:01) ====\n')).toBe(33);
    expect(testCount('34 passed, 1 warning in 0.50s\n')).toBe(34);
  });

  it('playwright', () => {
    expect(testCount('Running 27 tests using 1 worker\n\n[1/27] tests/e2e/a.spec.ts:1:1 › one\n  27 passed (2.9m)\n')).toBe(27);
    expect(testCount('  1 failed\n    [chromium] › tests/e2e/a.spec.ts:1:1 › one\n  26 passed (2.9m)\n')).toBe(26);
  });

  it('mocha, node --test, dotnet and cargo', () => {
    expect(testCount('  34 passing (12ms)\n')).toBe(34);
    expect(testCount('# tests 5\n# pass 5\n# fail 0\n')).toBe(5);
    expect(testCount('ℹ tests 5\nℹ pass 5\nℹ fail 0\n')).toBe(5);
    expect(testCount('Passed!  - Failed:     0, Passed:    34, Skipped:     0, Total:    34, Duration: 1 s\n')).toBe(34);
    expect(testCount('test result: ok. 30 passed; 0 failed; 0 ignored\n\ntest result: ok. 4 passed; 0 failed; 0 ignored\n')).toBe(34);
  });

  it('a command that runs two test tools adds them up', () => {
    expect(testCount(' Test Files  4 passed (4)\n      Tests  16 passed (16)\n   Duration  1s\n\n> app@1.0.0 test:e2e\nRunning 27 tests using 1 worker\n  27 passed (2.9m)\n')).toBe(43);
  });

  it('counts only summary lines, so a test name or a log line never adds to them', () => {
    expect(testCount('✓ shows 5 passed checks in the list\nall 9 passed reviews saved\n      Tests  2 passed (2)\n')).toBe(2);
  });

  it('another tool: the first count it says, and none when it says none', () => {
    expect(testCount('All good: 7 passed\n')).toBe(7);
    expect(testCount('Tests  0 passed\n')).toBe(0);
    expect(testCount('ok  example.com/app 0.1s\n')).toBeNull();
    expect(testCount('')).toBeNull();
  });

  it('how many ran is read through the colors too', () => {
    expect(testsRan(COLORS)).toBe(34);
    expect(testsRan('\x1b[2m      Tests \x1b[22m \x1b[31m2 failed\x1b[39m | \x1b[32m10 passed\x1b[39m (12)\n')).toBe(12);
  });

  it('the gate says one test in plain words, and counts only what the tests printed', async () => {
    commands({ test: 'echo "Tests  1 passed"' });
    const t0 = built();
    await squad().checks(t0.id);
    expect(get(t0.id).gates).toMatchObject({ checks: 'pass', checksText: '1 test passes, test OK' });

    // The tests print no count, and a later check prints something that looks like one.
    commands({ test: 'echo fine', build: 'echo "5 passed through the bundler"' });
    const t1 = built('Another');
    await squad().checks(t1.id);
    expect(get(t1.id).gates?.checksText).toBe('test, build pass');
  });
});
