import { addActivity, listReleases, listTickets, readMeta, readTicket, requireTicket, updateTicket, writeRelease, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { BoardActionError, ensureDraftRelease, pullRequestClashed } from '../board/actions.js';
import { chooseBuild, isMerged, unmergedDeps, wakeIfReady } from '../board/depends.js';
import { afterPullRequest, mergeWait } from '../board/auto.js';
import { clearStaleStop } from '../board/stale-stop.js';
import { isMine } from '../board/owner.js';
import { repoHostFor } from '../modules/registry.js';
import type { RepoHost } from '../modules/code-host/types.js';
import { followBase, localSetupFor, mapAfterMerge, opensPullRequest, recheckMerge, repoTarget, trackerMerged } from './sync.js';
import { fetchBase } from './handover.js';
import { writeReview } from './review-record/write.js';

/**
 * A pull request squad-kit opened can be merged on the code host by a person, outside squad-kit: after they settled its
 * clash there, or as its approver. squad-kit asks the code host about each one it still has open, when the person presses
 * Check again and by itself now and then, and records a merge it finds the way it records its own: merged, in the next
 * release, the person's checkout moved, the tracker item resolved. The stories that wait for it go on. One closed
 * without merging gets one plain line and nothing else. With no code host (merges on this computer) there is nothing to ask.
 */

type PrRef = NonNullable<Ticket['pr']>;

/** What a look at the code host found. 'none': there was nothing to ask it about. */
export type HostLook = 'merged' | 'open' | 'clash' | 'closed' | 'none';

/** What Check again found, with one plain line for the toast and the terminal. */
export interface MergeCheck {
  found: HostLook;
  line: string;
  /** The stories this look found merged. */
  merged: string[];
  ticket: Ticket;
}

/** How often squad-kit asks by itself, and how soon after the board opens a project it asks first. */
export const OUTSIDE_LOOK_MS = 5 * 60_000;
export const FIRST_LOOK_MS = 5_000;

/** On the clash card: the accepted change clashes with newer work in the base. */
function onClashCard(t: Ticket): boolean {
  return t.waiting?.kind === 'stuck' && t.stuck?.gate === 'merge';
}

/** Nothing runs on it now, and it is still on the board, not merged. */
function still(t: Ticket): boolean {
  return !t.live && !t.squad && !t.deleting && !t.archived && !isMerged(t);
}

/** The pull request squad-kit opened for the story, open as far as the board knows. */
function openPr(t: Ticket): PrRef | null {
  if (!still(t)) return null;
  if (t.stage === 'release' && t.pr) return t.pr;
  return onClashCard(t) ? (t.clashedPr ?? null) : null;
}

/** A clash card from before squad-kit kept the pull request: it may still have one, found by the story's branch. */
function mayHaveClashedPr(bp: BoardPaths, t: Ticket): boolean {
  return onClashCard(t) && still(t) && !t.clashedPr && Boolean(t.branch) && opensPullRequest(bp, t);
}

/** That pull request, found by the branch once and kept on the ticket, so later looks ask about it straight away. */
async function clashedByBranch(bp: BoardPaths, t: Ticket, host: RepoHost): Promise<PrRef | null> {
  if (!mayHaveClashedPr(bp, t) || !host.lastPullRequest) return null;
  const found = await host.lastPullRequest(t.branch!);
  if (!found) return null;
  const pr = { id: found.id, url: found.url, repo: host.repo, host: host.host };
  updateTicket(bp, t.id, (x) => {
    if (onClashCard(x) && !x.clashedPr) x.clashedPr = pr;
  });
  return pr;
}

/**
 * The code host merged it: recorded here as squad-kit records its own merge. False when it was merged here meanwhile.
 * A clash had taken it out of the release and kept the tracker item where it was: it goes back into the next release,
 * and the item moves to resolved.
 */
async function recordMerged(bp: BoardPaths, id: string, pr: PrRef, host: RepoHost, target: { dir: string; base: string; remote: string }): Promise<boolean> {
  const moved = await followBase(bp, id, target, host);
  const t0 = requireTicket(bp, id);
  if (isMerged(t0)) return false;
  const clash = onClashCard(t0);
  const draft = t0.release ? null : ensureDraftRelease(bp, t0.kind === 'bug' ? 'patch' : 'minor');
  let done = false;
  updateTicket(bp, id, (x) => {
    if (isMerged(x)) return;
    done = true;
    x.mergedAt = new Date().toISOString();
    // Merged: the clash card it waited at is over.
    clearStaleStop(x);
    x.retryPhase = undefined;
    x.stage = 'release';
    x.pr = pr;
    delete x.clashedPr;
    delete x.prClosed;
    x.release = x.release ?? draft?.version;
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    const ls = moved ? localSetupFor(bp, x) : undefined;
    if (ls) x.localSetup = ls;
    x.status = `Merged into ${target.base} · goes out in ${x.release ?? 'the next release'}`;
    addActivity(x, 'release', `Pull request ${pr.id} was merged on ${host.label}. squad-kit saw it and marked the story as merged`);
  });
  if (!done) return false;
  if (draft) {
    const r = listReleases(bp).find((v) => v.version === draft.version) ?? draft;
    if (!r.tickets.includes(id)) writeRelease(bp, { ...r, tickets: [...r.tickets, id] });
  }
  mapAfterMerge(bp);
  // Its owner's computer tells the tracker, as it would have for its own merge.
  if (clash && isMine(t0, readMeta(bp))) await trackerMerged(bp, id, pr, target.base);
  // Merged now, so the review's threads can go in: nothing in them can hold the merge up any more.
  await writeReview(bp, id, host, pr);
  return true;
}

function closedLine(pr: PrRef, host: RepoHost, base: string): string {
  return `Pull request ${pr.id} was closed on ${host.label} without merging, so it is not in ${base}. squad-kit changed nothing else: open the pull request again there to go on`;
}

/** Closed without merging: one line on the story, once. */
function saidClosed(bp: BoardPaths, id: string, pr: PrRef, host: RepoHost, base: string): void {
  updateTicket(bp, id, (x) => {
    if (x.prClosed === pr.id) return;
    x.prClosed = pr.id;
    addActivity(x, 'release', closedLine(pr, host, base));
  });
}

/** The clash card now, the way the live squad gives it: the newest code comes in by itself first. */
async function clashCardNow(bp: BoardPaths, id: string): Promise<void> {
  await fetchBase(bp, pullRequestClashed(bp, id));
  afterPullRequest(bp, id, true);
}

/**
 * The person pressed Check again on a story with a pull request of its own: the code host is asked now, and every answer
 * gets a line. Null when the story has nothing of its own to ask about.
 */
async function checkOwn(bp: BoardPaths, t: Ticket): Promise<Omit<MergeCheck, 'ticket'> | null> {
  const wait = mergeWait(t);
  if (wait) return checkWait(bp, t, wait);
  if (!openPr(t) && !mayHaveClashedPr(bp, t)) return null;
  const target = repoTarget(bp, t);
  const host = target && repoHostFor(bp, target.url);
  if (!target || !host) return { found: 'none', line: `${t.id}'s code host has no saved sign-in on this computer, so squad-kit cannot ask it. Add it in Settings, then check again.`, merged: [] };
  const pr = openPr(t) ?? (await clashedByBranch(bp, t, host));
  if (!pr) return mayHaveClashedPr(bp, t) ? { found: 'none', line: `squad-kit found no pull request of ${t.id} on ${host.label}, so there is nothing to ask about. Pick a way out on the card.`, merged: [] } : null;
  const state = await host.mergeState(pr.id);
  const base = target.base;
  if (state === 'merged') {
    const merged = await recordMerged(bp, t.id, pr, host, target);
    return { found: 'merged', line: `Pull request ${pr.id} was merged on ${host.label}. squad-kit saw it and marked ${t.id} as merged.`, merged: merged ? [t.id] : [] };
  }
  if (state === 'closed') {
    saidClosed(bp, t.id, pr, host, base);
    return { found: 'closed', line: `${closedLine(pr, host, base)}.`, merged: [] };
  }
  // Open again after it was closed: the quiet look asks about it again too.
  if (t.prClosed === pr.id) updateTicket(bp, t.id, (x) => delete x.prClosed);
  if (state === 'clash') {
    if (onClashCard(t)) return { found: 'clash', line: `Pull request ${pr.id} still clashes with ${base} on ${host.label}. Settle the clash there and merge it, or pick a way out on the card.`, merged: [] };
    await clashCardNow(bp, t.id);
    return { found: 'clash', line: `Pull request ${pr.id} clashes with newer work in ${base}, so ${t.id} waits for you with ways out.`, merged: [] };
  }
  return { found: 'open', line: `Pull request ${pr.id} is still open on ${host.label}, not merged yet. Nothing changed.`, merged: [] };
}

/** A merge the squad looks at again by itself (board/auto.ts mergeWait), looked at now. */
async function checkWait(bp: BoardPaths, t: Ticket, wait: 'pr' | 'checkout'): Promise<Omit<MergeCheck, 'ticket'>> {
  const base = repoTarget(bp, t)?.base ?? 'main';
  const r = await recheckMerge(bp, t.id);
  if (r === 'merged') return { found: 'merged', line: `${readTicket(bp, t.id)?.activity[0]?.text ?? `${t.id} is merged`}.`, merged: [t.id] };
  if (r === 'clash') {
    await clashCardNow(bp, t.id);
    return { found: 'clash', line: `${t.pr ? `Pull request ${t.pr.id}` : t.id} clashes with newer work in ${base}, so ${t.id} waits for you with ways out.`, merged: [] };
  }
  const target = repoTarget(bp, t);
  const host = target && repoHostFor(bp, target.url);
  if (r === 'closed' && t.pr && host) {
    saidClosed(bp, t.id, t.pr, host, base);
    return { found: 'closed', line: `${closedLine(t.pr, host, base)}.`, merged: [] };
  }
  if (wait === 'pr') return { found: 'open', line: `Pull request ${t.pr?.id ?? ''} is still open${host ? ` on ${host.label}` : ''}, waiting for someone to approve it. Nothing changed.`, merged: [] };
  return { found: 'open', line: `Your own copy of ${base} still has changes in the same files. Save or undo them there, and ${t.id} goes in by itself.`, merged: [] };
}

/**
 * Everything the story waited for is merged now: it goes on, as it would on the squad's next turn. One at the card that
 * asks how to build has nothing to choose any more, so it builds on the newest code. Only the owner's computer starts it.
 */
function goOn(bp: BoardPaths, id: string): boolean {
  const t = readTicket(bp, id);
  if (!t || t.deleting || unmergedDeps(bp, t).length || !isMine(t, readMeta(bp))) return false;
  if (t.waiting?.kind === 'depends') {
    chooseBuild(bp, id, 'wait');
    return true;
  }
  return wakeIfReady(bp, t);
}

/**
 * Check again (`squad check-merge <ticket>`): asks the code host now about the story's own pull request (open, waiting
 * for its approver, or at the clash card), or about the pull requests of the stories it waits for. A merge found there is
 * recorded, and what waited for it goes on.
 */
export async function checkMerge(bp: BoardPaths, id: string): Promise<MergeCheck> {
  const t = requireTicket(bp, id);
  if (readMeta(bp).engine !== 'live') throw new BoardActionError('The sample board has no code host, so there is nothing to check.');
  if (isMerged(t)) return { found: 'merged', line: `${t.id} is merged already.`, merged: [], ticket: t };
  const own = await checkOwn(bp, t);
  if (own) return { ...own, ticket: requireTicket(bp, id) };
  const deps = unmergedDeps(bp, t);
  if (!deps.length) throw new BoardActionError(`${t.id} has no pull request waiting and waits for no other story, so there is nothing to check.`);
  const lines: string[] = [];
  const merged: string[] = [];
  let found: HostLook = 'merged';
  for (const d of deps) {
    const r = (await checkOwn(bp, d)) ?? { found: 'none' as const, line: `${d.id} is not merged yet, and it has no pull request on the code host to ask about.`, merged: [] };
    lines.push(r.line);
    merged.push(...r.merged);
    if (r.found !== 'merged' && found === 'merged') found = r.found;
  }
  if (goOn(bp, id)) lines.push(`${t.id} starts now, on the newest code.`);
  return { found, line: lines.join(' '), merged, ticket: requireTicket(bp, id) };
}

/* ── The quiet look by itself ─────────────────────────── */

const looks = new Map<string, { at: number; busy: boolean }>();
/** Old clash cards whose pull request was not found by the branch: not asked about again while this board runs. */
const notFound = new Set<string>();

/** The board opened the project: the first quiet look comes in a few seconds. */
export function lookOutsideSoon(bp: BoardPaths, at = Date.now()): void {
  const l = looks.get(bp.squadDir);
  if (l) l.at = Math.min(l.at, at + FIRST_LOOK_MS);
  else looks.set(bp.squadDir, { at: at + FIRST_LOOK_MS, busy: false });
}

/**
 * On each turn of the live squad: when it is time, one quiet look runs beside the work. It never waits, never throws,
 * and the next one comes OUTSIDE_LOOK_MS after it ends.
 */
export function lookOutsideBeside(bp: BoardPaths, at = Date.now()): void {
  if (!looks.has(bp.squadDir)) lookOutsideSoon(bp, at);
  const l = looks.get(bp.squadDir)!;
  if (l.busy || at < l.at) return;
  l.busy = true;
  lookOutside(bp)
    .catch(() => undefined)
    .finally(() => {
      l.busy = false;
      l.at = Date.now() + OUTSIDE_LOOK_MS;
    });
}

/**
 * The quiet look: one call to the code host per open pull request of this computer's stories (open, waiting, or at the
 * clash card), none when there are none. A merge found there is recorded, and a pull request closed without merging gets
 * its one line. Anything else changes nothing and says nothing. Merges the squad looks at again by itself every 2
 * minutes (engine/live.ts lookAtMerge) are left to it.
 */
export async function lookOutside(bp: BoardPaths): Promise<{ asked: number; merged: string[] }> {
  const meta = readMeta(bp);
  const out = { asked: 0, merged: [] as string[] };
  if (meta.engine !== 'live') return out;
  for (const t of listTickets(bp)) {
    if (!isMine(t, meta) || mergeWait(t)) continue;
    const known = openPr(t);
    const key = `${bp.squadDir}\0${t.id}`;
    if (known ? t.prClosed === known.id : notFound.has(key) || !mayHaveClashedPr(bp, t)) continue;
    const target = repoTarget(bp, t);
    const host = target && repoHostFor(bp, target.url);
    if (!target || !host) continue;
    try {
      const pr = known ?? (await clashedByBranch(bp, t, host));
      if (!pr) {
        notFound.add(key);
        continue;
      }
      if (pr.id === t.prClosed) continue;
      out.asked += 1;
      const state = await host.mergeState(pr.id);
      if (state === 'merged' && (await recordMerged(bp, t.id, pr, host, target))) out.merged.push(t.id);
      else if (state === 'closed') saidClosed(bp, t.id, pr, host, target.base);
    } catch {
      // The code host could not be reached, or the story changed meanwhile: the next look asks again.
    }
  }
  return out;
}
