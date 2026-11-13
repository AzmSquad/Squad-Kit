import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Weakened checks fail the gate (E5): deleted tests, fewer tests, changed test scripts or settings, and tests switched
 * off. Ordinary test edits are no alarm. The live squad stops before the checks, with the reasons on the stuck card;
 * Send it back gives the Builder the reasons, and Continue anyway goes on, on the record. The AI tool is a fake.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { findWeakening, isTestFile, scriptsOf, weakenedChecks } = await import('../src/engine/weakened.js');
const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { withProblem } = await import('../src/board/problem.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');
const { prDescription } = await import('../src/engine/review-record/pr-description.js');

type FileChange = import('../src/engine/weakened.js').FileChange;
const change = (file: string, before: string | null, after: string | null, from?: string): FileChange => ({ path: file, before, after, ...(from ? { from } : {}) });

const SPEC = `import { describe, it, expect, test } from 'vitest';
describe('booking', () => {
  it('refuses the fourth booking', () => {
    expect(book(4)).toBe(false);
  });
  it('allows three', () => {
    expect(book(3)).toBe(true);
  });
  test('counts per day', () => {
    expect(count()).toBe(1);
  });
});
`;

describe('weakened checks: each one fails the gate, in plain words', () => {
  it('a deleted test file, with how many tests it held', () => {
    expect(findWeakening([change('test/booking.test.ts', SPEC, null)])).toEqual([
      { kind: 'deleted', file: 'test/booking.test.ts', text: 'test/booking.test.ts was deleted (3 tests).', key: 'deleted:test/booking.test.ts' },
    ]);
  });

  it('fewer tests in a file', () => {
    const fewer = SPEC.replace(/  it\('allows three'[\s\S]*?\n  }\);\n/, '');
    const found = findWeakening([change('src/booking.spec.ts', SPEC, fewer)]);
    expect(found.map((w) => [w.kind, w.text])).toEqual([['fewer', 'src/booking.spec.ts has fewer tests: 3 before, 2 now.']]);
  });

  it('.skip, .only, xit and fdescribe in JavaScript and TypeScript', () => {
    for (const [after, word] of [
      [SPEC.replace("it('allows three'", "it.skip('allows three'"), 'it.skip'],
      [SPEC.replace("it('allows three'", "it.only('allows three'"), 'it.only'],
      [SPEC.replace("it('allows three'", "xit('allows three'"), 'xit'],
      [SPEC.replace("describe('booking'", "fdescribe('booking'"), 'fdescribe'],
      [SPEC.replace("test('counts per day'", "test.skipIf(true)('counts per day'"), 'test.skipIf'],
      [SPEC.replace("describe('booking'", "describe.only('booking'"), 'describe.only'],
    ] as const) {
      const found = findWeakening([change('test/booking.test.ts', SPEC, after)]);
      expect(found, word).toHaveLength(1);
      expect(found[0]!.kind).toBe('skip');
      expect(found[0]!.text, word).toContain(word);
    }
    // .only runs only some tests: it says so.
    expect(findWeakening([change('test/booking.test.ts', SPEC, SPEC.replace("it('allows three'", "it.only('allows three'"))])[0]!.text).toBe(
      'In test/booking.test.ts: only some tests run because of it.only.',
    );
  });

  it('tests switched off in the other common languages', () => {
    const cases: [string, string, string, string][] = [
      ['tests/test_booking.py', 'def test_refuses():\n    assert True\n', '@pytest.mark.skip(reason="flaky")\ndef test_refuses():\n    assert True\n', '@pytest.mark.skip'],
      ['tests/test_booking.py', 'def test_refuses():\n    assert True\n', '@pytest.mark.xfail\ndef test_refuses():\n    assert True\n', '@pytest.mark.xfail'],
      ['booking_test.go', 'func TestRefuses(t *testing.T) {\n}\n', 'func TestRefuses(t *testing.T) {\n\tt.Skip("later")\n}\n', 't.Skip'],
      ['src/test/java/BookingTest.java', '@Test\nvoid refuses() {}\n', '@Disabled\n@Test\nvoid refuses() {}\n', '@Disabled'],
      ['Booking.Tests/BookingTests.cs', '[Fact]\npublic void Refuses() {}\n', '[Fact(Skip = "later")]\npublic void Refuses() {}\n', 'Skip'],
      ['spec/booking_spec.rb', "it 'refuses' do\nend\n", "xit 'refuses' do\nend\n", 'xit'],
      ['src/booking.rs', '#[test]\nfn refuses() {}\n', '#[test]\n#[ignore]\nfn refuses() {}\n', '#[ignore]'],
      ['tests/BookingTest.php', 'public function testRefuses() {}\n', 'public function testRefuses() { $this->markTestSkipped(); }\n', 'markTestSkipped'],
    ];
    for (const [file, before, after, word] of cases) {
      const found = findWeakening([change(file, before, after)]);
      expect(found.map((w) => w.kind), file).toEqual(['skip']);
      expect(found[0]!.text, file).toContain(word);
    }
  });

  it('a script that ran no tests becoming one that does sets tests up, and the other way round is still weaker', () => {
    const pkg = (test: string) => JSON.stringify({ name: 'app', scripts: { test } });
    for (const none of ['echo "Error: no test specified" && exit 1', 'exit 0', 'true', 'node -e "process.exit(0)"', 'echo no tests']) {
      expect(findWeakening([change('package.json', pkg(none), pkg('vitest run'))]), none).toEqual([]);
      expect(findWeakening([change('package.json', pkg('vitest run'), pkg(none))]), none).toHaveLength(1);
    }
    expect(findWeakening([change('package.json', pkg('echo start && vitest run'), pkg('echo start'))])).toHaveLength(1);
    expect(findWeakening([change('package.json', pkg('exit 0'), pkg('echo still nothing'))])).toHaveLength(1);
  });

  it('a changed or removed test script in package.json, with the change in words', () => {
    const pkg = (test: string | undefined, more: Record<string, string> = {}) => JSON.stringify({ name: 'app', scripts: { dev: 'vite', ...(test ? { test } : {}), ...more } }, null, 2);
    expect(findWeakening([change('package.json', pkg('vitest run'), pkg('vitest run --passWithNoTests'))])[0]!.text).toBe(
      'The test scripts or settings in package.json changed: "test" was "vitest run", now "vitest run --passWithNoTests".',
    );
    expect(findWeakening([change('web/package.json', pkg('jest'), pkg(undefined))])[0]!.text).toBe('The test scripts or settings in web/package.json changed: the "test" script was removed.');
    // The script the project's test command runs counts, whatever its name.
    expect(findWeakening([change('package.json', pkg('x', { check: 'vitest run' }), pkg('x', { check: 'echo ok' }))], ['check'])).toHaveLength(1);
    expect(findWeakening([change('package.json', pkg('x', { check: 'vitest run' }), pkg('x', { check: 'echo ok' }))])).toHaveLength(0);
  });

  it('changed or deleted test settings: vitest, jest, pytest and the test part of mixed files', () => {
    const found = findWeakening([
      change('vitest.config.ts', "export default { test: { include: ['test/**'] } };", "export default { test: { include: ['test/none/**'] } };"),
      change('jest.config.js', 'module.exports = { testMatch: ["**/*.test.js"] };', null),
      change('pytest.ini', '[pytest]\naddopts = -q\n', '[pytest]\naddopts = -q -k "not slow"\n'),
      change('pyproject.toml', '[project]\nname = "app"\n[tool.pytest.ini_options]\naddopts = "-q"\n', '[project]\nname = "app"\n[tool.pytest.ini_options]\naddopts = "-q --deselect tests/test_a.py"\n'),
      change('vite.config.ts', 'export default defineConfig({ plugins: [vue()], test: { environment: "jsdom" } });', 'export default defineConfig({ plugins: [vue()], test: { environment: "jsdom", exclude: ["**/*"] } });'),
    ]);
    expect(found.map((w) => [w.kind, w.text])).toEqual([
      ['config', 'The test settings in vitest.config.ts changed.'],
      ['config', 'The test settings in jest.config.js were deleted.'],
      ['config', 'The test settings in pytest.ini changed.'],
      ['config', 'The test settings in pyproject.toml changed.'],
      ['config', 'The test settings in vite.config.ts changed.'],
    ]);
    // In build files, a test switch-off is a setting of its own.
    expect(findWeakening([change('pom.xml', '<project><build/></project>', '<project><properties><skipTests>true</skipTests></properties></project>')])[0]!.text).toBe(
      'Tests are skipped or their failures ignored in pom.xml.',
    );
    expect(findWeakening([change('build.gradle', 'test { useJUnitPlatform() }', 'test { useJUnitPlatform(); ignoreFailures = true }')])).toHaveLength(1);
    expect(findWeakening([change('pom.xml', '<project><skipTests>true</skipTests></project>', '<project></project>')])).toEqual([]);
  });

  it('tells test files from code by name and folder', () => {
    for (const f of ['src/a.test.ts', 'src/a.spec.tsx', 'test/helpers.ts', '__tests__/a.js', 'tests/test_a.py', 'a_test.go', 'src/test/java/ATest.java', 'spec/a_spec.rb', 'App.Tests/Helpers.cs']) {
      expect(isTestFile(f), f).toBe(true);
    }
    for (const f of ['src/a.ts', 'src/testing.ts', 'README.md', 'test/fixtures/data.json', 'src/contest.py']) expect(isTestFile(f), f).toBe(false);
    expect(scriptsOf('npm test')).toEqual(['test']);
    expect(scriptsOf('pnpm run check && npm run test:unit')).toEqual(['check', 'test:unit']);
    expect(scriptsOf('pytest -q')).toEqual([]);
  });
});

