import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addActivity, now, readMeta, updateTicket, type BoardPaths } from '../board/store.js';
import type { BoardMeta, Ticket } from '../board/types.js';
import { depsReady, openOnBoard, unmergedDeps } from '../board/depends.js';
import { changedFiles, clearHalfCopy, commitArgsFor, copyIsWhole, copyTurn, git, gitLater, isAncestor, makeCopy, pushedBranch, removeWorktree, stageAllLater, worktreeRoot, type CopyHow } from './git.js';
import type { OpenTicket } from './prompts.js';
import { repoFor } from './repos.js';
import { writeLog } from '../core/app-log.js';
import { trackTask } from './process-group.js';

/**
 * Tickets that depend on unmerged work, on the engine's side: what the Analyst and the Architect see of the other open
 * tickets, a ticket's copy that starts from the work of the ticket it depends on, and bringing in the base once that
 * ticket is merged.
 */

/** At most this many files per open ticket go to the agents. */
const MAX_FILES = 20;

/** The other open tickets, with the files each one's branch (or its copy of the code) changed. */
export async function openTicketsFor(bp: BoardPaths, t: Ticket): Promise<OpenTicket[]> {
  const meta = readMeta(bp);
  const open: OpenTicket[] = [];
  for (const o of openOnBoard(bp, t.id)) open.push({ id: o.id, title: o.title, stage: o.stage, files: await branchFiles(bp, meta, o) });
  return open;
}

async function branchFiles(bp: BoardPaths, meta: BoardMeta, o: Ticket): Promise<string[]> {
  try {
    const repo = repoFor(meta, o);
    const root = path.join(bp.root, repo.path);
    let files: string[] = [];
    if (o.worktree && fs.existsSync(o.worktree) && o.baseCommit) files = await changedFiles(o.worktree, o.baseCommit);
    else {
      const ref = branchRef(root, o);
      const fork = ref ? git(root, ['merge-base', repo.base, ref], { allowFail: true }) : '';
      if (ref && fork) files = git(root, ['diff', '--name-only', fork, ref], { allowFail: true }).split('\n').filter(Boolean);
    }
    const squad = squadIn(bp, root);
    files = files.filter((f) => !(squad && (f === squad || f.startsWith(`${squad}/`))));
    if (meta.repos?.length) files = files.map((f) => `${repo.path}/${f}`);
    return files.length > MAX_FILES ? [...files.slice(0, MAX_FILES), `and ${files.length - MAX_FILES} more`] : files;
  } catch {
    return [];
  }
}

/** `.squad/` as a path inside the repo, or '' when it sits outside it. */
function squadIn(bp: BoardPaths, root: string): string {
  const rel = path.relative(root, bp.squadDir).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
}

/** A ticket's branch on this computer, else as someone pushed it. */
function branchRef(root: string, t: Ticket): string | null {
  const branch = t.branch ?? `squad/${t.id.toLowerCase()}`;
  if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })) return `refs/heads/${branch}`;
  return pushedBranch(root, branch);
}

/** "Build on RO-1's branch", before the copy exists: the one ticket whose work the copy starts from, or null. */
export function dependencyToStartFrom(bp: BoardPaths, t: Ticket): Ticket | null {
  if (t.dependency?.way !== 'branch' || (t.worktree && fs.existsSync(t.worktree))) return null;
  return unmergedDeps(bp, t).find((d) => t.dependency!.on.includes(d.id)) ?? null;
}

/**
 * The ticket's copy, started from the work of the ticket it depends on: one commit on the point where that ticket left
 * the base, with its code as it is now (its copy, else its branch here or as pushed). Nothing of the other ticket
 * moves: not its copy, its index or its branch. squad-kit's own `.squad/` files stay as the base has them, so its
 * documents never travel on this branch.
 */
