import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { CommandResult } from '../src/engine/checks.js';
import type { Criterion, Ticket } from '../src/board/types.js';
import type { KindsHost } from '../src/engine/proof-kinds/flow.js';

/**
 * The proof judges each "done when" by its own kind. A Test line is proved only by a test that fails on main's code and
 * passes on the story's: one that passes on main too goes back to the Builder as Not shown yet, to write a real test. A
 * Not on a screen line is what the Reviewer checked in its review. A planned picture is never quietly Not on a screen.
 * A story with no Screen line starts no browser; an old spec with no kinds is proved exactly as before.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { judgeTest, commandFor, cleanNamed } = await import('../src/engine/proof-kinds/tests.js');
const { keepNoneChecks, kindsStop, plannedProof, provedByKind } = await import('../src/engine/proof-kinds/flow.js');
const { appNeeded, kindOf, picturesNeeded, testerLines, testerProves } = await import('../src/engine/proof-kinds/lines.js');
const { kindsForTester, noneForReviewer, noPicturesPrompt } = await import('../src/engine/proof-kinds/prompts.js');
const { checkedLine, savedWords, isSavedProof } = await import('../src/engine/proof-kinds/saved.js');

let tmp: string;
let dir: string;
let base: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-kinds-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  // The story's copy: a Vitest project with the test that proves line 2.
  dir = path.join(tmp, 'copy');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'vitest'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  // main has an old test; the story adds the one that proves line 2.
  fs.writeFileSync(path.join(dir, 'tests', 'old.test.ts'), "it('was here before', () => {});\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'main');
  base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'tests', 'booking.test.ts'), "it('frees an unpaid slot', () => {});\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Vitest's own words: a run that passed, one where that very test failed its check, and one an import stopped. */
const PASSED = ' Test Files  1 passed (1)\n      Tests  1 passed (1)';
const FAILED = (name = 'frees an unpaid slot') => ` FAIL  tests/booking.test.ts > ${name}\nAssertionError: expected true to be false\n Test Files  1 failed (1)\n      Tests  1 failed (1)`;
const IMPORT_FAILED = " FAIL  tests/booking.test.ts [ tests/booking.test.ts ]\nError: Cannot find module '../src/slots'\n⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\n Test Files  1 failed (1)\n      Tests  no tests";
const run = (ok: boolean, output = ok ? PASSED : FAILED()): CommandResult => ({ ok, output, seconds: 0.42 });
const c = (then: string, kind?: string, why?: string): Criterion => ({ given: 'a customer', when: 'they book', then, ...(kind ? { proof: { kind: kind as 'screen', ...(why ? { why } : {}) } } : {}) });

function story(criteria: Criterion[]): string {
  const t = actions.createTicket(bp, { title: 'Pay by card when booking', ask: 'Customers pay by card.' });
  updateTicket(bp, t.id, (x) => {
    x.criteria = criteria;
    x.stage = 'review';
    x.baseCommit = base;
  });
  return t.id;
}

function host(id: string, o: { named?: unknown; now?: CommandResult; main?: CommandResult | null }): KindsHost & { ran: string[]; onMainRan: string[] } {
  const ran: string[] = [];
  const onMainRan: string[] = [];
  return {
    bp,
    id,
    dir,
    testCommand: 'npm test',
    ran,
    onMainRan,
    update: (change) => updateTicket(bp, id, change),
    tester: async () => o.named,
    run: async (cmd) => (ran.push(cmd), o.now ?? run(true)),
    onMain: async (use) => {
      if (o.main === null) return null;
      const main = path.join(tmp, 'main');
      fs.mkdirSync(main, { recursive: true });
      return use(main, async (cmd) => (onMainRan.push(cmd), o.main ?? run(false)));
    },
    log: () => {},
  };
}

const named = { tests: [{ criterion: 2, file: 'tests/booking.test.ts', name: 'frees an unpaid slot', steps: ['Makes a booking at 10:00 and does not pay', 'Moves the clock to 10:16', 'The 10:30 slot is free again'] }] };

