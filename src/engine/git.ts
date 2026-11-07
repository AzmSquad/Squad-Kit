import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { NOT_A_PROJECT_FOLDER, isOwnFolder } from '../core/paths.js';
import { OWN_GROUP, endGroup, signalGroup, track, whenExited } from './process-group.js';
import { hookFiles, isHookFile } from './hook-files.js';
import { clearHookGit, commitsIn, endHookGroup, hookGitEnv, hookGitLeft, hookWords, makeHookGit, noteHookGroup, putFilesBack } from './hook-git.js';
import { commitGuard, guardBlockedDetail, guardBlockedPath, projectEnv, spawnProject, type GuardSpec } from './project-guard.js';
import { RawError } from '../core/for-people.js';

/** Small git helpers. The squad never touches the person's own checkout: each ticket gets a worktree. */

/** English, so squad-kit can read what git says: a Mac always has en_US.UTF-8; elsewhere C is always there. */
const GIT_LOCALE: Record<string, string> = process.platform === 'darwin' ? { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } : { LC_ALL: 'C' };

/**
 * The environment for squad-kit's own git calls: git answers in English, and fast. Started with no language set (the
 * app opened from the Dock), git on a Mac asks the system for the person's languages on every call, through one
 * shared system service, which can take long when that service is busy. LANGUAGE would still pick git's words, so it
 * goes. The project's own commands (tests, the app) keep the person's language.
 */
export function gitEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, ...GIT_LOCALE };
  delete env.LANGUAGE;
  return env;
}

/* ── how the engine starts git: one place ────────────────── */

/**
 * A program a repo's settings could start from inside squad-kit, where the guard does not reach. A nested repo's
 * settings count too: git passes these down to it.
 */
const PROGRAMS_OFF = ['-c', 'core.fsmonitor=false'];

/** Hooks are the project's code: they run only in the guard, in one place (commitChecked). */
const HOOKS_OFF = ['-c', `core.hooksPath=${os.devNull}`];

/**
 * git-lfs uploads a project's large files from a `pre-push` hook, and hooks are off. So a push gets this one instead,
 * squad-kit's own: it does what git-lfs's hook does and runs nothing of the project's. Without it, a push would send
 * pointers to files the remote never got. It lives in squad-kit's folder, which no agent or project command can reach.
 */
const LFS_PRE_PUSH = `#!/bin/sh
command -v git-lfs >/dev/null 2>&1 || exit 0
git grep -q 'filter=lfs' HEAD -- ':(glob)**/.gitattributes' || exit 0
exec git lfs pre-push "$@"
`;

function pushHooks(): string[] {
  const dir = path.join(squadHome(), 'git-hooks');
  const file = path.join(dir, 'pre-push');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== LFS_PRE_PUSH) fs.writeFileSync(file, LFS_PRE_PUSH, { mode: 0o755 });
  return ['-c', `core.hooksPath=${dir}`];
}

