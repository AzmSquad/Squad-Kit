import type { HostRepoInfo } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';

/**
 * Where a repo's pull requests go: into the repo itself, or, for a copy (a fork, or squad-kit's own code with an
 * upstream), into the repo it came from, with the branch named "owner:branch". A repo's place never changes, so it is
 * asked once and kept a while.
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
  /** The branch as a pull request names it. */
  head(branch: string): string;
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
  let into = own.fork && own.parent ? { repo: own.parent.full_name, base: own.parent.default_branch } : undefined;
  if (!into && upstream && upstream.toLowerCase() !== own.full_name.toLowerCase()) {
    const up = await rawRepo(upstream);
    into = { repo: up.full_name, base: up.default_branch };
  }
  if (!into) {
    if (own.permissions?.push === false) throw new ModuleError(`You can't send changes to ${own.full_name} itself. Make your own copy of it (a fork) on GitHub first, then try again.`, 'other', 403);
    return { repo: own.full_name, head: (b) => b };
  }
  const owner = own.full_name.split('/')[0]!;
  return { repo: into.repo, head: (b) => `${owner}:${b}`, into };
}

const KEEP_MS = 10 * 60_000;
const kept = new Map<string, { at: number; where: Promise<Where> }>();

export function whereOf(origin: string, upstream?: string): Promise<Where> {
  const key = `${origin.toLowerCase()}\0${upstream?.toLowerCase() ?? ''}`;
  const k = kept.get(key);
  if (k && Date.now() - k.at < KEEP_MS) return k.where;
  const where = find(origin, upstream);
  kept.set(key, { at: Date.now(), where });
  // A failed ask is asked again next time.
  where.catch(() => kept.delete(key));
  return where;
}

/** Tests start clean. */
export function forgetWhere(): void {
  kept.clear();
}