describe('no false alarm on ordinary test edits', () => {
  it('changing what a test checks, adding tests, renaming a test file, or moving tests to another file', () => {
    const edited = SPEC.replace('toBe(false)', 'toBe(false); expect(reason()).toBe("limit")');
    const added = `${SPEC}\ndescribe('more', () => {\n  it('counts per person', () => {});\n});\n`;
    const [first, ...rest] = SPEC.split("  it('allows three'");
    expect(findWeakening([change('test/booking.test.ts', SPEC, edited)])).toEqual([]);
    expect(findWeakening([change('test/booking.test.ts', SPEC, added)])).toEqual([]);
    expect(findWeakening([change('test/bookings.test.ts', SPEC, SPEC, 'test/booking.test.ts')])).toEqual([]);
    // Two of the three tests move to a new file: the count over all changed test files stays the same.
    expect(
      findWeakening([
        change('test/booking.test.ts', SPEC, `${first}});\n`),
        change('test/allow.test.ts', null, `describe('allow', () => {\n  it('allows three'${rest.join('')}`),
      ]),
    ).toEqual([]);
  });

  it('setting up tests where there were none: a new test script and new test settings', () => {
    expect(
      findWeakening([
        change('package.json', JSON.stringify({ scripts: { dev: 'vite' } }), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest run' } })),
        change('vitest.config.ts', null, 'export default { test: {} };'),
        change('test/booking.test.ts', null, SPEC),
      ]),
    ).toEqual([]);
  });

  it('changes beside the tests: other scripts, other settings, a .skip( in code, a skip that was already there', () => {
    expect(
      findWeakening([
        change('package.json', JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' }, dependencies: { a: '1' } }), JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite --host' }, dependencies: { a: '2' } })),
        change('pyproject.toml', '[project]\nname = "app"\n[tool.pytest.ini_options]\naddopts = "-q"\n', '[project]\nname = "app2"\n[tool.pytest.ini_options]\naddopts = "-q"\n'),
        change('vite.config.ts', 'defineConfig({ plugins: [], test: { environment: "jsdom" } })', 'defineConfig({ plugins: [vue()], test: { environment: "jsdom" } })'),
        change('src/db.ts', 'find()', 'find().skip(10).limit(5)'),
        change('test/old.test.ts', "it.skip('later', () => {});\nit('now', () => {});\n", "it.skip('later', () => {});\nit('now', () => { expect(1).toBe(1); });\n"),
      ]),
    ).toEqual([]);
  });
});

