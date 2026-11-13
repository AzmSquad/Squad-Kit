import { inbox } from '../board/actions.js';
import { listTickets, type BoardPaths } from '../board/store.js';
import type { BoardMeta, GateOverride, StuckChoice, Ticket, WaitingKind } from '../board/types.js';
import { HARNESS_FILE_GATE } from '../board/additions.js';
import { readPause } from './usage-limit.js';

/**
 * What the gates really did, counted from this project's own stories on this computer: the lines the engine writes on a
 * story's activity, the state of its gates, its stop and what the person went past. Every number counts stories, so a
 * story stopped twice by one gate, or retaken, counts once. A gate with no record has no entry here and shows no number:
 * none is better than a wrong one. test/harness-seen.test.ts fails when the engine stops writing a line read here.
 */

export const SEEN_DAYS = 30;
export const WEEK_DAYS = 7;
const ONE_DAY = 86_400_000;

/** The lines that say a gate sent the work back or stopped a story. */
export const STOP_LINES: Record<string, RegExp> = {
  checks: /^Checks failed: /,
  weakened: /^Stopped before the checks: the tests were made weaker/,
  'no-tests': /^Not checked: .*Asked you once/,
  guard: /^A check (needed a file outside|tried to use Docker)/,
  'test-change': /^squad-kit keeps the current way of testing/,
  review: /^(Asked for \d+ fix|Still asks for )/,
  proof: /^(Could not take the screenshots|No screenshots yet)/,
  'bad-proof': /^The screenshots did not pass squad-kit's check/,
  'not-shown': /^(The screenshots do not show .* clearly yet|Could not show .* on a screen after)/,
  broken: /^(The screenshots show .* not working yet|Still not working after)/,
  window: /^The \w+ asked .*squad-kit refused\.$/,
  questions: /did not bother you with it\.$|^The \w+ asked a technical question/,
  sandbox: /^(Reaching|Reading|Writing) .* was blocked: |^A download from \S+ was not allowed for this project/,
  lane: /^The (Builder|Tester|Reviewer|project's checks) changed .*squad-kit put |^Stopped the \w+: /,
  hook: /^The project's own check said no/,
  merge: /^(Could not merge into |It clashes with newer changes)|clashes with newer changes in \S+, so it left/,
  cap: /^Paused: /,
  budget: /^Paused before the next step/,
};

/** When a story really passed a gate. Only a gate whose pass is a result: never one that only says the step ran. */
const PASSED: Record<string, (t: Ticket) => string | undefined> = {
  checks: (t) => (t.gates?.checks === 'pass' ? lineAt(t, /^All checks pass/) : undefined),
  'test-change': (t) => lineAt(t, /^squad-kit keeps the new way of testing/),
  review: (t) => (t.gates?.review === 'pass' ? lineAt(t, /^Approved: /) : undefined),
  // With a picture to show for it. "No screens to show" passes the gate too, and proves nothing.
  proof: (t) => (t.gates?.proof === 'pass' && t.proof?.length ? (t.history?.filter((h) => h.step === 'proof').at(-1)?.to ?? t.activity[0]?.at) : undefined),
  merge: (t) => t.mergedAt,
};

/** The lines that say what a rule did, with the words before the count. */
export const DID_LINES: Record<string, [RegExp, string]> = {
  spec: [/^Approved the spec/, 'You approved'],
  plan: [/^Approved the (design|plan)/, 'You approved'],
  'looks-right': [/^Checked the proof\. Looks right/, 'You accepted'],
  split: [/^Suggested splitting it into \d+ stories|^Found it too big for one story/, 'Suggested on'],
  ask: [/^Asked you: /, 'Asked on'],
  chat: [/^Started talking it through/, 'You talked on'],
  decisions: [/\. Decision saved as /, 'Saved decisions on'],
  depends: [/so the build waits for you to choose/, 'Waited for you on'],
  change: [/^Approved change \S+ \(big\)/, 'You approved a big change on'],
  'reviewer-floor': [/as strong as the Builder\)$/, 'Raised the model on'],
  'also-changed': [/^Also changed, not in the plan/, 'Named something on'],
  'off-screen': [/^"Done when" \d+ is not on a screen/, 'Marked on'],
  'api-proof': [/^squad-kit asked .* and kept the answer/, 'Used on'],
  'take-over': [/^Took it over/, 'You took over'],
  'pull-request': [/^Opened pull request/, 'Opened on'],
  checkout: [/^It goes in once your own copy/, 'Waited on'],
  release: [/^Released in /, 'Sent out'],
  watchdog: [/^Looks stuck: /, 'Flagged'],
  'step-up': [/^Runs on .*after \d+ failed tr/, 'Moved up on'],
  'plain-words': [/^The Tester wrote something technical/, 'Kept words out of the proof on'],
  interrupted: [/^Carried on.* after (a restart|the computer slept)|^The computer slept|^Resumed after sleep/, 'Carried on after it on'],
  blips: [/^The connection or the AI service had a problem/, 'Waited on'],
  leftovers: [/^Stopped (a program|\d+ programs) left running/, 'Stopped programs on'],
};

