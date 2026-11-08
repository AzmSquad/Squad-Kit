import { createTicket } from '../board/actions.js';
import { listTickets, type BoardPaths } from '../board/store.js';
import type { OldFailure, Ticket } from '../board/types.js';
import { tail, testCount } from './checks.js';
import { failedTests, inChanged, testAlone, testKey, testTitle, type FailedTest } from './failed-tests.js';

/**
 * An old test the story did not cause. A story's tests can fail on a bug that is already on main, in a screen the story
 * never touched: sending the story back to the Builder for it costs a long detour and fixes nothing of the story. So
 * before a try is counted, squad-kit runs each failed test on its own on main's code (the Tester's "before" copy) a few
 * times. Fails there too: it is old. The story goes on past it, the gate says so, and one new story fixes it. Passes
 * there every time: the story's change broke it, and the Builder fixes it as before, told so. Main never gets worse: a
 * story only goes past a test that main already fails, and a test the story itself changed is never one of them. When
 * squad-kit cannot tell, nothing changes.
 */

/** With more failed tests than this, the story goes the usual way: so many is rarely old. */
export const MAX_OLD = 5;
/** Runs of each failed test on main, stopping at the first that fails. */
export const MAX_RUNS_ON_MAIN = 3;
/** The longest all the runs on main may take together. */
export const ON_MAIN_MS = 5 * 60_000;

/**
 * The failed tests of a test check squad-kit may run on main's code: each has a command that runs it alone, and the
 * story did not change its file. Null when squad-kit cannot name them, or there are too many: then the usual way.
 */
export function testsToTry(output: string, dir: string, command: string, changed: string[]): FailedTest[] | null {
  const failed = failedTests(output);
  if (!failed.length || failed.length > MAX_OLD) return null;
  if (failed.some((t) => !testAlone(dir, command, t) || inChanged(t, changed, dir))) return null;
  return failed;
}

export interface MainResult {
  /** Failed on main at least once. */
  old: FailedTest[];
  /** Passed on main every time. */
  fine: FailedTest[];
  /** The last lines an old test printed on main, by its key. */
  printed: Record<string, string>;
}

/**
 * Each failed test on its own in main's copy `dir`, up to 3 times, stopping at the first failure. A failed run counts
 * only when the test tool names that very test as failed: a run that fails for another reason (a value the copy lacks,
 * a server that did not start) says nothing about the test. A pass counts only when the tool says a test passed. Null
 * when a run says nothing, a test has no command there, or the time is up.
 */
export async function runOnMain(dir: string, command: string, tests: FailedTest[], run: (one: string, ms: number) => Promise<{ ok: boolean; output: string; ended?: boolean }>, until: number): Promise<MainResult | null> {
  const out: MainResult = { old: [], fine: [], printed: {} };
  for (const t of tests) {
    const one = testAlone(dir, command, t);
    if (!one) return null;
    let failed = false;
    for (let i = 0; i < MAX_RUNS_ON_MAIN && !failed; i += 1) {
      const left = until - Date.now();
      if (left <= 0) return null;
      const r = await run(one, left);
      if (r.ended) return null;
      if (failedTests(r.output).some((f) => testKey(f) === testKey(t))) {
        failed = true;
        out.printed[testKey(t)] = tail(r.output.trim(), 20);
      } else if (!r.ok || !testCount(r.output)) return null;
    }
    (failed ? out.old : out.fine).push(t);
  }
  return out;
}

/** An open story that already fixes this test. */
function openFix(bp: BoardPaths, key: string): Ticket | undefined {
  return listTickets(bp).find((t) => t.stage !== 'done' && !t.archived && !t.deleting && t.oldTests?.includes(key));
}

function short(text: string, n = 90): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/**
 * The stories that fix these old tests: an open one that already has a test, else one new story for the rest, a bug
 * with a plain title and what the Analyst needs: which test, its file, what it printed on main, and that it fails there
 * without the other story's change. Never a second story for a test while one is open. The gate's list comes back.
 */
export function storiesForOld(bp: BoardPaths, from: Ticket, old: FailedTest[], printed: Record<string, string>, how: { command: string; repo?: string; part?: string }): OldFailure[] {
  const out: OldFailure[] = [];
  const left: FailedTest[] = [];
  for (const t of old) {
    const open = openFix(bp, testKey(t));
    if (open) out.push({ title: testTitle(t), file: t.file, story: open.id });
    else left.push(t);
  }
  if (!left.length) return out;
  const first = short(testTitle(left[0]!));
  const title = left.length === 1 ? `Fix an old test that fails: ${first}` : `Fix ${left.length} old tests that fail: ${first}, and ${left.length - 1} more`;
  const each = left
    .map((t) => {
      const said = printed[testKey(t)];
      return [`Test: ${testTitle(t)}`, `File: ${t.file}${t.line ? `, line ${t.line}` : ''}`, ...(how.part ? [`Part: ${how.part}`] : []), ...(said ? [`The last lines it printed on main:\n${said}`] : [])].join('\n');
    })
    .join('\n\n');
  const one = left.length === 1;
  const [it, they, its] = one ? ['it', 'it', 'its'] : ['them', 'they', 'their'];
  const ask = `${one ? 'A test fails' : 'These tests fail'} on main, without any story's change. squad-kit found ${it} while checking ${from.id} (${from.title}): ${they} failed there, and failed again when squad-kit ran ${it} on ${its} own on main's code. So ${from.id} did not cause ${it}, and this story fixes ${it}.

The project's tests run with: ${how.command}

${each}`;
  // It waits on the board: squad-kit made it, so only the person starts it. Nothing runs or costs before.
  const made = createTicket(bp, {
    title,
    ask,
    kind: 'bug',
    oldTests: left.map(testKey),
    waitsToStart: true,
    ...(how.repo ? { repo: how.repo } : {}),
    bySquad: `squad-kit made this story while checking ${from.id}: ${one ? 'a test fails' : 'tests fail'} on main without its change. It waits here until you start it`,
  });
  for (const t of left) out.push({ title: testTitle(t), file: t.file, story: made.id });
  return out;
}

/** The gate's words for old tests: "1 old test also fails on main". */
export function oldGateText(n: number): string {
  return n === 1 ? '1 old test also fails on main' : `${n} old tests also fail on main`;
}

/**
 * The one line on the story about its old tests, with the stories made for them. `waiting`: those still waiting on the
 * board for the person to start them.
 */
export function oldLine(old: OldFailure[], goesOn: boolean, waiting: string[] = []): string {
  const titles = old.map((o) => o.title).join('; ');
  const stories = [...new Set(old.map((o) => o.story).filter((s): s is string => Boolean(s)))];
  const one = old.length === 1;
  const idle = stories.filter((s) => waiting.includes(s));
  // "it waits" when it is every story named, else by name: "MA-21 waits".
  const who = idle.length === stories.length ? (idle.length === 1 ? 'it waits' : 'they wait') : `${idle.join(' and ')} ${idle.length === 1 ? 'waits' : 'wait'}`;
  const waits = idle.length ? `; ${who} on the board until you start ${idle.length === 1 ? 'it' : 'them'}` : '';
  const made = stories.length ? ` squad-kit made ${stories.join(' and ')} for ${one ? 'it' : 'them'}${waits}.` : '';
  return `${one ? 'An old test fails' : `${old.length} old tests fail`} on main too, without this story's change: ${titles}. ${one ? 'It is' : 'They are'} not this story's${goesOn ? ', so the work goes on' : ''}.${made}`;
}
