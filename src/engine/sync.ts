import fs from 'node:fs';
import path from 'node:path';
import { addActivity, listTickets, readMeta, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { Ticket, TrackerEvent } from '../board/types.js';
import { Azure, azureFor, escapeHtml, gitAuthEnv, parseAzureRemote } from './azure.js';
import { git, mergeIntoBase, moveBase, remotes } from './git.js';
import { projectRoot } from './live.js';
import { repoFor } from './repos.js';

/**
 * Keeps the tracker and the code host in step with the board: work item states and comments on Azure Boards, and
 * the pull request on Azure Repos. A tracker problem never stops the squad; it shows in the ticket's activity.
 */

function workItemId(t: Ticket): number | null {
  if (t.source.type !== 'azure') return null;
  const n = Number(t.source.id ?? t.source.ref?.replace(/^AB#/i, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function note(bp: BoardPaths, id: string, text: string): void {
  try {
    updateTicket(bp, id, (t) => addActivity(t, 'release', text));
  } catch {
    // The ticket was removed meanwhile.
  }
}

/** Tell Azure what just happened on the board. Resolves even when Azure is unreachable. */
export async function tellTracker(bp: BoardPaths, ticketId: string, event: TrackerEvent, az: Azure | null = azureFor(bp)): Promise<void> {
  let t: Ticket;
  try {
    t = requireTicket(bp, ticketId);
  } catch {
    return;
  }
  if (!az || readMeta(bp).engine !== 'live') return;
  if (event.kind === 'file-bug') return fileBug(bp, t, az);
  const wid = workItemId(t);
  if (!wid) return;
  try {
    switch (event.kind) {
      case 'started': {
        const state = await az.moveTo(wid, 'InProgress');
        await az.comment(wid, `<p>squad-kit started work on this as ticket <b>${escapeHtml(t.id)}</b>.</p>`);
        if (state) note(bp, ticketId, `Moved AB#${wid} to ${state} on Azure`);
        break;
      }
      case 'answered': {
        const answered = (t.questions ?? []).filter((q) => q.answer);
        if (!answered.length) return;
        const items = answered
          .map((q) => `<li>${escapeHtml(q.text)}<br><b>${escapeHtml(q.answer!.choice.replace(/:$/, ''))}${q.answer!.value ? `: ${escapeHtml(q.answer!.value)}` : ''}</b></li>`)
          .join('');
        await az.comment(wid, `<p><b>Questions answered</b> by ${escapeHtml(readMeta(bp).user.name)}</p><ol>${items}</ol>`);
        note(bp, ticketId, `Posted the answers on AB#${wid}`);
        break;
      }
      case 'planned': {
        const criteria = (t.criteria ?? []).map((c) => `<li><b>Given</b> ${escapeHtml(c.given)}, <b>when</b> ${escapeHtml(c.when)}, <b>then</b> ${escapeHtml(c.then)}</li>`).join('');
        const chosen = t.decision?.options.find((o) => o.chosen);
        const parts = [
          '<p><b>Plan approved</b></p>',
          t.story ? `<p>${escapeHtml(t.story)}</p>` : '',
          criteria ? `<p><b>Done when</b></p><ol>${criteria}</ol>` : '',
          t.decision && chosen ? `<p><b>Decision${t.decision.adr ? ` ${escapeHtml(t.decision.adr)}` : ''}:</b> ${escapeHtml(chosen.name)}. ${escapeHtml(t.decision.why)}</p>` : '',
        ];
        await az.comment(wid, parts.join(''));
        note(bp, ticketId, `Posted the plan on AB#${wid}`);
        break;
      }
      case 'note': {
        const label = event.noteKind === 'criterion' ? 'Acceptance criterion added' : event.noteKind === 'rule' ? 'Business rule added' : 'Note';
        await az.comment(wid, `<p><b>${label}</b> by ${escapeHtml(readMeta(bp).user.name)}</p><p>${escapeHtml(event.text)}</p>`);
        note(bp, ticketId, `Posted the note on AB#${wid}`);
        break;
      }
      case 'released': {
        const state = await az.moveTo(wid, 'Completed');
        await az.addTag(wid, event.version);
        await az.comment(wid, `<p>Released in <b>${escapeHtml(event.version)}</b>.</p>`);
        note(bp, ticketId, `Closed AB#${wid} on Azure${state ? ` (${state})` : ''}`);
        break;
      }
    }
  } catch (err) {
    note(bp, ticketId, `Could not update AB#${wid} on Azure: ${(err as Error).message}`);
  }
}

const SEVERITY: Record<NonNullable<Ticket['severity']>, string> = { 'stops-work': '1 - Critical', annoying: '3 - Medium', small: '4 - Low' };

/** A bug reported on the board becomes an Azure Bug, linked to the stories of the release it was found in. */
async function fileBug(bp: BoardPaths, t: Ticket, az: Azure): Promise<void> {
  if (workItemId(t)) return;
  try {
    const related = listTickets(bp)
      .filter((x) => t.foundIn && x.release === t.foundIn && x.id !== t.id)
      .map(workItemId)
      .filter((n): n is number => n !== null);
    const bug = await az.createBug({
      title: t.title,
      reproSteps: `<p>${escapeHtml(t.ask).replace(/\n/g, '<br>')}</p><p>Reported on the squad-kit board as ${escapeHtml(t.id)}.</p>`,
      severity: SEVERITY[t.severity ?? 'annoying'],
      tags: t.foundIn ? [t.foundIn] : [],
      relatedIds: related,
    });
    updateTicket(bp, t.id, (x) => {
      x.source = { type: 'azure', ref: `AB#${bug.id}`, id: String(bug.id), url: bug.url, itemType: 'Bug' };
      addActivity(x, 'release', `Filed as Bug AB#${bug.id} on Azure${related.length ? `, linked to ${related.map((n) => `AB#${n}`).join(', ')}` : ''}`);
    });
  } catch (err) {
    note(bp, t.id, `Could not file the bug on Azure: ${(err as Error).message}`);
  }
}

/** Send a ticket's queued tracker updates, oldest first. */
export async function flushTracker(bp: BoardPaths, ticketId: string): Promise<void> {
  const az = azureFor(bp);
  for (;;) {
    let event: TrackerEvent | undefined;
    updateTicket(bp, ticketId, (t) => {
      event = t.trackerQueue?.shift();
      if (!t.trackerQueue?.length) delete t.trackerQueue;
    });
    if (!event) return;
    await tellTracker(bp, ticketId, event, az);
  }
}

/** Where the project wiki is kept for the squad to read. */
export function wikiDir(bp: BoardPaths): string {
  return path.join(bp.dir, 'context', 'wiki');
}

/**
 * Copy the Azure project wiki next to the board, so every role reads the team's business rules and definition of
 * done. Refreshed at most every 10 minutes; a wiki problem never blocks a ticket.
 */
export async function syncWiki(bp: BoardPaths, az: Azure | null = azureFor(bp), force = false): Promise<number> {
  if (!az) return 0;
  const dir = wikiDir(bp);
  const stamp = path.join(dir, '.synced');
  if (!force && fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 10 * 60_000) return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  try {
    const pages = await az.wikiPages();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const p of pages) {
      const name = p.path.replace(/^\//, '').replace(/[^\w\- ]+/g, '-').trim() || 'Home';
      fs.writeFileSync(path.join(dir, `${name}.md`), `<!-- Azure wiki page ${p.path} -->\n${p.content.trim()}\n`, 'utf8');
    }
    fs.writeFileSync(stamp, new Date().toISOString(), 'utf8');
    return pages.length;
  } catch {
    return 0;
  }
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

/** The saved Azure token, for pushing and for PRs in any org the token can reach. */
function azureToken(bp: BoardPaths): string | undefined {
  return azureFor(bp)?.target.pat;
}

/** True when accepting the proof should open a pull request (the repo is on Azure Repos and a token is saved). */
export function opensPullRequest(bp: BoardPaths, t: Ticket): boolean {
  if (readMeta(bp).engine !== 'live' || !t.branch) return false;
  const target = repoTarget(bp, t);
  return Boolean(target && parseAzureRemote(target.url) && azureToken(bp));
}

/**
 * Push the ticket's branch and open a PR to the base branch, linked to the work item, with the proof screenshots.
 * Safe to run again: it reuses the open PR for the branch.
 */
export async function publishTicket(bp: BoardPaths, ticketId: string, http?: typeof fetch): Promise<void> {
  const t = requireTicket(bp, ticketId);
  const target = repoTarget(bp, t);
  const where = target && parseAzureRemote(target.url);
  const pat = azureToken(bp);
  if (!target || !where || !pat || !t.branch) throw new Error('This ticket has no Azure repo and token to open a pull request with.');
  const env = gitAuthEnv(pat, target.url);
  const az = new Azure({ organization: where.organization, project: where.project, pat }, http);

  // A brand-new Azure repo has no base branch yet, and a PR needs one to point at.
  const remoteBase = git(target.dir, ['ls-remote', '--heads', target.remote, target.base], { allowFail: true, env });
  if (!remoteBase) {
    git(target.dir, ['push', target.remote, `${target.base}:refs/heads/${target.base}`], { env });
    note(bp, ticketId, `Pushed ${target.base} to Azure Repos (the repo was empty)`);
  }
  git(t.worktree ?? target.dir, ['push', '--force-with-lease', target.remote, `${t.branch}:refs/heads/${t.branch}`], { env });

  const wid = workItemId(t);
  let pr = await az.findPullRequest(where.repo, t.branch);
  if (!pr) {
    pr = await az.createPullRequest({
      repo: where.repo,
      source: t.branch,
      target: target.base,
      title: t.title,
      description: prDescription(t, wid, []),
      workItemIds: wid ? [wid] : [],
    });
  }
  // Screenshots go into the PR so reviewers see the proof where they review the code.
  const shots: { label: string; url: string }[] = [];
  for (const shot of (t.proof ?? []).slice(0, 6)) {
    const file = path.join(bp.proofDir, shot.after);
    if (!shot.after || !fs.existsSync(file)) continue;
    try {
      shots.push({ label: shot.criterion, url: await az.attachToPullRequest(where.repo, pr.id, file) });
    } catch {
      // A missing screenshot should not block the PR.
    }
  }
  if (shots.length) await az.updatePullRequestDescription(where.repo, pr.id, prDescription(t, wid, shots));

  const opened = pr;
  updateTicket(bp, ticketId, (x) => {
    x.pr = { id: opened.id, url: opened.url, repo: where.repo, host: 'azure' };
    x.status = `Merging pull request ${opened.id}`;
    addActivity(x, 'release', `Opened pull request ${opened.id} on Azure Repos`);
  });

  // Merge on accept: the change goes into the base branch now, so the next tickets build on it.
  let merged = false;
  let why = '';
  try {
    await az.completePullRequest(where.repo, opened.id, `Merge ${t.title} (${t.id})`);
    merged = true;
    git(target.dir, ['fetch', target.remote, target.base], { env });
    const head = git(target.dir, ['rev-parse', 'FETCH_HEAD']);
    const local = moveBase(target.dir, target.base, head);
    if (local.note) note(bp, ticketId, local.note);
  } catch (err) {
    why = (err as Error).message;
  }
  updateTicket(bp, ticketId, (x) => {
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    if (merged) {
      x.mergedAt = new Date().toISOString();
      x.status = `Merged into ${target.base} · goes out in ${x.release ?? 'the next release'}`;
      addActivity(x, 'release', `Merged pull request ${opened.id} into ${target.base}`);
    } else {
      x.status = `PR ${opened.id} is waiting in Azure · ${x.release ?? 'next release'}`;
      addActivity(x, 'release', `Pull request ${opened.id} is open but not merged yet: ${why}`);
    }
  });

  if (wid) {
    try {
      const state = await az.moveTo(wid, 'Resolved');
      await az.comment(
        wid,
        merged
          ? `<p>Merged into <b>${escapeHtml(target.base)}</b> by pull request <a href="${opened.url}">${opened.id}</a>, with the proof. It goes out in the next release.</p>`
          : `<p>Pull request <a href="${opened.url}">${opened.id}</a> is open with the proof, waiting to be merged in Azure.</p>`,
      );
      if (state) note(bp, ticketId, `Moved AB#${wid} to ${state} on Azure`);
    } catch (err) {
      note(bp, ticketId, `Could not update AB#${wid} on Azure: ${(err as Error).message}`);
    }
  }
}

/**
 * Merge on accept for repos without a pull request host: merge the ticket's branch into the base branch locally, so
 * the next tickets start from it. Pushing waits for the release.
 */
export function mergeLocally(bp: BoardPaths, t: Ticket): { commit: string; base: string; note?: string } | null {
  if (!t.branch) return null;
  const repo = repoFor(readMeta(bp), t);
  const dir = path.join(projectRoot(bp), repo.path);
  const r = mergeIntoBase(dir, repo.base, t.branch, `Merge ${t.title} (${t.id})`);
  return { commit: r.commit, base: repo.base, ...(r.note ? { note: r.note } : {}) };
}

export function prDescription(t: Ticket, wid: number | null, shots: { label: string; url: string }[]): string {
  const lines: string[] = [];
  if (t.story) lines.push(t.story, '');
  if (wid) lines.push(`Work item: #${wid}`, '');
  if (t.criteria?.length) {
    lines.push('### Done when');
    for (const c of t.criteria) lines.push(`- [x] **Given** ${c.given}, **when** ${c.when}, **then** ${c.then}`);
    lines.push('');
  }
  const g = t.gates;
  if (g) {
    lines.push('### Checks');
    lines.push(`- Tests, lint and build: ${g.checks === 'pass' ? 'pass' : g.checks === 'skipped' ? 'failed, continued anyway' : g.checks}${g.checksText ? ` (${g.checksText})` : ''}`);
    lines.push(`- Code review: ${g.review === 'pass' ? 'approved' : g.review === 'skipped' ? 'notes still open, continued anyway' : g.review}${t.reviewRound ? ` after ${t.reviewRound} round${t.reviewRound > 1 ? 's' : ''}` : ''}`);
    lines.push(`- Proof: ${g.proof === 'pass' ? `checked by ${t.createdBy}` : g.proof}`);
    lines.push('');
  }
  if (t.overrides?.length) {
    lines.push('### Continued anyway');
    for (const o of t.overrides) lines.push(`- **${o.gate === 'checks' ? 'Failed checks' : 'Open review notes'}**, by ${o.by}: ${o.reason}`);
    lines.push('');
  }
  if (shots.length) {
    lines.push('### Screenshots');
    for (const s of shots) lines.push(`**${s.label}**`, '', `![${s.label.replace(/[[\]]/g, '')}](${s.url})`, '');
  }
  lines.push(`Ticket ${t.id} on the squad-kit board.`);
  return lines.join('\n');
}
