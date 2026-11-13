/**
 * A story whose pull request went to someone else's repo: the one the project's repo was copied from (a fork), or the
 * main repo of squad-kit's own code. Its owner merges it, never squad-kit; squad-kit watches the pull request, brings
 * the owner's notes back to the story, and answers each one it fixed (engine/contribution).
 */

/**
 * Where an owner's note stands. new: it waits for the person (Fix these, or Answer them yourself). fixing: the Builder
 * works on it. fixed: the fix is in the pull request, and the note was answered "Fixed in <commit>". left: the person
 * answers it on the code host themselves.
 */
export type OwnerNoteState = 'new' | 'fixing' | 'fixed' | 'left';

export interface OwnerNote {
  /** The code host's own id, with its kind: "line:123". */
  id: string;
  kind: 'line' | 'review' | 'comment';
  who: string;
  /** The owner's own words, as they wrote them. */
  text: string;
  file?: string;
  line?: number;
  url: string;
  at: string;
  /** A review that asked for changes. */
  changes?: boolean;
  state: OwnerNoteState;
  /** The short commit that fixed it, once the fix is in the pull request. */
  fixedIn?: string;
  /** squad-kit answered it on the code host. */
  answered?: boolean;
}

/**
 * waiting: for the owner to merge. notes: the owner wrote notes, which wait for the person. fixing: the Builder fixes
 * them. merged: the owner merged it. closed: the owner closed it without merging.
 */
export type ContributionState = 'waiting' | 'notes' | 'fixing' | 'merged' | 'closed';

export interface Contribution {
  /** "owner/name" of the repo the pull request went to. */
  into: string;
  /** Its branch the pull request goes into. */
  base: string;
  state: ContributionState;
  /** When it went into this state. */
  since: string;
  /** When squad-kit last asked the code host about it. */
  lookedAt?: string;
  notes?: OwnerNote[];
}

export interface TicketContribution {
  contribution?: Contribution;
}
