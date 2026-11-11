import { constants as bufferLimits } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { NOT_A_PROJECT_FOLDER, isOwnFolder } from '../core/paths.js';
import { OWN_GROUP, endGroup, endPid, signalGroup, takenOver, track, trackTask, whenExited } from './process-group.js';
import { hookFiles, isHookFile } from './hook-files.js';
import { clearHookGit, commitsIn, endHookGroup, hookGitEnv, hookGitLeft, hookWords, makeHookGit, noteHookGroup, putFilesBack, putFilesBackLater } from './hook-git.js';
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

/** All one string can hold: the most of git's answer squad-kit keeps in memory. A longer one is read as it comes (gitRecords). */
export const MOST_OUTPUT = bufferLimits.MAX_STRING_LENGTH;

/** git says this when another git holds one of its lock files for a moment: not a failure, a wait. */
const LOCKED = /Unable to create '[^']*\.lock'|could not lock config file/;
/** How long a git beside everything else waits for a lock, try by try: longer than any git here holds one, on any size. */
const LOCK_WAITS_MS = [100, 250, 500, 1000, 2000, 4000, 8000, 15_000];
/** The same for a git that holds up the board: only what a config or ref lock takes. */
const LOCK_WAITS_NOW_MS = [50, 100, 200];

function waitNow(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gaveUp(full: string[], timeoutMs: number): RawError {
  const s = Math.max(1, Math.round(timeoutMs / 1000));
  return new RawError(`git ${commandOf(full)} gave up after ${s} second${s === 1 ? '' : 's'}. Check the network, and that git can reach the remote without asking for a password.`);
}

function saidTooMuch(full: string[]): RawError {
  return new RawError(`git ${commandOf(full)} said more than squad-kit can read at once.`);
}

function runGit(cwd: string, full: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number }): string {
  for (let tries = 0; ; tries += 1) {
    try {
      const env = gitEnv(opts.env);
      return execFileSync('git', full, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MOST_OUTPUT, env, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) }).trim();
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message: string; code?: string };
      const said = (e.stderr ? e.stderr.toString() : e.message).trim();
      if (LOCKED.test(said) && tries < LOCK_WAITS_NOW_MS.length) {
        waitNow(LOCK_WAITS_NOW_MS[tries]!);
        continue;
      }
      // Never "nothing": a caller that may fail still believes what comes back.
      if (e.code === 'ENOBUFS') throw saidTooMuch(full);
      if (opts.allowFail) return '';
      if (e.code === 'ETIMEDOUT') throw gaveUp(full, opts.timeoutMs ?? 0);
      throw new RawError(`git ${commandOf(full)} failed: ${said.split('\n').slice(-3).join(' ')}`);
    }
  }
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): string {
  return runGit(cwd, gitArgs(args), opts);
}

/* ── git beside everything else ──────────────────────── */

/** How a git runs beside everything else. */
export interface GitLater {
  allowFail?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Ends it, and what it started: the ticket's Stop, or the board closing. */
  signal?: AbortSignal;
  /** Its process, which leads a group of its own. */
  onSpawn?(pid: number): void;
  /** Ends it once it has said this many bytes (the caller does not need more), with a GitSaidTooMuch. */
  mostBytes?: number;
  /** What it says goes straight to this open file. */
  outputTo?: number;
}

/** A Stop or the board closing ended this git. */
export class GitStopped extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'GitStopped';
  }
}

/** git's answer was longer than the caller keeps. */
export class GitSaidTooMuch extends RawError {}

class GitFailed extends RawError {
  /** Another git held a lock, so it may be tried again. */
  readonly locked: boolean;
  constructor(full: string[], said: string) {
    super(`git ${commandOf(full)} failed: ${said.trim().split('\n').slice(-3).join(' ')}`);
    this.locked = LOCKED.test(said);
  }
}

/**
 * The one way a git runs without holding up the board: the same arguments and environment as every other git, in a
 * process group of its own, so ending it ends what it started. `git worktree add` does its real work in a child.
 */
