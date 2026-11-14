import fs from 'node:fs';
import path from 'node:path';
import { BoardActionError, refuseWhileSaving } from '../board/actions.js';
import { releaseGoingOut, squadRunsElsewhere } from '../board/lock.js';
import { isMine, ownerOf } from '../board/owner.js';
import {
  addActivity,
  listDecisions,
  listReleases,
  listTickets,
  now,
  readMeta,
  readTicket,
  removeTicket,
  requireTicket,
  ticketStateFile,
  updateTicket,
  writeDecision,
  writeMeta,
  writeRelease,
  type BoardPaths,
} from '../board/store.js';
import type { BoardMeta, Decision, Deleting, Ticket } from '../board/types.js';
import { repoHostFor, trackerModule } from '../modules/registry.js';
import { copyDirsIn, currentBranch, dropSnapshot, git, gitLater, isRepo, netGitLater, removeWorktree, worktreeRoot } from './git.js';
import { agentRuns } from './live.js';
import { repoFor, reposOf } from './repos.js';
import { repoTarget, targetHost } from './sync.js';
import { deleteNoteCommit, localCopy } from './teammate-delete.js';
import { docsRepo, squadInRepo } from './project-git.js';
import { writeLog } from '../core/app-log.js';
import { dropTicketCache, ticketCacheDir } from './sandbox.js';
import { stopTry } from './try-app.js';
import { dropStoryDb } from './story-db.js';
import { plainWords } from '../core/for-people.js';

/**
 * Delete and Archive. Delete is for a ticket that never reached the base: the squad stops first, then its copy of the
 * code, its branch, its files, its state, chats and screenshots go. The tracker item stays (only the link goes), and
 * its cost stays in Usage. Each part goes in turn and the ticket keeps a "deleting" mark until the last one, so a
 * delete cut off half-way finishes when it runs again. Archive is for a merged or released ticket: it only leaves the
 * board, and its history stays in git and in `.squad/`.
 */

/** What Delete would do, in words, for the dialog and the terminal. */
export interface DeletePlan {
  id: string;
  title: string;
  /** One line under the title: what it is, where it got to, never merged. */
  summary: string;
  /** Why it cannot be deleted, in plain words. */
  refused?: string;
  /** Merged or released: Archive is the way to take it off the board. */
  archive?: boolean;
  removes: string[];
  stays: string[];
  /** What to know first: the work it stops, tickets that build on it. */
  warnings: string[];
  /** The branch was pushed: it can go from the remote too, never by default. */
  pushed?: { remote: string; branch: string; why: string };
  /** An earlier Delete stopped half-way, and why. */
  unfinished?: string;
  /** The earlier Delete's choice for the pushed branch, so pressing it again does the same. */
  remote: boolean;
  /** Someone else's ticket their owner deleted: it only leaves this board, and nothing changes on the remote. */
  local?: { by: string };
  /** The branch a merged ticket's code is in. */
  base: string;
  command: string;
}

export interface DeleteResult {
  id: string;
  title: string;
  /** What happened on the way, for example the pull request it closed. */
  notes: string[];
}

/** Merged into the base, or released. A sample board merges nothing: its accepted tickets count as merged. */
export function isMerged(t: Ticket, meta: Pick<BoardMeta, 'engine'>): boolean {
  return Boolean(t.mergedAt) || t.stage === 'done' || (meta.engine === 'demo' && t.stage === 'release');
}

function branchOf(t: Ticket): string {
  return t.branch ?? `squad/${t.id.toLowerCase()}`;
}

function repoDir(bp: BoardPaths, meta: BoardMeta, t: Ticket): string {
  return path.join(bp.root, repoFor(meta, t).path);
}

function copyOf(dir: string, t: Ticket): string {
  return t.worktree ?? path.join(worktreeRoot(dir), t.id.toLowerCase());
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function hasBranch(dir: string, branch: string): boolean {
  return Boolean(git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true }));
}

