import fs from 'node:fs';
import path from 'node:path';
import type { TestProof } from '../../board/proof-rows.js';
import { scrubSecrets } from '../../core/scrub.js';
import { tail, testCount, type CommandResult } from '../checks.js';
import { failedTests, fileAlone, wholeNamePattern } from '../failed-tests.js';

/**
 * The Test proof: the one test that proves a "done when", run by squad-kit on main's code (with the story's test file
 * put there) and on the story's code. It must fail before the change and pass now. A test that also passes on main is
 * no proof: the line goes back to the Builder, to write a test that does fail without the change. "Failed before" counts
 * only when the test tool ran that very test on main's code and named it failed: a run stopped by an import, the
 * setup, a missing tool or the time limit says nothing, and the person decides.
 */

/** The longest one test may run, each time. */
export const TEST_MS = 5 * 60_000;

/** The Tester's answer for one Test line. */
export interface NamedTest {
  criterion: number;
  file: string;
  name: string;
  line?: number;
  steps: string[];
}

/** A test's name in its parts: its groups, then its own title. "Bookings > frees a slot", "Bookings › frees a slot". */
export function nameParts(name: string): string[] {
  return name
    .split(/\s+(?:>|›)\s+|::/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The answer taken in squad-kit's shape: a file inside the copy that is there, a name each of whose parts is written in
 * that file, and plain steps. With `changed`, only a file the story added or changed: a test from before the story
 * cannot show its change.
 */
export function cleanNamed(raw: unknown, dir: string, lines: number[], changed?: string[] | null): NamedTest[] {
  const list = (raw as { tests?: unknown } | null)?.tests;
  const out: NamedTest[] = [];
  for (const x of Array.isArray(list) ? list : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const n = Number(o.criterion);
    const said = typeof o.file === 'string' ? path.normalize(o.file.trim()).replace(/^\.\//, '') : '';
    // A path from the copy's root when the project is a folder in it ("project/tests/a.test.ts"): that story file.
    const file = changed && !changed.includes(said) ? ([...changed].sort((a, b) => b.length - a.length).find((f) => said.endsWith(`/${f}`)) ?? said) : said;
    if (!lines.includes(n) || out.some((t) => t.criterion === n) || !file || file.startsWith('..') || path.isAbsolute(file) || !fs.existsSync(path.join(dir, file))) continue;
    if (changed && !changed.includes(file)) continue;
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!nameInFile(name, path.join(dir, file))) continue;
    const steps = (Array.isArray(o.steps) ? o.steps : []).filter((s): s is string => typeof s === 'string' && Boolean(s.trim())).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 160)).slice(0, 6);
    out.push({ criterion: n, file, name, ...(Number.isInteger(o.line) && (o.line as number) > 0 ? { line: o.line as number } : {}), steps });
  }
  return out;
}

/** True when the name has parts and each is written, word for word, in the test file. */
function nameInFile(name: string, file: string): boolean {
  const parts = nameParts(name);
  if (!parts.length) return false;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 2_000_000);
  } catch {
    return false;
  }
  return parts.every((p) => text.includes(p));
}

/** Why an answer is not in the shape: a Test line with a file the story did not add or change, or a name not in it. */
export function namedProblem(raw: unknown, dir: string, lines: number[], changed?: string[] | null): string | null {
  const list = (raw as { tests?: { criterion?: unknown; file?: unknown }[] } | null)?.tests ?? [];
  const wrong = list.filter((x) => lines.includes(Number(x?.criterion)) && !cleanNamed({ tests: [x] }, dir, lines, changed).length);
  if (!wrong.length) return null;
  const tests = changed?.length ? ` (it changed: ${changed.filter((f) => /test|spec/i.test(f)).slice(0, 20).join(', ') || 'no test files'})` : '';
  return `for "done when" ${wrong.map((x) => Number(x?.criterion)).join(', ')}, give a test file this story added or changed in this copy${tests}, and the test's full name as written in that file, its groups first`;
}

