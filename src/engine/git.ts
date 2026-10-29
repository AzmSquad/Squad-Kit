import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Small git helpers. The squad never touches the person's own checkout: each ticket gets a worktree. */

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim();
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
    git(dir, ['-c', 'user.name=squad-kit', '-c', 'user.email=squad-kit@localhost', 'commit', '-m', 'start the project'], {});
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
  return path.join(os.homedir(), '.squad-kit', 'worktrees', `${path.basename(projectRoot)}-${hash}`);
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