describe('a Test line: it must fail on main and pass now', () => {
  it('judges the two runs', () => {
    const t = { criterion: 2, file: 'tests/booking.test.ts', name: 'frees an unpaid slot', steps: ['a'] };
    expect(judgeTest(t, run(true), run(false))).toMatchObject({ shows: 'met', proof: { before: 'failed', after: 'passed', seconds: 0.4 } });
    expect(judgeTest(t, run(true), run(true))).toMatchObject({ shows: 'not-shown', toBuilder: true });
    expect(judgeTest(t, run(true), run(true)).why).toContain('passes too, so it does not show the change');
    expect(judgeTest(t, run(false), run(false))).toMatchObject({ shows: 'broken', toBuilder: true });
    expect(judgeTest(t, run(true), null)).toMatchObject({ shows: 'not-shown', toBuilder: false, proof: { before: 'unknown' } });
  });

  it('failed before counts only when that very test ran on main and its check said no', () => {
    const t = { criterion: 2, file: 'tests/booking.test.ts', name: 'frees an unpaid slot', steps: ['a'] };
    // An import stopped it: it never ran, so it proves nothing.
    expect(judgeTest(t, run(true), run(false, IMPORT_FAILED))).toMatchObject({ shows: 'not-shown', toBuilder: false, proof: { before: 'unknown' } });
    // Another test of the file failed, not this one.
    expect(judgeTest(t, run(true), run(false, FAILED('keeps a paid slot'))).proof?.before).toBe('unknown');
    // The time ran out, or the tool is missing.
    expect(judgeTest(t, run(true), { ok: false, output: FAILED(), seconds: 300, ended: true }).proof?.before).toBe('unknown');
    expect(judgeTest(t, run(true), run(false, 'sh: vitest: command not found')).proof?.before).toBe('unknown');
    // The name is matched whole: a longer test name with the same end is not this test.
    expect(judgeTest(t, run(true), run(false, FAILED('also frees an unpaid slot'))).proof?.before).toBe('unknown');
    // On the story's code, a run that ran no test passes nothing, and says so.
    expect(judgeTest(t, run(true, 'No test files found'), run(false))).toMatchObject({ shows: 'not-shown', toBuilder: false, proof: { after: 'unknown' } });
  });

  it("runs only that test with the project's own tool, and takes only a test file inside the copy", () => {
    const how = commandFor(dir, 'npm test', { criterion: 2, file: 'tests/booking.test.ts', name: 'Bookings > frees an unpaid slot', steps: [] })!;
    expect(how.command).toContain('vitest run');
    expect(how.command).toContain("'tests/booking.test.ts'");
    // Anchored at both ends: only this test, never one whose name merely contains it.
    expect(how.command).toContain("-t '^Bookings frees an unpaid slot$'");
    expect(how.whole).toBe(false);
    expect(commandFor(dir, 'npm test', { criterion: 2, file: 'tests/booking.test.ts', name: 'costs 1.50 (with tax)', steps: [] })!.command).toContain("-t '^costs 1\\.50 \\(with tax\\)$'");
    expect(cleanNamed({ tests: [{ criterion: 2, file: '../secret.ts', name: 'x', steps: [] }, { criterion: 9, file: 'tests/booking.test.ts', name: 'x', steps: [] }] }, dir, [2])).toEqual([]);
  });

  it('takes a name only when it is not empty and each of its parts is written in the file', () => {
    const one = (name: string) => cleanNamed({ tests: [{ criterion: 2, file: 'tests/booking.test.ts', name, steps: ['a'] }] }, dir, [2]);
    expect(one('frees an unpaid slot')).toHaveLength(1);
    expect(one('')).toEqual([]);
    expect(one('frees a paid slot')).toEqual([]);
    expect(one('Bookings > frees an unpaid slot')).toEqual([]);
  });

  it('met: the test failed on main with the story\'s test file put there, and passes now', async () => {
    const id = story([c('I see Paid', 'screen'), c('a slot not paid in 15 minutes is freed', 'test', 'A test moves the clock.'), c('card numbers are never saved', 'none', 'Nothing to show.')]);
    const h = host(id, { named });
    keepNoneChecks(bp, readTicket(bp, id)!, [{ criterion: 3, checked: 'Checked the code and the tables: only the last 4 digits are kept.', holds: true }]);
    const out = await provedByKind(h);
    expect(out).toEqual({ broken: [], open: [] });
    expect(h.ran).toHaveLength(1);
    expect(h.onMainRan).toEqual(h.ran);
    expect(fs.readFileSync(path.join(tmp, 'main', 'tests', 'booking.test.ts'), 'utf8')).toBe("it('frees an unpaid slot', () => {});\n");
    const rows = readTicket(bp, id)!.proof!;
    expect(rows.map((r) => [r.kind, r.shows])).toEqual([
      ['test', 'met'],
      ['none', 'met'],
    ]);
    expect(rows[0]!.test).toMatchObject({ name: 'frees an unpaid slot', before: 'failed', after: 'passed', steps: named.tests[0]!.steps });
    expect(rows[1]!.checked).toContain('last 4 digits');
    expect(isSavedProof(rows[0]!.after)).toBe(true);
    expect(fs.existsSync(path.join(bp.proofDir, rows[0]!.after))).toBe(true);
  });

  it("main gets the test file as it was before the story's run, not what the run left", async () => {
    const id = story([c('a slot not paid in 15 minutes is freed', 'test')]);
    const h = host(id, { named: { tests: [{ ...named.tests[0]!, criterion: 1 }] } });
    h.run = async () => {
      fs.writeFileSync(path.join(dir, 'tests', 'booking.test.ts'), "it('frees an unpaid slot', () => { expect(1).toBe(1); });\n");
      return run(true);
    };
    await provedByKind(h);
    expect(fs.readFileSync(path.join(tmp, 'main', 'tests', 'booking.test.ts'), 'utf8')).toBe("it('frees an unpaid slot', () => {});\n");
  });

  it('a test that passes on main too goes back to the Builder as Not shown yet', async () => {
    const id = story([c('a slot not paid in 15 minutes is freed', 'test')]);
    const out = await provedByKind(host(id, { named: { tests: [{ ...named.tests[0]!, criterion: 1 }] }, main: run(true) }));
    expect(out.broken).toHaveLength(1);
    expect(out.broken[0]!.why).toContain('Write a test that fails without the change');
    expect(readTicket(bp, id)!.proof![0]).toMatchObject({ kind: 'test', shows: 'not-shown' });
  });

  it('a test from before the story is never the proof: the Tester is asked again, then the Builder writes one', async () => {
    const id = story([c('a slot is freed', 'test')]);
    const asked: string[] = [];
    const h = host(id, { named: { tests: [{ ...named.tests[0]!, criterion: 1, file: 'tests/old.test.ts' }] } });
    h.tester = async (o) => {
      asked.push(o.check({ tests: [{ ...named.tests[0]!, criterion: 1, file: 'tests/old.test.ts' }] }) ?? 'ok');
      return { tests: [{ ...named.tests[0]!, criterion: 1, file: 'tests/old.test.ts' }] };
    };
    const out = await provedByKind(h);
    expect(asked[0]).toContain('give a test file this story added or changed');
    expect(asked[0]).toContain('tests/booking.test.ts');
    expect(out.broken[0]!.why).toContain('No test proves it yet');
    expect(h.ran).toEqual([]);
  });

  it('no test named: the Builder writes one; not run on main: the person decides', async () => {
    const a = story([c('a slot is freed', 'test')]);
    expect((await provedByKind(host(a, { named: { tests: [] } }))).broken[0]!.why).toContain('No test proves it yet');
    const b = story([c('a slot is freed', 'test')]);
    const out = await provedByKind(host(b, { named: { tests: [{ ...named.tests[0]!, criterion: 1 }] }, main: null }));
    expect(out.open[0]!.why).toContain("could not run the test");
    const x = readTicket(bp, b)!;
    kindsStop(x, out.open);
    expect(x.stuck?.question).toContain('could not make the proof of "done when" 1');
    expect(x.waiting?.kind).toBe('stuck');
  });
});