function gitBeside(cwd: string, full: string[], env: NodeJS.ProcessEnv, how: GitLater, onOutput: (chunk: Buffer, stop: (why: Error) => void) => void): Promise<void> {
  return new Promise((done, fail) => {
    if (how.signal?.aborted) return fail(new GitStopped());
    const child = track(spawn('git', full, { cwd, env, stdio: ['ignore', how.outputTo ?? 'pipe', 'pipe'], detached: OWN_GROUP }));
    let said = '';
    let why: Error | null = null;
    const stop = (reason: Error) => {
      why ??= reason;
      endGroup(child, 2000);
    };
    const onStop = () => stop(new GitStopped());
    const timer = how.timeoutMs ? setTimeout(() => stop(gaveUp(full, how.timeoutMs!)), how.timeoutMs) : undefined;
    how.signal?.addEventListener('abort', onStop, { once: true });
    const end = () => {
      clearTimeout(timer);
      how.signal?.removeEventListener('abort', onStop);
    };
    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk, stop));
    child.stderr!.on('data', (d: Buffer) => (said = `${said}${d.toString('utf8')}`.slice(-8000)));
    child.once('error', (err) => {
      end();
      fail(new RawError(`git ${commandOf(full)} failed: ${err.message}`));
    });
    if (child.pid) how.onSpawn?.(child.pid);
    void whenExited(child).then((code) => {
      end();
      if (why) fail(why);
      else if (code === 0) done();
      else fail(new GitFailed(full, said));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `git` for the steps that really take long on a big project. Its own lock waits for the git that holds it. */
export async function gitLater(cwd: string, args: string[], how: GitLater = {}): Promise<string> {
  const full = gitArgs(args);
  const most = how.mostBytes ?? MOST_OUTPUT;
  for (let tries = 0; ; tries += 1) {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      await gitBeside(cwd, full, gitEnv(how.env), how, (chunk, stop) => {
        size += chunk.length;
        if (size > most) stop(new GitSaidTooMuch(`git ${commandOf(full)} said more than squad-kit can read at once.`));
        else chunks.push(chunk);
      });
      return Buffer.concat(chunks).toString('utf8').trim();
    } catch (err) {
      if (err instanceof GitFailed && err.locked && tries < LOCK_WAITS_MS.length) {
        await sleep(LOCK_WAITS_MS[tries]!);
        continue;
      }
      // Never "nothing" for a Stop or an answer cut off: a caller that may fail still believes what comes back.
      if (how.allowFail && !(err instanceof GitStopped) && !(err instanceof GitSaidTooMuch)) return '';
      throw err;
    }
  }
}

/** Hands on each record of git's output as it comes, so no answer is too long. A record may end in a separator only. */
function recordsFrom(separator: '\0' | '\n', onRecord: (record: string) => void): (chunk: Buffer) => void {
  const byte = separator.charCodeAt(0);
  let rest: Buffer = Buffer.alloc(0);
  return (chunk) => {
    const all = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0;
    for (let at = all.indexOf(byte, from); at >= 0; at = all.indexOf(byte, from)) {
      if (at > from) onRecord(all.toString('utf8', from, at));
      from = at + 1;
    }
    rest = all.subarray(from);
  };
}

/** git's answer one record at a time, beside everything else: nothing of it is kept here, so its size breaks nothing. */
export function gitRecords(cwd: string, args: string[], separator: '\0' | '\n', onRecord: (record: string) => void, how: GitLater = {}): Promise<void> {
  const feed = recordsFrom(separator, onRecord);
  return gitBeside(cwd, gitArgs(args), gitEnv(how.env), how, (chunk) => feed(chunk));
}

/** The same for what cannot wait: the answer goes through a file. */
function gitRecordsNow(cwd: string, args: string[], separator: '\0' | '\n', onRecord: (record: string) => void, env?: Record<string, string>): void {
  const file = path.join(os.tmpdir(), `squad-git-${randomUUID()}`);
  const fd = fs.openSync(file, 'w+');
  try {
    execFileSync('git', gitArgs(args), { cwd, stdio: ['ignore', fd, 'pipe'], env: gitEnv(env) });
    const feed = recordsFrom(separator, onRecord);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let at = 0, n = fs.readSync(fd, chunk, 0, chunk.length, at); n > 0; at += n, n = fs.readSync(fd, chunk, 0, chunk.length, at)) feed(Buffer.from(chunk.subarray(0, n)));
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    throw new RawError(`git ${commandOf(gitArgs(args))} failed: ${(e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(-3).join(' ')}`);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}

/** The project's own core.hooksPath, which every other git here has masked. Only ever read, never used to run anything. */
export function projectHooksPath(dir: string): string {
  return runGit(dir, [...PROGRAMS_OFF, 'config', '--get', 'core.hooksPath'], { allowFail: true });
}

const NESTED_LINKS = ['ls-files', '-z', '--stage'];
const NESTED_FRESH = ['ls-files', '-z', '--others', '--exclude-standard'];
/** A submodule in the list of everything in the repo, by its path. */
const nestedLink = (line: string) => (line.startsWith('160000 ') ? line.slice(line.indexOf('\t') + 1) : null);

/**
 * The nested repos in a folder: submodules, and any folder with a `.git` of its own that is not ignored. It keeps
 * nothing of the lists it reads, so it finds them on any size, and when git cannot say, that is an error: a safety
 * check must never quietly find nothing.
 */
function nestedRepos(dir: string, env?: Record<string, string>): string[] {
  const found: string[] = [];
  gitRecordsNow(dir, NESTED_LINKS, '\0', (l) => void (nestedLink(l) !== null && found.push(nestedLink(l)!)), env);
  gitRecordsNow(dir, NESTED_FRESH, '\0', (f) => void (f.endsWith('/') && found.push(f.slice(0, -1))), env);
  return found;
}

async function nestedReposLater(dir: string, env?: Record<string, string>): Promise<string[]> {
  const found: string[] = [];
  const how = env ? { env } : {};
  await gitRecords(dir, NESTED_LINKS, '\0', (l) => void (nestedLink(l) !== null && found.push(nestedLink(l)!)), how);
  await gitRecords(dir, NESTED_FRESH, '\0', (f) => void (f.endsWith('/') && found.push(f.slice(0, -1))), how);
  return found;
}

const notThese = (paths: string[]) => paths.map((p) => `:(top,exclude,literal)${p}`);

/**
 * Folders squad-kit's own builds make in a copy, wherever in it they run: Xcode's build folder (XCODE_BUILD_DIR in
 * engine/find-commands.ts), and the record of squad-kit's own Android build (engine/phone/build.ts). A project's .gitignore may not name them, so git's local ignore list keeps them out of
 * `git status`, and staging leaves them out of every commit, even when a story changes what git ignores.
 */
export const OWN_BUILD_DIRS = ['build/squad-kit-ios', 'build/squad-kit-android'];

/** Puts squad-kit's own build folders on git's local ignore list, at any depth. */
export function keepOwnBuildsOut(dir: string): void {
  excludeLocal(dir, OWN_BUILD_DIRS.map((d) => `**/${d}/`));
}

/** squad-kit's own build folders, at any depth, ignored or not: staging leaves them out. */
const notOwnBuilds = () => OWN_BUILD_DIRS.map((d) => `:(top,exclude,glob)**/${d}/**`);

/**
 * Stages all the work in a folder, and nothing of a nested repo. git would otherwise look inside it with that repo's own
 * settings, and anything in the copy can write those: this is the one way the engine stages everything.
 */
export function stageAll(dir: string, env?: Record<string, string>): void {
  const out = [...notThese([...nestedRepos(dir, env), ...placedIn(dir)]), ...notOwnBuilds()];
  git(dir, ['add', '-A', ...(out.length ? ['--', ':/', ...out] : [])], env ? { env } : {});
}

/** stageAll, beside everything else: on a big project it reads every file. */
export async function stageAllLater(dir: string, env?: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const out = [...notThese([...(await nestedReposLater(dir, env)), ...placedIn(dir)]), ...notOwnBuilds()];
  await gitLater(dir, ['add', '-A', ...(out.length ? ['--', ':/', ...out] : [])], { ...(env ? { env } : {}), ...(signal ? { signal } : {}) });
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

/** squad-kit's own database files in a copy, like a story's SQLite file, beside the placed list: none goes in a commit. */
function madeList(dir: string): string | null {
  const list = placedList(dir);
  return list ? `${list.slice(0, -'squad-placed'.length)}squad-db-made` : null;
}

/** A path from the repo's top, as a line of git's ignore list that names that one file. */
const ignoreLine = (rel: string): string => `/${rel.replace(/[\\[\]*?!#]/g, (c) => `\\${c}`)}`;

/**
 * Says which files squad-kit made in this copy for the story's own database (a SQLite file, with the files SQLite keeps
 * beside it). git's local ignore list leaves them out of `git status`, so no step and no agent takes them for the
 * story's work; the list in the copy's git folder leaves them out of every commit, even when a story changes what git
 * ignores. Paths are full, or from the copy's folder.
 */
export function markDbMade(dir: string, files: string[]): void {
  const list = madeList(dir);
  if (!list) return;
  const top = fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }) || dir);
  const real = (f: string) => path.join(fs.realpathSync(path.dirname(path.resolve(dir, f))), path.basename(f));
  const rel = files.map((f) => path.relative(top, real(f)).split(path.sep).join('/')).filter((f) => f && !f.startsWith('..'));
  if (rel.length) fs.writeFileSync(list, rel.join('\n'));
  else fs.rmSync(list, { force: true });
  excludeLocal(dir, rel.map(ignoreLine));
}

