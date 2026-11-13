import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions.js';
import type { ReviewPosted } from '../../board/review-types.js';
import { repoTarget, targetHost } from '../sync.js';
import { stateOf } from './state.js';
import { reviewView, type ReviewView } from './view.js';
import { writeReview } from './write.js';

/**
 * The person's two buttons on the review, each one REST call and one terminal command (docs/console.md): go past one
 * open note with a reason, and write the review into the pull request again.
 */

/**
 * Go past one open note: only the person can, before Looks right, and the reason stays on the record. A review that
 * stopped is gone past as a whole on its stop card (Continue anyway); this is for a note the Reviewer left open.
 */
export function goPast(bp: BoardPaths, id: string, n: number, reason: string): ReviewView {
  const why = reason.trim();
  if (!why) throw new BoardActionError('Write why you go past this note. It stays on the record, in the pull request too.');
  const t0 = requireTicket(bp, id);
  if (t0.stage === 'release' || t0.stage === 'done') throw new BoardActionError(`${t0.id} is accepted already, so its review is on the record as it was.`);
  const t = updateTicket(bp, id, (x) => {
    const round = x.review?.rounds.find((r) => r.notes.some((note) => note.n === n));
    const note = round?.notes.find((y) => y.n === n);
    if (!round || !note) throw new BoardActionError(`${x.id} has no review note ${n}. squad review ${x.id} lists them.`);
    const state = stateOf(x, round, note);
    if (state !== 'open') throw new BoardActionError(state === 'fixed' ? `Note ${n} is fixed already.` : `You went past note ${n} already.`);
    note.past = { by: readMeta(bp).user.name, reason: why, at: now() };
    addActivity(x, 'you', `Went past review note ${n}. Why: ${why}`);
  });
  return reviewView(t);
}

/**
 * Write it again: the Changes tab's button and `squad review <story> --write`. Only into a merged pull request, so a
 * thread can never hold a merge up; it adds the threads that are missing and leaves the others as people left them.
 */
export async function writeReviewAgain(bp: BoardPaths, id: string): Promise<ReviewPosted> {
  const t = requireTicket(bp, id);
  if (!t.pr) throw new BoardActionError(`${t.id} has no pull request: its review is in its merge commit and on the board.`);
  const target = repoTarget(bp, t);
  const host = target && targetHost(bp, target);
  if (!host) throw new BoardActionError(`${t.id}'s code host has no saved sign-in on this computer. Add it in Settings, then try again.`);
  if (!host.postReview) throw new BoardActionError(`${host.label} keeps the review in the pull request's description only.`);
  const state = await host.mergeState(t.pr.id);
  if (state === 'closed') throw new BoardActionError(`Pull request ${t.pr.id} was closed on ${host.label} without merging, so its review is not written there. It stays on the board.`);
  if (state !== 'merged') throw new BoardActionError(`Pull request ${t.pr.id} is not merged yet. squad-kit writes the review into it once it is merged, so nothing in it can hold the merge up.`);
  return (await writeReview(bp, id, host, t.pr))!;
}