/** The lines that say a limit was reached, by the limit's name. */
export const HIT_LINES: Record<string, RegExp> = {
  MAX_CHECK_TRIES: /^Checks failed: .*\(try (\d+) of \1\)$/,
  MAX_REVIEW_ROUNDS: /^Still asks for /,
  MAX_RETAKES: /^Could not show .* on a screen after \d+ more tries/,
  MAX_PROOF_ROUNDS: /^Still not working after /,
  MAX_BASE_TRIES: /came in \d+ times, so it waits for you$/,
  REFUSALS_TO_STOP: /^Stopped: .*kept asking for things it may not do/,
  MISTAKES_TO_STOP: /^Stopped: .*kept using squad-kit's tools the wrong way/,
  TECHNICAL_TRIES: /^Stopped: .*kept asking a technical question/,
  BEFORE_SHOTS_MS: /^Stopped the before screenshots after/,
};

/** The row for what a story waits for. A stop goes by the gate that raised it. */
export const WAIT_ROW: Record<Exclude<WaitingKind, 'stuck'>, string> = { questions: 'questions', spec: 'spec', plan: 'plan', proof: 'looks-right', release: 'release', ask: 'ask', yours: 'take-over', chat: 'chat', change: 'change', depends: 'depends', split: 'split' };

export interface StoryLink {
  id: string;
  title: string;
  at: string;
}

export interface Seen {
  passed?: number;
  stopped?: number;
  /** Of those stopped, how many in the last WEEK_DAYS days. */
  week?: number;
  last?: StoryLink;
  did?: string;
}

export interface Need {
  id: string;
  summary: string;
  row: string;
  proof: boolean;
}

const lineAt = (t: Ticket, re: RegExp): string | undefined => t.activity.find((a) => re.test(a.text))?.at;

const stopRow = (s: StuckChoice): string => s.kind ?? s.gate ?? (s.budget ? 'budget' : 'ways-out');

const overrideRow = (o: GateOverride): string => (o.added ? 'gate-cant-run' : o.weakened?.length ? 'weakened' : o.gate === 'hooks' ? 'hook' : o.gate);

function needRow(t: Ticket): string {
  // A story held by one of the team's gates waits at that gate's own row.
  const gate = t.waiting?.kind === 'stuck' ? t.stuck?.added?.find((g) => g.id !== HARNESS_FILE_GATE) : undefined;
  if (gate) return `add:${gate.id}`;
  if (t.waiting) return t.waiting.kind === 'stuck' ? (t.stuck ? stopRow(t.stuck) : 'ways-out') : WAIT_ROW[t.waiting.kind];
  if (t.quiet?.kind === 'stuck') return 'watchdog';
  if (t.outdated?.length) return 'decisions';
  return t.testChange?.ask ? 'test-change' : 'change';
}

const storyWord = (n: number) => `${n} ${n === 1 ? 'story' : 'stories'}`;

