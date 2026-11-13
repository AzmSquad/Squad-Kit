import type { Ticket } from '../../board/types.js';
import type { ReviewNote, ReviewNoteState, ReviewPosted, ReviewRecord } from '../../board/review-types.js';
import { withOldNotes } from './notes.js';
import { pastOf, stateOf } from './state.js';

/**
 * The review as people read it, the same on the board, in the terminal, in the pull request and in the merge commit:
 * each round with its notes and where each stands, and the counts.
 */

export interface NoteView extends Omit<ReviewNote, 'past'> {
  state: ReviewNoteState;
  round: number;
  past?: NonNullable<ReviewNote['past']>;
}

export interface RoundView {
  n: number;
  at: string;
  approved: boolean;
  notes: NoteView[];
  /** The Builder's fix after it, by squad-kit: short commits. */
  fix: string[];
}

export interface ReviewView {
  rounds: RoundView[];
  counts: { notes: number; fixed: number; past: number; open: number };
  /** Builder changes after review: the commits squad-kit saved for its fixes. */
  fixes: string[];
  looksRight?: ReviewRecord['looksRight'];
  /** Writing it into the pull request, as this computer last tried it. */
  posted?: ReviewPosted;
  /** Kept the old way: the latest notes as plain text, with no rounds, files or lines. */
  old: boolean;
  /** Its pull request can take the review again: the story has one. */
  canWrite: boolean;
  /** A note can still be gone past: the story is not accepted yet. */
  canPast: boolean;
}

export type ReviewTicket = Pick<Ticket, 'review' | 'reviewNotes' | 'reviewAsked' | 'reviewRound' | 'createdAt' | 'overrides' | 'reviewPosted' | 'pr' | 'stage'>;

export function reviewView(t: ReviewTicket): ReviewView {
  const record = withOldNotes(t);
  const rounds: RoundView[] = (record?.rounds ?? []).map((r) => ({
    n: r.n,
    at: r.at,
    approved: r.approved,
    fix: Object.values(r.fix ?? {}),
    notes: r.notes.map((note) => {
      const past = pastOf(t, r, note);
      const { past: _own, ...rest } = note;
      return { ...rest, round: r.n, state: stateOf(t, r, note), ...(past ? { past } : {}) };
    }),
  }));
  const notes = rounds.flatMap((r) => r.notes);
  const count = (s: ReviewNoteState) => notes.filter((n) => n.state === s).length;
  return {
    rounds,
    counts: { notes: notes.length, fixed: count('fixed'), past: count('past'), open: count('open') },
    fixes: rounds.flatMap((r) => r.fix),
    ...(record?.looksRight ? { looksRight: record.looksRight } : {}),
    ...(t.reviewPosted ? { posted: t.reviewPosted } : {}),
    old: Boolean(rounds.length && !t.review?.rounds.length),
    canWrite: Boolean(t.pr),
    canPast: t.stage !== 'release' && t.stage !== 'done',
  };
}

/** "4: 3 fixed, 1 you went past", "2: both fixed", "None". */
export function countWords(v: Pick<ReviewView, 'counts'>): string {
  const { notes, fixed, past, open } = v.counts;
  if (!notes) return 'None';
  const parts = [fixed ? `${fixed} fixed` : '', past ? `${past} you went past` : '', open ? `${open} open` : ''].filter(Boolean);
  return `${notes}: ${parts.join(', ')}`;
}

/** "2 commits", "1 commit", "None". */
export function commitWords(n: number): string {
  return n ? `${n} ${n === 1 ? 'commit' : 'commits'}` : 'None';
}