/** Commands that would otherwise start a diff program, or look inside a nested repo with that repo's own settings. */
const COMMAND_OFF: Record<string, string[]> = {
  status: ['--ignore-submodules=dirty'],
  diff: ['--ignore-submodules=dirty', '--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  log: ['--no-ext-diff', '--no-textconv'],
};

/**
 * Every git the engine runs starts from these arguments: hooks off, and nothing a repo's settings can name is started
 * by it. The rest git could start needs a line in a settings file: a pager (never, the output here is no terminal),
 * ssh, a proxy, a credential helper, a filter or a merge driver (the person's own, git-lfs for one, so they stay on).
 * No project command or agent can write those files: the guard and the agent's sandbox keep them read only, and the
 * link in a copy's `.git` too, so a copy cannot be pointed at other settings.
 */
export function gitArgs(args: string[]): string[] {
  let at = 0;
  while (args[at] === '-c') at += 2;
  const hooks = args[at] === 'push' ? pushHooks() : HOOKS_OFF;
  return [...PROGRAMS_OFF, ...hooks, ...args.slice(0, at + 1), ...(COMMAND_OFF[args[at] ?? ''] ?? []), ...args.slice(at + 1)];
}

/** The word git's messages name a command by. */
function commandOf(args: string[]): string {
  const at = args.lastIndexOf('-c');
  return args[at < 0 ? 0 : at + 2] ?? 'command';
}

function runGit(cwd: string, full: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number }): string {
  try {
    const env = gitEnv(opts.env);
    return execFileSync('git', full, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, env, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    const e = err as { stderr?: Buffer | string; message: string; code?: string };
    if (e.code === 'ETIMEDOUT') {
      const s = Math.max(1, Math.round((opts.timeoutMs ?? 0) / 1000));
      throw new RawError(`git ${commandOf(full)} gave up after ${s} second${s === 1 ? '' : 's'}. Check the network, and that git can reach the remote without asking for a password.`);
    }
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(-3).join(' ');
    throw new RawError(`git ${commandOf(full)} failed: ${detail}`);
  }
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): string {
  return runGit(cwd, gitArgs(args), opts);
}

/** The project's own core.hooksPath, which every other git here has masked. Only ever read, never used to run anything. */
export function projectHooksPath(dir: string): string {
  return runGit(dir, [...PROGRAMS_OFF, 'config', '--get', 'core.hooksPath'], { allowFail: true });
}

/** The nested repos in a folder: submodules, and any folder with a `.git` of its own that is not ignored. */
function nestedRepos(dir: string, env?: Record<string, string>): string[] {
  const o = env ? { allowFail: true, env } : { allowFail: true };
  const links = git(dir, ['ls-files', '-z', '--stage'], o).split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
  const fresh = git(dir, ['ls-files', '-z', '--others', '--exclude-standard'], o).split('\0').filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1));
  return [...links, ...fresh];
}

/**
 * Stages all the work in a folder, and nothing of a nested repo. git would otherwise look inside it with that repo's own
 * settings, and anything in the copy can write those: this is the one way the engine stages everything.
 */
export function stageAll(dir: string, env?: Record<string, string>): void {
  const out = [...nestedRepos(dir, env), ...placedIn(dir)].map((p) => `:(top,exclude,literal)${p}`);
  git(dir, ['add', '-A', ...(out.length ? ['--', ':/', ...out] : [])], env ? { env } : {});
}

/** The list of local files squad-kit placed in a copy, in the copy's own git folder, where no agent writes. */
function placedList(dir: string): string | null {
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  return gitDir ? path.join(gitDir, 'squad-placed') : null;
}

/** Says which local files are in this copy: none ever goes in a commit, even when a story takes it out of .gitignore. */
export function markPlaced(dir: string, files: string[]): void {
  const list = placedList(dir);
  if (!list) return;
  if (files.length) fs.writeFileSync(list, files.join('\n'));
  else fs.rmSync(list, { force: true });
}

/** The placed files git would save now. One it ignores stays out by itself, and git refuses to be told to leave it out. */
function placedIn(dir: string): string[] {
  const list = placedList(dir);
  if (!list || !fs.existsSync(list)) return [];
  return fs.readFileSync(list, 'utf8').split('\n').filter((f) => f && !git(dir, ['check-ignore', '--', f], { allowFail: true }));
}

function isMerging(dir: string): boolean {
  return git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }) !== '';
}

/** True when a commit would hold something: what is staged, or a merge to finish. */
export function somethingToSave(dir: string): boolean {
  return git(dir, ['diff', '--cached', '--name-only'], { allowFail: true }) !== '' || isMerging(dir);
}

/** The tracked files in a folder that differ from the last commit, by their paths from that folder. */
export function changedTracked(dir: string): string[] {
  return git(dir, ['diff', '--name-only', '--relative', '-z', 'HEAD'], { allowFail: true }).split('\0').filter(Boolean);
}

/** True for a file a package tool writes itself: package-lock.json, pnpm-lock.yaml, yarn.lock, go.sum and the like. */
export function isLockFile(file: string): boolean {
  return /(?:\.lockb?|[-.]lock\.(?:json|ya?ml)|^go\.sum|^npm-shrinkwrap\.json|^Package\.resolved)$/.test(path.basename(file));
}

