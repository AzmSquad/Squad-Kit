import type { Ticket } from './types.js';

/**
 * True when a ticket's stop is an old record: the ticket has passed review (accepted, merged or released), so it is past
 * that stop. A stop on an accepted ticket that is not merged yet, while it waits for the person, may be a real one: the
 * pull request did not open. The checks, the review and the proof are behind it all the same.
 */
export function oldStop(t: Pick<Ticket, 'stuck' | 'stage' | 'mergedAt' | 'waiting'>): boolean {
  if (!t.stuck) return false;
  if (t.stage === 'done' || t.mergedAt) return true;
  if (t.stage !== 'release') return false;
  return t.waiting?.kind !== 'stuck' || ['checks', 'review', 'proof'].includes(t.stuck.gate ?? '');
}

/**
 * A step that stopped earlier passed now (the checks, the review, the proof or the merge): its old stop goes, with
 * its waiting state, so a ticket that went on never carries a stop it is past. The person's choice on it is already
 * in the activity. Changes `t` in place (inside an update).
 */
export function clearStaleStop(t: Ticket): void {
  if (t.stuck) t.stuck = undefined;
  if (t.waiting?.kind === 'stuck') t.waiting = null;
}
