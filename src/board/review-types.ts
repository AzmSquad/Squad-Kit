/**
 * The review of a story as a record (ADR-007): every round of the Reviewer with its notes, each note's file and line,
 * where each note stands, and who pressed Looks right. It goes into the pull request, or the merge commit's message on a
 * project with no pull requests, and the story's review.md.
 */

/**
 * Where a note stands. open: nothing settled it yet. fixed: the Builder's fix of the round that asked for it changed the
 * lines it points at (squad-kit reads that from git), or the Reviewer's next round said so after its file changed; the
 * Reviewer's next round can reopen it. past: the person went on without it, with a reason on the record.
 */
export type ReviewNoteState = 'open' | 'fixed' | 'past';

export interface ReviewNote {
  /** Its number on the story, 1 up across every round: what `squad review MA-21 --past 3` names. */
  n: number;
  /** The file it is about, from the story's folder. None when it is about the whole change. */
  file?: string;
  /** The line in that file as the Reviewer read it. None when it is about the whole file. */
  line?: number;
  text: string;
  /**
   * Fixed: the commit of the Builder's round that fixed it (short), and who could tell, git or the Reviewer. checked: the
   * Reviewer's next round has seen a fix git found, and did not reopen it.
   */
  fixed?: { commit?: string; by: 'git' | 'reviewer'; checked?: boolean };
  /** A later Builder round changed its place (short commit), which only the Reviewer's next round can call fixed. */
  touched?: string;
  /** The person went on without it: who, why and when. */
  past?: { by: string; reason: string; at: string };
}

export interface ReviewRound {
  /** 1 up across the story: a story that comes back to review after Something's wrong goes on counting. */
  n: number;
  at: string;
  approved: boolean;
  notes: ReviewNote[];
  /** The work as the Reviewer read it, saved by squad-kit before the Builder's fix: a short commit per repo folder. */
  read?: Record<string, string>;
  /** The Builder's fix after this round, saved by squad-kit: a short commit per repo folder it changed. */
  fix?: Record<string, string>;
}

export interface ReviewRecord {
  rounds: ReviewRound[];
  /** Who pressed Looks right, and when. byItself: the squad accepted it on the Builds by itself track, not a person. */
  looksRight?: { by: string; at: string; byItself?: boolean };
}

/** The review's part of a ticket: board/types.ts Ticket extends it. */
export interface TicketReview {
  reviewRound?: number;
  /** The squad's review notes still to fix, passed to the Builder. */
  reviewNotes?: string[];
  /** The Reviewer's notes from its last round, shown to it again with the whole change in the next round. */
  reviewAsked?: string[];
  /** Every round of the Reviewer with its notes, and who pressed Looks right. */
  review?: ReviewRecord;
  /** Writing the review into the pull request, as this computer last tried it. */
  reviewPosted?: ReviewPosted;
}

/**
 * Where each lives (board/store.ts, ADR-001): the record goes with the project, in the story's review.md; the rest, and
 * what this computer last heard from the code host, stays on this computer.
 */
export const REVIEW_HOME = { reviewRound: 'local', reviewNotes: 'local', reviewAsked: 'local', review: 'project', reviewPosted: 'local' } as const satisfies Record<keyof TicketReview, 'project' | 'local'>;

/** Writing the review into the pull request, as this computer last tried it. A refusal never stops the merge. */
export interface ReviewPosted {
  at: string;
  ok: boolean;
  /** The pull request it went to. */
  pr: number;
  /** How many notes went in as threads on their files. */
  threads?: number;
  /** The code host's refusal, in plain words. */
  why?: string;
}
