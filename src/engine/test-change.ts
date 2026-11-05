import { plainOutput, testCount } from './checks.js';

/**
 * The design changes how the project's tests run. The test command decides what the checks prove, and a project
 * manager cannot judge one, so squad-kit decides by trying it: in the ticket's copy, after the build, it runs the new
 * command, then the current one. The new one is kept when it passes and runs at least as many tests. Anything less
 * and the current one stays. Only when the current one fails and the new one passes without saying how many tests it
 * ran is there nothing to go on: then the person gets one plain sentence, and the commands are for engineers.
 */

export interface TestRun {
  ok: boolean;
  output: string;
}

export type TestVerdict =
  /** squad-kit decided: `why` is one plain clause for the ticket's activity, with no command in it. */
  | { keep: 'new' | 'current'; why: string; ran: string }
  /** Nothing to go on: the person chooses. */
  | { ask: true; why: string; ran: string };

/** A command that passes whatever the tests do, or that may run none: `npm test || true`, `--passWithNoTests`. */
const HIDES_FAILURES = /--pass-?with-?no-?tests?\b|--exit-?zero\b|--no-?fail\b|--ignore-?failures?\b|--continue-?on-?error\b|testFailureIgnore|maven\.test\.(?:skip|failure\.ignore)|skipTests|ignoreFailures|\s-x\s+test\b/i;

/** True when the command would pass with failing tests. What is in quotes is an argument, not a way to go on. */
export function hidesFailures(command: string): boolean {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''");
  return HIDES_FAILURES.test(bare) || /\|\||;/.test(bare);
}

/** How many tests ran, the failing ones too: "2 failed, 10 passed" is 12. Null when the output does not say. */
export function testsRan(output: string): number | null {
  // The "Tests" summary line first (vitest, jest), so a "Test Files 1 failed | 3 passed" line is not mistaken for it.
  const plain = plainOutput(output);
  const said = /^\s*Tests:?\s+\d.*$/im.exec(plain)?.[0] ?? plain;
  const passed = testCount(said);
  const failed = /(\d+)\s+(?:failed|failing)\b|Failed:\s+(\d+)|^# fail (\d+)/im.exec(said);
  if (passed === null && !failed) return null;
  return (passed ?? 0) + Number(failed?.[1] ?? failed?.[2] ?? failed?.[3] ?? 0);
}

/** What the two runs say, for the log and the engineer details. */
function ranWords(to: TestRun, from: TestRun): string {
  const one = (r: TestRun) => `${r.ok ? 'passed' : 'failed'}, ${testsRan(r.output) ?? 'an unknown number of'} tests`;
  return `new: ${one(to)}; current: ${one(from)}`;
}

/**
 * Tries the new test command against the current one. `run` runs a command in the ticket's copy. The current one only
 * runs when the new one passes and ran tests, so a command that does not work costs one run.
 */
export async function judgeTestChange(change: { from: string; to: string }, run: (command: string) => Promise<TestRun>): Promise<TestVerdict> {
  if (hidesFailures(change.to)) return { keep: 'current', why: 'the new way could hide failing tests', ran: 'not run: the command passes whatever the tests do' };
  const to = await run(change.to);
  if (!to.ok) return { keep: 'current', why: 'the new way did not pass', ran: `new: failed, ${testsRan(to.output) ?? 'an unknown number of'} tests` };
  const now = testsRan(to.output);
  if (now === 0) return { keep: 'current', why: 'the new way ran no tests', ran: 'new: passed, 0 tests' };
  const from = await run(change.from);
  const ran = ranWords(to, from);
  const was = testsRan(from.output);
  // The new one does not say what it ran: with a current one that works, nothing is lost by staying with it.
  if (now === null) return from.ok ? { keep: 'current', why: 'squad-kit could not tell if the new way checks as much', ran } : { ask: true, why: 'squad-kit could not tell if the new way checks as much', ran };
  // The current one never said what it ran, or no longer runs: the new one passes and shows real tests ran.
  if (was === null) return { keep: 'new', why: 'the new way works and shows the tests it ran', ran };
  return now < was ? { keep: 'current', why: 'the new way runs fewer tests', ran } : { keep: 'new', why: 'the new way works and runs every test', ran };
}