export async function addWorktreeOn(bp: BoardPaths, t: Ticket, dep: Ticket, at?: string, how: CopyHow = {}): Promise<{ dir: string; branch: string; baseCommit: string; from: string }> {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t);
  if (repoFor(meta, dep).path !== repo.path) throw new Error(`${dep.id} changes another repo (${repoFor(meta, dep).path}), so ${t.id} cannot start from its branch. Build anyway, or wait for it.`);
  const root = path.join(bp.root, repo.path);
  const start = await workOf(bp, root, dep, repo.base);
  if (!start) throw new Error(`${dep.id} has no code yet to build on. Wait for it, or build anyway.`);
  const dir = at ?? path.join(worktreeRoot(root), t.id.toLowerCase());
  const branch = `squad/${t.id.toLowerCase()}`;
  const from = `${dep.id}'s work so far`;
  const whole = await copyTurn(dir, async () => {
    await clearHalfCopy(root, dir, how.signal);
    if (copyIsWhole(dir)) return true;
    if (!git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })) {
      await makeCopy(root, dir, ['-b', branch], start, how, { branch, start });
      return false;
    }
    // Its branch is there already (its documents travelled on it): the other ticket's work comes in on top.
    await makeCopy(root, dir, [], branch, how);
    if (isAncestor(dir, start, 'HEAD')) return false;
    try {
      await gitLater(dir, [...commitArgsFor(dir), 'merge', '--no-ff', '-m', `Start from ${from}`, start]);
    } catch (err) {
      await gitLater(dir, ['merge', '--abort'], { allowFail: true });
      void trackTask(removeWorktree(root, dir));
      writeLog({ level: 'warn', ticket: t.id, text: `Starting from ${from}: ${(err as Error).message}` });
      throw new Error(`${t.id}'s work clashes with ${from}, so it cannot start from it.`);
    }
    return false;
  });
  if (whole) return { dir, branch, baseCommit: start, from };
  updateTicket(bp, t.id, (x) => {
    if (x.dependency) x.dependency.from = start;
  });
  return { dir, branch, baseCommit: start, from };
}

/** The commit a copy starts from: the other ticket's code now, on the point where it left the base. */
async function workOf(bp: BoardPaths, root: string, dep: Ticket, base: string): Promise<string | null> {
  const copy = dep.worktree && fs.existsSync(dep.worktree) ? dep.worktree : null;
  const tip = copy ? 'HEAD' : branchRef(root, dep);
  if (!tip) return null;
  const cwd = copy ?? root;
  const fork = git(cwd, ['merge-base', base, tip], { allowFail: true });
  if (!fork) return null;
  // A separate index: the other ticket's own index and files are never touched.
  const index = path.join(os.tmpdir(), `squad-start-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(cwd, ['read-tree', tip], { env });
    if (copy) await stageAllLater(cwd, env);
    const squad = squadIn(bp, root);
    if (squad) git(cwd, ['reset', '-q', fork, '--', squad], { env, allowFail: true });
    const tree = git(cwd, ['write-tree'], { env });
    return git(cwd, [...commitArgsFor(cwd), 'commit-tree', tree, '-p', fork, '-m', `${dep.id}: work so far, for the tickets that build on it`]);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Steps before which the base comes in: the checks run on it, and the review and the proof after them. */
const CATCH_UP_BEFORE = new Set(['test', 'review', 'proof']);

/**
 * Between steps: the base comes into the ticket's copy before its next checks, when the person pressed "Bring in
 * latest main", or when the ticket it was built on is merged now. Returns the step to run instead of `planned`, and
 * says so on the ticket. A Builder step that runs goes on; the base comes in after it.
 */
export function catchUp(bp: BoardPaths, t: Ticket, planned: string): string {
  if (!CATCH_UP_BEFORE.has(planned) || !t.worktree || !fs.existsSync(t.worktree)) return planned;
  const c = t.dependency;
  const due = c?.way === 'branch' && !c.caughtUp && depsReady(bp, c.on);
  if (!t.baseWanted && !due) return planned;
  const base = repoFor(readMeta(bp), t).base;
  updateTicket(bp, t.id, (x) => {
    if (due && x.dependency) {
      x.dependency.caughtUp = now();
      addActivity(x, 'squad', `${c!.on.join(' and ')} ${c!.on.length === 1 ? 'is' : 'are'} merged, so squad-kit brings the newest code into this ticket before the checks`);
    }
    delete x.baseWanted;
    x.status = `Bringing in the newest code`;
    // A stop or a failure on the way runs this again, not the checks without it.
    if (x.squad) x.squad.phase = 'update-base';
  });
  return 'update-base';
}
