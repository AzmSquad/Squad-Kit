import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addActivity, now, readMeta, updateTicket, type BoardPaths } from '../board/store.js';
import type { BoardMeta, Ticket } from '../board/types.js';
import { depsReady, openOnBoard, unmergedDeps } from '../board/depends.js';
import { changedFiles, commitArgsFor, git, isAncestor, pushedBranch, removeWorktree, stageAll, worktreeRoot } from './git.js';
import type { OpenTicket } from './prompts.js';
import { repoFor } from './repos.js';

/**
 * Tickets that depend on unmerged work, on the engine's side: what the Analyst and the Architect see of the other open
 * tickets, a ticket's copy that starts from the work of the ticket it depends on, and bringing in the base once that
 * ticket is merged.
 */

/** At most this many files per open ticket go to the agents. */
const MAX_FILES = 20;

/** The other open tickets, with the files each one's branch (or its copy of the code) changed. */
export function openTicketsFor(bp: BoardPaths, t: Ticket): OpenTicket[] {
  const meta = readMeta(bp);
  return openOnBoard(bp, t.id).map((o) => ({ id: o.id, title: o.title, stage: o.stage, files: branchFiles(bp, meta, o) }));
}

function branchFiles(bp: BoardPaths, meta: BoardMeta, o: Ticket): string[] {
  try {
    const repo = repoFor(meta, o);
    const root = path.join(bp.root, repo.path);
    let files: string[] = [];
    if (o.worktree && fs.existsSync(o.worktree) && o.baseCommit) files = changedFiles(o.worktree, o.baseCommit);
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
export function addWorktreeOn(bp: BoardPaths, t: Ticket, dep: Ticket): { dir: string; branch: string; baseCommit: string; from: string } {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t);
  if (repoFor(meta, dep).path !== repo.path) throw new Error(`${dep.id} changes another repo (${repoFor(meta, dep).path}), so ${t.id} cannot start from its branch. Build anyway, or wait for it.`);
  const root = path.join(bp.root, repo.path);
  const start = workOf(bp, root, dep, repo.base);
  if (!start) throw new Error(`${dep.id} has no code yet to build on. Wait for it, or build anyway.`);
  const dir = path.join(worktreeRoot(root), t.id.toLowerCase());
  const branch = `squad/${t.id.toLowerCase()}`;
  const from = `${dep.id}'s work so far`;
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, baseCommit: start, from };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
  if (!git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })) {
    git(root, ['worktree', 'add', '-b', branch, dir, start]);
  } else {
    // Its branch is there already (its documents travelled on it): the other ticket's work comes in on top.
    git(root, ['worktree', 'add', dir, branch]);
    if (!isAncestor(dir, start, 'HEAD')) {
      try {
        git(dir, [...commitArgsFor(dir), 'merge', '--no-ff', '-m', `Start from ${from}`, start]);
      } catch (err) {
        git(dir, ['merge', '--abort'], { allowFail: true });
        removeWorktree(root, dir);
        throw new Error(`${t.id}'s branch clashes with ${from}, so it cannot start from it: ${(err as Error).message}`);
      }
    }
  }
  updateTicket(bp, t.id, (x) => {
    if (x.dependency) x.dependency.from = start;
  });
  return { dir, branch, baseCommit: start, from };
}

/** The commit a copy starts from: the other ticket's code now, on the point where it left the base. */
function workOf(bp: BoardPaths, root: string, dep: Ticket, base: string): string | null {
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
    if (copy) stageAll(cwd, env);
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
      addActivity(x, 'squad', `${c!.on.join(' and ')} ${c!.on.length === 1 ? 'is' : 'are'} merged, so squad-kit brings the latest ${base} into this ticket before the checks`);
    }
    delete x.baseWanted;
    x.status = `Bringing in the latest ${base}`;
    // A stop or a failure on the way runs this again, not the checks without it.
    if (x.squad) x.squad.phase = 'update-base';
  });
  return 'update-base';
}