/** "RO-6", "RO-6 and RO-7", "RO-6, RO-7 and RO-8". */
function and(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The decisions the ticket made, and which of them another ticket builds on. Those stay; the rest go with it. */
function decisionsOf(bp: BoardPaths, t: Ticket): { going: Decision[]; kept: { d: Decision; by: string[] }[] } {
  const others = listTickets(bp).filter((x) => x.id !== t.id);
  const going: Decision[] = [];
  const kept: { d: Decision; by: string[] }[] = [];
  for (const d of listDecisions(bp).filter((x) => x.from === t.id)) {
    const by = others.filter((x) => x.follows?.includes(d.id) || x.replanFor === d.id).map((x) => x.id);
    if (by.length) kept.push({ d, by });
    else going.push(d);
  }
  return { going, kept };
}

/** Where the branch was pushed, if it was: the ticket was handed over, opened a pull request, or the remote has it. */
function pushedTo(bp: BoardPaths, dir: string, t: Ticket): DeletePlan['pushed'] {
  if (!isRepo(dir)) return undefined;
  const target = repoTarget(bp, t);
  if (!target) return undefined;
  const branch = branchOf(t);
  const there = git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${target.remote}/${branch}`], { allowFail: true });
  if (!there && !t.handedOver && !t.pr) return undefined;
  const why = t.handedOver
    ? 'squad-kit pushed it when the ticket was handed over.'
    : t.pr
      ? `squad-kit pushed it for pull request ${t.pr.id}.`
      : `${target.remote} has it, pushed from this computer or a teammate's.`;
  return { remote: target.remote, branch, why };
}

/** Why the ticket cannot be deleted, or undefined when it can. */
function refusal(bp: BoardPaths, meta: BoardMeta, t: Ticket): { why: string; archive?: boolean } | undefined {
  const base = repoFor(meta, t).base;
  // Someone else's ticket that its owner deleted can leave this board: that touches this computer only.
  if (!isMine(t, meta) && !t.ownerDeleted) return { why: `${t.id} is ${ownerOf(t)}'s. Only ${ownerOf(t)} can delete it.` };
  if (isMerged(t, meta)) {
    return { why: `${t.id} is merged already: its code is in ${base}, so it cannot be deleted. Archive it to hide it from the board. Its history stays.`, archive: true };
  }
  const going = releaseGoingOut(bp);
  const draft = listReleases(bp).find((r) => r.status === 'draft' && r.tickets.includes(t.id));
  if (draft && going === draft.version) return { why: `${draft.version} is going out right now with ${t.id}. Wait for it to finish.` };
  if (draft) return { why: `${t.id} is in ${draft.version}, the release being made, so it cannot be deleted. It goes out with that release; after that you can archive it.` };
  const dir = repoDir(bp, meta, t);
  if (isRepo(dir) && currentBranch(dir) === branchOf(t)) {
    return { why: `Your project folder is on ${branchOf(t)}. Switch it back to ${base} first (git switch ${base}), then delete ${t.id}.` };
  }
  return undefined;
}

export function deletePlan(bp: BoardPaths, id: string, opts: { remote?: boolean } = {}): DeletePlan {
  const meta = readMeta(bp);
  const t = requireTicket(bp, id);
  const dir = repoDir(bp, meta, t);
  const base = repoFor(meta, t).base;
  const no = refusal(bp, meta, t);
  if (!no && !isMine(t, meta) && t.ownerDeleted) return removePlan(bp, meta, t, dir, base);
  const pushed = no ? undefined : pushedTo(bp, dir, t);
  const remote = Boolean(pushed && (opts.remote ?? t.deleting?.remote));
  const removes: string[] = ['The ticket, its spec, notes and questions'];
  const stays: string[] = [`Your ${base} code and every other ticket`];
  const warnings: string[] = [];

  const inGit = isRepo(dir);
  const copy = inGit && fs.existsSync(copyOf(dir, t));
  const branch = inGit && hasBranch(dir, branchOf(t));
  if (copy || branch) removes.push(t.copies?.length ? 'Its copies of the code' : copy ? 'Its copy of the code' : 'Its saved work on this computer');
  if (fs.existsSync(ticketCacheDir(bp, t.id))) removes.push('The packages its Builder and Tester downloaded for it');
  const chats = Boolean(Object.values(t.sessions ?? {}).some(Boolean) || t.chat);
  const shots = Boolean(t.proof?.length);
  if (chats || shots) removes.push(chats && shots ? 'Its agent conversations and screenshots' : chats ? 'Its agent conversations' : 'Its screenshots');
  if (t.trackerQueue?.length) removes.push(`${t.trackerQueue.length === 1 ? 'An update' : `${t.trackerQueue.length} updates`} for the tracker that ${t.trackerQueue.length === 1 ? 'was' : 'were'} not sent yet`);

  const { going, kept } = decisionsOf(bp, t);
  const all = listDecisions(bp);
  for (const d of going) {
    removes.push(`Its decision ${d.id}, "${d.title}". It never reached ${base}.`);
    const old = all.find((x) => x.replacedBy === d.id);
    if (old) stays.push(`Decision ${old.id}, "${old.title}". It is a rule again, as it was before ${d.id} replaced it.`);
  }
  for (const r of listReleases(bp).filter((x) => x.bugs?.includes(t.id))) removes.push(`Its place among the bugs found in ${r.version}`);
  if (pushed && remote) removes.push(`Its saved work in your team's shared copy of the code${t.pr ? `, and pull request ${t.pr.id} is closed` : ''}`);

  const tracker = trackerModule(t.source.type);
  if (tracker) stays.push(`The ${t.kind === 'bug' ? 'bug' : 'story'}${t.source.ref ? ` ${t.source.ref}` : ''} in ${tracker.label}. Only the link to it is removed.`);
  stays.push('The cost it used, still counted in Usage');
  for (const k of kept) stays.push(`Its decision ${k.d.id}, "${k.d.title}", because ${and(k.by)} ${k.by.length === 1 ? 'follows' : 'follow'} it`);
  if (pushed && !remote) {
    stays.push(`Its saved work in your team's shared copy of the code, with a note that you deleted ${t.id}, so teammates' boards show it as deleted.`);
    if (t.pr) stays.push(`Pull request ${t.pr.id}, still open. Close it on the code host if you no longer need it.`);
  }

  const busy = t.live || t.squad || t.questions?.some((q) => q.thinking) || t.chat?.thinking;
  if (busy && !t.deleting) warnings.push('The squad is working on it. Delete stops it first and waits for it.');
  if (t.chat?.open) warnings.push('A chat is open on it. Delete ends the chat.');
  if (t.takenOver) warnings.push('You took it over. Close the session you opened in its copy first.');
  for (const k of kept) warnings.push(`${and(k.by)} ${k.by.length === 1 ? 'builds' : 'build'} on its decision ${k.d.id}.`);

  return {
    id: t.id,
    title: t.title,
    summary: [t.title, t.status, isMerged(t, meta) ? (t.stage === 'done' ? `released${t.release ? ` in ${t.release}` : ''}` : `merged into ${base}`) : 'never merged'].filter(Boolean).join(' · '),
    ...(no ? { refused: no.why, ...(no.archive ? { archive: true } : {}) } : {}),
    removes,
    stays,
    warnings,
    ...(pushed ? { pushed } : {}),
    ...(t.deleting?.error ? { unfinished: t.deleting.error } : {}),
    remote,
    base,
    command: `squad delete ${t.id}${remote ? ' --remote' : ''}`,
  };
}

/** Remove from my board: someone else's ticket that its owner deleted leaves this computer, and nothing else changes. */
function removePlan(bp: BoardPaths, meta: BoardMeta, t: Ticket, dir: string, base: string): DeletePlan {
  const by = t.ownerDeleted!.by;
  const local = localCopy(dir, t, base, copyOf(dir, t));
  const removes = [`${t.id} from your board: its files, notes and questions on this computer`];
  if (local.copy || local.branch) removes.push(local.copy ? 'Its copy of the code on this computer' : 'Its saved work on this computer');
  const chats = Boolean(Object.values(t.sessions ?? {}).some(Boolean) || t.chat);
  const shots = Boolean(t.proof?.length);
  if (chats || shots) removes.push(chats && shots ? 'Its agent conversations and screenshots on this computer' : chats ? 'Its agent conversations on this computer' : 'Its screenshots on this computer');
  const { going } = decisionsOf(bp, t);
  for (const d of going) removes.push(`Its decision ${d.id}, "${d.title}", on this computer`);
  const stays = [
    `Everything on the remote: squad-kit pushes and deletes nothing there. ${by}'s delete is theirs.`,
    `Your ${base} code and every other ticket`,
    ...local.kept,
    ...(t.usage?.length ? ['The cost it used on this computer, still counted in Usage'] : []),
  ];
  const warnings = t.chat?.open ? ['A chat is open on it. Removing it ends the chat.'] : [];
  return {
    id: t.id,
    title: t.title,
    summary: [t.title, `Deleted by ${by}`].join(' · '),
    removes,
    stays,
    warnings,
    remote: false,
    local: { by },
    base,
    command: `squad delete ${t.id}`,
  };
}

/* ── Delete ─────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The runs of this ticket going on in this process: its step, its chat answer, a change being written, before shots. */
function runsHere(bp: BoardPaths, id: string): string[] {
  const keys = agentRuns().find((r) => r.root === bp.root)?.keys ?? [];
  return keys.filter((k) => k === id || k.endsWith(`:${id}`));
}

/**
 * The squad stops the ticket's runs once it sees the mark. A squad in this process is watched directly; one in
 * another window says it stopped on the ticket itself. A step that ended just then may have saved the ticket without
 * the mark, so it is put back.
 */
async function waitForStop(bp: BoardPaths, id: string, mark: Deleting, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const t = readTicket(bp, id);
    if (!t) return;
    if (!t.deleting) updateTicket(bp, id, (x) => (x.deleting = { ...mark }));
    const here = runsHere(bp, id);
    const there = squadRunsElsewhere(bp) && !t.deleting?.stopped;
    if (!here.length && !there) return;
    if (Date.now() > end) throw new Error('The squad did not stop in time');
    await sleep(200);
  }
}

