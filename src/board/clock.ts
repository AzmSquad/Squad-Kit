import type { BoardPaths } from './store.js';
import type { AgentName, Stage, StepClock, StepRun, Ticket, TimedStep } from './types.js';
import { minutesWords, recordUsual, usualKey, usualOf, type Usual, type UsualBook } from './usual.js';

/**
 * The clock of the step running on a ticket. The engines start it when a step starts, move it on with the Builder's
 * plan steps, write the latest action into it, and end it when the step ends well, which adds the step's time to the
 * project's usual times. It counts only the time the step really runs: it stops while the ticket waits for the person,
 * for another story or for a free place. The board, the terminal and the Ask box all read it from the ticket.
 */

export const WHO: Record<AgentName | 'squad', string> = {
  analyst: 'Analyst',
  architect: 'Architect',
  builder: 'Builder',
  reviewer: 'Reviewer',
  tester: 'Tester',
  squad: 'squad-kit',
};

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** The first plan step not done yet, from 1. */
function firstOpenStep(t: Ticket): number | undefined {
  const steps = t.steps ?? [];
  if (!steps.length) return undefined;
  const i = steps.findIndex((s) => s.status !== 'done');
  return i >= 0 ? i + 1 : steps.length;
}

const TIMED = new Set<string>(['questions', 'spec', 'design', 'build', 'fix', 'checks', 'review', 'proof']);

/** The step of a run, when it is one squad-kit times. */
export function timedStep(step: string | undefined): TimedStep | null {
  return step && TIMED.has(step) ? (step as TimedStep) : null;
}

/**
 * A step starts. One already on the clock goes on with its time (the Tester's clock starts with the app, before the
 * Tester itself), without the time it waited. A run while the ticket waits for you (an answer about one of its
 * questions) is not a step.
 */
