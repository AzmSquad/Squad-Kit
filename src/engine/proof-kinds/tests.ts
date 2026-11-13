import fs from 'node:fs';
import path from 'node:path';
import type { TestProof } from '../../board/proof-rows.js';
import { scrubSecrets } from '../../core/scrub.js';
import { tail, testCount, type CommandResult } from '../checks.js';
import { fileAlone, type TestTool } from '../failed-tests.js';

/**
 * The Test proof: the one test that proves a "done when", run by squad-kit on main's code (with the story's test file
 * put there) and on the story's code. It must fail before the change and pass now. A test that also passes on main is
 * no proof: the line goes back to the Builder, to write a test that does fail without the change.
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

/**
 * The answer taken in squad-kit's shape: a file inside the copy that is there, a name, and plain steps. With `changed`,
 * only a file the story added or changed: a test from before the story cannot show its change.
 */
export function cleanNamed(raw: unknown, dir: string, lines: number[], changed?: string[] | null): NamedTest[] {
  const list = (raw as { tests?: unknown } | null)?.tests;
  const out: NamedTest[] = [];
  for (const x of Array.isArray(list) ? list : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const n = Number(o.criterion);
    const file = typeof o.file === 'string' ? path.normalize(o.file.trim()).replace(/^\.\//, '') : '';
    if (!lines.includes(n) || out.some((t) => t.criterion === n) || !file || file.startsWith('..') || path.isAbsolute(file) || !fs.existsSync(path.join(dir, file))) continue;
    if (changed && !changed.includes(file)) continue;
    const steps = (Array.isArray(o.steps) ? o.steps : []).filter((s): s is string => typeof s === 'string' && Boolean(s.trim())).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 160)).slice(0, 6);
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    out.push({ criterion: n, file, name, ...(Number.isInteger(o.line) && (o.line as number) > 0 ? { line: o.line as number } : {}), steps });
  }
  return out;
}

/** Why an answer is not in the shape: a Test line with a file that is not in the copy, or that the story did not change. */
export function namedProblem(raw: unknown, dir: string, lines: number[], changed?: string[] | null): string | null {
  const list = (raw as { tests?: { criterion?: unknown; file?: unknown }[] } | null)?.tests ?? [];
  const wrong = list.filter((x) => lines.includes(Number(x?.criterion)) && !cleanNamed({ tests: [x] }, dir, lines, changed).length);
  return wrong.length ? `the test file of "done when" ${wrong.map((x) => Number(x?.criterion)).join(', ')} is not a test file this story added or changed in this copy${changed?.length ? ` (it changed: ${changed.filter((f) => /test|spec/i.test(f)).slice(0, 20).join(', ') || 'no test files'})` : ''}` : null;
}

/** A name with its groups joined by " > ", as each tool writes it. */
function toolName(tool: TestTool, name: string): string {
  if (tool === 'jest') return name.split(' > ').join(' › ');
  if (tool === 'pytest') return name.split(' > ').join('::');
  if (tool === 'go') return name.split(' > ')[0]!;
  return name;
}

/** The command that runs that one test with the project's own tool; its whole file when the tool cannot pick one test. */
export function commandFor(dir: string, testCommand: string, t: NamedTest): { command: string; whole: boolean } | null {
  const at = t.line ? `${t.file}:${t.line}` : t.file;
  const file = fileAlone(dir, testCommand, at);
  if (!file) return null;
  const picks = file.tool === 'playwright' ? Boolean(t.line) : Boolean(t.name);
  const one = picks ? fileAlone(dir, testCommand, at, toolName(file.tool, t.name)) : null;
  return { command: one?.command ?? file.command, whole: !one };
}

/** A run that passed: the tool said so, and ran at least one test. */
export const passed = (r: CommandResult): boolean => r.ok && (testCount(r.output) ?? 0) > 0;

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
 * The verdict of a line from its two runs. Fails now: not working. Passes on main too: not shown, and the Builder
 * writes a real test. Could not run on main: not shown, and the person decides. Else met.
 */
export function judgeTest(t: NamedTest, now: CommandResult, main: CommandResult | null): TestVerdict {
  const before: TestProof['before'] = main === null ? 'unknown' : passed(main) ? 'passed' : 'failed';
  const after: TestProof['after'] = passed(now) ? 'passed' : 'failed';
  const proof: TestProof = { name: t.name, file: t.file, steps: t.steps, before, after, seconds: Math.round(now.seconds * 10) / 10 };
  const named = `the test "${t.name || t.file}"`;
  if (after === 'failed') return { shows: 'broken', why: `The story's code fails ${named}.`, toBuilder: true, proof };
  if (before === 'passed') return { shows: 'not-shown', why: `On main's code ${named} passes too, so it does not show the change. Write a test that fails without the change and passes with it.`, toBuilder: true, proof };
  if (before === 'unknown') return { shows: 'not-shown', why: `squad-kit could not run ${named} on main's code, so it cannot tell that it failed before the change.`, toBuilder: false, proof };
  return { shows: 'met', why: '', toBuilder: false, proof };
}

/** What squad-kit keeps of a run for engineers: the command and its last lines. */
export function runRecord(r: CommandResult | null, command: string): Record<string, unknown> | null {
  return r ? { command, ok: r.ok, seconds: r.seconds, tests: testCount(r.output), printed: scrubSecrets(tail(r.output.trim(), 40)) } : null;
}
