import { addActivity, listTickets, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { OwnerNote } from '../../board/contribution-types.js';
import type { HostNote } from '../../modules/code-host/types.js';
import { isMine } from '../../board/owner.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import { repoTarget, targetHost } from '../sync.js';
import { answerFixed } from './send.js';
import { closedOptions, noteLine, notesOptions, OWNER_CLOSED, OWNER_MERGED, OWNER_NOTES, OWNER_WAITS } from './words.js';
import { catchUpAfterMerge } from './catch-up.js';

/**
 * squad-kit watches a pull request its own code sent to the main repo: now and then by itself, beside the work, and
 * when the person presses Check again. The owner merged it: the story is done. Closed without merging: the story says
 * so, with ways out, and opened again it waits again. A clash there is said once, with what to do. New notes from the
 * owner: the story waits for the person, with Fix these.
 */

interface OwnerLook {
  found: 'merged' | 'closed' | 'notes' | 'open' | 'none';
  line: string;
}

/** Most note ids kept as seen: far more than any pull request gets. */
const MOST_SEEN = 5000;

/** The owner's card for a closed pull request is up: it may be opened again. */
const closedCard = (t: Ticket) => t.contribution?.state === 'closed' && t.waiting?.kind === 'stuck' && t.stuck?.kind === 'owner-closed';

/** Sent and not settled as far as the board knows, and nothing is being fixed or sent for it now. */
function watched(t: Ticket): boolean {
  const c = t.contribution;
  const open = c?.state === 'waiting' || c?.state === 'notes' || closedCard(t);
  return Boolean(c && t.pr && open && !t.live && !t.squad && !t.deleting && !t.archived && !t.mergedAt);
}

/** Why squad-kit does not look at it now, in one line. */
function notWatched(t: Ticket): string {
  const c = t.contribution;
  if (!c || !t.pr) return `${t.id} has no pull request in someone else's repo.`;
  if (c.state === 'merged' || t.mergedAt) return `${c.into} merged pull request ${t.pr.id} already.`;
  if (c.state === 'closed') return `Pull request ${t.pr.id} is closed, and you left it closed.`;
  return `The Builder is working on ${t.id} now. squad-kit looks at pull request ${t.pr.id} again once the fix is sent.`;
}

const asNote = (n: HostNote, pr: number): OwnerNote => ({ ...n, pr, state: 'new' });

/** Keeps the owner's notes not seen before; the story waits for the person while any of this pull request's are new. */
function takeNotes(bp: BoardPaths, id: string, found: HostNote[], label: string): number {
  let added = 0;
  updateTicket(bp, id, (x) => {
    const c = x.contribution;
    const pr = x.pr?.id;
    if (!c || !pr) return;
    const seen = new Set([...(c.seen ?? []), ...(c.notes ?? []).map((n) => n.id)]);
    const fresh = found.filter((n) => !seen.has(n.id)).map((n) => asNote(n, pr));
    added = fresh.length;
    if (fresh.length) {
      c.seen = [...seen, ...fresh.map((n) => n.id)].slice(-MOST_SEEN);
      // The newest 100 are kept to show; the seen list above keeps every older one from coming back.
      c.notes = [...(c.notes ?? []), ...fresh].slice(-100);
      addActivity(x, 'release', `${fresh.length === 1 ? 'The owner left a note' : `The owner left ${fresh.length} notes`} on pull request ${pr} in ${c.into}`);
    }
    const open = (c.notes ?? []).filter((n) => n.state === 'new' && n.pr === pr);
    if (!open.length || c.state === 'fixing') return;
    c.state = 'notes';
    const changes = open.some((n) => n.changes);
    x.status = OWNER_NOTES;
    x.stuck = {
      kind: 'owner-notes',
      question: `${open.length === 1 ? 'The owner left a note' : `The owner left ${open.length} notes`} on pull request ${pr}${changes ? ' and asked for changes' : ''}. squad-kit can have the Builder fix them, then send the fix to the same pull request.`,
      points: open.map(noteLine),
      options: notesOptions(label),
    };
    x.waiting = { kind: 'stuck', summary: 'The owner asked for changes on the pull request' };
  });
  return added;
}

/** The owner merged it: the story is done here. The person's copy and checkout catch up when they only fell behind. */
async function mergedByOwner(bp: BoardPaths, id: string, pr: { id: number }): Promise<void> {
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
  // The review is in the pull request's text already: squad-kit writes no threads into the owner's repo (ADR-008).
  await catchUpAfterMerge(bp, id).catch(() => undefined);
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

/** Closed, then opened again by the owner: it waits for them again, and the card goes. */
function openedAgain(bp: BoardPaths, id: string, pr: { id: number }): void {
  updateTicket(bp, id, (x) => {
    const c = x.contribution;
    if (!c || c.state !== 'closed') return;
    c.state = 'waiting';
    c.since = now();
    clearStaleStop(x);
    x.retryPhase = undefined;
    x.status = OWNER_WAITS;
    addActivity(x, 'release', `${c.into} opened pull request ${pr.id} again. It waits for the owner to merge it`);
  });
}

/** A clash with newer work in the owner's repo: said once per pull request, with what to do. */
function clashTold(bp: BoardPaths, id: string, pr: { id: number }): void {
  updateTicket(bp, id, (x) => {
    const c = x.contribution;
    if (!c || c.clashTold === pr.id) return;
    c.clashTold = pr.id;
    addActivity(x, 'release', `Pull request ${pr.id} clashes with newer work in ${c.into}. Bring your copy up to date (squad contribute --sync), then bring the newest code into the story (squad bring-in ${x.id}): the fix goes to the same pull request`);
  });
}

/** One look at the pull request: merged, closed or opened again, a clash, or new notes from the owner. */
export async function lookAtContribution(bp: BoardPaths, id: string): Promise<OwnerLook> {
  const t = requireTicket(bp, id);
  if (!watched(t)) return { found: 'none', line: notWatched(t) };
  const c = t.contribution!;
  const pr = t.pr!;
  const target = repoTarget(bp, t);
  const host = target && targetHost(bp, target);
  if (!host) return { found: 'none', line: `squad-kit is not signed in to the code host on this computer, so it cannot look at pull request ${pr.id}. The Tools page has the steps.` };
  const state = await host.mergeState(pr.id);
  updateTicket(bp, id, (x) => {
    if (x.contribution) x.contribution.lookedAt = now();
  });
  if (state === 'merged') {
    await mergedByOwner(bp, id, pr);
    return { found: 'merged', line: `${c.into} merged pull request ${pr.id}. ${t.id} is done.` };
  }
  if (state === 'closed') {
    closedByOwner(bp, id, pr);
    return { found: 'closed', line: `${c.into} closed pull request ${pr.id} without merging it, so ${t.id} waits for you with ways out.` };
  }
  if (c.state === 'closed') openedAgain(bp, id, pr);
  if (state === 'clash') clashTold(bp, id, pr);
  // A fix whose answers did not get through is answered now; one whose comment is gone is left, with why.
  const unanswered = (c.notes ?? []).filter((n) => n.state === 'fixed' && !n.answered && n.pr === pr.id);
  if (unanswered.length) {
    const { answered, gone } = await answerFixed(host, pr.id, unanswered);
    updateTicket(bp, id, (x) =>
      x.contribution?.notes?.forEach((n) => {
        if (answered.has(n.id)) n.answered = true;
        const why = gone.get(n.id);
        if (why) Object.assign(n, { state: 'left', why });
      }),
    );
  }
  const added = takeNotes(bp, id, (await host.ownerNotes?.(pr.id)) ?? [], host.label);
  if (added) return { found: 'notes', line: `${added === 1 ? 'The owner left a note' : `The owner left ${added} notes`} on pull request ${pr.id}, so ${t.id} waits for you: Fix these, or answer them yourself.` };
  if (state === 'clash') return { found: 'open', line: `Pull request ${pr.id} clashes with newer work in ${c.into}. Bring your copy up to date (squad contribute --sync), then the newest code into the story (squad bring-in ${t.id}).` };
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