/** Only when asked: its open pull request closes, then the branch goes from the remote. */
async function removeRemote(bp: BoardPaths, t: Ticket): Promise<string[]> {
  const target = repoTarget(bp, t);
  if (!target) return [];
  const branch = branchOf(t);
  // With where its work goes, so a pull request in the repo it was copied from is the one that closes.
  const host = targetHost(bp, target);
  const notes: string[] = [];
  if (t.pr && host) {
    try {
      await host.close(t.pr.id);
      notes.push(`Closed pull request ${t.pr.id}`);
    } catch (err) {
      throw new Error(`Could not close pull request ${t.pr.id}: ${plainWords(err, `Closing pull request ${t.pr.id}`, 'something technical stopped it. Try again.')}`);
    }
  }
  try {
    await netGitLater(target.dir, ['push', target.remote, '--delete', branch], { env: (await host?.gitEnv()) ?? {} });
    notes.push(`Deleted ${branch} on ${target.remote}`);
  } catch (err) {
    // Gone there already: a teammate deleted it, or an earlier try did.
    if (!/remote ref does not exist/i.test((err as Error).message)) throw new Error(`Could not delete its work on ${target.remote}: ${plainWords(err, `Deleting ${branch} on ${target.remote}`, 'something technical stopped it. Try again.')}`);
    git(target.dir, ['update-ref', '-d', `refs/remotes/${target.remote}/${branch}`], { allowFail: true });
  }
  return notes;
}

