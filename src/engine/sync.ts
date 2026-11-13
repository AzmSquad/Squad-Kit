import fs from 'node:fs';
import path from 'node:path';
import { addActivity, codeChanged, listTickets, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { LocalSetup, Ticket, TrackerEvent } from '../board/types.js';
import { repoHostFor, trackerFor } from '../modules/registry.js';
import type { Tracker } from '../modules/tracker/types.js';
import type { RepoHost } from '../modules/code-host/types.js';
import { MergeClash, currentBranch, git, mergeIntoBase, remotes, baseTurn, fetchedTip, moveBase } from './git.js';
import { projectRoot } from './live.js';
import { filesMoved, repoFor } from './repos.js';
import { overviewAfterMerge } from '../board/overview.js';
import { firstCodeMerged } from '../board/first-story.js';
import { PR_HOST_WAITS, mergeWait } from '../board/auto.js';
import { isMine } from '../board/owner.js';
import { clearStaleStop } from '../board/stale-stop.js';
import { copyViews } from './copies.js';
import { writeLog } from '../core/app-log.js';
import { freeName } from '../core/file-names.js';
import { ModuleError, refusedForGood } from '../modules/errors.js';
import { selfUpstream } from './self-project.js';
import { tidyStoryDbsBeside } from './story-db.js';
import type { ReviewRecord } from '../board/review-types.js';
import { withReviewBody } from './review-record/commit-body.js';
import { writeReview } from './review-record/write.js';
import type { PrItem } from './review-record/pr-description.js';

/**
 * Keeps the tracker and the code host in step with the board: item states and comments on the tracker, and the
 * pull request on the code host. A tracker problem never stops the squad; it shows in the ticket's activity.
 */

/** The ticket's item id on this tracker, when it came from it. */
export function itemId(t: Ticket, tracker: Tracker): string | null {
  if (t.source.type !== tracker.name) return null;
  return t.source.id ?? tracker.parseRef(t.source.ref ?? '');
}

export function noteOn(bp: BoardPaths, id: string, text: string): void {
  try {
    updateTicket(bp, id, (t) => addActivity(t, 'release', text));
  } catch {
    // The ticket was removed meanwhile.
  }
}

/** Words with a technical part: they stay out of the ticket's activity, in the log an engineer reads. */
export function saidToEngineers(bp: BoardPaths, id: string, text: string): void {
  writeLog({ level: 'warn', project: readMeta(bp).project, ticket: id, text });
}

/**
 * Tell the tracker what just happened on the board. Resolves even when the tracker is unreachable: false then, so the
 * update is kept and sent again. `again` is a retry: its failure is not noted a second time.
 */
export async function tellTracker(bp: BoardPaths, ticketId: string, event: TrackerEvent, tracker: Tracker | null = trackerFor(bp), again = false): Promise<boolean> {
  let t: Ticket;
  try {
    t = requireTicket(bp, ticketId);
  } catch {
    return true;
  }
  if (!tracker || readMeta(bp).engine !== 'live') return true;
  if (event.kind === 'file-bug') return fileBug(bp, t, tracker, again);
  const id = itemId(t, tracker);
  if (!id) return true;
  const ref = tracker.refOf(id);
  try {
    switch (event.kind) {
      case 'started': {
        const state = await tracker.moveTo(id, 'in-progress');
        await tracker.comment(id, `squad-kit started work on this as ticket **${t.id}**.`);
        if (state) noteOn(bp, ticketId, `Moved ${ref} to ${state} on ${tracker.label}`);
        break;
      }
      case 'answered': {
        const answered = (t.questions ?? []).filter((q) => q.answer);
        if (!answered.length) return true;
        const items = answered.map((q, i) => `${i + 1}. ${q.text}\n   **${q.answer!.choice.replace(/:$/, '')}${q.answer!.value ? `: ${q.answer!.value}` : ''}**`).join('\n');
        await tracker.comment(id, `**Questions answered** by ${readMeta(bp).user.name}\n\n${items}`);
        noteOn(bp, ticketId, `Posted the answers on ${ref}`);
        break;
      }
      case 'planned': {
        const criteria = (t.criteria ?? []).map((c, i) => `${i + 1}. **Given** ${c.given}, **when** ${c.when}, **then** ${c.then}`).join('\n');
        const chosen = t.decision?.options.find((o) => o.chosen);
        const parts = [
          '**Plan approved**',
          t.story ?? '',
          criteria ? `**Done when**\n\n${criteria}` : '',
          t.decision && chosen ? `**Decision${t.decision.adr ? ` ${t.decision.adr}` : ''}:** ${chosen.name}. ${t.decision.why}` : '',
        ];
        await tracker.comment(id, parts.filter(Boolean).join('\n\n'));
        noteOn(bp, ticketId, `Posted the plan on ${ref}`);
        break;
      }
      case 'note': {
        const label = event.noteKind === 'criterion' ? 'Acceptance criterion added' : event.noteKind === 'rule' ? 'Business rule added' : 'Note';
        await tracker.comment(id, `**${label}** by ${readMeta(bp).user.name}\n\n${event.text}`);
        noteOn(bp, ticketId, `Posted the note on ${ref}`);
        break;
      }
      case 'released': {
        const state = await tracker.moveTo(id, 'closed');
        if (tracker.abilities.tags) await tracker.addTag(id, event.version);
        await tracker.comment(id, `Released in **${event.version}**.`);
        noteOn(bp, ticketId, `Closed ${ref} on ${tracker.label}${state ? ` (${state})` : ''}`);
        break;
      }
    }
    return true;
  } catch (err) {
    // Sending it again would get the same no, and every later update of this ticket would wait behind it for good.
    if (refusedForGood(err)) {
      saidToEngineers(bp, ticketId, `${tracker.label} refused an update on ${ref}: ${(err as Error).message}`);
      noteOn(bp, ticketId, `${tracker.label} refused this update on ${ref}, so squad-kit went on without it. The item may be deleted, or a rule there may not allow it. Later updates still go`);
      return true;
    }
    if (!again) noteOn(bp, ticketId, `Could not update ${ref} on ${tracker.label}: ${(err as Error).message}. The update is kept and sent again later`);
    return false;
  }
}

/** A bug reported on the board becomes a bug on the tracker, linked to the items of the release it was found in. */
async function fileBug(bp: BoardPaths, t: Ticket, tracker: Tracker, again = false): Promise<boolean> {
  if (!tracker.abilities.bugs || itemId(t, tracker)) return true;
  try {
    const related = listTickets(bp)
      .filter((x) => t.foundIn && x.release === t.foundIn && x.id !== t.id)
      .map((x) => itemId(x, tracker))
      .filter((n): n is string => n !== null);
    const bug = await tracker.fileBug({
      title: t.title,
      steps: `${t.ask}\n\nReported on the squad-kit board as ${t.id}.`,
      severity: t.severity ?? 'annoying',
      tags: t.foundIn ? [t.foundIn] : [],
      related,
    });
    updateTicket(bp, t.id, (x) => {
      x.source = { type: tracker.name, ref: bug.ref, id: bug.id, url: bug.url, itemType: bug.type || 'Bug' };
      addActivity(x, 'release', `Filed as Bug ${bug.ref} on ${tracker.label}${related.length ? `, linked to ${related.map((n) => tracker.refOf(n)).join(', ')}` : ''}`);
    });
    return true;
  } catch (err) {
    if (refusedForGood(err)) {
      saidToEngineers(bp, t.id, `${tracker.label} refused a bug: ${(err as Error).message}`);
      noteOn(bp, t.id, `${tracker.label} refused this bug, so squad-kit went on without it. It stays on this board`);
      return true;
    }
    if (!again) noteOn(bp, t.id, `Could not file the bug on ${tracker.label}: ${(err as Error).message}. It is kept and filed again later`);
    return false;
  }
}

/** How long a tracker update that failed waits before the next try: 30 seconds, doubling, at most 30 minutes. */
export function trackerRetryDelay(tries: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, tries - 1));
}

