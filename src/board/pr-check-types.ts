import type { Gates } from './types.js';

/**
 * A check the code host failed on a story's own pull request, as squad-kit handles it by itself (engine/pr-checks.ts):
 * the Builder fixes the code, or names a job of the project's own that is the fix, and squad-kit merges once the checks
 * pass. Kept on this computer, like the rest of the merge.
 */
export interface PrCheck {
  pr: number;
  /** The pull request's newest commit when squad-kit last acted on a failed check: a new one is a new try. */
  sha: string;
  /** The failed checks, by name; where to see the first; the tests named as failed. */
  failed: string[];
  url?: string;
  tests?: string[];
  /** What the check printed that says why: for the Builder, and for engineers in the details. */
  log?: string;
  /** The Builder's rounds on this pull request's checks, and whether one runs now. */
  rounds: number;
  fixing?: boolean;
  /** The story's own copy's commit when the round began: the same after it, with nothing changed, means no code fix. */
  head?: string;
  /** The project's jobs a label starts on a pull request, offered to the Builder as a fix. */
  offered?: PullJobRef[];
  /** The project's job the Builder named as the fix, by its label: started once the fix is on the pull request. */
  job?: PullJobRef;
  /** The job squad-kit started, and on which commit: a new commit, or the job ending without one, moves it on. */
  started?: { label: string; sha: string; at: string };
  /** A newer commit on which the failed checks have not run again yet, since when: no merge before they pass there. */
  unrun?: { sha: string; at: string };
  /** The gates as they were before the Builder's round, back when the round changed nothing. */
  gates?: Gates;
  /** The card up now: 'fix', the check still fails after the Builder's rounds; 'held', another hold on the host. */
  card?: 'fix' | 'held';
}

/** One of the project's jobs a label starts on a pull request (modules/code-host PullJob). */
export interface PullJobRef {
  name: string;
  label: string;
  file: string;
  about: string;
}