/** Everything counted for the page. `now` is for the tests. */
export function harnessSeen(bp: BoardPaths, meta: BoardMeta, now = Date.now()) {
  const from = now - SEEN_DAYS * ONE_DAY;
  const week = now - WEEK_DAYS * ONE_DAY;
  const fresh = (at: string | undefined): at is string => Boolean(at) && Date.parse(at!) >= from;
  const rows: Record<string, Seen> = {};
  const weekIds: Record<string, string[]> = {};
  const hits: Record<string, StoryLink> = {};
  const did: Record<string, number> = {};
  // What the team's additions did that is no pass and no stop: the story's own record says it.
  const said: Record<string, { would: number; warned: number; cant?: StoryLink }> = {};
  const tickets = listTickets(bp).filter((t) => !t.deleting);
  let counted = 0;
  let wentPast = 0;
  for (const t of tickets) {
    const lines = t.activity.filter((a) => fresh(a.at));
    if (lines.length || fresh(t.createdAt)) counted += 1;
    const stops = new Map<string, string>();
    const stop = (row: string, at: string | undefined) => {
      if (fresh(at) && !(stops.get(row)! > at)) stops.set(row, at);
    };
    for (const [row, re] of Object.entries(STOP_LINES)) stop(row, lines.find((a) => re.test(a.text))?.at);
    // A stop from before these lines, or one that wrote none, is still a stop: its card or what you went past says so.
    if (t.stuck && t.waiting?.kind === 'stuck' && stopRow(t.stuck) !== 'ways-out') stop(stopRow(t.stuck), t.activity[0]?.at ?? t.createdAt);
    for (const o of t.overrides ?? []) stop(overrideRow(o), o.at);
    for (const r of t.added ?? []) if (r.stopped) stop(`add:${r.id}`, r.stopped);
    if (t.overrides?.some((o) => fresh(o.at))) wentPast += 1;
    for (const [row, at] of stops) {
      const r = (rows[row] ??= {});
      r.stopped = (r.stopped ?? 0) + 1;
      if (Date.parse(at) >= week) {
        r.week = (r.week ?? 0) + 1;
        (weekIds[row] ??= []).push(t.id);
      }
      if (!r.last || at > r.last.at) r.last = { id: t.id, title: t.title, at };
    }
    // One story, one result at a gate: one it stopped does not count as passed too, whatever came after.
    for (const [row, at] of Object.entries(PASSED).map(([row, of]) => [row, of(t)] as const)) {
      if (!stops.has(row) && fresh(at)) (rows[row] ??= {}).passed = (rows[row]!.passed ?? 0) + 1;
    }
    for (const r of (t.added ?? []).filter((x) => fresh(x.at))) {
      const row = `add:${r.id}`;
      const s = (said[row] ??= { would: 0, warned: 0 });
      const no = r.answers?.some((a) => a.answer === 'no');
      if (r.result === 'would-stop' || (no && r.state === 'try')) s.would += 1;
      if (r.result === 'warned') s.warned += 1;
      if (r.result === 'cant-run' && !(s.cant?.at! > r.at)) s.cant = { id: t.id, title: t.title, at: r.at };
      const fine = r.result === 'passed' || Boolean(r.answers?.length && r.answers.every((a) => a.answer === 'yes'));
      if (fine && !stops.has(row)) (rows[row] ??= {}).passed = (rows[row]!.passed ?? 0) + 1;
    }
    for (const [row, [re]] of Object.entries(DID_LINES)) if (lines.some((a) => re.test(a.text))) did[row] = (did[row] ?? 0) + 1;
    for (const [limit, re] of Object.entries(HIT_LINES)) {
      const at = lines.find((a) => re.test(a.text))?.at;
      if (at && !(hits[limit]?.at! > at)) hits[limit] = { id: t.id, title: t.title, at };
    }
  }
  for (const row of Object.keys(PASSED)) {
    if (rows[row]) rows[row] = { passed: 0, stopped: 0, ...rows[row] };
  }
  for (const [row, s] of Object.entries(said)) {
    const words = [s.would ? `Would have stopped ${storyWord(s.would)}` : '', s.warned ? `Warned on ${storyWord(s.warned)}` : '', s.cant ? `Could not run on ${s.cant.id}` : ''].filter(Boolean);
    rows[row] = { passed: 0, stopped: 0, ...rows[row], ...(words.length ? { did: words.join('. ') } : {}) };
  }
  for (const [row, n] of Object.entries(did)) (rows[row] ??= {}).did = `${DID_LINES[row]![1]} ${storyWord(n)}`;
  if (wentPast) (rows['ways-out'] ??= {}).did = `You went past a check on ${storyWord(wentPast)}`;
  const pause = readPause();
  if (pause && pause.project === meta.project && fresh(pause.since)) (rows['usage-limit'] ??= {}).did = `Last waited ${pause.since.slice(0, 10)}`;
  const needs: Need[] = inbox(bp)
    .filter((t) => !t.deleting && !t.archived)
    .map((t) => ({ id: t.id, summary: t.waiting?.summary ?? t.quiet?.detail ?? t.status, row: needRow(t), proof: t.waiting?.kind === 'proof' }));
  return { stories: counted, rows, weekIds, hits, needs };
}