let tmp: string;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

/** A code repo with one commit: a test file with three tests and a test script. Returns the folder and the commit. */
function repo(): { dir: string; base: string } {
  const dir = path.join(tmp, 'copy');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'test/booking.test.ts', SPEC);
  write(dir, 'test/limit.test.ts', SPEC.replace("'booking'", "'limit'"));
  write(dir, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }, null, 2));
  write(dir, 'src/booking.ts', 'export const book = (n: number) => n < 4;\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-weakened-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the ticket's copy against its base, with git", () => {
  it('finds a deleted test and a new file with .only, not the code change, and a file moved with the shell is no alarm', async () => {
    const { dir, base } = repo();
    write(dir, 'src/booking.ts', 'export const book = (n: number) => n <= 3;\n');
    fs.rmSync(path.join(dir, 'test/booking.test.ts'));
    write(dir, 'test/focus.test.ts', "it.only('just this one', () => {});\n");
    // Moved with mv: deleted from test/, new (untracked) in src/, same name.
    fs.mkdirSync(path.join(dir, 'src/__tests__'));
    fs.renameSync(path.join(dir, 'test/limit.test.ts'), path.join(dir, 'src/__tests__/limit.test.ts'));
    const found = await weakenedChecks(dir, base);
    expect(found.map((w) => w.text)).toEqual(['test/booking.test.ts was deleted (3 tests).', 'In test/focus.test.ts: only some tests run because of it.only.']);
    // Nothing weakened: nothing found. No base or no repo: nothing found either.
    git(dir, 'checkout', '-q', '--', '.');
    git(dir, 'clean', '-qfd');
    expect(await weakenedChecks(dir, base)).toEqual([]);
    expect(await weakenedChecks(tmp, base)).toEqual([]);
  });

  it('leaves out squad-kit\'s own folder', async () => {
    const { dir, base } = repo();
    write(dir, '.squad/tickets/RO-1/test.test.ts', "it.only('x', () => {});\n");
    expect(await weakenedChecks(dir, base, { skip: ['.squad/'] })).toEqual([]);
  });
});