/**
 * Its copy of the code (and a "before" copy left behind), then its local branch. For someone else's ticket, only the
 * parts that hold no unpushed work (`localCopy`); the rest stays.
 */
async function removeCopy(bp: BoardPaths, meta: BoardMeta, t: Ticket, opts: { safe?: boolean } = {}): Promise<string[]> {
  const projectCopies = worktreeRoot(bp.root);
  const one = async (dir: string, base: string, copy: string): Promise<string[]> => {
    if (!isRepo(dir)) return [];
    const root = worktreeRoot(dir);
    const keep = opts.safe ? localCopy(dir, t, base, copy) : null;
    if (!keep || keep.copy) {
      await removeWorktree(dir, copy);
      // By hand only inside squad-kit's own folder of copies, never anywhere else.
      if (inside(root, copy) || inside(projectCopies, copy)) await fs.promises.rm(copy, { recursive: true, force: true });
    }
    const before = path.join(root, `${t.id.toLowerCase()}-before`);
    if (fs.existsSync(before)) await dropSnapshot(dir, before);
    await gitLater(dir, ['worktree', 'prune'], { allowFail: true });
    if ((!keep || keep.branch) && hasBranch(dir, branchOf(t))) await gitLater(dir, ['branch', '-D', branchOf(t)]);
    return keep?.kept ?? [];
  };
  const dir = repoDir(bp, meta, t);
  const kept = await one(dir, repoFor(meta, t).base, copyOf(dir, t));
  for (const c of t.copies ?? []) kept.push(...(await one(path.join(bp.root, c.repo), reposOf(meta).find((r) => r.path === c.repo)?.base ?? repoFor(meta, t).base, c.dir)));
  // The story's folder goes with its last copy.
  if (t.storyDir && inside(projectCopies, t.storyDir) && fs.existsSync(t.storyDir) && !copyDirsIn(t.storyDir).length) await fs.promises.rm(t.storyDir, { recursive: true, force: true });
  return kept;
}

