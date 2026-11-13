import { addActivity, listTickets, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { OwnerNote } from '../../board/contribution-types.js';
import type { HostNote, RepoHost } from '../../modules/code-host/types.js';
import { isMine } from '../../board/owner.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import { repoTarget, targetHost } from '../sync.js';
import { writeReview } from '../review-record/write.js';
import { answerFixed } from './send.js';
import { closedOptions, noteLine, notesOptions, OWNER_CLOSED, OWNER_MERGED, OWNER_NOTES } from './words.js';
import { catchUpAfterMerge } from './catch-up.js';

/**
 * squad-kit watches a pull request it sent to someone else's repo: now and then by itself, beside the work, and when the
 * person presses Check again. The owner merged it: the story is done. Closed without merging: the story says so, with
 * ways out. New notes from the owner: the story waits for the person, with Fix these.
 */

export interface OwnerLook {
  found: 'merged' | 'closed' | 'notes' | 'open' | 'none';
  line: string;
}

/** Sent and still open as far as the board knows, and nothing is being fixed for it now. */
export function watched(t: Ticket): boolean {
  const c = t.contribution;
  return Boolean(c && t.pr && (c.state === 'waiting' || c.state === 'notes') && !t.live && !t.squad && !t.deleting && !t.archived && !t.mergedAt);
}

const asNote = (n: HostNote): OwnerNote => ({ ...n, state: 'new' });

/** Keeps the owner's notes not seen before; the story waits for the person when there are any. The number added. */
function takeNotes(bp: BoardPaths, id: string, found: HostNote[], label: string): number {
  let added = 0;
  updateTicket(bp, id, (x) => {
    const c = x.contribution;
    if (!c) return;
    const seen = new Set((c.notes ?? []).map((n) => n.id));
    const fresh = found.filter((n) => !seen.has(n.id)).map(asNote);
    added = fresh.length;
    // At most the last 100, so a long talk never grows the story's file for good.
    if (fresh.length) c.notes = [...(c.notes ?? []), ...fresh].slice(-100);
    const open = (c.notes ?? []).filter((n) => n.state === 'new');
    if (!open.length || c.state === 'fixing') return;
    if (fresh.length) addActivity(x, 'release', `${fresh.length === 1 ? 'The owner left a note' : `The owner left ${fresh.length} notes`} on pull request ${x.pr?.id ?? ''} in ${c.into}`);
    c.state = 'notes';
    const changes = open.some((n) => n.changes);
    x.status = OWNER_NOTES;
    x.stuck = {
      kind: 'owner-notes',
      question: `${open.length === 1 ? 'The owner left a note' : `The owner left ${open.length} notes`} on pull request ${x.pr?.id ?? ''}${changes ? ' and asked for changes' : ''}. squad-kit can have the Builder fix them, then send the fix to the same pull request.`,
      points: open.map(noteLine),
      options: notesOptions(label),
    };
    x.waiting = { kind: 'stuck', summary: 'The owner asked for changes on the pull request' };
  });
  return added;
}

/** The owner merged it: the story is done here. The person's copy and checkout catch up when they only fell behind. */
async function mergedByOwner(bp: BoardPaths, id: string, host: RepoHost, pr: { id: number }): Promise<void> {
  updateTicket(bp, id, (x) => {
    if (x.mergedAt || !x.contribution) return;
    x.mergedAt = now();
    x.contribution.state = 'merged';
    x.contribution.since = now();
    clearStaleStop(x);
    x.live = false;
    x.squad = null;
    x.status = OWNER_MERGED;
    addActivity(x, 'release', `${x.contribution.into} merged pull request ${pr.id}. Merged by the owner: the story is done`);
  });
  await catchUpAfterMerge(bp, id).catch(() => undefined);
  // Merged now, so the review's threads go in, as for any merged pull request (ADR-007).
  await writeReview(bp, id, host, pr);
}

function closedByOwner(bp: BoardPaths, id: string, pr: { id: number }): void {
  updateTicket(bp, id, (x) => {
    const c = x.contribution;
    if (!c || c.state === 'closed') return;
    c.state = 'closed';
    c.since = now();
    x.live = false;
    x.squad = null;
    x.retryPhase = 'publish';
    x.status = OWNER_CLOSED;
    x.stuck = { kind: 'owner-closed', question: `${c.into} closed pull request ${pr.id} without merging it. Nothing here changed: the work stays on the story's branch and in its copy.`, options: closedOptions() };
    x.waiting = { kind: 'stuck', summary: 'The owner closed the pull request without merging' };
    addActivity(x, 'release', `${c.into} closed pull request ${pr.id} without merging it`);
  });
}

/** One look at the pull request: merged, closed, or new notes from the owner. */
export async function lookAtContribution(bp: BoardPaths, id: string): Promise<OwnerLook> {
  const t = requireTicket(bp, id);
  const c = t.contribution;
  const pr = t.pr;
  if (!c || !pr) return { found: 'none', line: `${t.id} has no pull request in someone else's repo.` };
  if (c.state === 'merged') return { found: 'merged', line: `${c.into} merged pull request ${pr.id} already.` };
  const target = repoTarget(bp, t);
  const host = target && targetHost(bp, target);
  if (!host) return { found: 'none', line: `squad-kit is not signed in to the code host on this computer, so it cannot look at pull request ${pr.id}. The Tools page has the steps.` };
  const state = await host.mergeState(pr.id);
  updateTicket(bp, id, (x) => {
    if (x.contribution) x.contribution.lookedAt = now();
  });
  if (state === 'merged') {
    await mergedByOwner(bp, id, host, pr);
    return { found: 'merged', line: `${c.into} merged pull request ${pr.id}. ${t.id} is done.` };
  }
  if (state === 'closed') {
    closedByOwner(bp, id, pr);
    return { found: 'closed', line: `${c.into} closed pull request ${pr.id} without merging it, so ${t.id} waits for you with ways out.` };
  }
  // A fix whose answers did not get through is answered now.
  const unanswered = (c.notes ?? []).filter((n) => n.state === 'fixed' && !n.answered);
  if (unanswered.length) {
    const done = await answerFixed(host, pr.id, unanswered, '');
    updateTicket(bp, id, (x) => x.contribution?.notes?.forEach((n) => done.has(n.id) && (n.answered = true)));
  }
  const added = takeNotes(bp, id, (await host.ownerNotes?.(pr.id)) ?? [], host.label);
  if (added) return { found: 'notes', line: `${added === 1 ? 'The owner left a note' : `The owner left ${added} notes`} on pull request ${pr.id}, so ${t.id} waits for you: Fix these, or answer them yourself.` };
  return { found: 'open', line: `Pull request ${pr.id} is still open in ${c.into}, waiting for its owner. Nothing new.` };
}

/* ── the look by itself ─────────────────────────────── */

export const LOOK_MS = 3 * 60_000;
const looks = new Map<string, { at: number; busy: boolean }>();

/** Every watched story of this computer, one call after another. A problem waits for the next look. */
export async function lookAtContributions(bp: BoardPaths): Promise<string[]> {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return [];
  const asked: string[] = [];
  for (const t of listTickets(bp)) {
    if (!watched(t) || !isMine(t, meta)) continue;
    asked.push(t.id);
    await lookAtContribution(bp, t.id).catch(() => undefined);
  }
  return asked;
}

/** On each turn of the live squad: when it is time, one look runs beside the work. It never waits and never throws. */
export function lookAtContributionsBeside(bp: BoardPaths, at = Date.now()): void {
  const l = looks.get(bp.squadDir) ?? { at: 0, busy: false };
  looks.set(bp.squadDir, l);
  if (l.busy || at < l.at) return;
  l.busy = true;
  lookAtContributions(bp)
    .catch(() => undefined)
    .finally(() => {
      l.busy = false;
      l.at = Date.now() + LOOK_MS;
    });
}