/** Takes a dropped story database's files off git's local ignore list. `rel`: their paths from the repo's top. */
export function forgetDbMade(dir: string, rel: string[]): void {
  const file = excludeFile(dir);
  if (!file || !fs.existsSync(file)) return;
  const gone = new Set(rel.map((r) => ignoreLine(r.split(path.sep).join('/'))));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((l) => !gone.has(l));
  if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
}

/** The phone folders squad-kit's own build made in this copy (an Expo app's android/ or ios/), beside the placed list. */
function prebuiltList(dir: string): string | null {
  const list = placedList(dir);
  return list ? `${list.slice(0, -'squad-placed'.length)}squad-prebuilt` : null;
}

/**
 * Says which phone folders squad-kit's own build made in this copy: an Expo app with no android/ or ios/ folder gets one
 * made for the build (`expo prebuild`). Each holds a .gitignore of its own that hides it from git in this copy only,
 * and the list in the copy's git folder leaves it out of every commit, even when a story changes what git ignores.
 * Paths are full, or from the copy's folder.
 */
export function markPrebuilt(dir: string, folders: string[]): void {
  const list = prebuiltList(dir);
  if (!list) return;
  const top = fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }) || dir);
  const had = fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').filter(Boolean) : [];
  const rel = folders.map((f) => path.relative(top, fs.realpathSync(path.resolve(dir, f))).split(path.sep).join('/')).filter((f) => f && !f.startsWith('..'));
  for (const f of folders) fs.writeFileSync(path.join(path.resolve(dir, f), '.gitignore'), '*\n');
  fs.writeFileSync(list, [...new Set([...had, ...rel])].join('\n'));
}