describe('a planned proof is never dropped quietly', () => {
  it('no app could start for the Tester: its Screen, API and Data lines wait for the person', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'npm run dev', url: 'http://localhost:3000' } });
    const id = story([c('I see Paid', 'screen'), c('the booking is saved', 'data'), c('card numbers are never saved', 'none', 'Nothing to show.')]);
    keepNoneChecks(bp, readTicket(bp, id)!, [{ criterion: 3, checked: 'Only the last 4 digits are kept.', holds: true }]);
    const out = await provedByKind(host(id, {}), false);
    expect(out.open.map((r) => r.criterion)).toEqual([1, 2]);
    expect(out.open[1]!.why).toBe('squad-kit could not start the app here, so the Data proof was not made.');
    expect(out.broken).toEqual([]);
  });

  it("says what squad-kit's check looked at: the screenshots before, the proof with kinds", () => {
    const rows = (kind?: string) => [{ criterion: 'a', before: '', after: 'x', beforeLabel: '', afterLabel: '', shows: 'met' as const, ...(kind ? { kind: kind as 'test' } : {}) }];
    expect(checkedLine({ criteria: [c('a')], proof: rows() }, [])).toBe('Checked the screenshots: each "done when" on a screen is met');
    expect(checkedLine({ criteria: [c('a')], proof: rows() }, ['1 not shown yet'])).toBe('Checked the screenshots: 1 met, 1 not shown yet');
    expect(checkedLine({ criteria: [c('a', 'api')], proof: rows('api') }, [])).toBe('Checked the proof: each "done when" it shows is met');
    // A Test row is squad-kit's run, not the check's: it is not counted.
    expect(checkedLine({ criteria: [c('a', 'test')], proof: rows('test') }, ['1 not shown yet'])).toBe('Checked the proof: 0 met, 1 not shown yet');
  });
});