/**
 * The branch stays on the remote: a note on it tells the team's boards the ticket is deleted. Built on the remote's own
 * tip (fetched first) and pushed without force, so it never carries this computer's unpushed work and never overwrites
 * a teammate's. It is a courtesy: when it cannot be pushed, the delete still goes on, and says so.
 */
async function leaveNote(bp: BoardPaths, t: Ticket, by: string, at: string): Promise<string[]> {
  const target = repoTarget(bp, t);
  const repo = docsRepo(bp);
  if (!target || !repo || repo !== target.dir) return [];
  const branch = branchOf(t);
  const host = repoHostFor(bp, target.url);
  const env = (await host?.gitEnv()) ?? {};
  const ref = `refs/remotes/${target.remote}/${branch}`;
  try {
    await netGitLater(target.dir, ['fetch', '--quiet', target.remote, `+refs/heads/${branch}:${ref}`], { env });
    const tip = git(target.dir, ['rev-parse', '--verify', '-q', ref], { allowFail: true });
    if (!tip) return [];
    const note = deleteNoteCommit(target.dir, tip, squadInRepo(bp, repo), t, by, at);
    if (!note) return [];
    await netGitLater(target.dir, ['push', target.remote, `${note}:refs/heads/${branch}`], { env });
    git(target.dir, ['update-ref', ref, note], { allowFail: true });
    return [`Left a note on ${branch} on ${target.remote}, so teammates' boards show ${t.id} as deleted`];
  } catch (err) {
    return [`Teammates still see ${t.id}: squad-kit could not leave a note on ${branch} on ${target.remote} (${(err as Error).message})`];
  }
}

/**
 * The decisions it made that nothing else builds on go, and every link to the ticket goes: other decisions stop
 * listing it, one its decision replaced is a rule again. The links go before the files, so a delete cut off in between
 * still finds them.
 */
function unlinkDecisions(bp: BoardPaths, t: Ticket): void {
  const { going } = decisionsOf(bp, t);
  const ids = new Set(going.map((d) => d.id));
  for (const d of listDecisions(bp)) {
    if (ids.has(d.id)) continue;
    const tickets = d.tickets.filter((x) => x !== t.id);
    const buildsOn = d.buildsOn?.filter((x) => !ids.has(x));
    const back = Boolean(d.replacedBy && ids.has(d.replacedBy));
    if (tickets.length === d.tickets.length && buildsOn?.length === d.buildsOn?.length && !back) continue;
    const { replacedBy, buildsOn: _was, ...rest } = d;
    writeDecision(bp, { ...rest, tickets, ...(buildsOn?.length ? { buildsOn } : {}), ...(replacedBy && !back ? { replacedBy } : {}) });
  }
  if (ids.size) {
    for (const x of listTickets(bp).filter((y) => y.id !== t.id && y.outdated?.some((o) => ids.has(o.adr)))) {
      updateTicket(bp, x.id, (y) => {
        y.outdated = y.outdated?.filter((o) => !ids.has(o.adr));
        if (!y.outdated?.length) delete y.outdated;
      });
    }
    const meta = readMeta(bp);
    if (meta.impactChecks?.some((c) => ids.has(c.adr))) writeMeta(bp, { ...meta, impactChecks: meta.impactChecks.filter((c) => !ids.has(c.adr)) });
  }
  for (const r of listReleases(bp).filter((x) => x.bugs?.includes(t.id))) writeRelease(bp, { ...r, bugs: r.bugs!.filter((x) => x !== t.id) });
  for (const d of going) fs.rmSync(path.join(bp.decisionsDir, `${d.id}.md`), { force: true });
}

