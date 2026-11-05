import fs from 'node:fs';
import path from 'node:path';
import { addActivity, codeChanged, listTickets, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { LocalSetup, Ticket, TrackerEvent } from '../board/types.js';
import { repoHostFor, trackerFor } from '../modules/registry.js';
import type { Tracker } from '../modules/tracker/types.js';
import { MergeClash, currentBranch, git, mergeIntoBase, moveBase, netGit, remotes } from './git.js';
import { projectRoot } from './live.js';
import { filesMoved, repoFor } from './repos.js';
import { overviewAfterMerge } from '../board/overview.js';
import { mergeWait } from '../board/auto.js';
import { clearStaleStop } from '../board/stale-stop.js';

/**
 * Keeps the tracker and the code host in step with the board: item states and comments on the tracker, and the
 * pull request on the code host. A tracker problem never stops the squad; it shows in the ticket's activity.
 */

/** The ticket's item id on this tracker, when it came from it. */
function itemId(t: Ticket, tracker: Tracker): string | null {
  if (t.source.type !== tracker.name) return null;
  return t.source.id ?? tracker.parseRef(t.source.ref ?? '');
}

function note(bp: BoardPaths, id: string, text: string): void {
  try {
    updateTicket(bp, id, (t) => addActivity(t, 'release', text));
  } catch {
    // The ticket was removed meanwhile.
  }
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
        if (state) note(bp, ticketId, `Moved ${ref} to ${state} on ${tracker.label}`);
        break;
      }
      case 'answered': {
        const answered = (t.questions ?? []).filter((q) => q.answer);
        if (!answered.length) return true;
        const items = answered.map((q, i) => `${i + 1}. ${q.text}\n   **${q.answer!.choice.replace(/:$/, '')}${q.answer!.value ? `: ${q.answer!.value}` : ''}**`).join('\n');
        await tracker.comment(id, `**Questions answered** by ${readMeta(bp).user.name}\n\n${items}`);
        note(bp, ticketId, `Posted the answers on ${ref}`);
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
        note(bp, ticketId, `Posted the plan on ${ref}`);
        break;
      }
      case 'note': {
        const label = event.noteKind === 'criterion' ? 'Acceptance criterion added' : event.noteKind === 'rule' ? 'Business rule added' : 'Note';
        await tracker.comment(id, `**${label}** by ${readMeta(bp).user.name}\n\n${event.text}`);
        note(bp, ticketId, `Posted the note on ${ref}`);
        break;
      }
      case 'released': {
        const state = await tracker.moveTo(id, 'closed');
        if (tracker.abilities.tags) await tracker.addTag(id, event.version);
        await tracker.comment(id, `Released in **${event.version}**.`);
        note(bp, ticketId, `Closed ${ref} on ${tracker.label}${state ? ` (${state})` : ''}`);
        break;
      }
    }
    return true;
  } catch (err) {
    if (!again) note(bp, ticketId, `Could not update ${ref} on ${tracker.label}: ${(err as Error).message}. The update is kept and sent again later`);
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
    if (!again) note(bp, t.id, `Could not file the bug on ${tracker.label}: ${(err as Error).message}. It is kept and filed again later`);
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
    for (const p of pages) {
      const name = p.path.replace(/^\//, '').replace(/[^\w\- ]+/g, '-').trim() || 'Home';
      fs.writeFileSync(path.join(dir, `${name}.md`), `<!-- ${tracker.label} wiki page ${p.path} -->\n${p.content.trim()}\n`, 'utf8');
    }
    fs.writeFileSync(stamp, new Date().toISOString(), 'utf8');
    return pages.length;
  } catch {
    return 0;
  }
}

/** `.squad/` as a folder inside a repo, when it is in that repo: git moving the checkout must keep squad-kit's newer files. */
function squadInside(bp: BoardPaths, repoDir: string): string | undefined {
  const rel = path.relative(repoDir, bp.squadDir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
}

/** Where a ticket's repo lives: its folder, remote name and remote URL. */
export function repoTarget(bp: BoardPaths, t: Ticket): { dir: string; base: string; remote: string; url: string } | null {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t);
  const dir = path.join(projectRoot(bp), repo.path);
  const remote = repo.remote || remotes(dir)[0];
  if (!remote) return null;
  // The URL as configured, before any insteadOf rewriting, says which host the repo lives on.
  const url = git(dir, ['config', '--get', `remote.${remote}.url`], { allowFail: true });
  return url ? { dir, base: repo.base, remote, url } : null;
}

/** True when accepting the proof should open a pull request: the repo's code host has a module and a saved sign-in. */
export function opensPullRequest(bp: BoardPaths, t: Ticket): boolean {
  if (readMeta(bp).engine !== 'live' || !t.branch) return false;
  const target = repoTarget(bp, t);
  return Boolean(target && repoHostFor(bp, target.url));
}

/**
 * Push the ticket's branch and open a PR to the base branch, linked to the tracker item, with the proof screenshots.
 * Safe to run again: it reuses the open PR for the branch.
 */
