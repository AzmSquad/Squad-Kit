import { addActivity, readMeta, updateTicket, type BoardPaths } from './store.js';
import { countSampleStep } from './demo-cost.js';
import { needsSpec, wayOptions } from './actions.js';
import { endStep, nextPart, slowStep, startStep, stepDoing } from './clock.js';
import { readUsual } from './usual.js';
import type { StepClock, Ticket } from './types.js';

/**
 * The sample squad keeps the same clocks as the live one, so the sample board shows who works, since when, the usual
 * time and a slow step the same way. Its steps are timers, so it reads who works from the step it plays.
 */

/** Who works in the step the sample squad plays now, or null when nothing it plays is a timed step. */
export function demoStep(t: Ticket): Omit<StepClock, 'since'> | null {
  const s = t.squad;
  if (!s || t.waiting) return null;
  const doing = (t.steps ?? []).findIndex((x) => x.status === 'doing');
  const open = (t.steps ?? []).findIndex((x) => x.status !== 'done');
  const part = doing >= 0 ? doing + 1 : open >= 0 ? open + 1 : undefined;
  switch (s.phase) {
    case 'analyst-read':
      return t.track === 'express' || t.track === 'auto' ? null : { who: 'analyst', step: 'questions' };
    case 'plan-write':
    case 'spec-rewrite':
    case 'plan-rewrite':
      return s.phase === 'spec-rewrite' || (s.phase === 'plan-write' && needsSpec(t)) ? { who: 'analyst', step: 'spec' } : { who: 'architect', step: 'design' };
    case 'chat-spec':
      return { who: 'analyst', step: 'spec' };
    case 'chat-design':
    case 'answered-architect':
      return { who: 'architect', step: 'design' };
    case 'build':
    case 'unstick':
    case 'answered-builder':
    case 'chat-carry-builder':
      return t.stage === 'implement' && part ? { who: 'builder', step: 'build', part } : { who: 'builder', step: 'build' };
    case 'fix':
      return { who: 'builder', step: 'fix' };
    case 'test':
      return /^(Recording|Checking the change)/.test(t.status) ? { who: 'tester', step: 'proof' } : { who: 'squad', step: 'checks' };
    case 'review':
    case 'answered-reviewer':
    case 'chat-carry-reviewer':
      return /^Builder/.test(t.status) ? { who: 'builder', step: 'fix' } : { who: 'reviewer', step: 'review' };
    case 'chat-carry-tester':
      return { who: 'tester', step: 'proof' };
    case 'ambient':
      // The sample board's tickets that work on their own, in one step for as long as the board is open.
      if (t.stage === 'tickets') return { who: 'analyst', step: 'questions' };
      if (t.stage === 'implement') return { who: 'builder', step: 'build', ...(part ? { part } : {}) };
      if (t.stage === 'test') return { who: 'squad', step: 'checks' };
      return { who: 'reviewer', step: 'review' };
    default:
      return null;
  }
}

/** A sample step ended well: its time joins the usual times and the history, and what it used is counted. */
function endDemoStep(bp: BoardPaths, t: Ticket): void {
  const c = t.clock;
  if (c) countSampleStep(bp, t, c.who, c.step, readMeta(bp).quality);
  endStep(bp, t);
}

/** After each step the sample squad plays: a new step starts its clock, a finished one adds its time to the usual times. */
export function keepDemoClock(bp: BoardPaths, t: Ticket): void {
  const next = demoStep(t);
  const c = t.clock;
  if (!next) {
    if (c) endDemoStep(bp, t);
    return;
  }
  if (c && (c.who !== next.who || c.step !== next.step)) endDemoStep(bp, t);
  if (t.clock && next.part) nextPart(bp, t, next.part);
  if (!t.clock) startStep(t, next);
  // The Builder's line is on its step while the card says "Step 3 of 6"; elsewhere the card's line is the action.
  const line = /^Step \d+ of \d+/.test(t.status) ? (t.steps?.find((s) => s.status === 'doing')?.live ?? '') : t.status;
  if (line && line !== t.clock?.doing) stepDoing(t, line);
}

/** Stop on the sample board: park the ticket with a way on, or with "Stop and try again" start the step again. */
export function stopDemoStep(bp: BoardPaths, t: Ticket, speed: number): void {
  t.stopRequested = undefined;
  delete t.quiet;
  if (t.retryOnStop) {
    t.retryOnStop = undefined;
    const limit = t.clock?.limit;
    delete t.clock;
    t.live = true;
    addActivity(t, 'squad', 'Stopped the step and started it again, with the work so far');
    if (t.squad) t.squad.nextAt = new Date(Date.now() + 1000 / Math.max(speed, 0.1)).toISOString();
    keepDemoClock(bp, t);
    const fresh = t.clock as StepClock | undefined;
    if (fresh && limit) fresh.limit = limit;
    t.status = 'Trying the step again';
    return;
  }
  delete t.clock;
  t.live = false;
  t.retryPhase = t.squad?.phase;
  t.squad = null;
  t.status = 'Stopped, needs you';
  t.stuck = {
    question: 'You stopped the squad. Nothing was lost; the work so far is kept.',
    options: [{ do: 'retry', name: 'Carry on', note: 'Run the stopped step again.' }, ...wayOptions({}).slice(1)],
  };
  t.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
  addActivity(t, 'squad', 'Stopped: you stopped the squad. Nothing was lost; the work so far is kept.');
}

/** Every few seconds: a sample step past twice its usual time gets the "Taking longer than usual" card, as live. */
export function watchDemoSlow(bp: BoardPaths, tickets: Ticket[], at = Date.now()): void {
  const usual = readUsual(bp);
  for (const t of tickets) {
    if (!t.squad || t.waiting || t.stopRequested) continue;
    const snoozed = t.quietSnoozedUntil && Date.parse(t.quietSnoozedUntil) > at;
    const q = snoozed ? null : slowStep(t, usual, at);
    if ((q?.detail ?? null) === (t.quiet?.detail ?? null)) continue;
    updateTicket(bp, t.id, (x) => {
      if (q && x.quiet?.kind !== q.kind) addActivity(x, 'squad', `Taking long: ${q.detail}`);
      if (q) x.quiet = q;
      else delete x.quiet;
    });
  }
}