/** Its own conversation logs, and the screenshots no other ticket shows. */
function removeChatsAndShots(bp: BoardPaths, t: Ticket): void {
  const sessions = [...Object.values(t.sessions ?? {}), t.chat?.side].filter((s): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s));
  for (const s of sessions) fs.rmSync(path.join(bp.chatsDir, `${s}.jsonl`), { force: true });
  if (!fs.existsSync(bp.proofDir)) return;
  const shown = new Set(listTickets(bp).filter((x) => x.id !== t.id).flatMap((x) => (x.proof ?? []).flatMap((p) => [p.before, p.after, ...(p.more ?? []).map((m) => m.after)])));
  const own = new RegExp(`^${t.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(before|after)-`);
  const named = (t.proof ?? []).flatMap((p) => [p.before, p.after, ...(p.more ?? []).map((m) => m.after)]).filter(Boolean).map((f) => path.basename(f));
  for (const f of new Set([...named, ...fs.readdirSync(bp.proofDir).filter((f) => own.test(f))])) {
    if (!shown.has(f)) fs.rmSync(path.join(bp.proofDir, f), { force: true });
  }
}

/**
 * The board keeps a line for each deleted ticket on this computer: its cost stays in Usage, and its pushed branch
 * does not bring it back. Saved under the delete's own time, so a delete run again writes the same line, not a second.
 */
function keepRecord(bp: BoardPaths, t: Ticket, mark: Deleting, fromBoard = false): void {
  const meta = readMeta(bp);
  const rest = (meta.deleted ?? []).filter((d) => !(d.id === t.id && d.at === mark.at));
  writeMeta(bp, { ...meta, deleted: [...rest, { id: t.id, title: t.title, at: mark.at, by: mark.by, ...(t.usage?.length ? { usage: t.usage } : {}), ...(fromBoard ? { fromBoard } : {}) }] });
}

/**
 * Delete a ticket that is not merged. Its agents and chats stop first; then the pushed branch (only when asked), its
 * copy and branch, its decisions and links, chats and screenshots, and last its files. Safe to run again: each part
 * that is gone already is skipped.
 */
export function deleteTicket(bp: BoardPaths, id: string, opts: { remote?: boolean; waitMs?: number } = {}): Promise<DeleteResult> {
  const key = `${bp.squadDir}\0${id.toUpperCase()}`;
  // Pressed twice: one delete, and both presses get how it went.
  const now = deletesNow.get(key);
  if (now) return now;
  const run = deleteOnce(bp, id, opts).finally(() => deletesNow.delete(key));
  deletesNow.set(key, run);
  return run;
}

const deletesNow = new Map<string, Promise<DeleteResult>>();

