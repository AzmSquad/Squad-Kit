import fs from 'node:fs';
import path from 'node:path';
import { wayOptions } from '../../board/actions.js';
import { KIND_NAMES, isScreenFile, lockForScreens } from '../../board/proof-lock.js';
import { hasKinds } from '../../board/proof-rows.js';
import { addActivity, readMeta, readTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { BoardMeta, ProofShot, Ticket } from '../../board/types.js';
import { copiesOf } from '../copies.js';
import { hasAppToStart } from '../../board/apps.js';
import type { CommandResult } from '../checks.js';
import { criterionText, doneWhenCount, type OpenRow } from '../proof-verdict.js';
import { kindOf, linesOf, testerLines } from './lines.js';
import { TESTS_SCHEMA, testsPrompt } from './prompts.js';
import { theirLanguage } from '../prompts.js';
import { workSoFar } from '../handover.js';
import { TEST_MS, cleanNamed, commandFor, judgeTest, namedProblem, runRecord, type NamedTest } from './tests.js';
import { storyTestFiles } from './test-files.js';

/**
 * The proof of the kinds the Tester's window does not make: Test lines, which squad-kit proves by running their test on
 * main's code and on the story's, and Not on a screen lines, which the Reviewer checked in its review. Also squad-kit's
 * second lock, from the files the story changed, and every row marked with its kind. The live squad calls these at
 * its proof (engine/live.ts), through a small host, so this file holds the rules and none of the squad's plumbing.
 */

export interface KindsHost {
  bp: BoardPaths;
  id: string;
  /** The story's copy, where its tests run, and the project's saved test command there. */
  dir: string;
  testCommand: string;
  update(change: (t: Ticket) => void): Ticket;
  /** A short read-only Tester run in the story's copy, with squad-kit's shape for its answer. */
  tester(o: { prompt: string; schema: object; check(answer: unknown): string | null }): Promise<unknown>;
  /** One command in the story's copy, inside squad-kit's guard. */
  run(command: string, ms: number): Promise<CommandResult>;
  /** Main's code in a copy of its own, set up like the story's; null when it could not be made. */
  onMain<T>(use: (dir: string, run: (command: string, ms: number) => Promise<CommandResult>) => Promise<T | null>): Promise<T | null>;
  log(text: string): void;
}

/** What the other kinds ended with: lines for the Builder, and lines the person decides on. */
export interface KindsResult {
  broken: OpenRow[];
  open: OpenRow[];
}

const NOTHING: KindsResult = { broken: [], open: [] };

/** Where the Reviewer's checks of the Not on a screen lines wait for the proof: this computer's proof folder. */
const checksFile = (bp: BoardPaths, id: string) => path.join(bp.proofDir, `${id.toLowerCase()}-none-checks.json`);

interface NoneCheck {
  criterion: string;
  checked: string;
  holds: boolean;
}

/** The review's word on each Not on a screen line, kept for the proof. Each round's replaces the last. */
export function keepNoneChecks(bp: BoardPaths, t: Ticket, raw: unknown): void {
  const lines = linesOf(t, ['none']);
  if (!lines.length) return;
  const said = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: NoneCheck[] = [];
  for (const n of lines) {
    const o = said.find((x) => Number(x?.criterion) === n);
    const checked = typeof o?.checked === 'string' ? o.checked.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    if (checked) out.push({ criterion: criterionText(t, n)!, checked, holds: o!.holds === true });
  }
  fs.mkdirSync(bp.proofDir, { recursive: true });
  fs.writeFileSync(checksFile(bp, t.id), JSON.stringify(out, null, 2));
}

function noneChecks(bp: BoardPaths, id: string): NoneCheck[] {
  try {
    return JSON.parse(fs.readFileSync(checksFile(bp, id), 'utf8')) as NoneCheck[];
  } catch {
    return [];
  }
}

/** squad-kit's second lock: the story changed screen files, in any of its copies, and no line is Screen. Said once on the story. */
export async function lockScreenLines(bp: BoardPaths, id: string, meta: BoardMeta): Promise<void> {
  const t = readTicket(bp, id);
  // A project with no app to start has nothing to show: no picture is kept for it.
  if (!t || !hasKinds(t) || !hasAppToStart(meta)) return;
  const changed = (await Promise.all(copiesOf(meta, t).map((c) => (c.baseCommit ? workSoFar(c.dir, c.baseCommit).catch(() => []) : [])))).flat();
  const locked = lockForScreens(t.criteria!, changed.some(isScreenFile));
  if (!locked) return;
  updateTicket(bp, id, (x) => {
    x.criteria = locked.criteria;
    addActivity(x, 'squad', `The story changes a screen, so "done when" ${locked.line} keeps a picture`);
  });
}

/** A saved record for engineers beside the row, and the row's file. */
function saveRecord(bp: BoardPaths, id: string, n: number, end: 'test' | 'none', record: object): string {
  const file = `${id.toLowerCase()}-${end}-${n}.${end}.json`;
  fs.mkdirSync(bp.proofDir, { recursive: true });
  fs.writeFileSync(path.join(bp.proofDir, file), JSON.stringify(record, null, 2));
  return file;
}

/** A row of a kind with no picture: its saved record is both its before and its after. */
function row(t: Ticket, n: number, file: string, extra: Partial<ProofShot>): ProofShot {
  return { criterion: criterionText(t, n)!, before: file, after: file, beforeLabel: KIND_NAMES[kindOf(t, n) ?? 'screen'], afterLabel: KIND_NAMES[kindOf(t, n) ?? 'screen'], kind: kindOf(t, n)!, ...extra };
}

/** Puts rows in the proof, in place of any of the same "done when", and marks every row with its kind. */
function putRows(t: Ticket, rows: ProofShot[]): void {
  const by = new Map(rows.map((r) => [r.criterion, r]));
  const kept = (t.proof ?? []).filter((p) => !by.has(p.criterion));
  const numbers = Array.from({ length: doneWhenCount(t) }, (_, i) => i + 1);
  const number = (p: ProofShot) => numbers.find((n) => criterionText(t, n) === p.criterion) ?? numbers.length + 1;
  t.proof = [...kept, ...rows].sort((a, b) => number(a) - number(b));
  for (const r of t.proof) if (number(r) <= numbers.length) r.kind = kindOf(t, number(r))!;
}

/** Each Test line: the Tester names its test, and squad-kit runs it on main's code and on the story's. */
async function proveTests(host: KindsHost, t: Ticket, lines: number[], out: KindsResult): Promise<ProofShot[]> {
  host.update((x) => {
    x.status = 'Tester is finding the test for each Test line';
    addActivity(x, 'tester', `Finding the test that proves ${lines.length === 1 ? `"done when" ${lines[0]}` : `${lines.length} "done when"`}`);
  });
  // Only a test the story added or changed can show its change.
  const changed = t.baseCommit ? await workSoFar(host.dir, t.baseCommit).catch(() => null) : null;
  const prompt = testsPrompt(t, lines, storyTestFiles(host.dir, changed ?? []));
  const answer = await host.tester({ prompt: `${prompt}${theirLanguage(t)}`, schema: TESTS_SCHEMA, check: (a) => namedProblem(a, host.dir, lines, changed) });
  const named = cleanNamed(answer, host.dir, lines, changed);
  const rows: ProofShot[] = [];
  for (const n of lines) {
    const text = criterionText(t, n)!;
    const test = named.find((x) => x.criterion === n);
    if (!test) {
      out.broken.push({ criterion: n, text, why: 'No test proves it yet. Write a test that fails without the change and passes with it.' });
      rows.push(row(t, n, saveRecord(host.bp, t.id, n, 'test', { criterion: text, named: null }), { shows: 'not-shown', why: 'No test proves it yet, so the Builder writes one.' }));
      continue;
    }
    rows.push(await runOne(host, t, n, test, out));
  }
  return rows;
}

async function runOne(host: KindsHost, t: Ticket, n: number, test: NamedTest, out: KindsResult): Promise<ProofShot> {
  const text = criterionText(t, n)!;
  const how = host.testCommand ? commandFor(host.dir, host.testCommand, test) : null;
  if (!how) {
    const why = `squad-kit cannot run the test "${test.name || test.file}" on its own with this project's test command.`;
    out.open.push({ criterion: n, text, why });
    return row(t, n, saveRecord(host.bp, t.id, n, 'test', { criterion: text, test }), { shows: 'not-shown', why });
  }
  // The test file as it is now goes onto main's code: the very test that runs on the story's, only the change is missing.
  const snapshot = fs.readFileSync(path.join(host.dir, test.file));
  host.update((x) => (x.status = `Running the test of "done when" ${n} on the story's code`));
  const now = await host.run(how.command, TEST_MS);
  const main = await host.onMain(async (dir, run) => {
    const to = path.join(dir, test.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, snapshot);
    return run(how.command, TEST_MS);
  });
  const v = judgeTest(test, now, main, t.criteria?.[n - 1]?.proof?.keeps === true);
  host.log(`Ran the test of "done when" ${n} (${how.command}): on main ${v.proof?.before}, on the story's code ${v.proof?.after}`);
  const file = saveRecord(host.bp, t.id, n, 'test', { criterion: text, test, whole: how.whole, story: runRecord(now, how.command), main: runRecord(main, how.command) });
  if (v.shows !== 'met') (v.toBuilder ? out.broken : out.open).push({ criterion: n, text, why: v.why });
  const met = v.proof?.keeps ? 'passes before the change and after it' : 'failed before the change and passes now';
  host.update((x) => addActivity(x, 'tester', v.shows === 'met' ? `The test of "done when" ${n} ${met}` : `"Done when" ${n}: ${v.why}`));
  return row(t, n, file, { shows: v.shows, ...(v.why ? { why: v.why } : {}), ...(v.proof ? { test: v.proof } : {}), ...(test.steps.length ? { note: test.steps.join(' ') } : {}) });
}

/** Each Not on a screen line, from what the Reviewer checked in its review. */
function proveNone(host: KindsHost, t: Ticket, lines: number[], out: KindsResult): ProofShot[] {
  const checks = noneChecks(host.bp, t.id);
  return lines.map((n) => {
    const text = criterionText(t, n)!;
    const c = checks.find((x) => x.criterion === text);
    const reason = t.criteria?.[n - 1]?.proof?.why ?? '';
    const file = saveRecord(host.bp, t.id, n, 'none', { criterion: text, reason, ...(c ? { checked: c.checked, holds: c.holds } : {}) });
    if (!c) {
      const why = 'The Reviewer has not said what it checked yet.';
      out.open.push({ criterion: n, text, why });
      return row(t, n, file, { shows: 'not-shown', why, ...(reason ? { note: reason } : {}) });
    }
    if (!c.holds) out.broken.push({ criterion: n, text, why: `The Reviewer says it does not hold: ${c.checked}` });
    return row(t, n, file, { shows: c.holds ? 'met' : 'broken', checked: c.checked, ...(c.holds ? {} : { why: c.checked }), ...(reason ? { note: reason } : {}) });
  });
}

/**
 * The Test and Not on a screen lines of the proof, and every row marked with its kind. With no kinds, nothing: the
 * proof runs as before. `testerRan` false: no app could start for the Tester, so a planned picture, answer or rows was
 * not made, and the person decides; it never passes quietly.
 */
export async function provedByKind(host: KindsHost, testerRan = true): Promise<KindsResult> {
  const t = readTicket(host.bp, host.id);
  if (!t || !hasKinds(t)) return NOTHING;
  const out: KindsResult = { broken: [], open: [] };
  // A project with no app to start has nothing to show, call or read: those lines are not expected to have a proof.
  if (!testerRan && hasAppToStart(readMeta(host.bp))) for (const n of testerLines(t)) out.open.push({ criterion: n, text: criterionText(t, n)!, why: `squad-kit could not start the app here, so the ${KIND_NAMES[kindOf(t, n) ?? 'screen']} proof was not made.` });
  const tests = linesOf(t, ['test']);
  const rows = [...(tests.length ? await proveTests(host, t, tests, out) : []), ...proveNone(host, t, linesOf(t, ['none']), out)];
  host.update((x) => putRows(x, rows));
  return out;
}

/**
 * squad-kit's check said a planned proof cannot be made (a picture, an answer or rows): that is never accepted quietly
 * as Not on a screen. It is not shown yet, and after the retakes the person decides on the card.
 */
export function plannedProof<V extends { shows: string; why: string; advice: string }>(t: Ticket, n: number, v: V | null): V | null {
  if (!v || !hasKinds(t) || v.shows !== 'off-screen') return v;
  return { ...v, shows: 'not-shown', why: `${KIND_NAMES[kindOf(t, n) ?? 'screen']} was planned, and the Tester could not make it: ${v.why}`.slice(0, 600), advice: '' };
}

/** A Test or Not on a screen line squad-kit could not prove by itself: a plain stop, and the person decides. */
export function kindsStop(x: Ticket, rows: OpenRow[]): void {
  const which = rows.map((r) => r.criterion).join(', ');
  x.live = false;
  x.squad = null;
  delete x.clock;
  x.stage = 'review';
  x.retryPhase = 'proof';
  x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
  x.status = 'The proof is not made yet';
  addActivity(x, 'tester', `Could not make the proof of "done when" ${which}`);
  x.stuck = {
    gate: 'proof',
    kind: 'not-shown',
    question: `squad-kit could not make the proof of "done when" ${which}. Try again, or continue with a reason.`,
    points: rows.map((r) => `"Done when" ${r.criterion}, ${r.text}: ${r.why}`),
    options: wayOptions({ gate: 'proof', kind: 'not-shown' }),
  };
  x.waiting = { kind: 'stuck', summary: 'The proof is not made yet: needs one decision' };
}
