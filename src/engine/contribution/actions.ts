import { addActivity, now, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket, WayOut } from '../../board/types.js';
import type { ContributionState, OwnerNote } from '../../board/contribution-types.js';
import { BoardActionError } from '../../board/actions/errors.js';
import { scheduleSquad } from '../../board/schedule.js';
import { fixWords, MOST_NOTES, OWNER_FIXING, OWNER_LEFT_CLOSED, OWNER_WAITS } from './words.js';

/**
 * The person's buttons on a pull request that went to someone else's repo, each one REST call and one terminal command
 * (docs/console.md): Fix these (the Builder fixes the owner's notes in a normal fix round), Answer them yourself, and
 * Leave it closed. Send it again is the stop card's Try again.
 */

function sent(t: Ticket): NonNullable<Ticket['contribution']> {
  if (!t.contribution || !t.pr) throw new BoardActionError(`${t.id} has no pull request in someone else's repo.`);
  return t.contribution;
}

/** The owner's notes on the story's pull request now that wait for the person. */
const waiting = (t: Ticket): OwnerNote[] => (t.contribution?.notes ?? []).filter((n) => n.state === 'new' && n.pr === t.pr?.id);

/**
 * Fix these: the owner's new notes go to the Builder, at most MOST_NOTES at once (the rest wait for the next round);
 * then the checks, the review and Looks right, and the fix goes out. Only the notes sent are marked as being fixed.
 */
export function fixThese(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  sent(t);
  const fresh = waiting(t).slice(0, MOST_NOTES);
  if (!fresh.length) throw new BoardActionError(`${t.id} has no notes from the owner waiting. squad pr ${t.id} shows them all.`);
  if (t.live || t.squad) throw new BoardActionError(`${t.id} is busy with a step now. Fix these once it is done.`);
  const ids = new Set(fresh.map((n) => n.id));
  return updateTicket(bp, id, (x) => {
    const cx = x.contribution!;
    cx.notes = (cx.notes ?? []).map((n): OwnerNote => (ids.has(n.id) ? { ...n, state: 'fixing' } : n));
    cx.state = 'fixing';
    cx.since = now();
    x.changeRequest = fixWords(fresh, cx.into);
    x.stuck?.options.forEach((o) => (o.chosen = o.do === 'owner-fix'));
    x.stuck = undefined;
    x.waiting = null;
    delete x.clock;
    x.stage = 'implement';
    x.live = true;
    x.status = OWNER_FIXING;
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    addActivity(x, 'you', `Fix these: the Builder fixes ${fresh.length === 1 ? "the owner's note" : `the owner's ${fresh.length} notes`}`);
    scheduleSquad(x, 'fix', 0.2, 1);
  });
}

/** Back to waiting for the owner, with nothing waiting on the person. */
function backToWaiting(x: Ticket, state: ContributionState, status: string): void {
  x.contribution!.state = state;
  x.contribution!.since = now();
  x.stuck = undefined;
  x.waiting = null;
  x.live = false;
  x.squad = null;
  x.retryPhase = undefined;
  x.status = status;
}

/** Answer them yourself: the notes stay with the person, on the code host, and the story waits for the owner again. */
export function leaveNotes(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  sent(t);
  const fresh = waiting(t);
  if (!fresh.length) throw new BoardActionError(`${t.id} has no notes from the owner waiting.`);
  const ids = new Set(fresh.map((n) => n.id));
  return updateTicket(bp, id, (x) => {
    x.contribution!.notes = (x.contribution!.notes ?? []).map((n): OwnerNote => (ids.has(n.id) ? { ...n, state: 'left', why: 'You answer it yourself.' } : n));
    backToWaiting(x, 'waiting', OWNER_WAITS);
    addActivity(x, 'you', `Answers the owner's ${fresh.length === 1 ? 'note' : `${fresh.length} notes`} on the pull request themselves. squad-kit waits for the owner again`);
  });
}

/** Leave it closed: the story ends here, not merged. */
export function leaveClosed(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  if (sent(t).state !== 'closed') throw new BoardActionError(`Pull request ${t.pr!.id} of ${t.id} is not closed.`);
  return updateTicket(bp, id, (x) => {
    backToWaiting(x, 'closed', OWNER_LEFT_CLOSED);
    addActivity(x, 'you', `Left pull request ${x.pr?.id ?? ''} closed. The work stays on the story's branch`);
  });
}

/** The ways out on the owner's cards, chosen on the stop card (`squad unstick`). Null for any other way out. */
export function ownerWay(bp: BoardPaths, id: string, way: WayOut | undefined): Ticket | null {
  if (way === 'owner-fix') return fixThese(bp, id);
  if (way === 'owner-leave') return leaveNotes(bp, id);
  if (way === 'leave-closed') return leaveClosed(bp, id);
  return null;
}