/** The phone folders squad-kit's own build made in this copy, from the repo's top. */
export function prebuiltIn(dir: string): string[] {
  const list = prebuiltList(dir);
  return list && fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').filter(Boolean) : [];
}

/** The placed files git would save now. One it ignores stays out by itself, and git refuses to be told to leave it out. */
function placedIn(dir: string): string[] {
  const files = [placedList(dir), madeList(dir), prebuiltList(dir)].flatMap((list) => (list && fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n') : []));
  return files.filter((f) => f && !git(dir, ['check-ignore', '--', f], { allowFail: true }));
}

function isMerging(dir: string): boolean {
  return git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }) !== '';
}

/** True when a commit would hold something: what is staged, or a merge to finish. */
export function somethingToSave(dir: string): boolean {
  return git(dir, ['diff', '--cached', '--name-only'], { allowFail: true }) !== '' || isMerging(dir);
}

/** The tracked files in a folder that differ from the last commit, by their paths from that folder. */
export async function changedTracked(dir: string): Promise<string[]> {
  return (await gitLater(dir, ['diff', '--name-only', '--relative', '-z', 'HEAD'], { allowFail: true })).split('\0').filter(Boolean);
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
export async function putBackTracked(dir: string, opts: { keep?: string[]; only?: (file: string) => boolean } = {}): Promise<string[]> {
  const keep = new Set(opts.keep);
  const changed = (await changedTracked(dir)).filter((f) => !keep.has(f) && (opts.only?.(f) ?? true));
  if (changed.length) await gitLater(dir, ['checkout', 'HEAD', '--', ...changed], { allowFail: true });
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

/** git over the network (fetch, push, ls-remote, pull), beside everything else: it never asks for a password and gives up after two minutes. */
export function netGitLater(cwd: string, args: string[], opts: GitLater = {}): Promise<string> {
  return gitLater(cwd, args, { ...opts, env: networkGitEnv(cwd, opts.env), timeoutMs: opts.timeoutMs ?? NETWORK_GIT_MS });
}

/**
 * A branch's tip on the remote, as it is now. Not through FETCH_HEAD: every other fetch in this folder writes that too,
 * and any of them may run beside this one.
 */
export async function fetchedTip(dir: string, remote: string, branch: string, opts: GitLater = {}): Promise<string> {
  const ref = `refs/squad/fetched/${randomUUID()}`;
  await netGitLater(dir, ['fetch', remote, `+refs/heads/${branch}:${ref}`], opts);
  const tip = git(dir, ['rev-parse', ref]);
  git(dir, ['update-ref', '-d', ref], { allowFail: true });
  return tip;
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
export function ensureRepo(dir: string, projectName: string): 'later' | 'done' {
  // Everything on the computer sits under these: a first commit here would take it all.
  if (!isOwnFolder(dir) && !hasCommits(dir)) throw new Error(NOT_A_PROJECT_FOLDER);
  if (!isRepo(dir)) git(dir, ['init', '-b', 'main']);
  if (!hasCommits(dir)) {
    const readme = path.join(dir, 'README.md');
    if (!fs.readdirSync(dir).some((f) => f !== '.git' && f !== '.squad') && !fs.existsSync(readme)) fs.writeFileSync(readme, `# ${projectName}\n`, 'utf8');
    excludeLocal(dir, FIRST_COMMIT_SKIPS);
    if (bigToSave(dir)) return 'later';
    stageAll(dir);
    git(dir, authorArgs(dir).concat(['commit', '--allow-empty', '-m', FIRST_COMMIT]));
  }
  return 'done';
}

const FIRST_COMMIT = 'start the project';

/** Over this a first save takes a moment on the board's time, so it is a step of its own, beside everything else. */
const BIG_FIRST_SAVE = { files: 2000, bytes: 50 * 1024 * 1024 };
const NOT_SAVED_FIRST = new Set([...FIRST_COMMIT_SKIPS.filter((p) => p.endsWith('/')).map((p) => p.replace(/\//g, '')), '.git']);

/** True when a folder's first save would take a while. It stops looking as soon as it knows, on any size. */
function bigToSave(dir: string): boolean {
  let files = 0;
  let bytes = 0;
  const big = (at: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const file = path.join(at, e.name);
      if (e.isDirectory()) {
        if (!NOT_SAVED_FIRST.has(e.name) && big(file)) return true;
      } else if (e.isFile()) {
        files += 1;
        bytes += fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (files > BIG_FIRST_SAVE.files || bytes > BIG_FIRST_SAVE.bytes) return true;
      }
    }
    return false;
  };
  return big(dir);
}

/** The first save of a big folder, beside everything else. Run again after a restart or a Stop, it goes on from what is there. */
export async function firstSaveLater(dir: string, signal: AbortSignal): Promise<void> {
  if (hasCommits(dir)) return;
  await stageAllLater(dir, undefined, signal);
  await gitLater(dir, authorArgs(dir).concat(['commit', '--allow-empty', '-m', FIRST_COMMIT]), { signal });
}

/** git's local ignore list, shared by the repo and all its copies. */
function excludeFile(dir: string): string | null {
  const gitDir = git(dir, ['rev-parse', '--git-common-dir'], { allowFail: true });
  return gitDir ? path.resolve(dir, gitDir, 'info', 'exclude') : null;
}

/** Ignore squad-kit's own runtime files without editing the project's .gitignore. */
function excludeLocal(dir: string, patterns: string[]): void {
  const file = excludeFile(dir);
  if (!file) return;
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

/* ── making and removing a copy of the code ──────────── */

/**
 * A copy takes as long as the project's size, so it is made beside everything else, and it reaches its real place only
 * whole: git makes it in the folder below, and it moves into place in one step at the end. So a crash, a restart or a
 * Stop can leave half a copy only here, where nothing ever works. The same when one is removed: it moves here first.
 * The note beside it says who is at it. A copy with no note in its real place is whole, the ones from before too.
 */
const MAKING = '.making';

/** How a copy is made. */
export interface CopyHow {
  /** Ends it: the ticket's Stop, or the board closing. */
  signal?: AbortSignal;
  /** A copy really is being made now, not just found ready: the card says so. */
  making?(): void;
}

interface MakingNote {
  /** The real place of the copy. */
  dir: string;
  /** The squad-kit that is at it, and since when. */
  owner: number;
  since: string;
  /** The git making it, which leads a process group. */
  pid?: number;
  /** The branch made for this copy and where it started: with no work on it yet, it goes with half a copy. */
  branch?: string;
  start?: string;
}

function makingPlace(root: string, dir: string): { at: string; noteFile: string } {
  const key = createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
  const area = path.join(worktreeRoot(root), MAKING);
  return { at: path.join(area, key, path.basename(dir)), noteFile: path.join(area, `${key}.json`) };
}

function readNote(file: string): MakingNote | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as MakingNote;
  } catch {
    return null;
  }
}

function inTurn<T>(turns: Map<string, Promise<unknown>>, key: string, job: () => T | Promise<T>): Promise<T> {
  const run = (turns.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
  turns.set(key, run);
  void run.catch(() => undefined).finally(() => {
    if (turns.get(key) === run) turns.delete(key);
  });
  return run;
}

/** Only one thing happens to a copy at a time in this process: a second Start, a Stop's clean-up, a delete. */
const copyTurns = new Map<string, Promise<unknown>>();

export function copyTurn<T>(dir: string, job: () => Promise<T>): Promise<T> {
  return inTurn(copyTurns, path.resolve(dir), job);
}

/**
 * Only one step moves a repo's base at a time: an accept, a release, a look at a merge that waits. A second one waits
 * its turn, so it never finds the base moved from under it. The move itself, with `.squad` set aside and put back, is
 * one synchronous piece (moveBase, keepingFiles): nothing can read or write `.squad` in its middle, and a restart cannot
 * end it half way. A step with several repos takes their turns in one order, so two steps never wait for each other.
 */
const baseTurns = new Map<string, Promise<unknown>>();

export function baseTurn<T>(dirs: string | string[], job: () => T | Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set([dirs].flat().map((d) => path.resolve(d)))].sort();
  return first ? inTurn(baseTurns, first, () => baseTurn(rest, job)) : Promise.resolve().then(job);
}

/** Another squad-kit on this computer (a terminal beside the board) is at this copy right now. */
function otherAtIt(note: MakingNote | null): boolean {
  if (!note || note.owner === process.pid || takenOver(note.owner, note.since)) return false;
  try {
    process.kill(note.owner, 0);
    return true;
  } catch {
    return false;
  }
}

/** Half a copy goes, with what still works on it, when a crash left that running. Nothing here is ever in use. */
export async function clearHalfCopy(root: string, dir: string, signal?: AbortSignal): Promise<void> {
  const { at, noteFile } = makingPlace(root, dir);
  let note = readNote(noteFile);
  while (otherAtIt(note)) {
    if (signal?.aborted) throw new GitStopped();
    await sleep(500);
    note = readNote(noteFile);
  }
  if (!note && !fs.existsSync(at)) return;
  if (note?.pid && !takenOver(note.pid, note.since)) await endPid(note.pid);
  await gitLater(root, ['worktree', 'remove', '-f', '-f', at], { allowFail: true });
  await fs.promises.rm(path.dirname(at), { recursive: true, force: true });
  await gitLater(root, ['worktree', 'prune'], { allowFail: true });
  if (note?.branch && note.start && git(root, ['rev-parse', '--verify', '-q', `refs/heads/${note.branch}`], { allowFail: true }) === note.start) {
    await gitLater(root, ['branch', '-D', note.branch], { allowFail: true });
  }
  fs.rmSync(noteFile, { force: true });
}

/** What a crash or a restart left half made or half removed in this repo's copies goes, beside everything else. */
export async function clearHalfCopies(root: string): Promise<void> {
  const area = path.join(worktreeRoot(root), MAKING);
  let names: string[] = [];
  try {
    names = fs.readdirSync(area).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const note = readNote(path.join(area, name));
    if (note?.dir && !otherAtIt(note)) await copyTurn(note.dir, () => clearHalfCopy(root, note.dir));
  }
}

/**
 * True for a copy that can be used. git writes a copy's index last, so a copy from before this way of making them that
 * has none never got whole. One whose repo moved cannot be told yet, and is mended elsewhere.
 */
export function copyIsWhole(dir: string): boolean {
  let gitDir: string | null;
  try {
    gitDir = copyLink(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EISDIR';
  }
  return !gitDir || !fs.existsSync(gitDir) || fs.existsSync(path.join(gitDir, 'index'));
}

/** The copy's own git folder, as its `.git` file says. It takes no git to read, on any size. */
function copyLink(dir: string): string | null {
  const own = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'))?.[1];
  return own ? path.resolve(dir, own) : null;
}

/** The copy of this repo in this folder as git knows it: its own git folder. Null for anything else, which is not git's to remove. */
function copyGitDir(root: string, dir: string): string | null {
  if (!fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isFile()) return null;
  const own = git(dir, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  const common = git(root, ['rev-parse', '--git-common-dir'], { allowFail: true });
  return own && common && path.dirname(path.dirname(own)) === realOf(path.resolve(root, common)) ? own : null;
}

/** git's own record of where a copy is: what a move in one step leaves for it to be told. */
function tellGitWhere(gitDir: string, dir: string): void {
  fs.writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(realOf(path.dirname(dir)), path.basename(dir))}${path.sep}.git\n`);
}

/** A copy of this repo leaves its real place in one step, and goes with what is on its disk. False when it is not one. */
async function dropCopy(root: string, dir: string): Promise<boolean> {
  const gitDir = copyGitDir(root, dir);
  if (!gitDir) return false;
  const { at, noteFile } = makingPlace(root, dir);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(noteFile, JSON.stringify({ dir: path.resolve(dir), owner: process.pid, since: new Date().toISOString() } satisfies MakingNote));
  fs.renameSync(dir, at);
  tellGitWhere(gitDir, at);
  await clearHalfCopy(root, dir);
  return true;
}

const human = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.ceil(bytes / 1024 ** 2))} MB`);

/** There is not room for a copy on this computer's disk. Its words are for the person: nothing else can settle it. */
export class NoRoomForCopy extends Error {
  constructor(words: string) {
    super(words);
    this.name = 'NoRoomForCopy';
  }
}

/** A disk block: what a file takes at the least. */
const DISK_BLOCK = 4096;

/** The folder itself or the nearest one above it that is there: what the disk is asked about. */
function nearestFolder(dir: string): string {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/** Each copy takes the project's whole size. Stops with plain words on too little room; a size it cannot work out stops nothing. */
async function roomForCopy(root: string, commit: string, dir: string, signal?: AbortSignal): Promise<void> {
  let needed = 0;
  let free = 0;
  try {
    const disk = await fs.promises.statfs(nearestFolder(dir));
    free = disk.bavail * disk.bsize;
    await gitRecords(root, ['ls-tree', '-r', '-l', '-z', commit], '\0', (entry) => {
      needed += Math.ceil(Number(/^\d+ blob \S+ +(\d+)\t/.exec(entry)?.[1] ?? 0) / DISK_BLOCK) * DISK_BLOCK;
    }, signal ? { signal } : {});
  } catch (err) {
    if (err instanceof GitStopped) throw err;
    return;
  }
  if (needed > free) throw new NoRoomForCopy(`A copy of this project's code needs about ${human(needed)} of free disk space, and this computer has ${human(free)} free. Free up some space, then press Try again.`);
}

/**
 * Makes a copy in its real place, as `git worktree add <flags> <the place> <from>` would. Call it in the copy's turn,
 * with nothing whole there. A failure, or a Stop, leaves nothing in the real place: the rest goes by itself, in the next
 * turn, so a Stop lands now and not when the files are gone.
 */
export async function makeCopy(root: string, dir: string, flags: string[], from: string, how: CopyHow = {}, madeBranch?: { branch: string; start: string }): Promise<void> {
  how.making?.();
  await roomForCopy(root, from, dir, how.signal);
  if (fs.existsSync(dir) && !(await dropCopy(root, dir))) await fs.promises.rm(dir, { recursive: true, force: true });
  const { at, noteFile } = makingPlace(root, dir);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const note: MakingNote = { dir: path.resolve(dir), owner: process.pid, since: new Date().toISOString(), ...madeBranch };
  fs.writeFileSync(noteFile, JSON.stringify(note));
  try {
    await gitLater(root, ['worktree', 'prune'], { allowFail: true });
    // Every core a file can be written on, and a link by its full path, as the copy moves into place after.
    await gitLater(root, ['-c', 'checkout.workers=0', '-c', 'worktree.useRelativePaths=false', 'worktree', 'add', ...flags, at, from], { ...(how.signal ? { signal: how.signal } : {}), onSpawn: (pid) => fs.writeFileSync(noteFile, JSON.stringify({ ...note, pid })) });
    tellGitWhere(copyLink(at)!, dir);
    fs.renameSync(at, dir);
    fs.rmSync(path.dirname(at), { recursive: true, force: true });
    fs.rmSync(noteFile, { force: true });
  } catch (err) {
    void trackTask(copyTurn(dir, () => clearHalfCopy(root, dir)));
    if (/No space left on device|Disk quota exceeded/i.test((err as Error).message)) throw new NoRoomForCopy('The disk filled up while squad-kit made its copy of the code. Free up some space, then press Try again.');
    throw err;
  }
}

/**
 * The ticket's copy of the code. A branch pushed from another computer is where its work so far is, so the copy
 * starts from it, not from the base; `pushed` says so. With `remote`, a new copy starts from the newest base. Half a
 * copy from a crash or a Stop goes first, and a new one is made.
 */
export function addWorktree(projectRoot: string, ticketId: string, base: string, remote?: string, at?: string, how: CopyHow = {}): Promise<{ dir: string; branch: string; baseCommit: string; pushed?: string }> {
  const dir = at ?? path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
  const branch = `squad/${ticketId.toLowerCase()}`;
  return copyTurn(dir, async () => {
    let baseCommit = git(projectRoot, ['rev-parse', base]);
    await clearHalfCopy(projectRoot, dir, how.signal);
    if (copyIsWhole(dir)) return { dir, branch, baseCommit };
    const exists = git(projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true });
    const pushed = exists ? null : pushedBranch(projectRoot, branch);
    if (!exists && !pushed && remote) baseCommit = latestBase(projectRoot, base, remote).sha;
    if (exists) await makeCopy(projectRoot, dir, [], branch, how);
    // No tracking: nothing here reads it, and writing it is what two copies at once could trip over, after the branch is made.
    else await makeCopy(projectRoot, dir, ['--no-track', '-b', branch], pushed ?? baseCommit, how, { branch, start: git(projectRoot, ['rev-parse', pushed ?? baseCommit]) });
    // Xcode's build folder in the copy is squad-kit's own: never the story's work.
    keepOwnBuildsOut(dir);
    if (!pushed) return { dir, branch, baseCommit };
    // Where the ticket left the base, so its changes are measured from there and not against newer work in the base.
    return { dir, branch, baseCommit: git(projectRoot, ['merge-base', base, pushed], { allowFail: true }) || baseCommit, pushed: pushed.replace(/^refs\/remotes\//, '') };
  });
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

/** Removes a copy git knows as one of this repo's, beside everything else. Anything else in that folder is not git's to remove. */
export function removeWorktree(projectRoot: string, dir: string): Promise<void> {
  return copyTurn(dir, async () => {
    await clearHalfCopy(projectRoot, dir);
    if (fs.existsSync(dir) && !(await dropCopy(projectRoot, dir))) await gitLater(projectRoot, ['worktree', 'remove', '--force', dir], { allowFail: true });
  });
}

/** A throwaway copy of the code as it was at one commit, on no branch, beside the ticket copies. */
export async function addSnapshot(projectRoot: string, name: string, commit: string, how: CopyHow = {}): Promise<string> {
  const dir = path.join(worktreeRoot(projectRoot), name);
  await dropSnapshot(projectRoot, dir);
  await copyTurn(dir, () => makeCopy(projectRoot, dir, ['--detach'], commit, how));
  return dir;
}

/** Removes a throwaway copy, with whatever its setup added (node_modules and the like). */
export async function dropSnapshot(projectRoot: string, dir: string): Promise<void> {
  await removeWorktree(projectRoot, dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await gitLater(projectRoot, ['worktree', 'prune'], { allowFail: true });
}

/** Files changed in a worktree compared with where the ticket started, including new files. */
export async function changedFiles(dir: string, baseCommit: string): Promise<string[]> {
  const tracked = (await gitLater(dir, ['diff', '--name-only', baseCommit], { allowFail: true })).split('\n');
  const untracked = (await gitLater(dir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).split('\n');
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
}

/**
 * What a copy changed against where it started, written to a file straight as git says it: a huge change is read in
 * full by whoever opens the file, and is never told as no change at all.
 */
export async function writeChangesOf(dir: string, base: string | undefined, file: string, named: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    if (base) await gitBeside(dir, gitArgs(['diff', '--no-color', '--find-renames', base]), gitEnv(), { outputTo: fd }, () => undefined).catch(() => undefined);
  } finally {
    fs.closeSync(fd);
  }
  const added = (await gitLater(dir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).split('\n').filter(Boolean);
  const nothing = fs.statSync(file).size === 0;
  fs.appendFileSync(file, `${nothing ? 'Nothing changed in the files git already has.\n' : ''}\nNew files in ${named}/:\n${added.map((f) => `- ${f}`).join('\n') || '- none'}\n`);
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

const COMMIT_RULES = ['commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.js', '.commitlintrc.cjs', '.commitlintrc.yaml', '.commitlintrc.yml'];

/**
 * The project keeps its commit messages in the form commitlint checks. squad-kit's own commits run past the hooks or in a
 * copy with none, so nothing would turn them back here, and a check further on (a pull request, a pipeline) would.
 */
export function keepsCommitRules(dir: string): boolean {
  if (COMMIT_RULES.some((f) => fs.existsSync(path.join(dir, f)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { commitlint?: unknown; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
    return Boolean(pkg.commitlint || pkg.devDependencies?.['@commitlint/cli'] || pkg.dependencies?.['@commitlint/cli']);
  } catch {
    return false;
  }
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
async function stagedHookFiles(dir: string): Promise<Map<string, string>> {
  const names = hookFiles(dir);
  const staged = new Map<string, string>();
  await gitRecords(dir, ['ls-files', '-s', '-z'], '\0', (line) => {
    const entry = /^(\d+) ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
    if (entry && isHookFile(entry[3]!, names)) staged.set(entry[3]!, `${entry[1]},${entry[2]}`);
  });
  return staged;
}

/** A hook may change what is staged, as a formatter does, but not the check itself: it would run on every teammate's next commit. */
async function keepHookFiles(dir: string, before: Map<string, string>): Promise<void> {
  const now = await stagedHookFiles(dir);
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
async function filesFromHooks(dir: string, stagedBefore: Map<string, string>): Promise<void> {
  await stageAllLater(dir);
  await keepHookFiles(dir, stagedBefore);
}

/**
 * The hooks look at the change. A hook that fixed files and said no (a formatter), or that only refused the words
 * (commitlint), gets one more try with the fixed files staged and the words in the usual form; then it is a HookRefused,
 * and a person decides. The commit they make is only for them: it goes with the throwaway folder. What they say goes on:
 * the words for the real commit, or null when they left nothing to save.
 */
async function hooksLook(dir: string, start: string, message: string, words: string, limitMs: number, how: HookRun, whole: boolean): Promise<string | null> {
  const stagedBefore = await stagedHookFiles(dir);
  let last: CommitTry | undefined;
  try {
    last = await hooksCommit(dir, start, message, limitMs, how);
    if (!last.ok) {
      hookOutcome(dir, last, limitMs, how);
      await filesFromHooks(dir, stagedBefore);
      last = await hooksCommit(dir, start, commitHooks(dir).includes('commit-msg') ? words : message, limitMs, how);
    }
    if (!last.ok) {
      hookOutcome(dir, last, limitMs, how);
      await filesFromHooks(dir, stagedBefore);
      // The hook fixed everything itself (a formatter), so nothing is left to save. On a whole change it would mean throwing the work away.
      if (!whole && !somethingToSave(dir)) return null;
      throw new HookRefused(hookSaid(last.said, how), false, limitMs);
    }
    return last.words ?? message;
  } finally {
    // In this order: a crash between them leaves the folder, so the next start puts the files right.
    if (last?.stopped || last?.timedOut) await putFilesBackLater(dir);
    else await filesFromHooks(dir, stagedBefore);
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
    if (somethingToSave(dir)) await commitLater(dir, message);
    return;
  }
  const merging = isMerging(dir);
  const whole = Boolean(how.from) || merging;
  const savedFirst = whole && somethingToSave(dir);
  if (savedFirst) await commitLater(dir, keepsCommitRules(dir) ? conventionalWords('chore', `work so far: ${message}`) : `Work so far: ${message}`);
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
  await gitLater(dir, [...authorArgs(dir), 'commit', ...(whole ? ['--allow-empty'] : []), '-m', saying]);
}

/**
 * The work so far on a ticket's own branch, not its finished change. The project's commit hooks get a short try. When
 * they say no (unfinished work often fails them) the work is still saved, since nothing goes to the base here, and
 * `hookSaid` tells the caller, which marks the ticket hookOwed: the hooks see this work again when the change is
 * accepted. A hook only looks at what is staged, so nothing else would ever show it to them.
 */
export async function commitAll(dir: string, message: string, words = message, how: HookRun = {}): Promise<{ commit: string | null; hookSaid?: string }> {
  await stageAllLater(dir);
  if (!somethingToSave(dir)) return { commit: null };
  let said: string | undefined;
  try {
    await commitChecked(dir, message, words, SHORT_HOOK_MS, how);
  } catch (err) {
    if (!(err instanceof HookRefused)) throw err;
    said = err.said;
    if (somethingToSave(dir)) await commitLater(dir, message);
  }
  return { commit: git(dir, ['rev-parse', '--short', 'HEAD']), ...(said !== undefined ? { hookSaid: said } : {}) };
}

/** A commit with the project's hooks off, like every other git the engine runs. The caller keeps the record of why. */
export function commitWithoutHooks(dir: string, message: string): void {
  git(dir, commitArgs(dir, message));
}

/** commitWithoutHooks, beside everything else: on a big project a commit looks at every file. */
export async function commitLater(dir: string, message: string): Promise<void> {
  await gitLater(dir, commitArgs(dir, message));
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
    tree = execFileSync('git', gitArgs(['merge-tree', '--write-tree', baseSha, branchSha]), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MOST_OUTPUT, env: gitEnv() }).split('\n')[0]!.trim();
  } catch (err) {
    const e = err as { status?: number | null; stderr?: Buffer | string; message: string; code?: string };
    // Exit code 1 is git's "the merge has conflicts"; anything else means the merge could not be tried. A clean merge
    // says one line, so only clashes can say too much.
    if (e.status === 1 || e.code === 'ENOBUFS') throw new MergeClash(`${branch} clashes with changes already in ${base}.`);
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
