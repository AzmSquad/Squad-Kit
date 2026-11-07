import type { Stage, Ticket } from './types.js';

/**
 * Where a story stands while a conversation outside squad-kit works on it. Its own files say: nothing has to report the
 * step, so the board shows the real one whenever it is opened.
 */

const ORDER: Stage[] = ['tickets', 'specs', 'implement', 'test', 'review'];

type Files = Pick<Ticket, 'story' | 'criteria' | 'decision' | 'steps'>;

export function hasSpec(t: Files): boolean {
  return Boolean(t.story?.trim() || t.criteria?.length);
}

export function hasDesign(t: Files): boolean {
  return Boolean(t.decision || t.steps?.length);
}

/** The step a story is at as it leaves the squad. Nothing: no step has done anything on it yet. */
export function leavingAt(t: Pick<Ticket, 'stage' | 'waiting' | 'specApproved'> & Files): string | undefined {
  if (t.stage === 'implement') return 'the build';
  if (t.stage === 'test') return 'the checks';
  if (t.stage === 'review') return t.waiting?.kind === 'proof' ? 'the proof' : 'the review';
  if (t.stage === 'specs') return t.specApproved ? 'the design' : 'the spec';
  return hasSpec(t) ? 'the spec' : undefined;
}

/** What people call a story with the label. */
export function outsideWords(o: NonNullable<Ticket['outside']>): string {
  return o.from ? `Continued outside from ${o.from}` : 'Worked outside squad-kit';
}

/** The stage and the card's line. Never before the stage it left at. */
export function showOutsideStep(t: Ticket): void {
  const left = t.takenOver?.free;
  if (!left) return;
  const reached = t.worktree ? 'implement' : hasSpec(t) || hasDesign(t) ? 'specs' : 'tickets';
  const rank = (s: Stage) => Math.max(ORDER.indexOf(s), 0);
  t.stage = rank(left.stage) >= rank(reached) ? left.stage : reached;
  const doing = t.worktree ? 'building' : hasDesign(t) ? 'the design is written' : hasSpec(t) ? 'the spec is written' : 'not started yet';
  t.status = `In a conversation outside squad-kit: ${doing}`;
}

export const OUTSIDE_WAITS = 'In a conversation outside squad-kit. Bring it back when you are done';

/** The hash of a story with no documents, for a story that starts outside. */
export const NO_DOCS = 'none';

/** The story leaves the squad. Everything that keeps the squad off a taken-over story keeps it off this one too. */
export function leaveForOutside(t: Ticket, by: string, at: string, seen: { docs: string; work: string }): void {
  const from = leavingAt(t);
  const phase = t.squad?.phase;
  const left = { stage: t.stage, status: t.status, waiting: t.waiting, ...(phase ? { phase } : {}), ...seen, ...(from ? { from } : {}) };
  t.takenOver = { by, at, session: t.sessions?.build ?? '', cwd: t.storyDir ?? t.worktree ?? '', free: left };
  t.live = false;
  t.squad = null;
  t.waiting = { kind: 'yours', summary: OUTSIDE_WAITS };
  showOutsideStep(t);
}

/** squad-kit's own checks, review and proof all passed. Someone going past a gate is not squad-kit saying it is fine. */
function gatesPassed(g: Ticket['gates']): boolean {
  return g?.review === 'pass' && g.proof === 'pass' && (g.checks === 'pass' || g.checks === 'unchecked');
}

/** The proof just passed. */
export function markCheckedOutside(t: Ticket): void {
  if (!t.outside) return;
  const g = t.gates;
  t.outside = { ...t.outside, ...(gatesPassed(g) ? { checked: { at: new Date().toISOString(), by: 'squad-kit', ...(g?.checks === 'unchecked' ? { noTests: true } : {}) } } : { checked: undefined }) };
}

/** Checked lasts as long as those gates do: asking for more work, or going past one, ends it. */
export function dropOldChecked(t: Ticket): void {
  if (t.outside?.checked && !gatesPassed(t.gates)) t.outside = { ...t.outside, checked: undefined };
}

/** The Architect says how many screens a story changes. On a story designed outside no one said, so the Tester looks. */
export function changesScreens(t: Pick<Ticket, 'work' | 'outside'>): boolean {
  return (t.work?.screens ?? 0) > 0 || Boolean(t.outside && !t.work);
}