async function deleteOnce(bp: BoardPaths, id: string, opts: { remote?: boolean; waitMs?: number }): Promise<DeleteResult> {
  refuseWhileSaving(bp, id);
  const first = readTicket(bp, id);
  if (!first) {
    // Cut off after its files went: only this computer's record of it is left.
    if (fs.existsSync(ticketStateFile(bp, id))) {
      removeTicket(bp, id);
      return { id: id.toUpperCase(), title: '', notes: [] };
    }
    throw new BoardActionError(`No ticket ${id.toUpperCase()} on this board.`);
  }
  const meta = readMeta(bp);
  const no = refusal(bp, meta, first);
  if (no) throw new BoardActionError(no.why);
  // Someone else's, deleted by its owner: Remove from my board, this computer only.
  const local = !isMine(first, meta);
  const pushed = local ? undefined : pushedTo(bp, repoDir(bp, meta, first), first);
  const remote = Boolean(opts.remote ?? first.deleting?.remote) && Boolean(pushed);
  const mark: Deleting = { at: first.deleting?.at ?? now(), by: meta.user.name, ...(remote ? { remote } : {}), ...(first.deleting?.remoteDone ? { remoteDone: true } : {}) };
  updateTicket(bp, first.id, (x) => {
    if (!x.deleting) addActivity(x, 'you', local ? 'Pressed Remove from my board' : 'Pressed Delete');
    x.deleting = { ...mark };
    x.status = local ? 'Removing…' : 'Deleting…';
    x.waiting = null;
    x.live = false;
    x.squad = null;
  });
  try {
    await waitForStop(bp, first.id, mark, opts.waitMs ?? 60_000);
    const t = requireTicket(bp, first.id);
    const notes: string[] = [];
    if (remote && !t.deleting?.remoteDone) {
      notes.push(...(await removeRemote(bp, t)));
      updateTicket(bp, t.id, (x) => (x.deleting = { ...mark, ...x.deleting, remoteDone: true }));
    } else if (pushed && !remote && !t.deleting?.remoteDone) {
      notes.push(...(await leaveNote(bp, t, mark.by, mark.at)));
      updateTicket(bp, t.id, (x) => (x.deleting = { ...mark, ...x.deleting, remoteDone: true }));
    }
    // The copy of the app the person was trying stops before its copy of the code goes.
    await stopTry(bp, t.id);
    notes.push(...(await removeCopy(bp, meta, t, { safe: local })).map((k) => `Kept ${k.charAt(0).toLowerCase()}${k.slice(1)}`));
    // Its own database goes with its copy. One the server cannot drop now goes with the next tidy-up.
    await dropStoryDb(bp, t.id).catch(() => false);
    // Its own package cache: on this computer only, and of no use once the ticket is gone.
    dropTicketCache(bp, t.id);
    unlinkDecisions(bp, t);
    removeChatsAndShots(bp, t);
    keepRecord(bp, t, mark, local);
    removeTicket(bp, t.id);
    // The ticket's own record is gone now: the log keeps that it went, and who pressed it.
    writeLog({ level: 'info', project: meta.project || bp.projectId, ticket: t.id, text: `${local ? 'Removed from this board' : 'Deleted'} by ${mark.by}: "${t.title}"${notes.length ? `. ${notes.join('. ')}` : ''}` });
    return { id: t.id, title: t.title, notes };
  } catch (err) {
    const why = (err as Error).message.replace(/\.\s*$/, '');
    try {
      updateTicket(bp, first.id, (x) => {
        x.deleting = { ...mark, ...x.deleting, error: why };
        x.status = 'Delete did not finish';
        addActivity(x, 'squad', `Delete did not finish: ${why}`);
      });
    } catch {
      // Its files went already; running Delete again clears what is left.
    }
    throw new BoardActionError(`${first.id} is not fully deleted yet: ${why}. Delete it again to finish; it goes on where it stopped.`);
  }
}

/* ── Archive ────────────────────────────────────────────── */

/** Takes a merged or released ticket off the board. Nothing else changes: its history stays in git and in `.squad/`. */
export function archiveTicket(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const t = requireTicket(bp, id);
  if (t.archived) return t;
  if (!isMerged(t, meta)) {
    throw new BoardActionError(`${t.id} is not merged yet, so it stays on the board. Delete it instead if you no longer want it.`);
  }
  return updateTicket(bp, t.id, (x) => {
    x.archived = { by: meta.user.name, at: now() };
    addActivity(x, 'you', 'Archived it: off the board, its history kept');
  });
}

/** Unarchive: the ticket is on the board again, where it was. */
export function unarchiveTicket(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  if (!t.archived) throw new BoardActionError(`${t.id} is not archived.`);
  return updateTicket(bp, t.id, (x) => {
    delete x.archived;
    addActivity(x, 'you', 'Brought it back to the board');
  });
}
