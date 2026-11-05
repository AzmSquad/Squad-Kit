import type { Gates, ProjectCommands } from '../board/types.js';
import { testCount, type CheckResult } from './checks.js';

/**
 * "Not checked": a project with no tests gets no green pass. Lint, build and the app starting still run and must pass,
 * but only tests show that the work does what it should, so the gate says so. When a project truly has none, the person
 * is asked once per project: have the Builder add tests, or go on without them.
 */

/** A check's name in words: the app start is "the app starts". */
export function checkWords(name: string): string {
  return name === 'start' ? 'the app starts' : name;
}

/** True when no tests ran: no test command, or one that found none. */
export function noTestsRan(results: CheckResult[]): boolean {
  const test = results.find((r) => r.name === 'test');
  return !test || testCount(test.output) === 0;
}

/** The gate's line: "No tests ran · lint, build pass, the app starts". */
export function notCheckedText(results: CheckResult[]): string {
  const others = results.filter((r) => r.ok && r.name !== 'test' && r.name !== 'start').map((r) => r.name);
  const started = results.some((r) => r.ok && r.name === 'start');
  const passed = [others.length ? `${others.join(', ')} ${others.length === 1 ? 'passes' : 'pass'}` : '', started ? 'the app starts' : ''].filter(Boolean).join(', ');
  return `No tests ran${passed ? ` · ${passed}` : ''}`;
}

/** What the checks ran, kept on the gate for the Reviewer. */
export function ranOf(results: CheckResult[]): NonNullable<Gates['ran']> {
  return results.map((r) => {
    const tests = r.name === 'test' ? testCount(r.output) : null;
    return { name: r.name, command: r.command, ok: r.ok, ...(tests !== null ? { tests } : {}), ...(r.failedFirst !== undefined ? { failedOnce: true } : {}) };
  });
}

/** The card's plain words when no tests ran. It never names a command: engineers get those in the details. */
export function noTestsQuestion(results: CheckResult[]): string {
  const why = results.some((r) => r.name === 'test') ? "The project's tests found nothing to run" : 'This project has no tests yet';
  return `${why}, so squad-kit cannot check that the work does what it should.`;
}

/** For engineers, in the Developer tab: the commands behind the card. */
export function noTestsDetail(results: CheckResult[], suggestion?: string): string {
  const test = results.find((r) => r.name === 'test');
  return [test ? `The test command (${test.command}) found no tests.` : 'No test command is saved. Add one in Settings, under How the squad checks and runs this project.', suggestion ? `The Architect suggests: ${suggestion}` : ''].filter(Boolean).join('\n');
}

/**
 * The commands the Architect gave with a design. The test command decides what the checks prove, so it never changes
 * on its own: for a project with none it is a suggestion, and a different one is a change from → to. Both wait for the
 * person; the other commands apply as before.
 */
export function holdTestCommand(had: ProjectCommands, given: ProjectCommands): { apply: ProjectCommands; suggest?: string; change?: { from: string; to: string } } {
  const test = given.test?.trim();
  if (!test) return { apply: given };
  const apply = { ...given };
  delete apply.test;
  const now = had.test?.trim();
  if (!now) return { apply, suggest: test };
  return test === now ? { apply } : { apply, change: { from: now, to: test } };
}