/**
 * Puts back every tracked file that differs from the last commit, in a copy of the code that was just made: a setup
 * command may rewrite one (often a lock file), and that is not the story's work. Untracked and ignored files stay
 * (installed packages, a local database). In the person's own folder, `keep` names what already differed before the
 * setup ran and `only` limits it further, so their own changes stay. The files it put back.
 */
export function putBackTracked(dir: string, opts: { keep?: string[]; only?: (file: string) => boolean } = {}): string[] {
  const keep = new Set(opts.keep);
  const changed = changedTracked(dir).filter((f) => !keep.has(f) && (opts.only?.(f) ?? true));
  if (changed.length) git(dir, ['checkout', 'HEAD', '--', ...changed], { allowFail: true });
  return changed;
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

/** netGit beside everything else, so a slow remote never holds up the board. */
export function netGitLater(cwd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', gitArgs(args), { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: gitEnv(networkGitEnv(cwd, opts.env)), timeout: opts.timeoutMs ?? NETWORK_GIT_MS }, (err, stdout, stderr) => {
      if (err) fail(new RawError(`git ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else done(stdout.trim());
    });
  });
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
  // Everything on the computer sits under these: a first commit here would take it all.
  if (!isOwnFolder(dir) && !hasCommits(dir)) throw new Error(NOT_A_PROJECT_FOLDER);
  if (!isRepo(dir)) git(dir, ['init', '-b', 'main']);
  if (!hasCommits(dir)) {
    const readme = path.join(dir, 'README.md');
    if (!fs.readdirSync(dir).some((f) => f !== '.git' && f !== '.squad') && !fs.existsSync(readme)) fs.writeFileSync(readme, `# ${projectName}\n`, 'utf8');
    excludeLocal(dir, FIRST_COMMIT_SKIPS);
    stageAll(dir);
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
export function addWorktree(projectRoot: string, ticketId: string, base: string, remote?: string, at?: string): { dir: string; branch: string; baseCommit: string; pushed?: string } {
  const dir = at ?? path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
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

/** The git copies a folder holds: itself, or on a story's folder, the copies inside it. */
export function copyDirsIn(folder: string): string[] {
  if (fs.existsSync(path.join(folder, '.git'))) return [folder];
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(folder, d.name, '.git'))).map((d) => path.join(folder, d.name));
  } catch {
    return [];
  }
}

/**
 * The project's folder moved: a ticket's copy (kept outside it) still points at the old place, so git cannot work there
 * and the work sits out of reach. git can repair the link from the repo. True when the copy works now; it only runs git
 * more than once when the link is broken.
 */
export function repairCopyLink(repoRoot: string, dir: string): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  if (git(dir, ['rev-parse', '--git-dir'], { allowFail: true })) return true;
  git(repoRoot, ['worktree', 'repair'], { allowFail: true });
  return git(dir, ['rev-parse', '--git-dir'], { allowFail: true }) !== '';
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

/** The longest a project's own commit hooks may run on a finished change. */
export const HOOK_MS = 5 * 60_000;
/** The longest they may run on a save with no finished work in it: the work so far, or a release's own commit. */
export const SHORT_HOOK_MS = 60_000;

/** How a commit with the project's hooks runs. */
export interface HookRun {
  /** The guard for its hooks, which are the project's own code. Left out where this computer has no guard (Windows). */
  guard?: GuardSpec;
  /** Ends a hook that is still running: the ticket's Stop, or the board closing. */
  signal?: AbortSignal;
  /** A copy with no packages and no story's work in it (a release's own): what the install step made stays out of it. */
  noRunner?: boolean;
  /** Work was saved earlier without the hooks: they look at all of it since this commit, not only at what is new. */
  from?: string;
}

/** The ticket's Stop ended a hook while it ran, so nothing was saved. No hook said no, and no card is due. */
export class CommitStopped extends Error {
  /** Work was saved past the hooks before this: they still owe it a look. */
  owed = false;
  constructor() {
    super("Stopped while the project's own check ran.");
    this.name = 'CommitStopped';
  }
}

/** A project's own commit hook said no to a commit, or did not finish in time. */
export class HookRefused extends Error {
  /** Work was saved past the hooks before this: they still owe it a look. */
  owed = false;
  constructor(
    /** What the hook printed, for the engineer details and for the Builder. */
    readonly said: string,
    readonly timedOut: boolean,
    readonly limitMs: number,
  ) {
    super(`The project's commit hook ${timedOut ? `did not finish in ${Math.round(limitMs / 60_000)} minutes` : 'said no'}: ${said}`);
    this.name = 'HookRefused';
  }
}

/** Where git really looks for this folder's hooks (husky sets core.hooksPath). */
export function hookFolder(dir: string): string {
  return runGit(dir, [...PROGRAMS_OFF, 'rev-parse', '--git-path', 'hooks'], { allowFail: true });
}

function hasHook(dir: string, where: string, name: string): boolean {
  try {
    fs.accessSync(path.resolve(dir, where, name), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The hooks that can refuse a commit in this folder, wherever the project keeps them. */
export function commitHooks(dir: string): string[] {
  const where = hookFolder(dir);
  return where ? ['pre-commit', 'prepare-commit-msg', 'commit-msg'].filter((name) => hasHook(dir, where, name)) : [];
}

/** The same commit in the form tools like commitlint ask for: "feat: add a login page (SK-1)". */
export function conventionalWords(type: 'feat' | 'fix' | 'chore', text: string, id?: string): string {
  const tail = id ? ` (${id})` : '';
  const room = Math.max(10, 72 - type.length - 2 - tail.length);
  const subject = text.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  return `${type}: ${subject.charAt(0).toLowerCase()}${subject.slice(1, room).trimEnd()}${tail}`;
}

interface CommitTry {
  ok: boolean;
  said: string;
  timedOut: boolean;
  /** The ticket's Stop ended it. */
  stopped?: boolean;
  /** The words for the real commit, when the hooks passed. */
  words?: string;
}

function commitArgs(dir: string, message: string): string[] {
  return [...authorArgs(dir), 'commit', '-m', message];
}

export function quoted(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The hook files as they are staged now, by path. */
function stagedHookFiles(dir: string): Map<string, string> {
  const names = hookFiles(dir);
  const staged = new Map<string, string>();
  for (const line of git(dir, ['ls-files', '-s', '-z'], { allowFail: true }).split('\0')) {
    const entry = /^(\d+) ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
    if (entry && isHookFile(entry[3]!, names)) staged.set(entry[3]!, `${entry[1]},${entry[2]}`);
  }
  return staged;
}

/** A hook may change what is staged, as a formatter does, but not the check itself: it would run on every teammate's next commit. */
function keepHookFiles(dir: string, before: Map<string, string>): void {
  const now = stagedHookFiles(dir);
  for (const rel of new Set([...before.keys(), ...now.keys()])) {
    const was = before.get(rel);
    if (was === now.get(rel)) continue;
    if (was) {
      // Its folder may be a link by now, which this puts back too.
      git(dir, ['update-index', '--add', '--replace', '--cacheinfo', `${was},${rel}`]);
      git(dir, ['checkout-index', '-f', '--', rel]);
    } else {
      git(dir, ['update-index', '--force-remove', '--', rel]);
      removeInCopy(dir, rel);
    }
  }
}

/**
 * Removes a file of a copy, from outside the guard. Something a hook left running may swap a folder above it for a link at
 * any moment, so the removal works from inside the real folder, once that is known to be in the copy.
 */
function removeInCopy(dir: string, rel: string): void {
  const from = path.join(dir, path.dirname(rel));
  try {
    if (process.platform === 'win32') fs.rmSync(path.join(dir, rel), { force: true });
    else execFileSync('/bin/sh', ['-c', 'cd -P -- "$2" && case "$(pwd -P)/" in "$1"/*) rm -f -- "$3" ;; esac', 'sh', realOf(dir), from, path.basename(rel)], { stdio: 'ignore' });
  } catch {
    // It is not in the copy now, or it is a folder: nothing of the person's is touched.
  }
}

/** A lock this old has no git behind it: a kill or a crash left it. */
const STALE_LOCK_MS = 2 * 60_000;

/** What a hook of 1.2.1 could leave in a copy's own folder, which the next commit would write through or believe. */
const LEFT_BY_OLD_HOOKS = ['COMMIT_EDITMSG', 'ORIG_HEAD', 'logs/HEAD', 'MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'AUTO_MERGE'];

/**
 * A copy that a crash of 1.2.1 left on that version's stand-in branch goes back on the real one, where the next commit
 * must land. First what a hook left: moving HEAD writes to the reflog, through any link there.
 */
function leaveOldStandIn(dir: string, own: string): void {
  // From the file: git would follow a stand-in a hook made a link to another branch, and answer with that branch.
  const head = fs.readFileSync(path.join(own, 'HEAD'), 'utf8');
  const name = /^ref: refs\/heads\/squad\/saving\/(.+)\/now\s*$/.exec(head)?.[1];
  if (!name) return;
  const common = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
  if (fs.lstatSync(path.join(own, 'logs'), { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(path.join(own, 'logs'), { force: true });
  for (const left of LEFT_BY_OLD_HOOKS) fs.rmSync(path.join(own, left), { force: true });
  const detached = /^detached\/([0-9a-f]+)$/.exec(name);
  if (detached) git(dir, ['update-ref', '--no-deref', 'HEAD', detached[1]!]);
  else git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${name}`]);
  for (const at of ['', 'logs']) fs.rmSync(path.join(common, at, 'refs', 'heads', 'squad', 'saving'), { recursive: true, force: true });
  for (const ref of git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/squad/saving'], { allowFail: true }).split('\n').filter(Boolean)) git(dir, ['update-ref', '--no-deref', '-d', ref], { allowFail: true });
}

/** The line for the ticket when a crash cut the hooks off and what was on disk was kept. */
export function cutOffWords(ref: string): string {
  return `squad-kit stopped while the project's own check ran, so this ticket's files went back as they were saved. What was on disk then is kept: an engineer can see it with git show ${ref}`;
}

/**
 * What a crash or a kill can leave in a copy, put right: a dead lock on the index or on HEAD, from squad-kit's own git,
 * and a throwaway git folder. That folder says the hooks were cut off, so what is left of them ends and the files go back
 * to what was staged before them, once only: work done after that is not touched. What was on disk is kept first, and this
 * returns where. The real branch never moved. Safe to call at any time no commit runs in the copy.
 */
export function settleCopy(dir: string): string | null {
  const own = git(dir, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  if (!own) return null;
  leaveOldStandIn(dir, own);
  for (const name of ['index.lock', 'HEAD.lock']) {
    const lock = path.join(own, name);
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true });
    } catch {
      // No lock.
    }
  }
  if (!hookGitLeft(dir)) return null;
  endHookGroup(dir);
  try {
    const kept = putFilesBack(dir);
    clearHookGit(dir);
    return kept;
  } catch {
    // What was on disk could not be kept, so nothing moved: the next try settles it.
    return null;
  }
}

export function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The commit the hooks run on, as git's own arguments: its folder's settings say the rest (hook-git.ts). */
function trialArgs(message: string): string[] {
  return ['commit', '-m', message];
}

/** What a commit's hooks run with: the environment of the project's own commands, with git answering in English, on their own git folder. */
function hookEnv(dir: string, gitDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...projectEnv(), ...GIT_LOCALE, ...hookGitEnv(dir, gitDir) };
  delete env.LANGUAGE;
  return env;
}

/**
 * The hooks' commit beside everything else, in its own process group: a hook that hangs, or that a Stop ends, goes with
 * all it started.
 */
function hooksCommit(dir: string, start: string, message: string, limitMs: number, how: HookRun): Promise<CommitTry> {
  return new Promise((done) => {
    const gitDir = makeHookGit(dir, start, message);
    const env = hookEnv(dir, gitDir);
    const child = how.guard
      ? spawnProject(['git', ...trialArgs(message)].map(quoted).join(' '), { cwd: dir, env, guard: commitGuard(how.guard, { own: realOf(git(dir, ['rev-parse', '--absolute-git-dir'])), common: realOf(path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']))), gitDir }) })
      : track(spawn('git', trialArgs(message), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: OWN_GROUP }));
    if (child.pid) noteHookGroup(dir, child.pid);
    let said = '';
    let timedOut = false;
    let stopped = false;
    const keep = (d: Buffer) => (said = `${said}${d.toString('utf8')}`.slice(-4000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      endGroup(child, 2000);
    }, limitMs);
    const onStop = () => {
      stopped = true;
      endGroup(child, 2000);
    };
    if (how.signal?.aborted) onStop();
    else how.signal?.addEventListener('abort', onStop, { once: true });
    const end = () => {
      clearTimeout(timer);
      how.signal?.removeEventListener('abort', onStop);
    };
    child.on('error', (err) => {
      end();
      done({ ok: false, said: err.message, timedOut: false });
    });
    void whenExited(child).then((code) => {
      end();
      // Nothing a hook left in its group goes on beside what comes next.
      signalGroup(child, 'SIGKILL');
      // A commit of a hook's own goes with the folder. Its words are not this change's, and when it took everything or moved the branch from under this one, no hook said no.
      const commits = commitsIn(gitDir);
      const ok = !timedOut && !stopped && (code === 0 || (commits > 0 && /nothing (?:added )?to commit|cannot lock ref 'HEAD'/.test(said)));
      done({ ok, said: said.trim(), timedOut, ...(stopped ? { stopped } : {}), ...(ok ? { words: code === 0 && commits <= 1 ? hookWords(gitDir, message) : message } : {}) });
    });
  });
}

/** For engineers, first: the file the guard kept from the hook, when that is why it said no. Then what the hook printed. */
function hookSaid(said: string, how: HookRun): string {
  const blocked = how.guard ? guardBlockedPath(said, how.guard) : null;
  return blocked ? `${guardBlockedDetail(blocked, 'the commit hook', how.guard)}\n${said}` : said;
}

/**
 * git's own trouble, looked at directly: whatever a hook prints, it never counts as this. Null when git could commit here,
 * so what stopped the commit was the hook.
 */
function gitTrouble(dir: string): string | null {
  const own = git(dir, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  if (!own) return 'this folder is no longer a git repository';
  if (fs.existsSync(path.join(own, 'index.lock'))) return 'another git process holds the index (index.lock)';
  try {
    git(dir, ['write-tree']);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** What a refusal leads to: a Stop or a hook that hung ends it, and so does git's own trouble. Anything else is the hook's word. */
function hookOutcome(dir: string, t: CommitTry, limitMs: number, how: HookRun): void {
  if (t.stopped) throw new CommitStopped();
  if (t.timedOut) throw new HookRefused(hookSaid(t.said, how), true, limitMs);
  const trouble = gitTrouble(dir);
  if (trouble) throw new RawError(`git commit failed: ${trouble}`);
}

/** Only files come back from the hooks, so they are staged here, as the next commit needs, with the check itself put back. */
function filesFromHooks(dir: string, stagedBefore: Map<string, string>): void {
  stageAll(dir);
  keepHookFiles(dir, stagedBefore);
}

/**
 * The hooks look at the change. A hook that fixed files and said no (a formatter), or that only refused the words
 * (commitlint), gets one more try with the fixed files staged and the words in the usual form; then it is a HookRefused,
 * and a person decides. The commit they make is only for them: it goes with the throwaway folder. What they say goes on:
 * the words for the real commit, or null when they left nothing to save.
 */
async function hooksLook(dir: string, start: string, message: string, words: string, limitMs: number, how: HookRun, whole: boolean): Promise<string | null> {
  const stagedBefore = stagedHookFiles(dir);
  let last: CommitTry | undefined;
  try {
    last = await hooksCommit(dir, start, message, limitMs, how);
    if (!last.ok) {
      hookOutcome(dir, last, limitMs, how);
      filesFromHooks(dir, stagedBefore);
      last = await hooksCommit(dir, start, commitHooks(dir).includes('commit-msg') ? words : message, limitMs, how);
    }
    if (!last.ok) {
      hookOutcome(dir, last, limitMs, how);
      filesFromHooks(dir, stagedBefore);
      // The hook fixed everything itself (a formatter), so nothing is left to save. On a whole change it would mean throwing the work away.
      if (!whole && !somethingToSave(dir)) return null;
      throw new HookRefused(hookSaid(last.said, how), false, limitMs);
    }
    return last.words ?? message;
  } finally {
    // In this order: a crash between them leaves the folder, so the next start puts the files right.
    if (last?.stopped || last?.timedOut) putFilesBack(dir);
    else filesFromHooks(dir, stagedBefore);
    clearHookGit(dir);
  }
}

/**
 * A project may keep what runs its hooks in a folder git ignores: an install step makes it in the person's checkout (a
 * hook manager's generated folder), and a new copy has none. git then skips every hook without a word, so the check
 * would look passed when it never ran. It comes from the person's checkout, which the agents never write in.
 */
export function bringHookRunner(dir: string): void {
  const where = projectHooksPath(dir);
  if (!where || path.isAbsolute(where) || where.startsWith('~')) return;
  const root = checkoutOf(dir);
  if (path.resolve(root) === path.resolve(dir)) return;
  // An agent can leave a link here. What follows runs outside the guard and must not write through it.
  if (fs.lstatSync(path.join(dir, where), { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(path.join(dir, where), { force: true });
  const inCopy = `${realOf(dir)}${path.sep}`;
  const ignored = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', where], { allowFail: true }).split('\0').filter(Boolean);
  for (const rel of ignored) {
    const to = path.join(dir, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (!`${realOf(path.dirname(to))}${path.sep}`.startsWith(inCopy)) continue;
      fs.rmSync(to, { force: true });
      fs.copyFileSync(path.join(root, rel), to);
    } catch {
      // It went while being copied: the hook manager's own install makes it again.
    }
  }
}

/**
 * The person's own checkout of the repo this copy belongs to. It is not always the folder above git's: a submodule's
 * git folder sits inside the parent's, and git's settings say where its checkout is.
 */
function checkoutOf(dir: string): string {
  const common = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir'], { allowFail: true }) || '.git');
  const set = git(dir, ['config', '--file', path.join(common, 'config'), '--get', 'core.worktree'], { allowFail: true });
  return set ? path.resolve(common, set) : path.dirname(common);
}

/**
 * The one way a commit runs with the project's hooks on, in their guard where this computer has one. The hooks look at
 * what is staged, on a throwaway git folder; then the real commit goes on the real branch, outside the guard, with the
 * person's signature when their git signs. So a refusal, a Stop or a crash leaves every branch where it was.
 *
 * With `from`, or a merge not finished yet, all of it is saved first, so nothing can be lost whatever the hooks do. They
 * see everything since it started as staged, and the commit that passed goes on top of the branch's last one, so a branch
 * already pushed still moves forward.
 */
export async function commitChecked(dir: string, message: string, words: string, limitMs = HOOK_MS, how: HookRun = {}): Promise<void> {
  settleCopy(dir);
  if (!how.noRunner) bringHookRunner(dir);
  const where = hookFolder(dir);
  if (!commitHooks(dir).length && !(where && hasHook(dir, where, 'post-commit'))) {
    if (somethingToSave(dir)) commitWithoutHooks(dir, message);
    return;
  }
  const merging = isMerging(dir);
  const whole = Boolean(how.from) || merging;
  const savedFirst = whole && somethingToSave(dir);
  if (savedFirst) commitWithoutHooks(dir, `Work so far: ${message}`);
  const tip = git(dir, ['rev-parse', 'HEAD']);
  let start = tip;
  if (how.from) {
    // Where it started, as far as git can still tell; failing that, everything, so that no work goes unseen.
    start = git(dir, ['merge-base', how.from, tip], { allowFail: true }) || git(dir, ['rev-list', '--max-parents=0', tip]).split('\n').at(-1)!;
  } else if (merging) {
    start = git(dir, ['rev-parse', `${tip}^1`]);
  }
  // Nothing to show them: all of it passed before, or was never there.
  if (whole && (start === tip || !git(dir, ['diff', '--name-only', start, tip], { allowFail: true }))) return;
  const saying = await hooksLook(dir, start, message, words, limitMs, how, whole).catch((err: unknown) => {
    if (savedFirst && (err instanceof HookRefused || err instanceof CommitStopped)) err.owed = true;
    throw err;
  });
  if (saying === null || (!whole && !somethingToSave(dir))) return;
  git(dir, [...authorArgs(dir), 'commit', ...(whole ? ['--allow-empty'] : []), '-m', saying]);
}

/**
 * The work so far on a ticket's own branch, not its finished change. The project's commit hooks get a short try. When
 * they say no (unfinished work often fails them) the work is still saved, since nothing goes to the base here, and
 * `hookSaid` tells the caller, which marks the ticket hookOwed: the hooks see this work again when the change is
 * accepted. A hook only looks at what is staged, so nothing else would ever show it to them.
 */
export async function commitAll(dir: string, message: string, words = message, how: HookRun = {}): Promise<{ commit: string | null; hookSaid?: string }> {
  stageAll(dir);
  if (!somethingToSave(dir)) return { commit: null };
  let said: string | undefined;
  try {
    await commitChecked(dir, message, words, SHORT_HOOK_MS, how);
  } catch (err) {
    if (!(err instanceof HookRefused)) throw err;
    said = err.said;
    if (somethingToSave(dir)) commitWithoutHooks(dir, message);
  }
  return { commit: git(dir, ['rev-parse', '--short', 'HEAD']), ...(said !== undefined ? { hookSaid: said } : {}) };
}

/** A commit with the project's hooks off, like every other git the engine runs. The caller keeps the record of why. */
export function commitWithoutHooks(dir: string, message: string): void {
  git(dir, commitArgs(dir, message));
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
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
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
export function mergeIntoBase(dir: string, base: string, branch: string, message: string, keep?: string, oneCommit = false): { commit: string; moved: boolean; note?: string } {
  const baseSha = git(dir, ['rev-parse', base]);
  const branchSha = git(dir, ['rev-parse', branch]);
  // Already in the base (merged before, or nothing new): nothing to do.
  if (isAncestor(dir, branchSha, baseSha)) return { commit: baseSha, moved: true };
  const tree = mergedTree(dir, base, branch, baseSha, branchSha);
  // As one plain commit, the base's history has no sign of the branch, so "already in" means the merge changes nothing.
  if (oneCommit && tree === git(dir, ['rev-parse', `${baseSha}^{tree}`])) return { commit: baseSha, moved: true };
  const commit = git(dir, [...authorArgs(dir), 'commit-tree', tree, '-p', baseSha, ...(oneCommit ? [] : ['-p', branchSha]), '-m', message]);
  return { commit, ...moveBase(dir, base, commit, keep) };
}

/** Whether merging a branch would clash. Nothing moves: it is for looking at every repo before any of them changes. */
export function mergeWouldClash(dir: string, base: string, branch: string): boolean {
  const baseSha = git(dir, ['rev-parse', base]);
  const branchSha = git(dir, ['rev-parse', branch]);
  if (isAncestor(dir, branchSha, baseSha)) return false;
  try {
    mergedTree(dir, base, branch, baseSha, branchSha);
    return false;
  } catch (err) {
    if (err instanceof MergeClash) return true;
    throw err;
  }
}

/** The files as they would be after the merge, with nothing moved. A clash says so. */
function mergedTree(dir: string, base: string, branch: string, baseSha: string, branchSha: string): string {
  let tree: string;
  try {
    tree = execFileSync('git', gitArgs(['merge-tree', '--write-tree', baseSha, branchSha]), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, env: gitEnv() }).split('\n')[0]!.trim();
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
  return tree;
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
    execFileSync('git', gitArgs(['merge-base', '--is-ancestor', a, b]), { cwd: dir, stdio: 'ignore', env: gitEnv() });
    return true;
  } catch {
    return false;
  }
}
