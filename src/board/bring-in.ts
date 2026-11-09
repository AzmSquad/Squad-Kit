import fs from 'node:fs';
import { addActivity, listTickets, now, readMeta, requireTicket, updateTicket, type BoardPaths } from './store.js';
import type { Ticket } from './types.js';
import { scheduleSquad } from './schedule.js';
import { git, isAncestor, remotes } from '../engine/git.js';
import { repoFor } from '../engine/repos.js';
import { copyViews } from '../engine/copies.js';

/**
 * A merge that clashes with newer work in the base, on any track: the squad brings the newest code into the story by
 * itself and runs the checks, the review and the proof again. On Builds by itself it is then accepted by itself; on the
 * other tracks the proof comes back to the person. The clash card is for when that did not help.
 */

/** Times the latest base comes in by itself after a merge clash, in all, before the person gets the clash card. */
export const MAX_BASE_TRIES = 3;

/** How often a story looks again at another one that is landing, and how long it waits for it at most. */
const LANDING_LOOK_MS = 15_000;
export const MAX_LANDING_WAIT_MS = 3 * 60_000;

/** How many times the latest base came in by itself. A ticket from before the count has only when it first did. */
function baseTries(t: Ticket): number {
  return t.selfAccept?.baseTries ?? (t.selfAccept?.baseTried ? 1 : 0);
}

/**
 * True when the base has work newer than what last came into this ticket: its tip here (work accepted on this computer)
 * or on the remote (the team's, as last fetched) is not in the ticket's branch. When git cannot say, it counts as moved,
 * and the count of tries still ends it.
 */
function baseMoved(bp: BoardPaths, story: Ticket): boolean {
  return copyViews(readMeta(bp), story).some((t) => oneBaseMoved(bp, t));
}

function oneBaseMoved(bp: BoardPaths, t: Ticket): boolean {
  if (!t.worktree || !t.branch || !fs.existsSync(t.worktree)) return true;
  try {
    const repo = repoFor(readMeta(bp), t);
    const remote = repo.remote || remotes(t.worktree)[0];
    return [repo.base, ...(remote ? [`refs/remotes/${remote}/${repo.base}`] : [])].some((ref) => {
      const tip = git(t.worktree!, ['rev-parse', '--verify', '-q', ref], { allowFail: true });
      return Boolean(tip) && tip !== t.baseCommit && !isAncestor(t.worktree!, tip, t.branch!);
    });
  } catch {
    return true;
  }
}

/**
 * The accepted change clashes with newer work in the base. The squad brings the latest base into the ticket's copy
 * itself (the Builder settles the clashing files) and runs the checks, the review and the proof again, up to
 * MAX_BASE_TRIES times in all, counted on the ticket so a restart does not start over. After the first time only when
 * the base moved since it last came in: bringing in the same base again would change nothing. Otherwise the usual clash
 * card stays, with its ways out. Only at the clash card.
 */
export function bringInAgain(bp: BoardPaths, id: string): Ticket {
  const t0 = requireTicket(bp, id);
  const moved = baseTries(t0) === 0 || baseMoved(bp, t0);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'stuck' || t.stuck?.gate !== 'merge') return;
    const tries = baseTries(t);
    if (tries >= MAX_BASE_TRIES) {
      addActivity(t, 'squad', `It still clashes after the newest code came in ${MAX_BASE_TRIES} times, so it waits for you`);
      return;
    }
    if (!moved) {
      addActivity(t, 'squad', `It still clashes, and the code has not moved since it last came in, so it waits for you`);
      return;
    }
    t.selfAccept = { ...t.selfAccept, baseTried: now(), baseTries: tries + 1 };
    t.waiting = null;
    t.stuck = undefined;
    t.retryPhase = undefined;
    t.stage = 'implement';
    t.live = true;
    t.status = `Bringing in the newest code`;
    const then = t.track === 'auto' ? '' : '. Then the proof comes back to you';
    addActivity(t, 'squad', `It clashes with newer changes, so squad-kit brings in the newest code and runs the checks, the review and the proof again (try ${tries + 1} of ${MAX_BASE_TRIES})${then}`);
    scheduleSquad(t, 'update-base', 0.2, 1);
  });
}

/**
 * Another story on the same repo that is at its merge step: about to accept itself, or its pull request merging. Its
 * name, or null. Those steps never wait for a story that is about to bring in the base, so two can never wait for each other.
 */
export function landingFirst(bp: BoardPaths, t: Ticket): string | null {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t).path;
  const other = listTickets(bp).find((o) => o.id !== t.id && (o.squad?.phase === 'accept' || o.squad?.phase === 'publish') && !o.waiting && !o.stopRequested && !o.deleting && !o.archived && repoFor(meta, o).path === repo);
  return other?.id ?? null;
}

/**
 * About to bring in the base while another story is landing: it waits for that one, or its base comes in without that
 * work, and the next merge clashes again after another round of checks. True while it waits: it looks again every few
 * seconds, MAX_LANDING_WAIT_MS at most. A restart keeps when it began.
 */
export function waitForLanding(bp: BoardPaths, id: string): boolean {
  const t = requireTicket(bp, id);
  const since = t.selfAccept?.landingSince;
  const going = landingFirst(bp, t);
  if (!going || (since && Date.now() - Date.parse(since) >= MAX_LANDING_WAIT_MS)) {
    if (since) updateTicket(bp, id, (x) => delete x.selfAccept?.landingSince);
    return false;
  }
  const base = repoFor(readMeta(bp), t).base;
  updateTicket(bp, id, (x) => {
    if (!since) {
      x.selfAccept = { ...x.selfAccept, landingSince: now() };
      addActivity(x, 'squad', `${going} is about to merge into ${base}, so this story waits for it, then brings in the newest code`);
    }
    x.status = `Waits for ${going} to merge, then brings in the newest code`;
    if (x.squad) x.squad.nextAt = new Date(Date.now() + LANDING_LOOK_MS).toISOString();
  });
  return true;
}
