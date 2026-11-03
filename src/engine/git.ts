import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../core/home.js';

/** Small git helpers. The squad never touches the person's own checkout: each ticket gets a worktree. */

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): string {
  try {
    const env = opts.env ? { ...process.env, ...opts.env } : undefined;
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    const e = err as { stderr?: Buffer | string; message: string; code?: string };
    if (e.code === 'ETIMEDOUT') {
      const s = Math.max(1, Math.round((opts.timeoutMs ?? 0) / 1000));
      throw new Error(`git ${args[0]} gave up after ${s} second${s === 1 ? '' : 's'}. Check the network, and that git can reach the remote without asking for a password.`);
    }
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(-3).join(' ');
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

/** The longest git over the network may take. */
export const NETWORK_GIT_MS = 120_000;

const SSH_SAFE = ['-o BatchMode=yes', '-o ConnectTimeout=15'];

/**
 * The environment for git over the network. git never asks for a password in the background (a code host module
 * signs in through its own variables), and ssh gives up instead of asking, or waiting on a host that does not answer.
 * The person's own ssh command (GIT_SSH_COMMAND or core.sshCommand) keeps its options; theirs come first, so they win.
 */
export function networkGitEnv(cwd: string, env: Record<string, string> = {}): Record<string, string> {
  const all = { ...process.env, ...env };
  const own = all.GIT_SSH_COMMAND?.trim() || git(cwd, ['config', '--get', 'core.sshCommand'], { allowFail: true });
  // A program in GIT_SSH (such as plink) may not take ssh's options, so it is left as it is.
  const ssh = own || (all.GIT_SSH ? '' : 'ssh');
  const add = SSH_SAFE.filter((o) => !ssh.toLowerCase().includes(o.slice(3, o.indexOf('=')).toLowerCase()));
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...(ssh ? { GIT_SSH_COMMAND: [ssh, ...add].join(' ') } : {}) };
}

/** git over the network (fetch, push, ls-remote, pull): it never asks for a password and gives up after two minutes. */
export function netGit(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): string {
  return git(cwd, args, { ...opts, env: networkGitEnv(cwd, opts.env), timeoutMs: opts.timeoutMs ?? NETWORK_GIT_MS });
}

export function isRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
}

export function hasCommits(dir: string): boolean {
  return git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }) !== '';
}

/** A new project starts as an empty folder: give it a repo and a first commit so tickets can branch. */
/** Never part of a first commit squad-kit makes: squad-kit's own folder, what tools generate, and secrets. */
const FIRST_COMMIT_SKIPS = ['/.squad/', 'node_modules/', 'dist/', 'build/', '.next/', 'target/', 'bin/', 'obj/', '.venv/', 'venv/', '__pycache__/', '.DS_Store', '*.log', '.env', '.env.*'];

/**
 * A folder squad-kit works in needs git with one commit to branch from. A plain folder becomes a repo whose first
 * commit holds the files already there, so the squad's copies start from the real code.
 */
export function ensureRepo(dir: string, projectName: string): void {
  if (!isRepo(dir)) git(dir, ['init', '-b', 'main']);
  if (!hasCommits(dir)) {
    const readme = path.join(dir, 'README.md');
    if (!fs.readdirSync(dir).some((f) => f !== '.git' && f !== '.squad') && !fs.existsSync(readme)) fs.writeFileSync(readme, `# ${projectName}\n`, 'utf8');
    excludeLocal(dir, FIRST_COMMIT_SKIPS);
    git(dir, ['add', '-A']);
    git(dir, authorArgs(dir).concat(['commit', '--allow-empty', '-m', 'start the project']));
  }
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

/** The ticket's branch as someone pushed it (a hand over, or your own other computer), when this computer has none. */
export function pushedBranch(projectRoot: string, branch: string): string | null {
  const refs = git(projectRoot, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`], { allowFail: true });
  return refs.split('\n').filter(Boolean)[0] ?? null;
}

/**
 * The newest base to build on. The remote's copy (as last fetched) has the team's work; the local one has work
 * accepted here and not pushed yet. When one holds the other, that one; when both moved on, a merge of the two that no
 * branch points at, so the ticket gets both. No remote, or the two clash: the local base, as before.
 */
export function latestBase(dir: string, base: string, remote?: string): { ref: string; sha: string } {
  const here = git(dir, ['rev-parse', base]);
  const there = remote ? git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${base}`], { allowFail: true }) : '';
  if (!there || there === here || isAncestor(dir, there, here)) return { ref: base, sha: here };
  if (isAncestor(dir, here, there)) return { ref: `${remote}/${base}`, sha: there };
  try {
    const tree = git(dir, ['merge-tree', '--write-tree', here, there]).split('\n')[0]!.trim();
    const sha = git(dir, [...authorArgs(dir), 'commit-tree', tree, '-p', here, '-p', there, '-m', `Merge ${remote}/${base} into ${base}`]);
    return { ref: `${base} and ${remote}/${base}`, sha };
  } catch {
    return { ref: base, sha: here };
  }
}