/** The ticket has tracker updates to send now: none failed, or the wait after the last failure is over. */
export function trackerDue(t: Ticket): boolean {
  return Boolean(t.trackerQueue?.length) && (!t.trackerRetry || Date.parse(t.trackerRetry.nextAt) <= Date.now());
}

/**
 * Send a ticket's queued tracker updates, oldest first. Each one leaves the queue only once the tracker has it; one
 * that fails stays first, and the queue waits a little longer after each failure. The work never waits on it.
 */
export async function flushTracker(bp: BoardPaths, ticketId: string, tracker: Tracker | null = trackerFor(bp)): Promise<void> {
  for (;;) {
    const t = readTicket(bp, ticketId);
    const event = t?.trackerQueue?.[0];
    if (!t || !event || !trackerDue(t)) return;
    const sent = await tellTracker(bp, ticketId, event, tracker, Boolean(t.trackerRetry));
    try {
      updateTicket(bp, ticketId, (x) => {
        if (!sent) {
          const tries = (x.trackerRetry?.tries ?? 0) + 1;
          x.trackerRetry = { tries, nextAt: new Date(Date.now() + trackerRetryDelay(tries)).toISOString() };
          return;
        }
        // Updates queued while this one was sent stay behind it.
        if (JSON.stringify(x.trackerQueue?.[0]) === JSON.stringify(event)) x.trackerQueue!.shift();
        if (!x.trackerQueue?.length) delete x.trackerQueue;
        delete x.trackerRetry;
      });
    } catch {
      // The ticket was removed meanwhile.
      return;
    }
    if (!sent) return;
  }
}

