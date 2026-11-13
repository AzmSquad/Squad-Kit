/**
 * A story of squad-kit's own code whose pull request went to the main repo (ADR-008): its owner merges it, never
 * squad-kit. squad-kit watches the pull request, brings the owner's notes back to the story, and answers each one its
 * fix really changed (engine/contribution).
 */

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
  /** The pull request it was written on: a new one after Send it again never answers an old note. */
  pr: number;
  /** A note on a line that answers another one: its thread's first note, where answers go. */
  thread?: string;
  /**
   * new: it waits for the person (Fix these, or Answer them yourself). fixing: the Builder works on it. fixed: git shows
   * the fix changed its lines, and squad-kit answered "Fixed in <commit>". left: the person answers it on the code host,
   * with why.
   */
  state: 'new' | 'fixing' | 'fixed' | 'left';
  /** The short commit that fixed it. */
  fixedIn?: string;
  /** squad-kit answered it on the code host. */
  answered?: boolean;
  /** Left: why squad-kit did not answer it, in plain words. */
  why?: string;
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
  /** The full commit last sent to the pull request: a fix round's changes are read from git against it. */
  sent?: string;
  /** The newest notes, at most 100. */
  notes?: OwnerNote[];
  /** Every note id ever seen on it, so an old one never comes back as new. */
  seen?: string[];
  /** The pull request whose clash in the owner's repo was said on the story, once. */
  clashTold?: number;
}

export interface TicketContribution {
  contribution?: Contribution;
}
