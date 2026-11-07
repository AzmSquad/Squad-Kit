import fs from 'node:fs';
import path from 'node:path';
import { git, latestBase, pushedBranch, worktreeRoot } from '../../src/engine/git.js';

/**
 * A ticket's copy for a test's setup, made in one go. The engine makes its own beside everything else (addWorktree in
 * src/engine/git.ts, tested in test/big-project.test.ts); a test about something else only needs one to be there.
 */
export function addWorktree(projectRoot: string, ticketId: string, base: string, remote?: string, at?: string): { dir: string; branch: string; baseCommit: string; pushed?: string } {
  const dir = at ?? path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
  const branch = `squad/${ticketId.toLowerCase()}`;
  let baseCommit = git(projectRoot, ['rev-parse', base]);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, baseCommit };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = git(projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true });
  const pushed = exists ? null : pushedBranch(projectRoot, branch);
  if (!exists && !pushed && remote) baseCommit = latestBase(projectRoot, base, remote).sha;
  git(projectRoot, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, pushed ?? baseCommit]);
  if (!pushed) return { dir, branch, baseCommit };
  return { dir, branch, baseCommit: git(projectRoot, ['merge-base', base, pushed], { allowFail: true }) || baseCommit, pushed: pushed.replace(/^refs\/remotes\//, '') };
}