/** A line that starts a test with its title: `it('…'`, `test.only("…"`. */
const STARTS_TEST = /\b(it|test)(\.\w+)*\s*\(\s*['"`]/;

/**
 * The line the Tester gave, when the test starts on it with its own title: a wrong line would pick no test at all, so
 * a line squad-kit cannot be sure of is left out and the test is picked by its name only.
 */
function checkedLine(dir: string, t: NamedTest): number | undefined {
  const title = nameParts(t.name).at(-1);
  if (!t.line || !title) return undefined;
  try {
    const text = fs.readFileSync(path.join(dir, t.file), 'utf8').split('\n')[t.line - 1] ?? '';
    return STARTS_TEST.test(text) && text.includes(title) ? t.line : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command that runs that one test with the project's own tool, by its whole name from its first word to its last
 * (failed-tests.ts wholeNamePattern), and on Vitest 3 and later by its file and line too, when the line is right;
 * pytest and go by their own ids, Playwright by its line. Its whole file when the tool cannot pick one test.
 */
export function commandFor(dir: string, testCommand: string, t: NamedTest): { command: string; whole: boolean } | null {
  const line = checkedLine(dir, t);
  const at = line ? `${t.file}:${line}` : t.file;
  const file = fileAlone(dir, testCommand, at);
  if (!file) return null;
  if (file.tool === 'playwright') return { command: file.command, whole: !line };
  const parts = nameParts(t.name);
  if (!parts.length) return { command: file.command, whole: true };
  const one = fileAlone(dir, testCommand, at, file.tool === 'pytest' ? parts.join('::') : file.tool === 'go' ? parts[0]! : parts.join(' > '));
  return { command: one?.command ?? file.command, whole: !one };
}

/** A run that ran at least one test and passed. */
export const passed = (r: CommandResult): boolean => r.ok && !r.ended && (testCount(r.output) ?? 0) > 0;

/** True when the tool named this very test failed: it ran, and its check said no. A test written for `each`: one of its cases. */
export function namedFailed(r: CommandResult, t: Pick<NamedTest, 'file' | 'name'>): boolean {
  if (r.ended) return false;
  const want = new RegExp(wholeNamePattern(nameParts(t.name).join(' > ')));
  const file = t.file.replace(/^\.\//, '');
  return failedTests(r.output).some((f) => Boolean(f.name) && want.test(nameParts(f.name!).join(' > ')) && (f.file.replace(/^\.\//, '') === file || file.endsWith(`/${f.file.replace(/^\.\//, '')}`) || f.file.endsWith(`/${file}`)));
}

/** How one run went: passed, failed on the test's own check, or nothing it can tell (it did not run that test). */
export function runOf(r: CommandResult | null, t: Pick<NamedTest, 'file' | 'name'>): 'passed' | 'failed' | 'unknown' {
  if (!r) return 'unknown';
  if (passed(r)) return 'passed';
  return namedFailed(r, t) ? 'failed' : 'unknown';
}

/** What one Test line ended with. */
export interface TestVerdict {
  shows: 'met' | 'broken' | 'not-shown';
  /** Why it is not met, in plain words. */
  why: string;
  /** Not shown because it also passes on main: it goes to the Builder. Else a not shown waits for the person. */
  toBuilder: boolean;
  proof?: TestProof;
}

/**
 * The verdict of a line from its two runs. Fails now on its own check: not working. Passes on main too: not shown, and
 * the Builder writes a real test. Either run told nothing (it did not run that test, or stopped before it): not shown,
 * and the person decides. Else met: it failed before the change and passes now. `keeps`: the line keeps something that
 * already works ("stays as it is"), so met is passing on main and now, and failing on main is the problem the person
 * decides on: what it keeps did not work before.
 */
export function judgeTest(t: NamedTest, now: CommandResult, main: CommandResult | null, keeps = false): TestVerdict {
  const before = runOf(main, t);
  const after = runOf(now, t);
  const proof: TestProof = { name: t.name, file: t.file, steps: t.steps, before, after, seconds: Math.round(now.seconds * 10) / 10, ...(keeps ? { keeps: true } : {}) };
  const named = `the test "${t.name || t.file}"`;
  if (after === 'failed') return { shows: 'broken', why: `The story's code fails ${named}.`, toBuilder: true, proof };
  if (after === 'unknown') return { shows: 'not-shown', why: `squad-kit could not run ${named} by its name on the story's code.`, toBuilder: false, proof };
  if (keeps && before === 'passed') return { shows: 'met', why: '', toBuilder: false, proof };
  if (keeps && before === 'failed') return { shows: 'not-shown', why: `This line keeps something that already works, but on main's code ${named} fails: it did not work before the change.`, toBuilder: false, proof };
  if (keeps && main) return { shows: 'not-shown', why: `On main's code ${named} did not run to its own check (an import, the setup, a missing tool or the time limit stopped it), so it does not show that it worked before the change.`, toBuilder: false, proof };
  if (before === 'passed') return { shows: 'not-shown', why: `On main's code ${named} passes too, so it does not show the change. Write a test that fails without the change and passes with it.`, toBuilder: true, proof };
  if (before === 'unknown' && !main) return { shows: 'not-shown', why: `squad-kit could not run ${named} on main's code, so it cannot tell how it went before the change.`, toBuilder: false, proof };
  if (before === 'unknown') return { shows: 'not-shown', why: `On main's code ${named} did not run to its own check (an import, the setup, a missing tool or the time limit stopped it), so it does not show that it failed before the change.`, toBuilder: false, proof };
  return { shows: 'met', why: '', toBuilder: false, proof };
}

/** What squad-kit keeps of a run for engineers: the command and its last lines. */
export function runRecord(r: CommandResult | null, command: string): Record<string, unknown> | null {
  return r ? { command, ok: r.ok, seconds: r.seconds, tests: testCount(r.output), printed: scrubSecrets(tail(r.output.trim(), 40)) } : null;
}
