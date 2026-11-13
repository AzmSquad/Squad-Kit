import type { Ticket } from '../../board/types.js';
import type { ReviewNote, ReviewNoteState, ReviewRound } from '../../board/review-types.js';

/**
 * Where a note stands. Going past a note is the person's alone, with a reason: one at a time (`squad review --past`), or
 * all the notes still open when the review stopped and they pressed Continue anyway (the stop card's own reason).
 */

/** Continue anyway on the review stop that came after this round: its reason stands for the notes left open. */
function pastByStop(t: Pick<Ticket, 'overrides'>, round: Pick<ReviewRound, 'at'>): ReviewNote['past'] | undefined {
  const o = (t.overrides ?? []).filter((x) => x.gate === 'review' && x.at >= round.at).sort((a, b) => a.at.localeCompare(b.at))[0];
  return o ? { by: o.by, reason: o.reason, at: o.at } : undefined;
}

export function pastOf(t: Pick<Ticket, 'overrides'>, round: Pick<ReviewRound, 'at'>, note: ReviewNote): ReviewNote['past'] | undefined {
  if (note.past) return note.past;
  return note.fixed ? undefined : pastByStop(t, round);
}

export function stateOf(t: Pick<Ticket, 'overrides'>, round: Pick<ReviewRound, 'at'>, note: ReviewNote): ReviewNoteState {
  if (note.fixed) return 'fixed';
  return pastOf(t, round, note) ? 'past' : 'open';
}

/** The notes nothing settled yet, oldest first, each with its round. */
export function openNotes(t: Pick<Ticket, 'review' | 'overrides'>): ReviewNote[] {
  return (t.review?.rounds ?? []).flatMap((r) => r.notes.filter((n) => stateOf(t, r, n) === 'open'));
}
