import type { HostRepoInfo } from '../code-host/types.js';
import { githubApi } from './auth.js';

/**
 * Where a repo's pull requests go. Into the repo itself, a fork too: a team's fork is its own repo, and squad-kit merges
 * there. Only when the engine names an upstream (squad-kit's own code) do they go to that repo, from "owner:branch", and
 * its owners merge them, never squad-kit: a maintainer's own clone of it too. The upstream wins over GitHub's own parent,
 * so a copy of a copy still sends its work to the right repo. A repo's place never changes, so it is asked once and kept
 * a while.
 */

export interface RawRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  fork?: boolean;
  parent?: { full_name: string; default_branch: string };
  permissions?: { push?: boolean };
}

export interface Where {
  /** The repo that holds the pull requests. */
  repo: string;
  /** The owner of the branch's repo, as GitHub names it (a renamed account too). */
  owner: string;
  /** The branch as a pull request names it. */
  head(branch: string): string;
  /** The signed-in person can push to the branch's repo. */
  push: boolean;
  /** Set when the pull requests go to someone else's repo. */
  into?: { repo: string; base: string };
}

export function infoOf(r: RawRepo): HostRepoInfo {
  return {
    repo: r.full_name,
    url: r.html_url,
    gitUrl: { https: r.clone_url, ssh: r.ssh_url },
    defaultBranch: r.default_branch,
    canPush: r.permissions?.push === true,
    ...(r.fork && r.parent ? { parent: r.parent.full_name } : {}),
  };
}

export function rawRepo(repo: string): Promise<RawRepo> {
  return githubApi<RawRepo>(`/repos/${repo}`);
}

async function find(origin: string, upstream?: string): Promise<Where> {
  const own = await rawRepo(origin);
  const owner = own.full_name.split('/')[0]!;
  const push = own.permissions?.push !== false;
  if (!upstream) return { repo: own.full_name, owner, head: (b) => b, push };
  // A maintainer's own clone of the main repo: the pull request opens there too, and its owners merge it, never squad-kit.
  const up = upstream.toLowerCase() === own.full_name.toLowerCase() ? own : await rawRepo(upstream);
  const same = up.full_name.toLowerCase() === own.full_name.toLowerCase();
  return { repo: up.full_name, owner, head: (b) => (same ? b : `${owner}:${b}`), push, into: { repo: up.full_name, base: up.default_branch } };
}

const KEEP_MS = 10 * 60_000;
const kept = new Map<string, { at: number; where: Promise<Where> }>();

export function whereOf(origin: string, upstream?: string): Promise<Where> {
  const key = `${origin.toLowerCase()}\0${upstream?.toLowerCase() ?? ''}`;
  const k = kept.get(key);
  if (k && Date.now() - k.at < KEEP_MS) return k.where;
  const where = find(origin, upstream);
  const entry = { at: Date.now(), where };
  kept.set(key, entry);
  // A failed ask is asked again next time.
  where.catch(() => kept.get(key) === entry && kept.delete(key));
  return where;
}

/** Tests start clean. */
export function forgetWhere(): void {
  kept.clear();
}
