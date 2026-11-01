import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../core/home.js';

/** Small git helpers. The squad never touches the person's own checkout: each ticket gets a worktree. */

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}): string {
  try {
    const env = opts.env ? { ...process.env, ...opts.env } : undefined;
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    const e = err as { stderr?: Buffer | string; message: string };
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(-3).join(' ');
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export function isRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
}

export function hasCommits(dir: string): boolean {
  return git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }) !== '';
}

/** A new project starts as an empty folder: give it a repo and a first commit so tickets can branch. */
export function ensureRepo(dir: string, projectName: string): void {
  if (!isRepo(dir)) git(dir, ['init', '-b', 'main']);
  if (!hasCommits(dir)) {
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${projectName}\n`, 'utf8');
    // Commit the .gitignore that `squad init` wrote too, so tickets build on it instead of clashing with it.
    git(dir, ['add', 'README.md', ...(fs.existsSync(path.join(dir, '.gitignore')) ? ['.gitignore'] : [])]);
    git(dir, authorArgs(dir).concat(['commit', '-m', 'start the project']));
  }
  excludeLocal(dir, ['.squad/board/squad.pid']);
}

/** Ignore squad-kit's own runtime files without editing the project's .gitignore. */
function excludeLocal(dir: string, patterns: string[]): void {
  const gitDir = git(dir, ['rev-parse', '--git-common-dir'], { allowFail: true });
  if (!gitDir) return;
  const file = path.resolve(dir, gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = patterns.filter((p) => !current.split('\n').includes(p));
  if (missing.length) fs.appendFileSync(file, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`);
}

export function currentBranch(dir: string): string {
  // symbolic-ref also works on a brand-new repo that has no commits yet.
  return git(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true }) || git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || 'main';
}

export function remotes(dir: string): string[] {
  return git(dir, ['remote'], { allowFail: true }).split('\n').filter(Boolean);
}

/** Worktrees live outside the project folder so searches in the project never see them. */
export function worktreeRoot(projectRoot: string): string {
  const hash = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 8);
  return path.join(squadHome(), 'worktrees', `${path.basename(projectRoot)}-${hash}`);
}

export function addWorktree(projectRoot: string, ticketId: string, base: string): { dir: string; branch: string; baseCommit: string } {
  const dir = path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
  const branch = `squad/${ticketId.toLowerCase()}`;
  const baseCommit = git(projectRoot, ['rev-parse', base]);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, baseCommit };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(projectRoot, ['worktree', 'prune'], { allowFail: true });
  const exists = git(projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true });
  git(projectRoot, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
  return { dir, branch, baseCommit };
}

export function removeWorktree(projectRoot: string, dir: string): void {
  git(projectRoot, ['worktree', 'remove', '--force', dir], { allowFail: true });
}

/** Files changed in a worktree compared with where the ticket started, including new files. */
export function changedFiles(dir: string, baseCommit: string): string[] {
  const tracked = git(dir, ['diff', '--name-only', baseCommit], { allowFail: true }).split('\n');
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true }).split('\n');
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
}

export function commitAll(dir: string, message: string): string | null {
  git(dir, ['add', '-A']);
  if (!git(dir, ['status', '--porcelain'], { allowFail: true })) return null;
  git(dir, authorArgs(dir).concat(['commit', '-m', message]));
  return git(dir, ['rev-parse', '--short', 'HEAD']);
}

/** Use the person's git identity; fall back to a squad-kit one so a commit never fails on a fresh machine. */
function authorArgs(dir: string): string[] {
  const name = git(dir, ['config', 'user.name'], { allowFail: true });
  const email = git(dir, ['config', 'user.email'], { allowFail: true });
  return name && email ? [] : ['-c', 'user.name=squad-kit', '-c', 'user.email=squad-kit@localhost'];
}

export function commitArgsFor(dir: string): string[] {
  return authorArgs(dir);
}

/**
 * Move the base branch to a commit that already contains it, without disturbing the person's own work: a checked-out
 * base fast-forwards unless that would touch a file the person changed; then the result says what to run.
 */
export function moveBase(dir: string, base: string, commit: string, keep?: string): { moved: boolean; note?: string } {
  const before = git(dir, ['rev-parse', base]);
  if (currentBranch(dir) !== base) {
    git(dir, ['update-ref', `refs/heads/${base}`, commit, before]);
    return { moved: true };
  }
  // Your own changes stay safe: git refuses the fast-forward itself if it would touch a file you changed.
  try {
    keepingFiles(dir, keep, before, commit, () => git(dir, ['merge', '--ff-only', commit]));
    return { moved: true };
  } catch (err) {
    return { moved: false, note: `Your ${base} checkout was not moved (${(err as Error).message.replace(/^git merge failed: /, '')}). Run: git merge --ff-only ${commit.slice(0, 8)}` };
  }
}

/**
 * Merge a ticket's branch into the base branch with a merge commit, without checking anything out, so the next
 * tickets start from it. Throws when the branch clashes with changes already in the base.
 */
export function mergeIntoBase(dir: string, base: string, branch: string, message: string, keep?: string): { commit: string; moved: boolean; note?: string } {
  const baseSha = git(dir, ['rev-parse', base]);
  const branchSha = git(dir, ['rev-parse', branch]);
  // Already in the base (merged before, or nothing new): nothing to do.
  if (isAncestor(dir, branchSha, baseSha)) return { commit: baseSha, moved: true };
  let tree: string;
  try {
    tree = git(dir, ['merge-tree', '--write-tree', baseSha, branchSha]).split('\n')[0]!.trim();
  } catch {
    throw new Error(`${branch} clashes with changes already in ${base}.`);
  }
  const commit = git(dir, [...authorArgs(dir), 'commit-tree', tree, '-p', baseSha, '-p', branchSha, '-m', message]);
  return { commit, ...moveBase(dir, base, commit, keep) };
}

/**
 * Runs a git step that moves the checkout from one commit to another, keeping the files under `keep` (a folder in the
 * repo) as they were: squad-kit's own `.squad/` files in the checkout are newer than the copies the branch carries.
 * Its tracked files changed since the last commit are set back first, so git lets the step through, and come back
 * after. Files the step brings that were not there before stay as the step left them.
 */
export function keepingFiles<T>(dir: string, keep: string | undefined, from: string, to: string, step: () => T): T {
  if (!keep) return step();
  const lines = (args: string[]) => git(dir, args, { allowFail: true }).split('\n').filter(Boolean);
  const changed = lines(['diff', '--name-only', from, to, '--', keep]);
  const edited = lines(['diff', '--name-only', 'HEAD', '--', keep]);
  const files = [...new Set([...changed, ...edited])].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  const saved = new Map(files.map((f) => [f, fs.readFileSync(f)]));
  if (edited.length) git(dir, ['checkout', 'HEAD', '--', ...edited]);
  let result: T;
  try {
    result = step();
  } catch (err) {
    for (const [file, content] of saved) fs.writeFileSync(file, content);
    throw err;
  }
  for (const [file, content] of saved) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return result;
}

export function isAncestor(dir: string, a: string, b: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