export async function publishTicket(bp: BoardPaths, ticketId: string): Promise<{ clash: boolean }> {
  const t = requireTicket(bp, ticketId);
  const target = repoTarget(bp, t);
  const host = target && repoHostFor(bp, target.url);
  if (!target || !host || !t.branch) throw new Error('This ticket has no code host with a saved sign-in to open a pull request with.');
  const env = host.gitEnv();

  // A brand-new repo has no base branch yet, and a PR needs one to point at.
  const remoteBase = netGit(target.dir, ['ls-remote', '--heads', target.remote, target.base], { allowFail: true, env });
  if (!remoteBase) {
    netGit(target.dir, ['push', target.remote, `${target.base}:refs/heads/${target.base}`], { env });
    note(bp, ticketId, `Pushed ${target.base} to ${host.label} (the repo was empty)`);
  }
  netGit(t.worktree ?? target.dir, ['push', '--force-with-lease', target.remote, `${t.branch}:refs/heads/${t.branch}`], { env });

  const tracker = trackerFor(bp);
  const item = tracker ? itemId(t, tracker) : null;
  let pr = await host.findPullRequest(t.branch);
  if (!pr) {
    pr = await host.openPullRequest({ source: t.branch, target: target.base, title: t.title, description: prDescription(t, item, []), items: item ? [item] : [] });
  }
  // Screenshots go into the PR so reviewers see the proof where they review the code.
  const shots: { label: string; url: string }[] = [];
  // Each "done when"'s main picture first, then its others while there is room.
  const rows = t.proof ?? [];
  const pictures = [...rows.map((p) => ({ label: p.criterion, after: p.after })), ...rows.flatMap((p) => (p.more ?? []).map((m) => ({ label: p.criterion, after: m.after })))].slice(0, 6);
  for (const shot of host.abilities.attachImages ? pictures : []) {
    const file = path.join(bp.proofDir, shot.after);
    if (!shot.after || !fs.existsSync(file)) continue;
    try {
      shots.push({ label: shot.label, url: await host.attachImage(pr.id, file) });
    } catch {
      // A missing screenshot should not block the PR.
    }
  }
  if (shots.length) await host.updateDescription(pr.id, prDescription(t, item, shots));

  const opened = pr;
  updateTicket(bp, ticketId, (x) => {
    x.pr = { id: opened.id, url: opened.url, repo: host.repo, host: host.host };
    x.status = `Merging pull request ${opened.id}`;
    addActivity(x, 'release', `Opened pull request ${opened.id} on ${host.label}`);
  });

  // Merge on accept: the change goes into the base branch now, so the next tickets build on it.
  let merged = false;
  let movedLocal = false;
  let why = '';
  let clash = false;
  try {
    await host.merge(opened.id, `Merge ${t.title} (${t.id})`);
    merged = true;
    netGit(target.dir, ['fetch', target.remote, target.base], { env });
    const head = git(target.dir, ['rev-parse', 'FETCH_HEAD']);
    const local = moveBase(target.dir, target.base, head, squadInside(bp, target.dir));
    if (local.note) note(bp, ticketId, local.note);
    movedLocal = local.moved;
  } catch (err) {
    why = (err as Error).message;
    // Newer changes in the base clash with it: that needs the clash card (the caller gives it), not a wait on the host.
    clash = (await host.mergeState(opened.id).catch(() => null)) === 'clash';
  }
  updateTicket(bp, ticketId, (x) => {
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    if (merged) {
      x.mergedAt = new Date().toISOString();
      // Merged: a stop it went past (a clash it settled, a pull request that did not open) is over.
      clearStaleStop(x);
      const ls = movedLocal ? localSetupFor(bp, x) : undefined;
      if (ls) x.localSetup = ls;
      x.status = `Merged into ${target.base} · goes out in ${x.release ?? 'the next release'}`;
      addActivity(x, 'release', `Merged pull request ${opened.id} into ${target.base}`);
    } else if (!clash) {
      x.status = `PR ${opened.id} is waiting in ${host.label} · ${x.release ?? 'next release'}`;
      addActivity(x, 'release', `Pull request ${opened.id} is open but not merged yet: ${why}`);
    }
  });
  if (merged) mapAfterMerge(bp);

  // A clash is not done yet: the item stays where it is until the ticket is accepted again.
  if (tracker && item && !clash) {
    try {
      const state = await tracker.moveTo(item, 'resolved');
      await tracker.comment(
        item,
        merged
          ? `Merged into **${target.base}** by pull request [${opened.id}](${opened.url}), with the proof. It goes out in the next release.`
          : `Pull request [${opened.id}](${opened.url}) is open with the proof, waiting to be merged in ${host.label}.`,
      );
      if (state) note(bp, ticketId, `Moved ${tracker.refOf(item)} to ${state} on ${tracker.label}`);
    } catch (err) {
      note(bp, ticketId, `Could not update ${tracker.refOf(item)} on ${tracker.label}: ${(err as Error).message}`);
    }
  }
  return { clash };
}