/**
 * The ticket's copy of the code. A branch pushed from another computer is where its work so far is, so the copy
 * starts from it, not from the base; `pushed` says so. With `remote`, a new copy starts from the newest base.
 */
export function addWorktree(projectRoot: string, ticketId: string, base: string, remote?: string): { dir: string; branch: string; baseCommit: string; pushed?: string } {
  const dir = path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
  const branch = `squad/${ticketId.toLowerCase()}`;
  let baseCommit = git(projectRoot, ['rev-parse', base]);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, baseCommit };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(projectRoot, ['worktree', 'prune'], { allowFail: true });
  const exists = git(projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true });
  const pushed = exists ? null : pushedBranch(projectRoot, branch);
  if (!exists && !pushed && remote) baseCommit = latestBase(projectRoot, base, remote).sha;
  git(projectRoot, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, pushed ?? baseCommit]);
  if (!pushed) return { dir, branch, baseCommit };
  // Where the ticket left the base, so its changes are measured from there and not against newer work in the base.
  return { dir, branch, baseCommit: git(projectRoot, ['merge-base', base, pushed], { allowFail: true }) || baseCommit, pushed: pushed.replace(/^refs\/remotes\//, '') };
}

export function removeWorktree(projectRoot: string, dir: string): void {
  git(projectRoot, ['worktree', 'remove', '--force', dir], { allowFail: true });
}

/** A throwaway copy of the code as it was at one commit, on no branch, beside the ticket copies. */
export function addSnapshot(projectRoot: string, name: string, commit: string): string {
  const dir = path.join(worktreeRoot(projectRoot), name);
  dropSnapshot(projectRoot, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(projectRoot, ['worktree', 'add', '--detach', dir, commit]);
  return dir;
}

/** Removes a throwaway copy, with whatever its setup added (node_modules and the like). */
export function dropSnapshot(projectRoot: string, dir: string): void {
  removeWorktree(projectRoot, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  git(projectRoot, ['worktree', 'prune'], { allowFail: true });
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

/** The branch changes the same lines as newer work in the base: a person decides. Any other git failure is not this. */
export class MergeClash extends Error {}

/** The oldest git that can merge without a checkout (`merge-tree --write-tree`). */
export const MIN_GIT = [2, 38] as const;
export const GIT_UPDATE = 'Update git: on a Mac run brew install git (or xcode-select --install); on Linux use your package manager';

/** The installed git's version, like "2.41.0", or null when git does not run. */
export function gitVersion(): string | null {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function gitIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

/**
 * Merge a ticket's branch into the base branch with a merge commit, without checking anything out, so the next
 * tickets start from it. Throws a MergeClash when the branch clashes with changes already in the base; any other
 * failure (an older git, most often) throws a plain error that says so.
 */
export function mergeIntoBase(dir: string, base: string, branch: string, message: string, keep?: string): { commit: string; moved: boolean; note?: string } {
  const baseSha = git(dir, ['rev-parse', base]);
  const branchSha = git(dir, ['rev-parse', branch]);
  // Already in the base (merged before, or nothing new): nothing to do.
  if (isAncestor(dir, branchSha, baseSha)) return { commit: baseSha, moved: true };
  let tree: string;
  try {
    tree = execFileSync('git', ['merge-tree', '--write-tree', baseSha, branchSha], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).split('\n')[0]!.trim();
  } catch (err) {
    const e = err as { status?: number | null; stderr?: Buffer | string; message: string };
    // Exit code 1 is git's "the merge has conflicts"; anything else means the merge could not be tried.
    if (e.status === 1) throw new MergeClash(`${branch} clashes with changes already in ${base}.`);
    const version = gitVersion();
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(-2).join(' ');
    const old = version && !gitIsNewEnough(version);
    throw new Error(
      old
        ? `git ${version} cannot merge ${branch} into ${base}: squad-kit needs git ${MIN_GIT.join('.')} or newer. ${GIT_UPDATE}, then try again.`
        : `git could not merge ${branch} into ${base} (git ${version ?? 'not found'}): ${detail}`,
    );
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
