import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failedTests, fileAlone, inChanged, testAlone, testKey, testTitle, wholeNamePattern, type FailedTest } from '../src/engine/failed-tests.js';

/**
 * The failed tests a check's output names, and the command that runs one of them on its own with the project's own
 * test tool. Outputs here are in the shape each tool really prints; nothing is run but a stand-in for npx.
 */

/** Playwright's list reporter: one old drag test of another screen fails in a run of 70. */
const PLAYWRIGHT = `
> shop@1.0.0 test:e2e
> playwright test

Running 70 tests using 1 worker
······F······
  1) tests/e2e/shelves.spec.ts:387:7 › Putting shelves in order › laptop: a mouse drag changes the order

    Error: expect(locator).toHaveText(expected) failed

    Locator: getByTestId('shelf-row').first()
    Expected: "Fruit"
    Received: "Bread"

  1 failed
    tests/e2e/shelves.spec.ts:387:7 › Putting shelves in order › laptop: a mouse drag changes the order
  69 passed (2.8m)
`;

/** What Vitest 4 prints (CI set, no colors), for a file that cannot load and two failed tests. */
const VITEST = `
 RUN  v4.1.12 /work/shop

 ❯ src/sum.test.ts (3 tests | 2 failed) 6ms
       × adds two numbers 5ms
   × top level fails 0ms
 ❯ src/broken.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/broken.test.ts [ src/broken.test.ts ]
Error: Cannot find module './nope.js' imported from /work/shop/src/broken.test.ts

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/sum.test.ts > sums > small numbers > adds two numbers
AssertionError: expected 3 to be 4 // Object.is equality

 FAIL  src/sum.test.ts > top level fails
AssertionError: expected true to be false // Object.is equality

 Test Files  2 failed | 1 passed (3)
      Tests  2 failed | 2 passed (4)
   Start at  06:57:13
   Duration  230ms (transform 37ms, setup 0ms, import 48ms, tests 8ms, environment 0ms)
`;

const JEST = `
 FAIL  src/cart.test.js
  cart
    ✕ adds an item (3 ms)
    ✓ empties (1 ms)

  ● cart › adds an item

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1

 FAIL  src/broken.test.js
  ● Test suite failed to run

    Cannot find module './nope' from 'src/broken.test.js'

 PASS  src/ok.test.js

Test Suites: 2 failed, 1 passed, 3 total
Tests:       1 failed, 3 passed, 4 total
Snapshots:   0 total
Time:        0.512 s
Ran all test suites.
`;

const PYTEST = `
============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0
rootdir: /work/shop
collected 6 items

tests/test_cart.py .F..                                                  [ 66%]
tests/test_db.py E.                                                      [100%]

=================================== FAILURES ===================================
___________________________________ test_add ___________________________________

>       assert add(1, 2) == 4
E       assert 3 == 4

tests/test_cart.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_cart.py::TestTotals::test_add[two-items] - assert 3 == 4
ERROR tests/test_db.py::test_connects - ConnectionError: refused
==================== 1 failed, 4 passed, 1 error in 0.12s =====================
`;

const GO = `
--- FAIL: TestTotal (0.00s)
    total_test.go:9: got 3, want 4
--- FAIL: TestTable (0.00s)
    --- FAIL: TestTable/two_items (0.00s)
        table_test.go:20: bad
FAIL
FAIL	example.com/shop/billing	0.002s
ok  	example.com/shop/stock	0.001s
FAIL
`;