/** Where the project wiki is kept for the squad to read. */
export function wikiDir(bp: BoardPaths): string {
  return bp.wikiDir;
}

/**
 * Copy the tracker's project wiki next to the board, so every role reads the team's business rules and definition
 * of done. Refreshed at most every 10 minutes; a wiki problem never blocks a ticket.
 */
export async function syncWiki(bp: BoardPaths, tracker: Tracker | null = trackerFor(bp), force = false): Promise<number> {
  if (!tracker?.abilities.wiki) return 0;
  const dir = wikiDir(bp);
  const stamp = path.join(dir, '.synced');
  if (!force && fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 10 * 60_000) return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  try {
    const pages = await tracker.wikiPages();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set<string>();
    for (const p of pages) {
      // Letters and digits of any language stay. The end of the path says most, so that is what a long one keeps.
      const name = p.path.replace(/^\//, '').replace(/[^\p{L}\p{M}\p{N}_\- ]+/gu, '-').trim().slice(-80);
      const file = freeName(`${/[\p{L}\p{N}]/u.test(name) ? name : 'Home'}.md`, taken);
      fs.writeFileSync(path.join(dir, file), `<!-- ${tracker.label} wiki page ${p.path} -->\n${p.content.trim()}\n`, 'utf8');
    }
    fs.writeFileSync(stamp, new Date().toISOString(), 'utf8');
    return pages.length;
  } catch {
    return 0;
  }
}

/** `.squad/` as a folder inside a repo, when it is in that repo: git moving the checkout must keep squad-kit's newer files. */
export function squadInside(bp: BoardPaths, repoDir: string): string | undefined {
  const rel = path.relative(repoDir, bp.squadDir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
}

/**
 * Where a ticket's repo lives: its folder, remote name and remote URL. On squad-kit's own code, `upstream`: the repo its
 * work goes to by pull request (ADR-008). Any other project has none: a fork's pull requests stay in the fork.
 */
export function repoTarget(bp: BoardPaths, t: Ticket): { dir: string; base: string; remote: string; url: string; upstream?: string } | null {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t);
  const dir = path.join(projectRoot(bp), repo.path);
  const remote = repo.remote || remotes(dir)[0];
  if (!remote) return null;
  // The URL as configured, before any insteadOf rewriting, says which host the repo lives on.
  const url = git(dir, ['config', '--get', `remote.${remote}.url`], { allowFail: true });
  if (!url) return null;
  const upstream = selfUpstream(dir, remote);
  return { dir, base: repo.base, remote, url, ...(upstream ? { upstream } : {}) };
}

/** The code host of a ticket's repo, which knows the repo its work goes to when that is another one. */
export function targetHost(bp: BoardPaths, target: { url: string; upstream?: string }): RepoHost | null {
  return repoHostFor(bp, target.url, target.upstream);
}

/** True when accepting the proof should open a pull request: the repo's code host has a module and a saved sign-in. */
export function opensPullRequest(bp: BoardPaths, t: Ticket): boolean {
  const meta = readMeta(bp);
  if (meta.engine !== 'live' || !t.branch) return false;
  // A story across parts goes out together at the release. So does a project that pushes to a branch, by its own choice.
  if (meta.delivery === 'push' || t.copies?.length) return false;
  const target = repoTarget(bp, t);
  return Boolean(target && targetHost(bp, target));
}

/**
 * An accepted ticket whose change is not in the base yet (board/auto.ts mergeWait), looked at again. Its pull request is
 * asked about through the code host module: once the host has merged it (someone approved and completed it there), the
 * ticket is merged here too and the person's checkout follows. With no pull request, the merge into the base is tried
 * again, now that the person's own copy may be free. 'clash': newer work in the base clashes with it now; the caller
 * gives the clash card. 'closed': the host closed the pull request without merging it. Nothing changes while it still
 * waits.
 */
export async function recheckMerge(bp: BoardPaths, id: string): Promise<'merged' | 'clash' | 'waiting' | 'closed'> {
  const t = readTicket(bp, id);
  const wait = mergeWait(t);
  if (!t || !wait) return 'waiting';
  const base = repoFor(readMeta(bp), t).base;
  let line: string;
  let moved = false;
  let review: (() => Promise<unknown>) | undefined;
  if (wait === 'pr') {
    const target = repoTarget(bp, t);
    const host = target && targetHost(bp, target);
    if (!target || !host || !t.pr) return 'waiting';
    const state = await host.mergeState(t.pr.id).catch(() => null);
    if (state === 'clash' || state === 'closed') return state;
    if (state !== 'merged') {
      // The host says it can merge now (its checks passed, someone approved, or a blip cut the merge off): it merges.
      // One the host held back (PR_HOST_WAITS) is asked too, so a refusal is said on the story once and the wait ends.
      if (state !== 'mergeable' && t.status !== PR_HOST_WAITS) return 'waiting';
      const err = await host.merge(t.pr.id, `Merge ${t.title} (${t.id})`).then(() => null, (e: unknown) => e as Error);
      if (err instanceof ModuleError && err.kind === 'clash') return 'clash';
      if (err) {
        if (!(err instanceof ModuleError && err.kind === 'waiting') && t.status === PR_HOST_WAITS) heldBack(bp, id, t.pr.id, host.label, err.message);
        return 'waiting';
      }
    }
    moved = await followBase(bp, id, target, host);
    const pr = t.pr;
    review = () => writeReview(bp, id, host, pr);
    line = `Pull request ${t.pr.id} was approved and merged on ${host.label}`;
  } else {
    const dirs = copyViews(readMeta(bp), t).map((view) => path.join(projectRoot(bp), repoFor(readMeta(bp), view).path));
    const went = await baseTurn(dirs, () => {
      // Looked at again in its turn: an accept that went first may have merged it by now.
      if (!mergeWait(readTicket(bp, id))) return false;
      // A story across parts goes in everywhere. One already in is skipped, so a later look finishes the rest.
      for (const view of copyViews(readMeta(bp), t)) if (!mergeLocally(bp, view)?.moved) return false;
      return true;
    }).catch((err: unknown) => (err instanceof MergeClash ? 'clash' : false));
    if (went === 'clash') return 'clash';
    if (!went) return 'waiting';
    moved = true;
    line = `Merged into ${base}: your own copy of ${base} was free again`;
  }
  updateTicket(bp, id, (x) => {
    if (x.mergedAt) return;
    x.mergedAt = new Date().toISOString();
    clearStaleStop(x);
    const ls = moved ? localSetupFor(bp, x) : undefined;
    if (ls) x.localSetup = ls;
    x.status = `Merged into ${base} · goes out in ${x.release ?? 'the next release'}`;
    addActivity(x, 'release', line);
  });
  mapAfterMerge(bp);
  await review?.();
  // A pull request that waited left the item open: it is in the base now.
  if (wait === 'pr' && t.pr && isMine(t, readMeta(bp))) await trackerMerged(bp, id, t.pr, base);
  return 'merged';
}

/** A pull request the code host held back for good (a failed check, a draft): said once, and the squad stops looking. */
function heldBack(bp: BoardPaths, id: string, pr: number, label: string, why: string): void {
  updateTicket(bp, id, (x) => {
    if (x.status !== PR_HOST_WAITS) return;
    x.status = `PR ${pr} is waiting in ${label} · ${x.release ?? 'next release'}`;
    addActivity(x, 'release', `Pull request ${pr} is open but not merged yet: ${why}`);
  });
}

/**
 * The code host merged a pull request, so its base moved there: the person's own checkout of the base follows when it
 * can. True when it moved.
 */
export async function followBase(bp: BoardPaths, id: string, target: { dir: string; base: string; remote: string }, host: RepoHost): Promise<boolean> {
  try {
    const head = await fetchedTip(target.dir, target.remote, target.base, { env: host.gitEnv() });
    const local = await baseTurn(target.dir, () => moveBase(target.dir, target.base, head, squadInside(bp, target.dir)));
    if (local.note) saidToEngineers(bp, id, local.note);
    return local.moved;
  } catch {
    // The person's checkout catches up with the next fetch; the change is in the base on the host already.
    return false;
  }
}

/** The story's item in a pull request into `repo`: its name on the tracker, and the line that closes it on merge. */
export function prItem(tracker: Tracker | null, item: string | null, repo: string): PrItem | null {
  if (!tracker || !item) return null;
  const closes = tracker.closesWith?.(item, repo);
  return { ref: tracker.refOf(item), ...(closes ? { closes } : {}) };
}

/**
 * The item after Looks right: resolved, and closed only when its work is really in the base (`merged`); a pull request
 * that waits for its checks, an approver or an owner leaves it open. Said on the ticket; a tracker problem stops nothing.
 */
export async function resolveItem(bp: BoardPaths, ticketId: string, tracker: Tracker | null, item: string | null, merged: boolean, words: string): Promise<void> {
  if (!tracker || !item) return;
  try {
    const state = await tracker.moveTo(item, 'resolved', { merged });
    await tracker.comment(item, words);
    if (state) noteOn(bp, ticketId, `Moved ${tracker.refOf(item)} to ${state} on ${tracker.label}`);
  } catch (err) {
    noteOn(bp, ticketId, `Could not update ${tracker.refOf(item)} on ${tracker.label}: ${(err as Error).message}`);
  }
}

/**
 * A story merged on the code host after Looks right: its pull request clashed (the clash kept the item where it was),
 * waited for its checks or an approver, or waited for the owner of another repo. Its item is resolved and closed now,
 * with where the change went. Its owner's computer tells the tracker. A tracker problem is said on the ticket and stops
 * nothing.
 */
export async function trackerMerged(bp: BoardPaths, ticketId: string, pr: { id: number; url: string }, base: string, tracker: Tracker | null = trackerFor(bp)): Promise<void> {
  const t = readTicket(bp, ticketId);
  const item = t && tracker ? itemId(t, tracker) : null;
  if (!tracker || !item || readMeta(bp).engine !== 'live') return;
  await resolveItem(bp, ticketId, tracker, item, true, `Merged into **${base}** by pull request [${pr.id}](${pr.url}), with the proof. It goes out in the next release.`);
}

/**
 * A merge moved the base. The Architect reads the code again (project map, stack and patterns) only when files were
 * added, moved or removed since its last read: edits inside files leave all three as they were.
 */
export function mapAfterMerge(bp: BoardPaths): void {
  // A merged story's own database goes, beside everything else.
  tidyStoryDbsBeside(bp, Date.now(), true);
  // The overview, the project's home, is brought up to date after every merged ticket.
  overviewAfterMerge(bp);
  firstCodeMerged(bp);
  const meta = readMeta(bp);
  if (meta.blueprint?.status === 'done' && !filesMoved(projectRoot(bp), meta, meta.blueprint, bp.squadDir)) return;
  codeChanged(bp);
}

/**
 * Merge on accept for repos without a pull request host: merge the ticket's branch into the base branch locally, so
 * the next tickets start from it. Pushing waits for the release.
 */
/**
 * The setup to run in the person's own checkout once a merge moved it: new packages and migrations came with the
 * merged code. Nothing when the checkout is on another branch (its files did not change) or there is no setup.
 */
export function localSetupFor(bp: BoardPaths, t: Ticket): LocalSetup | undefined {
  const repo = repoFor(readMeta(bp), t);
  const command = repo.commands.setup?.trim();
  const dir = path.join(projectRoot(bp), repo.path);
  if (!command) return undefined;
  try {
    if (currentBranch(dir) !== repo.base) return undefined;
  } catch {
    return undefined;
  }
  return { status: 'pending', dir, command };
}

/** `ok`: who pressed Looks right, when it is not on the story yet. The review goes under the commit's title. */
export function mergeLocally(bp: BoardPaths, t: Ticket, ok?: NonNullable<ReviewRecord['looksRight']>): { commit: string; base: string; moved: boolean; note?: string } | null {
  if (!t.branch) return null;
  const meta = readMeta(bp);
  const repo = repoFor(meta, t);
  const dir = path.join(projectRoot(bp), repo.path);
  const plain = meta.delivery === 'push';
  const r = mergeIntoBase(dir, repo.base, t.branch, withReviewBody(plain ? `${t.id}: ${t.title}` : `Merge ${t.title} (${t.id})`, t, ok), squadInside(bp, dir), plain);
  return { commit: r.commit, base: repo.base, moved: r.moved, ...(r.note ? { note: r.note } : {}) };
}
