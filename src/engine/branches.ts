import path from 'node:path';
import { listTickets, readMeta, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { repoHostFor } from '../modules/registry.js';
import { git, isAncestor, isRepo, netGit, remotes } from './git.js';
import { reposOf } from './repos.js';

/**
 * Old ticket branches. Each ticket gets a branch (squad/<id>), and after its release that branch only fills the list.
 * The branches of released tickets go: on this computer always (after each release, or `squad branches --clean`), on
 * the remote only when the person asks (`--remote`). A branch with work that is not in the base is never deleted.
 */

export interface OldBranch {
  /** The repo's folder in the project, '.' for the project itself. */
  repo: string;
  branch: string;
  ticket: string;
  /** For a branch on a remote: the remote's name. */
  remote?: string;
  /** The commit the branch is at, so a branch someone moved since is never deleted. */
  sha: string;
}

export interface BranchPlan {
  here: OldBranch[];
  remote: OldBranch[];
  /** Released tickets whose branch stays, and why. */
  kept: { branch: string; why: string }[];
}

function lines(root: string, args: string[]): string[] {
  return git(root, args, { allowFail: true }).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Branches a copy of the code still has checked out: git refuses to delete those, and they are in use. */
function inUse(root: string): Set<string> {
  return new Set(lines(root, ['worktree', 'list', '--porcelain']).filter((l) => l.startsWith('branch refs/heads/')).map((l) => l.slice('branch refs/heads/'.length)));
}

/** A branch belongs to a released ticket on this board: named by the ticket, or as the ticket recorded it. */
function releasedTicket(tickets: Ticket[], branch: string): Ticket | undefined {
  return tickets.find((t) => t.stage === 'done' && (t.branch === branch || `squad/${t.id.toLowerCase()}` === branch));
}

/** What `squad branches --clean` would delete, here and on the remotes, and what it keeps. `only`: just these tickets. */
export function oldBranches(bp: BoardPaths, only?: string[]): BranchPlan {
  const meta = readMeta(bp);
  const tickets = listTickets(bp).filter((t) => !only || only.includes(t.id));
  const plan: BranchPlan = { here: [], remote: [], kept: [] };
  for (const repo of reposOf(meta)) {
    const root = path.join(bp.root, repo.path);
    if (!isRepo(root)) continue;
    const base = repo.base;
    const used = inUse(root);
    for (const branch of lines(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/squad'])) {
      const t = releasedTicket(tickets, branch);
      if (!t) continue;
      if (used.has(branch)) plan.kept.push({ branch, why: 'a copy of the code still uses it' });
      else if (!isAncestor(root, branch, base)) plan.kept.push({ branch, why: `it has work that is not in ${base}` });
      else plan.here.push({ repo: repo.path, branch, ticket: t.id, sha: git(root, ['rev-parse', branch]) });
    }
    const remote = repo.remote || remotes(root)[0];
    const there = remote ? git(root, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${base}`], { allowFail: true }) : '';
    if (!remote || !there) continue;
    for (const ref of lines(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/squad`])) {
      const branch = ref.slice(`refs/remotes/${remote}/`.length);
      const t = releasedTicket(tickets, branch);
      if (!t) continue;
      if (!isAncestor(root, ref, there)) plan.kept.push({ branch: `${remote}/${branch}`, why: `it has work that is not in ${remote}/${base}` });
      else plan.remote.push({ repo: repo.path, branch, ticket: t.id, remote, sha: git(root, ['rev-parse', ref]) });
    }
  }
  return plan;
}

export interface BranchClean {
  deleted: string[];
  failed: string[];
  /** What is left on the remotes, when they were not asked for. */
  remoteLeft: OldBranch[];
  kept: BranchPlan['kept'];
}

/**
 * Deletes the old branches of released tickets on this computer, and on the remotes with `remote`. The remotes are
 * fetched first, and a branch someone moved since is left as it is.
 */
export function cleanBranches(bp: BoardPaths, opts: { remote?: boolean; only?: string[] } = {}): BranchClean {
  const meta = readMeta(bp);
  if (opts.remote) {
    for (const repo of reposOf(meta)) {
      const root = path.join(bp.root, repo.path);
      const remote = isRepo(root) ? repo.remote || remotes(root)[0] : undefined;
      if (remote) netGit(root, ['fetch', '--prune', remote], { env: hostEnv(bp, root, remote), allowFail: true });
    }
  }
  const plan = oldBranches(bp, opts.only);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const b of plan.here) {
    const root = path.join(bp.root, b.repo);
    try {
      // Only from where it was looked at: a branch that moved meanwhile stays.
      git(root, ['update-ref', '-d', `refs/heads/${b.branch}`, b.sha]);
      deleted.push(b.branch);
    } catch (err) {
      failed.push(`${b.branch}: ${(err as Error).message}`);
    }
  }
  if (opts.remote) {
    for (const b of plan.remote) {
      const root = path.join(bp.root, b.repo);
      try {
        netGit(root, ['push', `--force-with-lease=refs/heads/${b.branch}:${b.sha}`, b.remote!, '--delete', b.branch], { env: hostEnv(bp, root, b.remote!) });
        deleted.push(`${b.remote}/${b.branch}`);
      } catch (err) {
        failed.push(`${b.remote}/${b.branch}: ${(err as Error).message}`);
      }
    }
  }
  return { deleted, failed, remoteLeft: opts.remote ? [] : plan.remote, kept: plan.kept };
}

function hostEnv(bp: BoardPaths, root: string, remote: string): Record<string, string> {
  const url = git(root, ['config', '--get', `remote.${remote}.url`], { allowFail: true });
  return url ? (repoHostFor(bp, url)?.gitEnv() ?? {}) : {};
}
