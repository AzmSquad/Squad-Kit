import type { MergeState } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';
import { deleteBranch, getPull, type RawPull } from './pulls.js';

/**
 * squad-kit's merge on GitHub: one look, then a merge commit and the branch goes, when GitHub's own rules allow it now.
 * squad-kit never waits here: checks that still run, or an approval a branch rule asks for, are a wait it looks at again
 * later by itself. A failed check, a draft or a clash is said plainly, and squad-kit never goes around a rule, even when
 * the signed-in person could.
 */

export interface MergePace {
  /** Between two looks while GitHub works out whether it can merge (a few seconds after a push). */
  stepMs: number;
  settleLooks: number;
  /** A pull request this young with no check yet: its checks may still be on their way. */
  graceMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const REAL: MergePace = { stepMs: 3_000, settleLooks: 5, graceMs: 2 * 60_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
let pace = REAL;

/** Tests wait no time. Null goes back to the real pace. */
export function useMergePace(p: Partial<MergePace> | null): void {
  pace = p ? { ...REAL, ...p } : REAL;
}

interface Checks {
  any: boolean;
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
  const out: Checks = { any: Boolean(runs.check_runs?.length || status.statuses?.length), pending: [], failed: [] };
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

type Look = { pr: RawPull; state: 'merged' | 'closed' | 'clash' | 'ready' | 'behind' } | { pr: RawPull; state: 'waiting' | 'refused'; why: string };

/**
 * Where it stands now, by squad-kit's rules: GitHub's own answer, and the checks on its newest commit. `settle`: give
 * GitHub a few seconds to work out whether it can merge, only right before a merge, so one look never waits twice.
 */
async function look(repo: string, n: number, settle = false): Promise<Look> {
  let p = await getPull(repo, n);
  for (let i = 0; settle && p.state === 'open' && !p.merged && p.mergeable === null && i < pace.settleLooks; i++) {
    await pace.sleep(pace.stepMs);
    p = await getPull(repo, n);
  }
  if (p.merged || p.merged_at) return { pr: p, state: 'merged' };
  if (p.state === 'closed') return { pr: p, state: 'closed' };
  if (p.draft) return { pr: p, state: 'refused', why: `Pull request ${n} is a draft on GitHub, so squad-kit does not merge it.` };
  const st = p.mergeable_state ?? 'unknown';
  if (p.mergeable === false || st === 'dirty') return { pr: p, state: 'clash' };
  if (p.mergeable === null) return { pr: p, state: 'waiting', why: `GitHub is still working out whether pull request ${n} can merge.` };
  const checks = await checksOf(repo, p.head.sha);
  if (checks.failed.length) return { pr: p, state: 'refused', why: `GitHub's check "${checks.failed[0]}" failed on pull request ${n}, so squad-kit did not merge it. Look at the check on GitHub, then merge it there or press Check again.` };
  if (checks.pending.length) return { pr: p, state: 'waiting', why: `Pull request ${n} waits for its checks on GitHub (${checks.pending.slice(0, 3).join(', ')}).` };
  if (st === 'behind') return { pr: p, state: 'behind' };
  if (st === 'blocked') return { pr: p, state: 'waiting', why: `Pull request ${n} waits for what the branch rule on ${p.base.ref} asks, such as a person's approving review on GitHub.` };
  const young = !checks.any && pace.now() - Date.parse(p.created_at ?? '') < pace.graceMs;
  if (young) return { pr: p, state: 'waiting', why: `Pull request ${n} is new: squad-kit gives its checks a moment to start.` };
  if (['clean', 'unstable', 'has_hooks'].includes(st)) return { pr: p, state: 'ready' };
  return { pr: p, state: 'waiting', why: `Pull request ${n} is not ready to merge on GitHub yet.` };
}

export async function pullState(repo: string, n: number): Promise<MergeState> {
  const l = await look(repo, n);
  if (l.state === 'ready') return 'mergeable';
  if (l.state === 'merged' || l.state === 'closed' || l.state === 'clash') return l.state;
  return 'waiting';
}

/** Pull requests squad-kit already brought the newest base into: once, never in a loop. Kept while the board runs. */
const updated = new Set<string>();

export async function mergePull(repo: string, n: number, message: string): Promise<{ commit: string }> {
  for (let tries = 0; ; tries++) {
    const l = await look(repo, n, true);
    const p = l.pr;
    if (l.state === 'merged') return { commit: p.merge_commit_sha ?? '' };
    if (l.state === 'closed') throw new ModuleError(`Pull request ${n} was closed on GitHub without merging.`, 'other', 410);
    if (l.state === 'clash') throw new ModuleError(`Pull request ${n} clashes with newer work in ${p.base.ref} on GitHub.`, 'clash', 409);
    if (l.state === 'refused') throw new ModuleError(l.why, 'other', 405);
    if (l.state === 'waiting') throw new ModuleError(l.why, 'waiting');
    const key = `${repo.toLowerCase()}#${n}`;
    if (l.state === 'behind') {
      if (updated.has(key)) throw new ModuleError(`${p.base.ref} moved on GitHub again after squad-kit brought it into pull request ${n} once, so squad-kit stops here instead of trying forever. Merge it on GitHub, or press Check again later.`, 'other', 405);
      // The branch rule asks for the newest base: GitHub brings it in, and the checks run again.
      await githubApi(`/repos/${repo}/pulls/${n}/update-branch`, { method: 'PUT', body: { expected_head_sha: p.head.sha } });
      updated.add(key);
      throw new ModuleError(`GitHub is bringing the newest ${p.base.ref} into pull request ${n}, so its checks run again.`, 'waiting');
    }
    try {
      const done = await githubApi<{ merged: boolean; sha: string }>(`/repos/${repo}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: 'merge', commit_title: message, sha: p.head.sha } });
      updated.delete(key);
      // Only a branch of this same repo goes: a copy's branch is its owner's.
      if (p.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()) await deleteBranch(repo, p.head.ref).catch(() => undefined);
      return { commit: done.sha };
    } catch (err) {
      // Someone pushed to the branch meanwhile: looked at again, once.
      if (err instanceof ModuleError && err.status === 409 && tries === 0) continue;
      if (err instanceof ModuleError && err.status === 405) throw new ModuleError(`GitHub did not merge pull request ${n}: ${err.message.replace(/^GitHub said 405: /, '')}`, 'other', 405);
      throw err;
    }
  }
}