export function startStep(t: Ticket, c: Omit<StepClock, 'since'>, at = Date.now()): void {
  if (t.waiting) return;
  const same = t.clock?.who === c.who && t.clock.step === c.step ? t.clock : undefined;
  const part = c.part ?? same?.part ?? (c.who === 'builder' && c.step === 'build' ? firstOpenStep(t) : undefined);
  const limit = c.limit ?? same?.limit;
  // What it waited moves its start on, so the time so far is the time it ran.
  const waited = same?.paused ? Math.max(0, at - Date.parse(same.paused)) : 0;
  const since = same ? iso(Date.parse(same.since) + waited) : iso(at);
  const { paused: _paused, ...goesOn } = same ?? ({} as Partial<StepClock>);
  t.clock = {
    ...goesOn,
    who: c.who,
    step: c.step,
    since,
    began: same?.began ? iso(Date.parse(same.began) + waited) : since,
    ...(part ? { part } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** The ticket's step does not run now: it waits for the person or for another story. */
export function waitsNow(t: Pick<Ticket, 'waiting' | 'live' | 'squad'>): boolean {
  return Boolean(t.waiting) || (!t.live && !t.squad);
}

/** The step does not run for now (a wait, a place in the queue): its clock stands still until the step starts again. */
export function pauseClock(t: Ticket, at = Date.now()): void {
  if (t.clock && !t.clock.paused) t.clock.paused = iso(at);
}

/** Seconds the step on the clock has run; a clock that stands still counts up to when it stopped. */
export function stepSeconds(c: StepClock, at = Date.now()): number {
  const end = c.paused ? Math.min(at, Date.parse(c.paused)) : at;
  return Math.max(0, (end - Date.parse(c.since)) / 1000);
}

/** The steps a ticket keeps in its history, newest last. */
export const HISTORY = 80;

/**
 * The board restarted while the step ran: it carries on with its time so far, and says once that it resumed. The time
 * of a part cut off like this says little about the step, so it does not teach the usual times.
 */
export function resumeClock(t: Ticket, at = Date.now()): void {
  if (t.clock) t.clock.resumed = iso(at);
}

/**
 * The step ended well: its time joins the usual times and the ticket's history, with the stage it ran in, and the
 * clock stops. `more`: what else the history keeps of it.
 */
export function endStep(bp: BoardPaths, t: Ticket, at = Date.now(), more: Pick<StepRun, 'builderRun'> = {}): void {
  const c = t.clock;
  if (!c) return;
  if (!c.resumed) recordUsual(bp, usualKey(c.who, c.step, t.track), stepSeconds(c, at));
  t.history = [...(t.history ?? []), { who: c.who, step: c.step, from: c.began ?? c.since, to: iso(c.paused ? Math.min(at, Date.parse(c.paused)) : at), stage: t.stage, ...more }].slice(-HISTORY);
  delete t.clock;
}

/** Seconds the whole step on the clock has run, all of the Builder's plan steps together, without what it waited. */
export function runSeconds(c: StepClock, at = Date.now()): number {
  const end = c.paused ? Math.min(at, Date.parse(c.paused)) : at;
  const secs = (end - Date.parse(c.began ?? c.since)) / 1000;
  return Number.isFinite(secs) ? Math.max(0, secs) : 0;
}

/** The Builder moved on to plan step `part` (from 1): the one before counts as done, and its clock starts again. */
export function nextPart(bp: BoardPaths, t: Ticket, part: number, at = Date.now()): void {
  const c = t.clock;
  if (!c || c.step !== 'build' || c.part === part) return;
  if (c.part !== undefined && part > c.part && !c.resumed) recordUsual(bp, usualKey(c.who, c.step, t.track), stepSeconds(c, at));
  c.part = part;
  c.since = iso(at);
  delete c.resumed;
  delete c.paused;
}

/** The step's latest action, in plain words: its last progress. */
export function stepDoing(t: Ticket, line: string, at = Date.now()): void {
  if (!t.clock || !line) return;
  t.clock.doing = line;
  t.clock.doingAt = iso(at);
}

/**
 * Keeps how long the ticket spends in each stage, for the tracker under its title, and how much of it was the
 * person's turn. A ticket from before this was kept starts counting now, so a stage it was in for hours never shows the
 * wrong time.
 */
export function trackStage(t: Ticket, before: Stage, at = Date.now()): void {
  const st = t.stageTimes ?? { stage: before, since: before === 'tickets' || before === 'bugs' ? t.createdAt : iso(at), spent: {} };
  const secsSince = (from: string) => {
    const secs = Math.max(0, Math.round((at - Date.parse(from)) / 1000));
    return Number.isFinite(secs) ? secs : 0;
  };
  const yours = Boolean(t.waiting || t.takenOver);
  // The person's turn ended, or the stage moved on during it: that time goes to the stage it was in.
  if (st.yoursSince && (!yours || st.stage !== t.stage)) {
    st.yours = { ...st.yours, [st.stage]: (st.yours?.[st.stage] ?? 0) + secsSince(st.yoursSince) };
    delete st.yoursSince;
  }
  if (st.stage !== t.stage) {
    st.spent = { ...st.spent, [st.stage]: (st.spent[st.stage] ?? 0) + secsSince(st.since) };
    st.stage = t.stage;
    st.since = iso(at);
  }
  if (yours && !st.yoursSince) st.yoursSince = iso(at);
  t.stageTimes = st;
}

/** Never call a step slow before this, whatever its usual time: a step that usually takes seconds may take a few minutes. */
export const SLOW_FLOOR_S = 5 * 60;

/** "under a minute", "about 1 minute", "3 to 6 minutes". */
export function usualSentence(u: Pick<Usual, 'low' | 'high'>): string {
  if (u.high < 60) return 'under a minute';
  const low = Math.max(1, Math.round(u.low / 60));
  const high = Math.max(low, Math.round(u.high / 60));
  return low === high ? `about ${low} minute${low === 1 ? '' : 's'}` : `${low} to ${high} minutes`;
}

/** When a step counts as slow: twice its usual time, and never before the floor. */
export function slowAfter(u: Pick<Usual, 'high'>): number {
  return Math.max(2 * u.high, SLOW_FLOOR_S);
}

/**
 * Past twice its usual time a step is taking longer than usual, and the card says so in words. Null while the step
 * is within its time, or when nothing on the ticket is timed.
 */
export function slowStep(t: Ticket, book: UsualBook, at = Date.now()): NonNullable<Ticket['quiet']> | null {
  const c = t.clock;
  if (!c || t.waiting || c.paused) return null;
  const u = usualOf(book, c.who, c.step, t.track);
  const n = t.steps?.length ?? 0;
  // The build is timed per plan step, by what the Builder says of its steps. Until it has said a word about any, they
  // would all pile up on the first, so the build is slow when the whole of it is: against what that many steps take.
  const heard = t.steps?.some((s) => s.status === 'doing' || s.status === 'done');
  if (c.who === 'builder' && c.step === 'build' && n > 1 && !heard) {
    const all = { low: u.low * n, high: u.high * n };
    const secs = Math.max(0, (at - Date.parse(c.began ?? c.since)) / 1000);
    if (secs < slowAfter(all)) return null;
    return { since: c.began ?? c.since, kind: 'long', detail: `The Builder has been building for ${minutesWords(secs)}. ${n} steps usually take ${usualSentence(all)}.` };
  }
  const secs = stepSeconds(c, at);
  if (secs < slowAfter(u)) return null;
  const detail =
    c.who === 'squad'
      ? `The checks have been running for ${minutesWords(secs)}. They usually take ${usualSentence(u)}.`
      : `The ${WHO[c.who]} has been on this step for ${minutesWords(secs)}. It usually takes ${usualSentence(u)}.`;
  return { since: c.since, kind: 'long', detail };
}
