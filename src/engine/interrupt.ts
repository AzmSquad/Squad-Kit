import { performance } from 'node:perf_hooks';
import { now } from '../board/store.js';
import type { Interruption, Ticket } from '../board/types.js';

/**
 * An interruption is not a failure. A run cut off by a board restart, a Stop, squad-kit closing or the computer
 * sleeping says nothing about the work, so it never counts as a failed try and never makes the next run stronger. It
 * is kept on the ticket as what it was, and the step carries on from where it was.
 */

/**
 * Records that the step's run was cut off, and gives the step to carry on with. As with the usage limit, the round or
 * the try it cut off does not count: a review cut off runs its round again, the Builder cut off while it fixed the
 * review notes carries on with the fix, and checks that run again after a fix that was cut off count once.
 */
export function markInterrupted(x: Ticket, phase: string, by: Interruption['by'], at = now()): string {
  let next = phase;
  if (phase === 'review' && x.reviewNotes?.length) next = 'review-fix';
  // Cut off while the Builder fixed what the screenshots showed: it carries on with that fix.
  else if (phase === 'proof' && x.stage === 'implement' && x.proof?.some((p) => p.shows === 'broken')) next = 'proof-fix';
  else if (phase === 'review' && x.reviewRound) x.reviewRound -= 1;
  if (phase === 'test' && x.clock?.who === 'builder') {
    x.tries = Math.max(0, (x.tries ?? 0) - 1);
    x.fails = Math.max(0, (x.fails ?? 0) - 1);
  }
  x.interrupted = { at, by, phase: next };
  return next;
}

/** The step carries on after this interruption: the same phase it cut off. */
export function carriesOn(t: Pick<Ticket, 'interrupted'>, phase: string): Interruption | undefined {
  return t.interrupted?.phase === phase ? t.interrupted : undefined;
}

const WHY: Record<Interruption['by'], string> = {
  restart: 'squad-kit restarted while you worked',
  stop: 'Your last run was stopped',
  sleep: 'The computer slept while you worked',
};

/** The Builder carries on in its own conversation after an interruption: from the step it was on, never from step 1. */
export function carryOnPrompt(t: Pick<Ticket, 'steps'>, by: Interruption['by']): string {
  const steps = t.steps ?? [];
  const i = steps.findIndex((s) => s.status !== 'done');
  const where = i >= 0 ? ` You were on step ${i + 1} of ${steps.length}: ${steps[i]!.title}.${i > 0 ? ' The steps before it are done.' : ''}` : '';
  return `${WHY[by]}, so your run was cut off. Nothing was lost: the work so far is in this copy.${where} Carry on from there; do not start again from step 1, and print ">> step N" as you start each step. Programs you started before (servers, watchers) were stopped, so start again what you need. Then run the tests.`;
}

/** The activity line when the Builder carries on: one line, saying why. */
export function carryOnLine(t: Pick<Ticket, 'steps'>, by: Interruption['by']): string {
  const steps = t.steps ?? [];
  const i = steps.findIndex((s) => s.status !== 'done');
  const where = i >= 0 && steps.length > 1 ? ` with step ${i + 1} of ${steps.length}` : '';
  return `Carried on${where} ${by === 'restart' ? 'after a restart' : by === 'sleep' ? 'after the computer slept' : 'from where you stopped it'}`;
}

/** A point in time on both clocks: the wall clock, and the one that stops while the computer sleeps. */
export interface SleepMark {
  wall: number;
  awake: number;
}

export function sleepMark(): SleepMark {
  return { wall: Date.now(), awake: performance.now() };
}

/** The computer slept since the mark: the wall clock moved on a minute or more past the time the app could run. */
export function sleptSince(m: SleepMark | undefined, wall = Date.now(), awake = performance.now()): boolean {
  return Boolean(m) && wall - m!.wall - (awake - m!.awake) >= 60_000;
}

/** Thrown when a run was cut off by the computer sleeping: the step carries on, it did not fail. */
export class CutOff extends Error {
  constructor(readonly by: Interruption['by']) {
    super('The run was cut off');
  }
}
