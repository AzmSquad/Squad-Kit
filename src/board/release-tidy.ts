import path from 'node:path';
import { addActivity, listReleases, listTickets, now, readMeta, readRelease, readTicket, updateTicket, writeRelease, type BoardPaths } from './store.js';
import type { Release, Ticket } from './types.js';
import { BoardActionError, closeReleased, joinNextRelease } from './actions.js';
import { holdRelease, releaseGoingOut } from './lock.js';
import { isMerged } from './depends.js';
import { repoFor } from '../engine/repos.js';
import { leaveOutProblem } from '../engine/leave-out.js';
import { cleanBranches } from '../engine/branches.js';
import { clearJournal, journalAlive, readJournal, settleRepos } from '../engine/release-resume.js';
import { copyDirsIn, removeWorktree } from '../engine/git.js';
import { dropTicketCache } from '../engine/sandbox.js';
import fs from 'node:fs';
import { copyViews } from '../engine/copies.js';

/**
 * Three release fixes. Take a ticket out of the next release before it is made (its code stays in the base; the
 * release leaves it out, and it goes out with the next one). Delete old ticket branches after a release (on this
 * computer always, on the remote only when asked, never a branch with work that is not in the base). And a release
 * cut off by a restart is finished or rolled back on the next start, never left half-done.
 */

function draftFor(bp: BoardPaths, version: string): Release {
  const r = readRelease(bp, version);
  if (!r || r.status !== 'draft') throw new BoardActionError(`${version} is not a release that waits to go out.`);
  if (releaseGoingOut(bp) === r.version) throw new BoardActionError(`${r.version} is going out right now. Wait for it to finish.`);
  return r;
}

/** `squad release --without RO-3`: the ticket leaves the next release. Nothing in git changes until the release is made. */
export function takeOutOfRelease(bp: BoardPaths, version: string, id: string): Release {
  const r = draftFor(bp, version);
  const t = readTicket(bp, id);
  if (!t || !r.tickets.includes(t.id)) throw new BoardActionError(`${id.toUpperCase()} is not in ${r.version}.`);
  if (r.tickets.length === 1) throw new BoardActionError(`${t.id} is the only ticket in ${r.version}. Leave it in, or simply release later.`);
  // A ticket in the release that builds on this one would go out without what it needs.
  const needs = listTickets(bp).filter((x) => r.tickets.includes(x.id) && x.id !== t.id && x.dependsOn?.includes(t.id));
  if (needs.length) throw new BoardActionError(`${needs.map((x) => x.id).join(' and ')} in this release ${needs.length === 1 ? 'depends' : 'depend'} on ${t.id}. Take ${needs.length === 1 ? 'it' : 'them'} out first, or keep ${t.id} in.`);
  const meta = readMeta(bp);
  if (meta.engine === 'live' && t.mergedAt) {
    const repo = repoFor(meta, t);
    const problem = leaveOutProblem(path.join(bp.root, repo.path), repo.base, [t, ...(r.out ?? []).map((x) => readTicket(bp, x)).filter((x): x is Ticket => Boolean(x?.mergedAt) && repoFor(meta, x!).path === repo.path)]);
    if (problem) throw new BoardActionError(`${problem} Keep it in ${r.version}.`);
  }
  const next: Release = { ...r, tickets: r.tickets.filter((x) => x !== t.id), out: [...new Set([...(r.out ?? []), t.id])] };
  writeRelease(bp, next);
  updateTicket(bp, t.id, (x) => {
    const base = repoFor(meta, x).base;
    x.status = `Taken out of ${r.version} · goes out in the release after it`;
    addActivity(x, 'you', x.mergedAt ? `Took it out of ${r.version}: its code stays in ${base}, and ${r.version} leaves it out` : `Took it out of ${r.version}`);
  });
  return next;
}

/** `squad release --put-back RO-3`: a ticket taken out goes back into the release. */
export function putBackInRelease(bp: BoardPaths, version: string, id: string): Release {
  const r = draftFor(bp, version);
  const key = id.toUpperCase();
  if (!r.out?.includes(key)) throw new BoardActionError(`${key} was not taken out of ${r.version}.`);
  const out = r.out.filter((x) => x !== key);
  const next: Release = { ...r, tickets: [...new Set([...r.tickets, key])], out };
  if (!out.length) delete next.out;
  writeRelease(bp, next);
  if (readTicket(bp, key)) {
    updateTicket(bp, key, (x) => {
      x.release = r.version;
      x.status = x.mergedAt ? `Merged into ${repoFor(readMeta(bp), x).base} · goes out in ${r.version}` : `Ready for ${r.version}`;
      addActivity(x, 'you', `Put it back into ${r.version}`);
    });
  }
  return next;
}

/**
 * After a release went out: the tickets taken out of it join the next release, and the old branches of the released
 * tickets go on this computer. Those on the remote stay until the person asks; the log says how.
 */
