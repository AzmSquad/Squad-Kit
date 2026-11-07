import type { Ticket } from '../board/types.js';
import { addSnapshot, commitArgsFor, dropSnapshot, git, pushedBranch } from './git.js';
import { writeLog } from '../core/app-log.js';

/**
 * Taking a ticket out of a release. Accepted work merges into the base at once, so the code of a ticket taken out is
 * in the base already. The release leaves it out instead: in the release's own copy its merge is undone before the
 * release commit, and done again right after the tag. The tag has the release without it; the base keeps it, and it
 * goes out with the next release.
 */

/** The merge that brought a ticket into the base: the merge commit on the base whose second parent is its branch. */
export function mergeCommitOf(root: string, base: string, t: Ticket): string | null {
  const branch = t.branch ?? `squad/${t.id.toLowerCase()}`;
  const refs = [git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true }) ? `refs/heads/${branch}` : '', pushedBranch(root, branch) ?? ''];
  const tips = new Set(refs.filter(Boolean).map((r) => git(root, ['rev-parse', r], { allowFail: true })).filter(Boolean));
  if (!tips.size) return null;
  const merges = git(root, ['rev-list', '--first-parent', '--merges', '-n', '500', base], { allowFail: true }).split('\n').filter(Boolean);
  for (const m of merges) {
    const second = git(root, ['rev-parse', '--verify', '-q', `${m}^2`], { allowFail: true });
    if (second && tips.has(second)) return m;
  }
  return null;
}

/** Why these tickets cannot be left out of a release made from `base` now, or null when they can. Changes nothing. */
export function leaveOutProblem(root: string, base: string, tickets: Ticket[]): string | null {
  const found = tickets.map((t) => ({ t, merge: mergeCommitOf(root, base, t) }));
  const missing = found.find((x) => !x.merge);
  if (missing) return `${missing.t.id}'s merge into ${base} was not found (it may have gone in as one squashed commit), so the release cannot leave it out.`;
  const dir = addSnapshot(root, 'leave-out-check', base);
  try {
    for (const { t, merge } of found) {
      try {
        // A check in a throwaway copy, and later a revert of accepted work: the project's hooks have nothing to say on it.
        git(dir, [...commitArgsFor(dir), 'revert', '--no-edit', '-m', '1', merge!]);
      } catch {
        git(dir, ['revert', '--abort'], { allowFail: true });
        return `${t.id} cannot be left out: work merged into ${base} after it changed the same lines.`;
      }
    }
    return null;
  } finally {
    dropSnapshot(root, dir);
  }
}

/** In the release's copy: undoes each ticket's merge, one commit each. Returns those commits, oldest first. */
export function leaveOut(dir: string, root: string, base: string, tickets: Ticket[], version: string, log: { ok: boolean; text: string }[]): string[] {
  const done: string[] = [];
  for (const t of tickets) {
    const merge = mergeCommitOf(root, base, t);
    if (!merge) throw new Error(`${t.id}'s merge into ${base} was not found, so the release cannot leave it out. Put it back into ${version}, or release later.`);
    try {
      git(dir, ['revert', '--no-commit', '-m', '1', merge]);
    } catch {
      git(dir, ['revert', '--abort'], { allowFail: true });
      throw new Error(`${t.id} cannot be left out of ${version}: work merged into ${base} after it changed the same lines. Put it back, or take that work out too.`);
    }
    if (!git(dir, ['status', '--porcelain'], { allowFail: true })) continue;
    git(dir, [...commitArgsFor(dir), 'commit', '-m', `Leave ${t.id} out of ${version}: it goes out with the next release`]);
    done.push(git(dir, ['rev-parse', 'HEAD']));
    log.push({ ok: true, text: `Left ${t.id} ${t.title} out: its work stays in the code and goes out with the next release` });
  }
  return done;
}

/** After the tag: the tickets left out come back, so the base keeps their code. */
export function bringBack(dir: string, reverts: string[], version: string, base: string): void {
  for (const r of [...reverts].reverse()) {
    try {
      git(dir, ['revert', '--no-commit', r]);
    } catch (err) {
      git(dir, ['revert', '--abort'], { allowFail: true });
      writeLog({ level: 'error', text: `Bringing back the work left out of ${version}: ${(err as Error).message}` });
      throw new Error(`The work left out of ${version} could not come back into ${base}. An engineer can see why in the log.`);
    }
    if (git(dir, ['status', '--porcelain'], { allowFail: true })) git(dir, [...commitArgsFor(dir), 'commit', '-m', `Bring back the work left out of ${version}`]);
  }
}
