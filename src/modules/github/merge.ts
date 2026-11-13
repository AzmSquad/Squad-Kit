import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';
import { deleteBranch, getPull, type RawPull } from './pulls.js';

/**
 * squad-kit's merge on GitHub: a merge commit, then the branch goes. GitHub's own rules stay in charge. While the checks
 * run, squad-kit waits; a failed check, a clash or a branch rule that asks for a person's review is said plainly, and
 * squad-kit never goes around it, even when the signed-in person could.
 */

export interface MergePace {
  /** Between two looks. */
  stepMs: number;
  /** At most this long in all, then the pull request waits on GitHub and squad-kit looks again later. */
  waitMs: number;
  /** A branch rule that holds it with no check running yet: a check may still be on its way. */
  graceMs: number;
  sleep(ms: number): Promise<void>;
}

const REAL: MergePace = { stepMs: 10_000, waitMs: 15 * 60_000, graceMs: 2 * 60_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let pace = REAL;

/** Tests wait no time. Null goes back to the real pace. */
export function useMergePace(p: Partial<MergePace> | null): void {
  pace = p ? { ...REAL, ...p } : REAL;
}

interface Checks {
  pending: string[];
  failed: string[];
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** The checks on a commit: GitHub's check runs and the older commit statuses. */
async function checksOf(repo: string, sha: string): Promise<Checks> {
  const [runs, status] = await Promise.all([
    githubApi<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    githubApi<{ statuses: { context: string; state: string }[] }>(`/repos/${repo}/commits/${sha}/status`),
  ]);
  const out: Checks = { pending: [], failed: [] };
  for (const r of runs.check_runs ?? []) {
    if (r.status !== 'completed') out.pending.push(r.name);
    else if (r.conclusion && FAILED.has(r.conclusion)) out.failed.push(r.name);
  }
  for (const s of status.statuses ?? []) {
    if (s.state === 'pending') out.pending.push(s.context);
    else if (s.state === 'failure' || s.state === 'error') out.failed.push(s.context);
  }
  return out;
}

const refused = (message: string, status = 405) => new ModuleError(message, 'other', status);

/** Waits until it can merge, or says why it cannot. */
async function readyPull(repo: string, n: number): Promise<RawPull> {
  const start = Date.now();
  let updated = false;
  for (;;) {
    const p = await getPull(repo, n);
    if (p.merged) return p;
    if (p.state === 'closed') throw refused(`Pull request ${n} was closed on GitHub without merging.`, 410);
    if (p.draft) throw refused(`Pull request ${n} is a draft on GitHub, so squad-kit does not merge it.`);
    if (p.mergeable === false || p.mergeable_state === 'dirty') throw new ModuleError(`Pull request ${n} clashes with newer work in ${p.base.ref} on GitHub.`, 'clash', 409);
    const checks = await checksOf(repo, p.head.sha);
    if (checks.failed.length) throw refused(`GitHub's check "${checks.failed[0]}" failed on pull request ${n}, so squad-kit did not merge it. Look at the check on GitHub, then merge it there or try again.`);
    const st = p.mergeable_state ?? 'unknown';
    if (p.mergeable === true && ['clean', 'unstable', 'has_hooks'].includes(st) && !checks.pending.length) return p;
    const waited = Date.now() - start;
    // The branch rule asks for the newest base: GitHub brings it in, once, and the checks run again.
    if (st === 'behind' && !updated) {
      await githubApi(`/repos/${repo}/pulls/${n}/update-branch`, { method: 'PUT', body: { expected_head_sha: p.head.sha } });
      updated = true;
    } else if (st === 'blocked' && !checks.pending.length && waited >= pace.graceMs) {
      throw refused(`The branch rule on ${p.base.ref} asks for more before pull request ${n} can merge, such as a person's approving review. squad-kit never goes around it: once someone approves it on GitHub, squad-kit sees the merge.`);
    }
    if (waited >= pace.waitMs) {
      const what = checks.pending.length ? ` for its checks (${checks.pending.slice(0, 3).join(', ')})` : '';
      throw new ModuleError(`Pull request ${n} is still waiting on GitHub${what}, so it is not merged yet.`);
    }
    await pace.sleep(pace.stepMs);
  }
}

export async function mergePull(repo: string, n: number, message: string): Promise<{ commit: string }> {
  for (let tries = 0; ; tries++) {
    const p = await readyPull(repo, n);
    if (p.merged) return { commit: p.merge_commit_sha ?? '' };
    try {
      const done = await githubApi<{ merged: boolean; sha: string }>(`/repos/${repo}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: 'merge', commit_title: message, sha: p.head.sha } });
      // Only a branch of this same repo goes: a copy's branch is its owner's.
      if (p.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()) await deleteBranch(repo, p.head.ref).catch(() => undefined);
      return { commit: done.sha };
    } catch (err) {
      // Someone pushed to the branch meanwhile: looked at again, once.
      if (err instanceof ModuleError && err.status === 409 && tries === 0) continue;
      if (err instanceof ModuleError && err.status === 405) throw refused(`GitHub did not merge pull request ${n}: ${err.message.replace(/^GitHub said 405: /, '')}`);
      throw err;
    }
  }
}
