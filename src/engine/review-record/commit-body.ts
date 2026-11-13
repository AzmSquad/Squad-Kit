import { now, readMeta, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { ReviewRecord } from '../../board/review-types.js';
import { commitWords, countWords, reviewView } from './view.js';
import { approvalWords, oneLine, reasonWords, stateWords } from './words.js';

/**
 * A project with no pull requests keeps the review in the merge commit (ADR-007): the short form, one line per note,
 * under the commit's title. The board keeps the whole record.
 */

type LooksRight = NonNullable<ReviewRecord['looksRight']>;

/** Who pressed Looks right now: the person on this board, or the squad itself on the Builds by itself track. */
export function looksRightNow(bp: BoardPaths, byItself?: string): LooksRight {
  return byItself ? { by: 'squad-kit', at: now(), byItself: true } : { by: readMeta(bp).user.name, at: now() };
}

/** Kept on the story with its review. */
export function noteLooksRight(t: Ticket, ok: LooksRight): void {
  t.review = { rounds: t.review?.rounds ?? [], looksRight: ok };
}

/** The merge commit's body: the review in short, each note with where it stands, and who pressed Looks right. */
export function reviewCommitBody(t: Ticket, ok: LooksRight | undefined = t.review?.looksRight): string {
  const v = reviewView(t);
  const lines: string[] = [];
  if (v.rounds.length) {
    lines.push(`Review: ${v.rounds.length} ${v.rounds.length === 1 ? 'round' : 'rounds'}. Notes ${countWords(v)}. Builder changes after review: ${commitWords(v.fixes.length)}.`);
    for (const n of v.rounds.flatMap((r) => r.notes)) {
      lines.push(`- ${stateWords(n)}: ${oneLine(n, 110)}${n.state === 'past' ? ` ${reasonWords(n)}` : ''}`);
    }
  }
  if (ok) lines.push(approvalWords(ok));
  return lines.join('\n');
}

/** The commit message with the review under it, when there is one. */
export function withReviewBody(title: string, t: Ticket, ok?: LooksRight): string {
  const body = reviewCommitBody(t, ok);
  return body ? `${title}\n\n${body}` : title;
}
