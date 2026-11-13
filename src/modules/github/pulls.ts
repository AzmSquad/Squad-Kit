import type { PullRequest } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';
import type { Where } from './where.js';

/** GitHub's pull requests, as squad-kit uses them: find, open, describe, ask where one stands, close. */

export interface RawPull {
  number: number;
  html_url: string;
  created_at?: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  draft?: boolean;
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base: { ref: string };
}

/** GitHub takes at most 65,536 characters in a description. */
const MOST_BODY = 65_000;

const body = (text: string) => (text.length > MOST_BODY ? `${text.slice(0, MOST_BODY)}\n\n(cut short: the whole record is on the squad-kit board)` : text);

const asPr = (p: RawPull): PullRequest => ({ id: p.number, url: p.html_url });

/** Every page of a list, 100 at a time, at most 1,000. */
export async function paged<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const join = path.includes('?') ? '&' : '?';
    const rows = await githubApi<T[]>(`${path}${join}per_page=100&page=${page}`);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export function getPull(repo: string, n: number): Promise<RawPull> {
  return githubApi<RawPull>(`/repos/${repo}/pulls/${n}`);
}

/** The pull request from `branch` of the branch's repo: the open one, or the newest of any state. */
export async function findPull(w: Where, branch: string, state: 'open' | 'all'): Promise<PullRequest | null> {
  const q = new URLSearchParams({ state, head: `${w.owner}:${branch}`, sort: 'created', direction: 'desc' });
  const rows = await githubApi<RawPull[]>(`/repos/${w.repo}/pulls?${q.toString()}`);
  return rows[0] ? asPr(rows[0]) : null;
}

export async function openPull(w: Where, o: { source: string; base: string; title: string; description: string }): Promise<PullRequest> {
  try {
    const p = await githubApi<RawPull>(`/repos/${w.repo}/pulls`, { method: 'POST', body: { title: o.title, head: w.head(o.source), base: o.base, body: body(o.description), maintainer_can_modify: true } });
    return asPr(p);
  } catch (err) {
    // Opened meanwhile (a retry after a cut connection): that one is it.
    if (err instanceof ModuleError && err.status === 422 && /already exists/i.test(err.message)) {
      const found = await findPull(w, o.source, 'open');
      if (found) return found;
    }
    throw err;
  }
}

export async function describePull(repo: string, n: number, description: string): Promise<void> {
  await githubApi(`/repos/${repo}/pulls/${n}`, { method: 'PATCH', body: { body: body(description) } });
}

export async function closePull(repo: string, n: number): Promise<void> {
  await githubApi(`/repos/${repo}/pulls/${n}`, { method: 'PATCH', body: { state: 'closed' } });
}

/** Deletes a branch of the repo, after its merge. Gone already (GitHub deletes merged branches itself when asked to): fine. */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  await githubApi(`/repos/${repo}/git/refs/heads/${ref}`, { method: 'DELETE' }).catch((err: unknown) => {
    if (err instanceof ModuleError && (err.status === 422 || err.status === 404)) return;
    throw err;
  });
}