/**
 * Builds by itself: an accepted story whose change is not in the base yet (board/auto.ts mergeWait), looked at again.
 * Its pull request is asked about through the code host module: once the host has merged it (someone approved and
 * completed it there), the ticket is merged here too and the person's checkout follows. With no pull request, the
 * merge into the base is tried again, now that the person's own copy may be free. 'clash': newer work in the base
 * clashes with it now; the caller gives the clash card. Nothing changes while it still waits.
 */
export async function recheckMerge(bp: BoardPaths, id: string): Promise<'merged' | 'clash' | 'waiting'> {
  const t = readTicket(bp, id);
  const wait = mergeWait(t);
  if (!t || !wait) return 'waiting';
  const base = repoFor(readMeta(bp), t).base;
  let line: string;
  let moved = false;
  if (wait === 'pr') {
    const target = repoTarget(bp, t);
    const host = target && repoHostFor(bp, target.url);
    if (!target || !host || !t.pr) return 'waiting';
    const state = await host.mergeState(t.pr.id).catch(() => null);
    if (state === 'clash') return 'clash';
    if (state !== 'merged') return 'waiting';
    try {
      const env = host.gitEnv();
      netGit(target.dir, ['fetch', target.remote, target.base], { env });
      const local = moveBase(target.dir, target.base, git(target.dir, ['rev-parse', 'FETCH_HEAD']), squadInside(bp, target.dir));
      if (local.note) note(bp, id, local.note);
      moved = local.moved;
    } catch {
      // The person's checkout catches up with the next fetch; the change is in the base on the host already.
    }
    line = `Pull request ${t.pr.id} was approved and merged on ${host.label}`;
  } else {
    try {
      const r = mergeLocally(bp, t);
      if (!r?.moved) return 'waiting';
      moved = true;
    } catch (err) {
      return err instanceof MergeClash ? 'clash' : 'waiting';
    }
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
  return 'merged';
}

/**
 * A merge moved the base. The Architect reads the code again (project map, stack and patterns) only when files were
 * added, moved or removed since its last read: edits inside files leave all three as they were.
 */
export function mapAfterMerge(bp: BoardPaths): void {
  // The overview, the project's home, is brought up to date after every merged ticket.
  overviewAfterMerge(bp);
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

export function mergeLocally(bp: BoardPaths, t: Ticket): { commit: string; base: string; moved: boolean; note?: string } | null {
  if (!t.branch) return null;
  const repo = repoFor(readMeta(bp), t);
  const dir = path.join(projectRoot(bp), repo.path);
  const r = mergeIntoBase(dir, repo.base, t.branch, `Merge ${t.title} (${t.id})`, squadInside(bp, dir));
  return { commit: r.commit, base: repo.base, moved: r.moved, ...(r.note ? { note: r.note } : {}) };
}

export function prDescription(t: Ticket, item: string | null, shots: { label: string; url: string }[]): string {
  const lines: string[] = [];
  if (t.story) lines.push(t.story, '');
  if (item) lines.push(`Work item: #${item}`, '');
  if (t.criteria?.length) {
    lines.push('### Done when');
    for (const c of t.criteria) lines.push(`- [x] **Given** ${c.given}, **when** ${c.when}, **then** ${c.then}`);
    lines.push('');
  }
  const g = t.gates;
  if (g) {
    lines.push('### Checks');
    lines.push(`- Tests, lint and build: ${g.checks === 'pass' ? 'pass' : g.checks === 'skipped' ? 'failed, continued anyway' : g.checks === 'unchecked' ? 'not checked, no tests ran' : g.checks}${g.checksText ? ` (${g.checksText})` : ''}`);
    lines.push(`- Code review: ${g.review === 'pass' ? 'approved' : g.review === 'skipped' ? 'notes still open, continued anyway' : g.review}${t.reviewRound ? ` after ${t.reviewRound} round${t.reviewRound > 1 ? 's' : ''}` : ''}`);
    lines.push(`- Proof: ${g.proof === 'pass' ? `checked by ${t.createdBy}` : g.proof === 'skipped' ? 'no screenshots, continued anyway' : g.proof}`);
    lines.push('');
  }
  if (t.overrides?.length) {
    lines.push('### Continued anyway');
    for (const o of t.overrides) lines.push(`- **${o.weakened?.length ? 'Weakened tests' : o.gate === 'checks' ? 'Failed checks' : o.gate === 'proof' ? 'No screenshots' : 'Open review notes'}**, by ${o.by}: ${o.reason}`);
    lines.push('');
  }
  if (shots.length) {
    lines.push('### Screenshots');
    for (const s of shots) lines.push(`**${s.label}**`, '', `![${s.label.replace(/[[\]]/g, '')}](${s.url})`, '');
  }
  lines.push(`Ticket ${t.id} on the squad-kit board.`);
  return lines.join('\n');
}