describe('the live squad on weakened tests', () => {
  type Squad = { checks(id: string): Promise<void>; step(id: string, phase: string): Promise<void> };
  let bp: ReturnType<typeof boardPaths>;

  function ticketOn(dir: string, base: string) {
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { test: 'echo "Tests  6 passed"' }, blueprint: undefined, impactChecks: [], techDrafts: [] });
    const t0 = actions.createTicket(bp, { title: 'Limit bookings', ask: 'One person blocks the whole day.' });
    return updateTicket(bp, t0.id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.waiting = null;
      x.squad = null;
      x.worktree = dir;
      x.baseCommit = base;
      x.sessions = { intake: 'i-1', build: 'b-1' };
      x.story = 'As a clerk, I want at most 3 bookings a day per person.';
      x.criteria = [{ given: 'a person with 3 bookings', when: 'they book again', then: 'it is refused' }];
      x.steps = [{ title: 'Refuse the fourth booking', status: 'done' }];
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
  }

  it('stops before the checks with the reasons; Continue anyway runs the checks and stays on the record', async () => {
    const { dir, base } = repo();
    const t0 = ticketOn(dir, base);
    fs.rmSync(path.join(dir, 'test/booking.test.ts'));
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.checks(t0.id);
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck).toMatchObject({ gate: 'checks', kind: 'weakened', points: ['test/booking.test.ts was deleted (3 tests).'] });
    expect(t.stuck!.question).toBe('This change makes the tests weaker than on main, so passing checks would prove little.');
    expect(withProblem(t).stuck!.title).toBe('The tests were made weaker');
    expect(t.gates).toMatchObject({ checks: 'fail', checksText: 'Tests were weakened' });
    expect(t.retryPhase).toBe('restore-tests');
    expect(t.fails).toBe(1);
    // It stopped before running anything.
    expect(t.activity.some((a) => a.text === 'squad-kit is running the project checks')).toBe(false);
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['retry', 'yourself', 'continue', 'plan']);
    expect(t.stuck!.options[0]!.name).toBe('Send it back to the Builder');

    // Only you can go past it, and only with a reason.
    expect(() => actions.decideStuck(bp, t0.id, 2, {})).toThrow(/Write why/);
    t = actions.decideStuck(bp, t0.id, 2, { reason: 'The booking screen is gone, so are its tests' });
    expect(t.overrides).toEqual([expect.objectContaining({ gate: 'checks', weakened: ['test/booking.test.ts was deleted (3 tests).'], reason: 'The booking screen is gone, so are its tests' })]);
    expect(t.squad?.phase).toBe('test');

    // The checks still run, and the gate is never a plain pass while the weakened tests are there.
    await squad.checks(t0.id);
    t = readTicket(bp, t0.id)!;
    expect(t.waiting).toBeNull();
    expect(t.gates).toMatchObject({ checks: 'skipped', checksText: '6 tests pass, test OK; tests weakened, you continued' });
    expect(t.squad?.phase).toBe('review');
    // It is on the record: in the release notes and for the Reviewer.
    expect(actions.composeNotes(bp, { version: 'v1.0.0', status: 'draft', from: 'v0.9.0', tickets: [t0.id], notes: '', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } })).toContain(
      'went out with weakened tests. ',
    );
    expect(P.reviewPrompt(readMeta(bp), [], t, 1)).toContain('The tests were made weaker in this change, and the person chose to go on anyway (The booking screen is gone, so are its tests)');
    expect(prDescription(t, null, [])).toContain('- **Weakened tests**, by ');

    // Weakened again, in a new way: it stops again, on the new one only.
    write(dir, 'test/limit.test.ts', SPEC.replace("'limit'", "'limit'").replace("it('allows three'", "it.skip('allows three'"));
    await squad.checks(t0.id);
    t = readTicket(bp, t0.id)!;
    expect(t.stuck?.points).toEqual(['In test/limit.test.ts: tests switched off with it.skip.']);
  });

  it('Send it back: the Builder gets the reasons, puts the tests back, and the checks run again', async () => {
    const { dir, base } = repo();
    const t0 = ticketOn(dir, base);
    write(dir, 'test/booking.test.ts', SPEC.replace("it('allows three'", "xit('allows three'"));
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.checks(t0.id);
    let t = actions.decideStuck(bp, t0.id, 0, {});
    expect(t.squad?.phase).toBe('restore-tests');
    await squad.step(t0.id, 'restore-tests');
    const run = calls.filter((c) => c.schema === P.BUILD_SCHEMA).at(-1)!;
    expect(run.resume).toBe('b-1');
    expect(run.prompt).toContain('the tests were made weaker');
    expect(run.prompt).toContain('- In test/booking.test.ts: tests switched off with xit.');
    expect(run.prompt).toContain('Never weaken a test to make it pass.');
    t = readTicket(bp, t0.id)!;
    expect(t.activity.map((a) => a.text)).toContain('Put the tests back');
    expect(t.squad?.phase).toBe('test');
  });

  it('an ordinary change runs the checks as before', async () => {
    const { dir, base } = repo();
    const t0 = ticketOn(dir, base);
    write(dir, 'src/booking.ts', 'export const book = (n: number) => n <= 3;\n');
    write(dir, 'test/booking.test.ts', `${SPEC}\nit('refuses a fifth', () => {});\n`);
    await (new LiveSquad(bp) as unknown as Squad).checks(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '6 tests pass, test OK' });
    expect(t.squad?.phase).toBe('review');
  });
});