describe('a Not on a screen line: the Reviewer says what it checked', () => {
  it('one that does not hold goes to the Builder, one with no check waits for the person', async () => {
    const id = story([c('card numbers are never saved', 'none', 'Nothing to show.'), c('logs hold no email', 'none', 'Nothing to show.')]);
    keepNoneChecks(bp, readTicket(bp, id)!, [{ criterion: 1, checked: 'The payments table keeps the whole card number.', holds: false }]);
    const out = await provedByKind(host(id, {}));
    expect(out.broken[0]!.why).toContain('does not hold');
    expect(out.open[0]!.why).toBe('The Reviewer has not said what it checked yet.');
    expect(noneForReviewer(readTicket(bp, id)!)).toContain('1. Card numbers are never saved Reason: Nothing to show.');
  });
});

describe('the verdict per kind, and the old way', () => {
  it('never takes a planned picture quietly as Not on a screen', () => {
    const kinds = { criteria: [c('I see Paid', 'screen')] } as Ticket;
    const old = { criteria: [c('I see Paid')] } as Ticket;
    const off = { shows: 'off-screen', why: 'The app has no past bookings.', advice: '' };
    expect(plannedProof(kinds, 1, off)).toMatchObject({ shows: 'not-shown', why: 'Screen was planned, and the Tester could not make it: The app has no past bookings.' });
    expect(plannedProof(old, 1, off)).toEqual(off);
    expect(plannedProof(kinds, 1, null)).toBeNull();
  });

  it('the Tester proves Screen, API and Data lines; squad-kit the rest', () => {
    const t = { criteria: [c('I see Paid', 'screen'), c('saved', 'data'), c('answers', 'api'), c('freed', 'test'), c('never saved', 'none', 'x')] } as Ticket;
    expect(testerLines(t)).toEqual([1, 2, 3]);
    expect(testerProves(t, 4)).toBe(false);
    expect(kindOf(t, 5)).toBe('none');
    expect(kindsForTester(t, ['app'])).toContain('Prove only 1, 2, 3. Leave out 4, 5');
    expect(kindsForTester(t, ['app'])).toContain('read_rows with when "before"');
  });

  it('a backend-only story starts the app only for its API or rows, and never for pictures', () => {
    const backend = { criteria: [c('answers', 'api'), c('freed', 'test')] } as Ticket;
    expect(picturesNeeded(backend, true)).toBe(false);
    expect(appNeeded(backend, true)).toBe(true);
    const testsOnly = { criteria: [c('freed', 'test'), c('never saved', 'none', 'x')] } as Ticket;
    expect(appNeeded(testsOnly, true)).toBe(false);
    expect(noPicturesPrompt(backend, '1. …', ['app'], '')).not.toContain('take_screenshots');
  });

  it('an old spec with no kinds: every rule falls back to what the squad did before', async () => {
    const old = { criteria: [c('I see Paid'), c('saved')] } as Ticket;
    expect(picturesNeeded(old, true)).toBe(true);
    expect(picturesNeeded(old, false)).toBe(false);
    expect(appNeeded(old, false)).toBe(false);
    expect(testerLines(old)).toEqual([1, 2]);
    expect(kindOf(old, 1)).toBeNull();
    expect(kindsForTester(old, [])).toBe('');
    const id = story([c('I see Paid'), c('saved')]);
    expect(await provedByKind(host(id, {}))).toEqual({ broken: [], open: [] });
    expect(readTicket(bp, id)!.proof).toBeUndefined();
    expect(savedWords(['a.png', 'b.png', 'x.api.json'], 0)).toBe('Saved 2 screenshots and 1 answer from the API');
    expect(savedWords(['x.api.json', 'y.rows.json'], 0)).toBe('Saved 1 answer from the API and 1 set of rows');
    expect(savedWords(['x.api.json'], 0)).toBe('Saved 1 answer from the API');
  });
});