describe('the failed tests an output names', () => {
  it('Playwright: the list under "1 failed", with the file, line and full name', () => {
    expect(failedTests(PLAYWRIGHT)).toEqual([{ tool: 'playwright', file: 'tests/e2e/shelves.spec.ts', line: 387, name: 'Putting shelves in order › laptop: a mouse drag changes the order' }]);
  });

  it('Playwright with projects: each test with the project it ran in', () => {
    const out = '  2 failed\n    [chromium] › tests/a.spec.ts:10:7 › Group › two ──────\n    [webkit] › tests/a.spec.ts:10:7 › Group › two\n  26 passed (1.1m)\n';
    expect(failedTests(out)).toEqual([
      { tool: 'playwright', file: 'tests/a.spec.ts', line: 10, name: 'Group › two', project: 'chromium' },
      { tool: 'playwright', file: 'tests/a.spec.ts', line: 10, name: 'Group › two', project: 'webkit' },
    ]);
    // Flaky tests passed in the end: they are not failures.
    expect(failedTests('  1 flaky\n    tests/a.spec.ts:3:5 › one\n  27 passed (1.0m)\n')).toEqual([]);
  });

  it('Vitest: failed tests and a file that could not load, from its real output', () => {
    expect(failedTests(VITEST)).toEqual([
      { tool: 'vitest', file: 'src/broken.test.ts' },
      { tool: 'vitest', file: 'src/sum.test.ts', name: 'sums > small numbers > adds two numbers' },
      { tool: 'vitest', file: 'src/sum.test.ts', name: 'top level fails' },
    ]);
  });

  it('Vitest with its colors, and with a project', () => {
    const colors = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/sum.test.ts\x1b[2m > \x1b[22msums\x1b[2m > \x1b[22madds\n\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m3 passed\x1b[39m\x1b[22m\x1b[90m (4)\x1b[39m\n';
    expect(failedTests(colors)).toEqual([{ tool: 'vitest', file: 'src/sum.test.ts', name: 'sums > adds' }]);
    expect(failedTests(' FAIL  |unit| src/a.test.ts > adds\n Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).toEqual([{ tool: 'vitest', file: 'src/a.test.ts', name: 'adds', project: 'unit' }]);
  });

  it('Vitest run by a file and line: the file without the line it prints after it', () => {
    // Vitest 5's own words, run as "tests/unit/services-action.test.ts:135".
    const pinned = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/services-action.test.ts\x1b[2m:135\x1b[22m\x1b[2m > \x1b[22madding a service\x1b[2m > \x1b[22mrefuses a service over 8 hours\n\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m29 skipped\x1b[39m\x1b[90m (30)\x1b[39m\n';
    expect(failedTests(pinned)).toEqual([{ tool: 'vitest', file: 'tests/unit/services-action.test.ts', name: 'adding a service > refuses a service over 8 hours' }]);
  });

  it('Jest: each "●" under its FAIL file, and a file that failed to run', () => {
    expect(failedTests(JEST)).toEqual([
      { tool: 'jest', file: 'src/broken.test.js' },
      { tool: 'jest', file: 'src/cart.test.js', name: 'cart › adds an item' },
    ]);
  });

  it('pytest: the short summary, with a class and parameters, and an error', () => {
    expect(failedTests(PYTEST)).toEqual([
      { tool: 'pytest', file: 'tests/test_cart.py', name: 'TestTotals::test_add[two-items]' },
      { tool: 'pytest', file: 'tests/test_db.py', name: 'test_connects' },
    ]);
    expect(failedTests('FAILED tests/test_a.py::test_one\n1 failed, 3 passed in 0.05s\n')).toEqual([{ tool: 'pytest', file: 'tests/test_a.py', name: 'test_one' }]);
  });

  it('go test: each whole test, with its package and the file it printed from', () => {
    expect(failedTests(GO)).toEqual([
      { tool: 'go', file: 'total_test.go', name: 'TestTotal', pkg: 'example.com/shop/billing' },
      { tool: 'go', file: 'table_test.go', name: 'TestTable', pkg: 'example.com/shop/billing' },
    ]);
  });

  it('two tools in one command: the unit tests passed, the browser test failed', () => {
    const both = ' Test Files  4 passed (4)\n      Tests  16 passed (16)\n   Duration  1s\n' + PLAYWRIGHT;
    expect(failedTests(both).map((t) => t.tool)).toEqual(['playwright']);
  });

  it('nothing it knows: an empty list', () => {
    expect(failedTests('')).toEqual([]);
    expect(failedTests('the booking test failed\nnpm ERR! Test failed.')).toEqual([]);
    expect(failedTests(' Test Files  3 passed (3)\n      Tests  34 passed (34)\n')).toEqual([]);
  });

  it('nothing when it cannot be sure it found every one', () => {
    // Tests that never ran, and errors outside any test.
    expect(failedTests('  1 failed\n    tests/a.spec.ts:3:5 › one\n  4 did not run\n  2 passed (9s)\n')).toEqual([]);
    expect(failedTests('  1 failed\n    tests/a.spec.ts:3:5 › one\n  1 error was not a part of any test, see above for details\n')).toEqual([]);
    // Counts that do not add up: a list cut short.
    expect(failedTests('  2 failed\n    tests/a.spec.ts:3:5 › one\n  4 passed (9s)\n')).toEqual([]);
    expect(failedTests(' FAIL  src/a.test.ts > one\n Test Files  1 failed (1)\n      Tests  2 failed (2)\n')).toEqual([]);
    expect(failedTests(' Test Files  1 passed (1)\n      Tests  3 passed (3)\n⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nVitest caught 1 unhandled error during the test run.\n')).toEqual([]);
    // pytest stopped early, or collected nothing.
    expect(failedTests('FAILED tests/test_a.py::test_one - x\n!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!\n==== 1 failed in 0.1s ====\n')).toEqual([]);
    expect(failedTests('!!!!!!! Interrupted: 1 error during collection !!!!!!!\n==== 1 error in 0.1s ====\n')).toEqual([]);
    // A go package that did not build, or failed with no test named.
    expect(failedTests('# example.com/shop/billing\n./total.go:3:1: syntax error\nFAIL\texample.com/shop/billing [build failed]\n')).toEqual([]);
    expect(failedTests('FAIL\texample.com/shop/billing\t0.002s\n')).toEqual([]);
    // One tool unsure spoils the whole list: a failure it missed would be skipped.
    expect(failedTests(`${PLAYWRIGHT}\n  1 interrupted\n    tests/b.spec.ts:1:1 › two\n`)).toEqual([]);
  });

  it('a test as a person reads it, and as squad-kit remembers it', () => {
    const [t] = failedTests(PLAYWRIGHT) as [FailedTest];
    expect(testTitle(t)).toBe('Putting shelves in order › laptop: a mouse drag changes the order');
    // The line moves when the file changes: the same test keeps its key.
    expect(testKey({ ...t, line: 390 })).toBe(testKey(t));
    expect(testTitle({ tool: 'vitest', file: 'src/broken.test.ts' })).toBe('src/broken.test.ts');
  });
});

let dir: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const tool = (name: string) => write(`node_modules/.bin/${name}`, '#!/bin/sh\n');
const scripts = (s: Record<string, string>) => write('package.json', JSON.stringify({ name: 'shop', scripts: s }));

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-one-test-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const pw: FailedTest = { tool: 'playwright', file: 'tests/e2e/shelves.spec.ts', line: 387, name: 'Putting shelves in order › a drag' };
const vt: FailedTest = { tool: 'vitest', file: 'src/sum.test.ts', name: 'sums > small numbers > adds two numbers' };

describe('the command that runs one failed test on its own', () => {
  it('Playwright, as the npm script runs it: the file as an exact pattern, and its line', () => {
    scripts({ test: 'vitest run', 'test:e2e': 'playwright test' });
    tool('playwright');
    tool('vitest');
    expect(testAlone(dir, 'npm test && npm run test:e2e', pw)).toBe("npx playwright test 'tests/e2e/shelves\\.spec\\.ts:387'");
  });

  it('a tool that is not installed in the folder: nothing, so nothing is ever downloaded', () => {
    scripts({ 'test:e2e': 'playwright test' });
    expect(testAlone(dir, 'npm run test:e2e', pw)).toBeNull();
    tool('playwright');
    expect(testAlone(dir, 'npm run test:e2e', pw)).not.toBeNull();
  });

  it('carries the config file and the values the script gives the tool, and leaves the rest', () => {
    scripts({ 'test:e2e': 'E2E=1 playwright test -c e2e/pw.config.ts --reporter=list --project chromium tests/e2e' });
    tool('playwright');
    expect(testAlone(dir, 'npm run test:e2e', pw)).toBe("E2E='1' npx playwright test -c 'e2e/pw.config.ts' --project='chromium' 'tests/e2e/shelves\\.spec\\.ts:387'");
    // The project the test ran in wins over the script's.
    expect(testAlone(dir, 'npm run test:e2e', { ...pw, project: 'webkit' })).toContain("--project='webkit' ");
    scripts({ test: 'vitest run --config vitest.unit.ts --coverage' });
    tool('vitest');
    expect(testAlone(dir, 'npm test', vt)).toBe("npx vitest run --config='vitest.unit.ts' 'src/sum.test.ts' -t '^ ?sums(?: > | )small numbers(?: > | )adds two numbers$'");
    expect(testAlone(dir, 'npm test', { tool: 'vitest', file: 'src/broken.test.ts' })).toBe("npx vitest run --config='vitest.unit.ts' 'src/broken.test.ts'");
  });

  it('Jest, pytest and go test', () => {
    scripts({ test: 'jest --runInBand' });
    tool('jest');
    expect(testAlone(dir, 'npm test', { tool: 'jest', file: 'src/cart.test.js', name: 'cart › adds an item' })).toBe("npx jest --runInBand 'src/cart\\.test\\.js' -t '^ ?cart(?: > | )adds an item$'");
    write('.venv/bin/python', '');
    write('.venv/bin/pytest', '');
    expect(testAlone(dir, 'pytest -q --ds=shop.settings', { tool: 'pytest', file: 'tests/test_cart.py', name: 'TestTotals::test_add[two-items]' })).toBe(".venv/bin/python -m pytest --ds='shop.settings' 'tests/test_cart.py::TestTotals::test_add[two-items]'");
    write('go.mod', 'module example.com/shop\n\ngo 1.22\n');
    expect(testAlone(dir, 'go vet ./... && go test -tags=e2e ./...', { tool: 'go', file: 'table_test.go', name: 'TestTable/two_items', pkg: 'example.com/shop/billing' })).toBe("go test -tags='e2e' -count=1 -run '^TestTable$' './billing'");
    // A package of another module is not this folder's.
    expect(testAlone(dir, 'go test ./...', { tool: 'go', file: 'x_test.go', name: 'TestX', pkg: 'example.com/other' })).toBeNull();
  });

  it('a chain whose first part failed: nothing, as the second part never ran', () => {
    scripts({ test: 'vitest run', 'test:e2e': 'playwright test' });
    tool('playwright');
    tool('vitest');
    expect(testAlone(dir, 'npm test && npm run test:e2e', vt)).toBeNull();
    // The same tool twice: squad-kit cannot tell which part printed it.
    scripts({ test: 'vitest run --project unit && vitest run --project browser' });
    expect(testAlone(dir, 'npm test', vt)).toBeNull();
    // A post script runs after the tests: the tests are not last.
    scripts({ test: 'vitest run', posttest: 'node report.js' });
    expect(testAlone(dir, 'npm test', vt)).toBeNull();
    // Checks before the tests that are no test tool are fine: they passed, as the tests ran.
    scripts({ test: 'tsc --noEmit && vitest run' });
    expect(testAlone(dir, 'npm test', vt)).not.toBeNull();
  });

  it('nothing when squad-kit cannot be sure how the project runs it', () => {
    tool('vitest');
    for (const command of ['cd web && vitest run', 'vitest run | tee out.txt', 'vitest run; echo done', 'vitest run || true', 'npm run missing', 'turbo run test', 'sh ./run-tests.sh', 'node --test', 'vitest run $FILES']) {
      scripts({ missing2: 'x' });
      expect(testAlone(dir, command, vt), command).toBeNull();
    }
    // Another tool than the one that printed the failure.
    scripts({ test: 'jest' });
    expect(testAlone(dir, 'npm test', vt)).toBeNull();
  });

  it('a hostile test name or file is only ever data: quoted, and never read as an option', () => {
    scripts({ test: 'vitest run' });
    tool('vitest');
    const hostile: FailedTest = { tool: 'vitest', file: 'src/a.test.ts', name: `x'; touch pwned; echo '$(touch pwned2) \`touch pwned3\`` };
    const command = testAlone(dir, 'npm test', hostile)!;
    // A stand-in for npx says the words it got: the name arrives whole, as one word, and nothing else ran.
    const bin = path.join(dir, 'stand-in');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n', { mode: 0o755 });
    const said = execFileSync('/bin/sh', ['-c', command], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
    expect(said.trim().split('\n')).toEqual(['[vitest]', '[run]', '[src/a.test.ts]', '[-t]', `[^ ?x'; touch pwned; echo '\\$\\(touch pwned2\\) \`touch pwned3\`$]`]);
    for (const f of ['pwned', 'pwned2', 'pwned3']) expect(fs.existsSync(path.join(dir, f))).toBe(false);
    // A name or file that starts like an option is never passed at all.
    expect(testAlone(dir, 'npm test', { ...vt, name: '--reporter=./evil.js' })).toBeNull();
    expect(testAlone(dir, 'npm test', { ...vt, file: '--config=/tmp/evil.ts' })).toBeNull();
  });
});

describe('one test by its whole name, on every Vitest and Jest', () => {
  // How each tool writes the whole name it matches -t against.
  const vitest5 = 'Bookings > when unpaid > frees the slot after 15 minutes';
  const vitest4 = 'Bookings when unpaid frees the slot after 15 minutes';
  const vitest2 = ' Bookings when unpaid frees the slot after 15 minutes';
  const jest = 'Bookings when unpaid frees the slot after 15 minutes';

  it('matches the name joined by " > " (Vitest 5) and by a space (Vitest 4 and before, Jest), with nested groups', () => {
    for (const said of ['Bookings > when unpaid > frees the slot after 15 minutes', 'Bookings › when unpaid › frees the slot after 15 minutes']) {
      const re = new RegExp(wholeNamePattern(said));
      for (const name of [vitest5, vitest4, vitest2, jest]) expect(re.test(name), `${said} on "${name}"`).toBe(true);
    }
    expect(wholeNamePattern('Bookings > when unpaid > frees the slot')).toBe('^ ?Bookings(?: > | )when unpaid(?: > | )frees the slot$');
    // A test with no group.
    expect(new RegExp(wholeNamePattern('adds two numbers')).test('adds two numbers')).toBe(true);
  });

  it('matches that one test only: not one with more words, another group, or a group left out', () => {
    const re = new RegExp(wholeNamePattern('Bookings > when unpaid > frees the slot'));
    for (const other of ['Old Bookings when unpaid frees the slot', 'Bookings when unpaid frees the slot again', 'Bookings > frees the slot', 'Bookings when paid frees the slot', 'Bookings  when unpaid frees the slot', 'x Bookings when unpaid frees the slot']) {
      expect(re.test(other), other).toBe(false);
    }
    // Each part is taken as it is: a dot, brackets and a plus are no pattern.
    const price = new RegExp(wholeNamePattern('Prices > costs 1.50 (with tax) + fees'));
    expect(price.test('Prices costs 1.50 (with tax) + fees')).toBe(true);
    expect(price.test('Prices costs 1x50 with tax  fees')).toBe(false);
  });

  it('a title written for each matches each of its cases, and nothing else', () => {
    const re = new RegExp(wholeNamePattern('validateService > accepts a duration of %s minutes'));
    for (const name of ['validateService > accepts a duration of 10 minutes', 'validateService accepts a duration of 480 minutes', ' validateService accepts a duration of "15" minutes']) expect(re.test(name), name).toBe(true);
    for (const name of ['validateService > accepts a duration of 10 hours', 'validateService > refuses a duration of 5 minutes', 'other > accepts a duration of 10 minutes']) expect(re.test(name), name).toBe(false);
    expect(new RegExp(wholeNamePattern('charges $amount for $service.name')).test('charges 15.00 for Haircut')).toBe(true);
    expect(new RegExp(wholeNamePattern('case %# of %d')).test('case 2 of 30')).toBe(true);
  });

  it('a Vitest test the proof names by its line: the file and line on Vitest 3 and later, the file only before', () => {
    scripts({ test: 'vitest run' });
    tool('vitest');
    write('src/sum.test.ts', '');
    const one = (version?: string) => {
      if (version) write('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version }));
      return fileAlone(dir, 'npm test', 'src/sum.test.ts:12', 'sums > adds two numbers')?.command;
    };
    expect(one()).toBe("npx vitest run 'src/sum.test.ts' -t '^ ?sums(?: > | )adds two numbers$'");
    expect(one('2.1.9')).toBe("npx vitest run 'src/sum.test.ts' -t '^ ?sums(?: > | )adds two numbers$'");
    expect(one('4.1.12')).toBe("npx vitest run 'src/sum.test.ts:12' -t '^ ?sums(?: > | )adds two numbers$'");
    // With no name, the whole file as before: a line alone is never the proof's pick.
    expect(fileAlone(dir, 'npm test', 'src/sum.test.ts:12')?.command).toBe("npx vitest run 'src/sum.test.ts'");
    // A failed test squad-kit runs again is picked by its name only: the tool printed no line for it.
    expect(testAlone(dir, 'npm test', { tool: 'vitest', file: 'src/sum.test.ts', name: 'sums > adds two numbers' })).toBe("npx vitest run 'src/sum.test.ts' -t '^ ?sums(?: > | )adds two numbers$'");
  });
});

describe('one test file the Builder asks for', () => {
  it('goes to the tool whose tests it is, by Playwright\'s own test folder', () => {
    scripts({ test: 'vitest run', 'test:e2e': 'playwright test' });
    tool('playwright');
    tool('vitest');
    write('playwright.config.ts', "export default defineConfig({ testDir: './tests/e2e' });");
    write('tests/e2e/shelves.spec.ts', '');
    write('src/sum.test.ts', '');
    expect(fileAlone(dir, 'npm test && npm run test:e2e', 'tests/e2e/shelves.spec.ts:42')).toEqual({ tool: 'playwright', command: "npx playwright test 'tests/e2e/shelves\\.spec\\.ts:42'" });
    expect(fileAlone(dir, 'npm test && npm run test:e2e', './src/sum.test.ts')).toEqual({ tool: 'vitest', command: "npx vitest run 'src/sum.test.ts'" });
    // The config file the script names says where Playwright's tests are, from its own folder.
    scripts({ test: 'vitest run', 'test:e2e': 'playwright test -c e2e/pw.config.ts' });
    write('e2e/pw.config.ts', "export default { testDir: './specs' };");
    write('e2e/specs/cart.spec.ts', '');
    expect(fileAlone(dir, 'npm test && npm run test:e2e', 'e2e/specs/cart.spec.ts')).toEqual({ tool: 'playwright', command: "npx playwright test -c 'e2e/pw.config.ts' 'e2e/specs/cart\\.spec\\.ts'" });
  });

  it('nothing for a file outside the copy, one that is not there, or when squad-kit cannot tell the tool', () => {
    scripts({ test: 'vitest run && playwright test' });
    tool('playwright');
    tool('vitest');
    write('tests/a.spec.ts', '');
    // No test folder in Playwright's config: both tools may own it.
    expect(fileAlone(dir, 'npm test', 'tests/a.spec.ts')).toBeNull();
    expect(fileAlone(dir, 'npx vitest run', '../outside.test.ts')).toBeNull();
    expect(fileAlone(dir, 'npx vitest run', '/etc/hosts')).toBeNull();
    expect(fileAlone(dir, 'npx vitest run', 'src/missing.test.ts')).toBeNull();
    expect(fileAlone(dir, 'npx vitest run', 'tests/a.spec.ts')).toEqual({ tool: 'vitest', command: "npx vitest run 'tests/a.spec.ts'" });
  });
});

describe('a failed test the story changed', () => {
  it('its own file, as the tool prints it from its own folder', () => {
    expect(inChanged(pw, ['src/app.tsx', 'tests/e2e/shelves.spec.ts'], dir)).toBe(true);
    expect(inChanged(pw, ['web/tests/e2e/shelves.spec.ts'], dir)).toBe(true);
    expect(inChanged(pw, ['src/shelves.tsx', 'tests/e2e/other.spec.ts'], dir)).toBe(false);
  });

  it('go: any test file of its package', () => {
    write('go.mod', 'module example.com/shop\n');
    const t: FailedTest = { tool: 'go', file: 'total_test.go', name: 'TestTotal', pkg: 'example.com/shop/billing' };
    expect(inChanged(t, ['billing/table_test.go'], dir)).toBe(true);
    expect(inChanged(t, ['billing/total.go', 'stock/stock_test.go'], dir)).toBe(false);
  });
});