export function afterRelease(bp: BoardPaths, release: Release): void {
  const out = (release.out ?? []).filter((id) => !release.tickets.includes(id) && readTicket(bp, id));
  if (out.length) {
    joinNextRelease(bp, out);
    for (const id of out) {
      updateTicket(bp, id, (x) => {
        x.status = x.mergedAt ? `Merged into ${repoFor(readMeta(bp), x).base} · goes out in ${x.release}` : `Ready for ${x.release}`;
      });
    }
  }
  if (readMeta(bp).engine !== 'live') return;
  const lines: { ok: boolean; text: string }[] = [];
  try {
    const done = cleanBranches(bp, { only: release.tickets });
    if (done.deleted.length) lines.push({ ok: true, text: `Deleted the old ticket branches on this computer: ${done.deleted.join(', ')}` });
    for (const f of done.failed) lines.push({ ok: false, text: `Could not delete ${f}` });
    if (done.remoteLeft.length) {
      const remote = done.remoteLeft[0]!.remote;
      lines.push({ ok: true, text: `Their branches on ${remote} stay (${done.remoteLeft.length}). To delete them there too: squad branches --clean --remote` });
    }
  } catch (err) {
    lines.push({ ok: false, text: `Could not tidy the old ticket branches: ${(err as Error).message}` });
  }
  if (!lines.length) return;
  release.log = [...(release.log ?? []), ...lines];
  writeRelease(bp, release);
}

/**
 * A release that stopped half-way, by a restart or an error: what reached its remote is finished, the rest rolled
 * back. Returns the release as it stands after, or null when nothing was half-done. Call it holding the release lock.
 */
export async function settleRelease(bp: BoardPaths, why: string): Promise<Release | null> {
  const j = readJournal(bp);
  if (!j) return null;
  const release = readRelease(bp, j.version);
  if (!release || release.status === 'released') {
    clearJournal(bp);
    return release;
  }
  const meta = readMeta(bp);
  const repos = settleRepos(bp, j);
  // A pull request the code host merged for the release is in the base now, whatever else happened.
  for (const id of j.prMerged ?? []) {
    if (!readTicket(bp, id)) continue;
    updateTicket(bp, id, (x) => {
      if (x.mergedAt) return;
      x.mergedAt = now();
      addActivity(x, 'release', `Its pull request was merged while ${j.version} went out`);
    });
  }
  const reached = new Set(repos.filter((r) => r.reached).map((r) => r.repo));
  const log = [{ ok: false, text: why }, ...repos.flatMap((r) => (repos.length > 1 || meta.repos?.length ? r.log.map((l) => ({ ...l, text: `${r.repo}: ${l.text}` })) : r.log))];
  clearJournal(bp);
  if (!reached.size) {
    writeRelease(bp, { ...release, log: [...log, { ok: true, text: `${release.version} did not go out. Press Release again when you are ready.` }] });
    return readRelease(bp, release.version);
  }
  // Out there for at least one repo: it is released there. Tickets of a repo it never reached wait for the next one.
  const going = j.tickets.filter((id) => {
    const t = readTicket(bp, id);
    return t && copyViews(meta, t).every((v) => reached.has(repoFor(meta, v).path));
  });
  const rest = release.tickets.filter((id) => !going.includes(id));
  const unpushed = repos.flatMap((r) => (r.unpushed ? [r.unpushed] : []));
  if (release.addons.pipeline && (meta.commands?.deploy || meta.repos?.some((x) => x.commands.deploy))) {
    log.push({ ok: false, text: 'The pipeline did not run, because the release was cut off. Run it yourself when you are ready.' });
  }
  const done: Release = { ...release, status: 'released', date: release.date ?? j.at, tickets: going, log, ...(unpushed.length ? { unpushed } : {}) };
  if (!unpushed.length) delete done.unpushed;
  writeRelease(bp, done);
  for (const id of going) {
    const t = readTicket(bp, id);
    for (const v of t?.worktree ? copyViews(meta, t) : []) removeWorktree(path.join(bp.root, repoFor(meta, v).path), v.worktree!);
    if (t?.storyDir && !copyDirsIn(t.storyDir).length) fs.rmSync(t.storyDir, { recursive: true, force: true });
    dropTicketCache(bp, id);
  }
  if (rest.length) joinNextRelease(bp, rest);
  closeReleased(bp, done);
  afterRelease(bp, done);
  return readRelease(bp, done.version);
}

/**
 * On the next start: a release cut off by a restart is settled, unless it is still going out in another window.
 * Never throws; returns what it settled.
 */
export async function resumeCutRelease(bp: BoardPaths): Promise<Release | null> {
  try {
    const j = readJournal(bp);
    if (!j || journalAlive(j) || releaseGoingOut(bp)) return null;
    const free = holdRelease(bp, j.version);
    try {
      return await settleRelease(bp, `${j.version} was cut off while it went out (the app closed or the computer restarted).`);
    } finally {
      free();
    }
  } catch {
    return null;
  }
}

/** The draft releases, newest first: where a terminal command takes a ticket out when no version is named. */
export function nextDraft(bp: BoardPaths, version?: string): Release {
  const v = version && (version.startsWith('v') ? version : `v${version}`);
  const going = releaseGoingOut(bp);
  const r = listReleases(bp).find((x) => x.status === 'draft' && x.version !== going && (!v || x.version === v));
  if (!r) throw new BoardActionError(v ? `${v} is not a release that waits to go out.` : 'There is no release ready to go out.');
  return r;
}

/** Whether a ticket taken out is still waiting to go out, for the board's list. */
export function outItems(bp: BoardPaths, r: Release): { id: string; title: string; merged: boolean }[] {
  return (r.out ?? []).map((id) => {
    const t = readTicket(bp, id);
    return { id, title: t?.title ?? r.titles?.[id] ?? id, merged: Boolean(t && isMerged(t)) };
  });
}
