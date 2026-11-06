import { execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { findApp, isUp, projectApps, type ProjectApp } from '../board/apps.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { RepoInfo } from '../board/types.js';
import { runCommand, tail } from './checks.js';
import { DOCKER_STOP_MS, DOCKER_WAIT_MS, composeRun, dockerGuard } from './compose-run.js';
import { dockerBlockedWords, guardSupport, projectGuardFor, spawnProject, type GuardSpec } from './project-guard.js';
import { git, latestBase } from './git.js';
import { KILL_AFTER_MS, OWN_GROUP, endGroup, endTree, takenOver } from './process-group.js';
import { portSettings } from './port-vars.js';
import { reposOf } from './repos.js';
import { runsAsProduct } from '../board/parts.js';
import { leaveProduct, takeProduct } from './product-lock.js';

/**
 * Your apps: squad-kit runs each app of the project from its own copy of main, never the person's checkout, so a
 * project manager can try what the squad built without a terminal. One copy per app. It runs while the board runs,
 * and stops with it, the whole process group. Terminal: `squad app start`, `squad app stop`, `squad app status`.
 */

export type AppState = 'not-running' | 'starting' | 'running' | 'stopped' | 'failed';

/** Another program holds the app's port. */
export interface BusyPort {
  port: number;
  /** The program that holds it, when the system can tell. */
  program?: string;
  pid?: number;
  /** squad-kit started it (an earlier run, or `squad app start` in a terminal), so squad-kit may stop it. */
  ours: boolean;
}

export interface AppStatus extends ProjectApp {
  state: AppState;
  /** While starting: bringing the copy up to date, the setup command, or the start command. */
  step?: 'update' | 'setup' | 'start';
  /** Where it runs: the app's address, or the next free port when the person chose it. */
  address?: string;
  /** When the person last pressed Start: the copy holds main as it was then. */
  startedAt?: string;
  /** When it began to answer. */
  since?: string;
  /** Why it failed, in one plain sentence with no command, port or process in it. */
  error?: string;
  /** What failed, for engineers ("See what failed"): the command and what it printed, the port and the program. */
  detail?: string;
  busy?: BusyPort;
  /** The main commit the copy holds. */
  commit?: string;
  /** squad-kit's copy of the code. */
  dir: string;
  /** Running, but not from this board: from `squad app start` in a terminal, or an earlier squad-kit. */
  elsewhere?: boolean;
  /** Something answers at the app's address now. */
  up: boolean;
}

export interface StartOptions {
  /** Kept for the terminal's --next-port: an app that takes a port setting moves to the next free port by itself. */
  nextPort?: boolean;
  /** The port is in use by a program squad-kit started earlier: stop that program first. */
  stopOther?: boolean;
}

export interface RunnerOptions {
  /** How long the app gets to answer at its address. */
  waitMs?: number;
  /** Every line the app prints, as it prints it: `squad app start` in a terminal shows them. */
  echo?(text: string): void;
}

/** What this computer keeps about each app, in the project's folder in ~/.squad-kit: apps.json. */
interface AppRecord {
  /** The process group squad-kit started for it, while it runs. */
  pid?: number;
  url?: string;
  commit?: string;
  startedAt?: string;
  /** The dependency files the setup last ran for. */
  setupFor?: string;
  /** Merged tickets the person said Not now to. */
  notNow?: string[];
}

interface Run {
  state: AppState;
  step?: AppStatus['step'];
  child?: ChildProcess;
  address?: string;
  startedAt: string;
  since?: string;
  error?: string;
  detail?: string;
  busy?: BusyPort;
  commit?: string;
  stop: AbortController;
  /** Resolves once the start is over: running, failed or stopped. */
  settled: Promise<void>;
  /** Resolves once the app's program has exited. */
  exited: Promise<void>;
  /** A part in Docker: this stops its stack and keeps its data, once its program is gone. */
  afterStop?: () => Promise<unknown>;
}

/** A start that went wrong before anything of the app ran; the exact error is for engineers. */
const CANNOT_START = 'squad-kit could not start it.';

export const APP_WAIT_MS = 3 * 60_000;
const SETUP_MS = 20 * 60_000;
const OUTPUT_KEEP = 60_000;

/** squad-kit's own copy of an app's code, in the project's folder on this computer. */
/** Who holds the running product when a person runs it from Your apps. */
const YOUR_APPS = 'Your apps';

export function appCopyDir(bp: BoardPaths, app: ProjectApp): string {
  return path.join(bp.localDir, 'apps', app.name.replace(/[^\w.-]+/g, '-') || 'app');
}

/**
 * Brings squad-kit's copy up to date with the newest main: the work accepted here, and the team's as last fetched.
 * Files the app wrote that git does not track (packages, a local database) stay. A new copy says so: it needs the setup.
 */
export function updateCopy(root: string, repo: RepoInfo, dir: string): { commit: string; fresh: boolean } {
  const src = path.join(root, repo.path);
  const commit = latestBase(src, repo.base, repo.remote || undefined).sha;
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      git(dir, ['checkout', '--force', '--detach', commit]);
      return { commit, fresh: false };
    } catch {
      // No longer a working copy: make it again.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(src, ['worktree', 'prune'], { allowFail: true });
  git(src, ['worktree', 'add', '--force', '--detach', dir, commit]);
  return { commit, fresh: true };
}

/** `.env`, `.env.local`, `.env.development` and the like; not the examples a project keeps in git for people to copy. */
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;

/**
 * Copies the person's `.env` files from their own folder into squad-kit's copy, at the same places, because git never
 * carries them and the app needs them to start. They stay on this computer, readable by this user only. Says which
 * ones it copied.
 */
/** The project's untracked .env files in a repo, by their paths in it. */
export function localEnvFiles(src: string): string[] {
  const list = (args: string[]) =>
    git(src, ['ls-files', '-z', '--others', '--exclude-standard', ...args], { allowFail: true })
      .split('\0')
      .filter((f) => f && !f.endsWith('/'));
  // Untracked files, and ignored ones with ignored folders (node_modules) folded into one line.
  return [...new Set([...list([]), ...list(['--ignored', '--directory'])])].filter((f) => {
    const name = path.basename(f);
    return ENV_FILE.test(name) && !ENV_EXAMPLE.test(name);
  });
}

/** Copies the .env files, and the local files an engineer named, into squad-kit's own copy that runs the person's own version. */
export function copyEnvFiles(src: string, dir: string, named: string[] = []): string[] {
  const files = [...new Set([...localEnvFiles(src), ...named.filter((f) => fs.existsSync(path.join(src, f)))])];
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
    fs.chmodSync(to, 0o600);
  }
  return files.sort();
}

/** Files that list what the app needs: when one changes, the setup command runs again. */
const DEP_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'uv.lock', 'setup.py', 'setup.cfg', 'Gemfile', 'Gemfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'packages.lock.json', 'Directory.Packages.props', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock',
]);
const DEP_NAMES = [/^requirements.*\.txt$/, /\.(cs|fs|vb)proj$/];

/** One short fingerprint of the dependency files at a commit. */
export function dependencyPrint(dir: string, commit: string): string {
  const lines = git(dir, ['ls-tree', '-r', commit], { allowFail: true })
    .split('\n')
    .filter((l) => {
      const name = path.basename(l.split('\t')[1] ?? '');
      return DEP_FILES.has(name) || DEP_NAMES.some((p) => p.test(name));
    });
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The start command on another port, when it takes a port setting: $PORT, --port 3000, -p 3000, PORT=3000 or
 * host:3000. Null when it has none, so squad-kit cannot move it.
 */
export function onPort(command: string, from: number, to: number): string | null {
  if (/\$\{?PORT\b|%PORT%/.test(command)) return command;
  const n = String(from);
  const settings = [
    new RegExp(`(--port[= ])${n}\\b`),
    new RegExp(`(\\s-p ?)${n}\\b`),
    new RegExp(`(\\bPORT=)${n}\\b`),
    new RegExp(`((?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):)${n}\\b`),
  ];
  for (const s of settings) if (s.test(command)) return command.replace(s, `$1${to}`);
  return null;
}

export function portOf(url: string): number {
  const u = new URL(url);
  return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
}

export function withPort(url: string, port: number): string {
  const u = new URL(url);
  u.port = String(port);
  return url.endsWith('/') ? u.toString() : u.toString().replace(/\/$/, '');
}

const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

function isLocal(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (yes: boolean) => {
      s.destroy();
      resolve(yes);
    };
    // When this process was busy (a git call that waits, on a busy computer), the timer comes up before an answer that
    // is already here. That answer goes first, or a port in use reads as free.
    s.setTimeout(800, () => setImmediate(() => done(false)));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** True when a program on this computer listens on the port, over IPv4 or IPv6. */
export async function portTaken(port: number): Promise<boolean> {
  return (await connects('127.0.0.1', port)) || (await connects('::1', port));
}

/** The first port after `from` that nothing listens on. */
export async function nextFreePort(from: number): Promise<number | undefined> {
  for (let p = from + 1; p < from + 50 && p < 65536; p += 1) if (!(await portTaken(p))) return p;
  return undefined;
}

/** The program listening on a port, when the system can tell (lsof on a Mac and on Linux). */
export function whoListens(port: number): { pid: number; program: string } | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const pid = Number(/^p(\d+)/m.exec(out)?.[1]);
    return pid ? { pid, program: /^c(.+)$/m.exec(out)?.[1] ?? '' } : null;
  } catch {
    return null;
  }
}

/** One field of a process, from ps: its group (pgid) or its parent (ppid). */
function psField(pid: number, field: 'pgid' | 'ppid'): number | null {
  if (process.platform === 'win32') return null;
  try {
    return Number(execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()) || null;
  } catch {
    return null;
  }
}

/** True while any process of the group runs. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(OWN_GROUP ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  // Windows has no groups: the whole tree under the shell goes at once.
  if (process.platform === 'win32') return endTree(pid);
  try {
    process.kill(OWN_GROUP ? -pid : pid, signal);
  } catch {
    // Already gone.
  }
}

/** Stops a process group squad-kit started, from any process: TERM, then KILL when it is still there. */
export async function endPid(pid: number): Promise<void> {
  signalPid(pid, 'SIGTERM');
  const until = Date.now() + KILL_AFTER_MS;
  while (groupAlive(pid) && Date.now() < until) await sleep(100);
  if (groupAlive(pid)) signalPid(pid, 'SIGKILL');
  const gone = Date.now() + 2000;
  while (groupAlive(pid) && Date.now() < gone) await sleep(100);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The address a dev server prints when it is ready ("Local: http://localhost:5173/"), for an app with none set. */
export function addressIn(output: string): string | undefined {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s'"]*/i.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
  return m?.[0].replace('0.0.0.0', '127.0.0.1').replace(/\/$/, '');
}

/** The port a crashed start says is taken (EADDRINUSE and the like). */
export function busyIn(output: string): number | undefined {
  const m = /(?:EADDRINUSE|address already in use)[^\n]*?:(\d{2,5})\b|port (\d{2,5}) is (?:already )?in use/i.exec(output);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

/**
 * The process group listening on a port, when squad-kit started it: one of this project's apps (its group is kept in
 * apps.json), or anything this squad-kit process runs (a ticket's copy of the app for the Tester, a check). Null for a
 * program of the person's own, which squad-kit never stops.
 */
export function squadKitOn(bp: BoardPaths, port: number): { group: number; holder: { pid: number; program: string }; app?: string } | null {
  const holder = whoListens(port);
  if (!holder) return null;
  const group = psField(holder.pid, 'pgid') ?? holder.pid;
  let records: Record<string, AppRecord> = {};
  try {
    records = JSON.parse(fs.readFileSync(path.join(bp.localDir, 'apps.json'), 'utf8')) as Record<string, AppRecord>;
  } catch {
    // No app started yet.
  }
  const repo = Object.entries(records).find(([, r]) => r.pid === group)?.[0];
  if (repo !== undefined) {
    const app = projectApps(readMeta(bp)).find((a) => a.repo === repo);
    return { group, holder, ...(app ? { app: app.name } : {}) };
  }
  return psField(group, 'ppid') === process.pid ? { group, holder } : null;
}

export class AppError extends Error {}

/** The project's apps on this computer: the board's buttons and the terminal's calls share one runner per project. */
export class AppRunner {
  private runs = new Map<string, Run>();
  private output = new Map<string, string>();

  constructor(
    private bp: BoardPaths,
    private opts: RunnerOptions = {},
  ) {}

  /** squad-kit's own guard for an app copy's commands on this computer, or null where there is none (Windows). */
  private guardFor(cwd: string): GuardSpec | undefined {
    if (!guardSupport().on) return undefined;
    const allow = readMeta(this.bp).guard;
    return projectGuardFor(this.bp, { cwd, ...(allow ? { allow } : {}) });
  }

  private find(ref?: string): ProjectApp {
    try {
      return findApp(readMeta(this.bp), ref);
    } catch (err) {
      throw new AppError((err as Error).message);
    }
  }

  private repoOf(app: ProjectApp): RepoInfo {
    return reposOf(readMeta(this.bp)).find((r) => r.path === app.repo)!;
  }

  private file(): string {
    return path.join(this.bp.localDir, 'apps.json');
  }

  private records(): Record<string, AppRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, AppRecord>;
    } catch {
      return {};
    }
  }

  private record(repo: string, change: (r: AppRecord) => void): void {
    const all = this.records();
    const r = all[repo] ?? {};
    change(r);
    all[repo] = r;
    fs.mkdirSync(this.bp.localDir, { recursive: true });
    fs.writeFileSync(this.file(), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  }

  /** A run squad-kit started outside this board that still runs. */
  private elsewhere(repo: string): AppRecord | null {
    const r = this.records()[repo];
    return r?.pid && groupAlive(r.pid) && !takenOver(r.pid, r.startedAt) && !this.runs.get(repo)?.child ? r : null;
  }

  /**
   * The process group on the port, when squad-kit started it: one of this project's apps, or anything this
   * squad-kit runs (a ticket's copy of the app for the Tester, a check). Null for a program of the person's own.
   */
  private oursOn(port: number): { group: number; holder: { pid: number; program: string } } | null {
    return squadKitOn(this.bp, port);
  }

  private keep(repo: string, text: string): void {
    this.output.set(repo, ((this.output.get(repo) ?? '') + text).slice(-OUTPUT_KEEP));
    this.opts.echo?.(text);
  }

  /** Every app of the project and how it is now. */
  async status(): Promise<AppStatus[]> {
    return Promise.all(projectApps(readMeta(this.bp)).map((a) => this.view(a)));
  }

  async statusOf(ref?: string): Promise<AppStatus> {
    return this.view(this.find(ref));
  }

  private async view(app: ProjectApp): Promise<AppStatus> {
    const run = this.runs.get(app.repo);
    const dir = appCopyDir(this.bp, app);
    const base = { ...app, dir };
    if (run) {
      const at = run.address ?? app.url;
      return {
        ...base,
        state: run.state,
        ...(run.state === 'starting' && run.step ? { step: run.step } : {}),
        ...(run.address && run.state !== 'failed' ? { address: run.address } : {}),
        startedAt: run.startedAt,
        ...(run.since && run.state === 'running' ? { since: run.since } : {}),
        ...(run.error ? { error: run.error } : {}),
        ...(run.detail ? { detail: run.detail } : {}),
        ...(run.busy ? { busy: run.busy } : {}),
        ...(run.commit ? { commit: run.commit } : {}),
        up: at ? await isUp(at) : false,
      };
    }
    const away = this.elsewhere(app.repo);
    if (away) {
      return { ...base, state: 'running', address: away.url, startedAt: away.startedAt, since: away.startedAt, commit: away.commit, elsewhere: true, up: away.url ? await isUp(away.url) : false };
    }
    const last = this.records()[app.repo]?.startedAt;
    return { ...base, state: 'not-running', ...(last ? { startedAt: last } : {}), up: app.url ? await isUp(app.url) : false };
  }

  /** The last lines the app and its setup printed, for engineers. */
  lines(ref?: string, count = 200): string[] {
    const app = this.find(ref);
    return (this.output.get(app.repo) ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-count);
  }

  /** The person said Not now to the new version a ticket brought. */
  notNow(ref: string | undefined, ticket: string): void {
    const app = this.find(ref);
    this.record(app.repo, (r) => (r.notNow = [...new Set([...(r.notNow ?? []), ticket])].slice(-50)));
  }

  notNowOf(repo: string): string[] {
    return this.records()[repo]?.notNow ?? [];
  }

  /**
   * Starts the app from squad-kit's copy of main. It answers at once with the app's status (Starting); the rest runs
   * on: the copy brought up to date, the setup when the copy is new or its dependency files changed, then the start
   * command, until the address answers. `settled()` waits for the end of it.
   */
  start(ref?: string, opts: StartOptions = {}): AppStatus {
    const app = this.find(ref);
    if (!app.start) throw new AppError(`squad-kit does not know how to start ${app.name} yet. Ask the Architect to find it, or type the start command.`);
    const now = this.runs.get(app.repo);
    if (now?.state === 'starting') throw new AppError(`${app.name} is starting already.`);
    if (now?.state === 'running') throw new AppError(`${app.name} is already running at ${now.address ?? app.url}.`);
    const away = this.elsewhere(app.repo);
    if (away && !opts.stopOther) throw new AppError(`${app.name} is already running at ${away.url ?? app.url}, started outside the board. Stop it first, or press Restart.`);
    const stop = new AbortController();
    let settle!: () => void;
    let exit!: () => void;
    const run: Run = {
      state: 'starting',
      step: 'update',
      startedAt: new Date().toISOString(),
      stop,
      settled: new Promise<void>((r) => (settle = r)),
      exited: new Promise<void>((r) => (exit = r)),
    };
    this.runs.set(app.repo, run);
    this.output.set(app.repo, '');
    void this.launch(app, run, opts, exit)
      .catch((err) => this.fail(run, CANNOT_START, { detail: (err as Error).message }))
      .finally(() => {
        if (!run.child) exit();
        settle();
      });
    return { ...app, dir: appCopyDir(this.bp, app), state: 'starting', step: 'update', startedAt: run.startedAt, up: false };
  }

  /** Waits until the app's start is over, and says how it went. */
  async settled(ref?: string): Promise<AppStatus> {
    const app = this.find(ref);
    await this.runs.get(app.repo)?.settled;
    return this.view(app);
  }

  /** Resolves once the app's program has exited: stopped, or ended by itself. */
  async exited(ref?: string): Promise<void> {
    await this.runs.get(this.find(ref).repo)?.exited;
  }

  private fail(run: Run, error: string, more: { detail?: string; busy?: BusyPort } = {}): void {
    if (run.stop.signal.aborted) return;
    run.state = 'failed';
    run.error = error;
    if (more.detail) run.detail = more.detail;
    if (more.busy) run.busy = more.busy;
    this.leaveIfIdle();
  }

  /** The running product is free again once none of Your apps runs. */
  private leaveIfIdle(): void {
    if (![...this.runs.values()].some((r) => r.state === 'starting' || r.state === 'running')) leaveProduct(this.bp, YOUR_APPS);
  }

  private async launch(app: ProjectApp, run: Run, opts: StartOptions, exited: () => void): Promise<void> {
    const repo = this.repoOf(app);
    const dir = appCopyDir(this.bp, app);
    const { signal } = run.stop;
    // A product's parts keep their addresses, so Your apps and a story cannot run it at the same time.
    const fixed = runsAsProduct(readMeta(this.bp));
    if (fixed) {
      const other = takeProduct(this.bp, YOUR_APPS, 'apps');
      if (other) return this.fail(run, `The squad is running the product for ${other.holder.replace(/^try:/, '')} right now, on the same addresses. Start this again when that is done.`);
    }
    await this.elsewhereStopped(app, opts);

    // The newest main, every time: the work accepted since the last Start comes with it.
    let copy: { commit: string; fresh: boolean };
    try {
      copy = updateCopy(this.bp.root, repo, dir);
    } catch (err) {
      return this.fail(run, `squad-kit could not get the newest ${repo.base} ready.`, { detail: (err as Error).message });
    }
    run.commit = copy.commit;
    if (signal.aborted) return;
    const named = (readMeta(this.bp).localFiles ?? []).filter((f) => f.repo === repo.path).map((f) => f.path);
    try {
      const env = copyEnvFiles(path.join(this.bp.root, repo.path), dir, named);
      if (env.length) this.keep(app.repo, `Copied from your project folder: ${env.join(', ')}\n`);
    } catch (err) {
      return this.fail(run, "squad-kit could not copy this project's settings into its own copy.", { detail: `Could not copy your .env files: ${(err as Error).message}` });
    }

    // Something else on the app's port: squad-kit goes around it when the app takes a port setting. Only when it cannot
    // does the person read about it, in plain words. The program is left alone unless they press Stop it and start.
    let url = app.url;
    let command = app.start!;
    let moved: Record<string, string> = {};
    const port = url && isLocal(url) ? portOf(url) : null;
    if (port && (await portTaken(port))) {
      const ours = opts.stopOther ? this.oursOn(port) : null;
      const freed = ours ? await this.freePort(app, port, ours) : false;
      if (!freed) {
        const own = portSettings(dir, port);
        const next = !fixed && (onPort(command, port, port + 1) !== null || own.reads) ? await nextFreePort(port) : undefined;
        if (!next) return this.fail(run, ...(await this.busyPort(app, port)));
        command = onPort(command, port, next) ?? command;
        url = withPort(url!, next);
        moved = Object.fromEntries(own.vars.map((name) => [name, String(next)]));
        this.keep(app.repo, `Port ${port} is used by another program, so ${app.name} runs on port ${next}${own.vars.length ? ` (set as PORT and ${own.vars.join(', ')})` : ''}\n`);
      }
    }

    // A new copy, or new packages since the last setup: the project's setup first.
    const setup = repo.commands.setup?.trim();
    const deps = dependencyPrint(dir, copy.commit);
    if (setup && (copy.fresh || this.records()[app.repo]?.setupFor !== deps)) {
      run.step = 'setup';
      this.keep(app.repo, `$ ${setup}\n`);
      const r = await runCommand(dir, setup, SETUP_MS, { signal, ...(this.guardFor(dir) ? { guard: this.guardFor(dir)! } : {}) });
      this.keep(app.repo, `${r.output}\n`);
      if (signal.aborted) return;
      // One plain sentence; the command and what it printed are behind "See what failed", for engineers.
      if (!r.ok) return this.fail(run, dockerBlockedWords(r.output, this.guardFor(dir)) ?? `squad-kit could not set up ${app.name}.`, { detail: `${setup}\n${tail(r.output, 30)}` });
      this.record(app.repo, (rec) => (rec.setupFor = deps));
      // A setup can write the same files, like cp .env.example .env.dev: the person's own go back over them.
      try {
        copyEnvFiles(path.join(this.bp.root, repo.path), dir, named);
      } catch (err) {
        return this.fail(run, "squad-kit could not copy this project's settings into its own copy.", { detail: `Could not copy your .env files: ${(err as Error).message}` });
      }
    }

    // A part that runs in Docker gets the one opening compose-run.ts allows, as it does for a story.
    const compose = composeRun(readMeta(this.bp), repo.path, command, dir, this.bp.root);
    if (compose && 'why' in compose) return this.fail(run, compose.why);
    const ownGuard = this.guardFor(dir);
    const guard = compose && ownGuard ? dockerGuard(ownGuard, compose) : ownGuard;
    if (compose) {
      command = compose.command;
      run.afterStop = () => runCommand(dir, compose.stop, DOCKER_STOP_MS, { ...(guard ? { guard } : {}), env: compose.env });
    }
    const waitMs = this.opts.waitMs ?? (compose ? DOCKER_WAIT_MS : APP_WAIT_MS);

    run.step = 'start';
    this.keep(app.repo, `$ ${command}\n`);
    const env = {
      CI: '1',
      FORCE_COLOR: '0',
      BROWSER: 'none',
      ...(url && (url !== app.url || /\$\{?PORT\b|%PORT%/.test(command)) ? { PORT: String(portOf(url)) } : {}),
      ...moved,
      ...(compose ? compose.env : {}),
    };
    const child = spawnProject(command, { cwd: dir, env, ...(guard ? { guard } : {}) });
    run.child = child;
    let printed = '';
    const heard = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      printed = (printed + text).slice(-OUTPUT_KEEP);
      this.keep(app.repo, text);
    };
    child.stdout!.on('data', heard);
    child.stderr!.on('data', heard);
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      exited();
      this.record(app.repo, (rec) => delete rec.pid);
      if (run.state === 'running' && !signal.aborted) {
        run.state = 'failed';
        run.error = 'It stopped by itself.';
        run.detail = `${command}\n${tail(printed, 30)}`;
        this.leaveIfIdle();
      }
    };
    child.once('error', (err) => {
      printed += `\n${err.message}`;
      done();
    });
    child.once('exit', done);
    if (child.pid) this.record(app.repo, (rec) => Object.assign(rec, { pid: child.pid, url, commit: copy.commit, startedAt: run.startedAt }));

    // Running only once the address answers.
    const until = Date.now() + waitMs;
    while (!signal.aborted) {
      if (ended) {
        const taken = busyIn(printed);
        if (taken) return this.fail(run, ...(await this.busyPort(app, taken)));
        return this.fail(run, dockerBlockedWords(printed, guard) ?? 'It stopped while starting.', { detail: `${command}\n${tail(printed, 30)}` });
      }
      url ??= addressIn(printed);
      if (url) run.address = url;
      if (url && (await isUp(url))) {
        run.state = 'running';
        run.since = new Date().toISOString();
        this.record(app.repo, (rec) => (rec.url = url));
        return;
      }
      if (Date.now() > until) {
        endGroup(child);
        await Promise.race([run.exited, sleep(KILL_AFTER_MS + 1000)]);
        await run.afterStop?.();
        const mins = Math.round(waitMs / 60_000);
        const wait = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(waitMs / 1000)} seconds`;
        const printedLast = tail(printed, 30);
        return url
          ? this.fail(run, `It did not answer within ${wait}.`, { detail: `${command}\nIt did not answer at ${url}.\n${printedLast}` })
          : this.fail(run, `squad-kit could not tell where it runs after ${wait}.`, { detail: `${command}\nIt printed no address. Set the app's address, like http://localhost:3000\n${printedLast}` });
      }
      await sleep(400);
    }
  }

  /** The app runs from outside this board, and the person asked to start it here: that run stops first. */
  private async elsewhereStopped(app: ProjectApp, opts: StartOptions): Promise<void> {
    const away = this.elsewhere(app.repo);
    if (!opts.stopOther || !away?.pid) return;
    await endPid(away.pid);
    this.record(app.repo, (r) => delete r.pid);
  }

  /** Stops the program squad-kit started on the app's port. True once the port is free. */
  private async freePort(app: ProjectApp, port: number, ours: { group: number; holder: { pid: number; program: string } }): Promise<boolean> {
    this.keep(app.repo, `Stopping ${ours.holder.program || 'the program'} (process ${ours.holder.pid}), which squad-kit started on port ${port}\n`);
    await endPid(ours.group);
    const until = Date.now() + 3000;
    while ((await portTaken(port)) && Date.now() < until) await sleep(200);
    return !(await portTaken(port));
  }

  /** One plain sentence about a program in the way. What the system can tell about it is for engineers. */
  private async busyPort(app: ProjectApp, port: number): Promise<[string, { detail: string; busy: BusyPort }]> {
    const ours = this.oursOn(port);
    const holder = ours?.holder ?? whoListens(port);
    const busy: BusyPort = { port, ours: Boolean(ours), ...(holder ? { pid: holder.pid, ...(holder.program ? { program: holder.program } : {}) } : {}) };
    const who = holder ? `${holder.program || 'A program'} (process ${holder.pid})` : 'A program the system does not name';
    return [
      ours ? `Something squad-kit started earlier is using what ${app.name} needs.` : `Another program on this computer is using what ${app.name} needs.`,
      { detail: `${who} listens on port ${port}, the port in ${app.name}'s address.`, busy },
    ];
  }

  /** Stops the app and everything it started. */
  async stop(ref?: string): Promise<AppStatus> {
    const app = this.find(ref);
    const run = this.runs.get(app.repo);
    if (run && (run.state === 'starting' || run.state === 'running')) {
      run.stop.abort();
      if (run.child) {
        endGroup(run.child);
        await Promise.race([run.exited, sleep(KILL_AFTER_MS + 2000)]);
        if (run.child.pid) {
          const gone = Date.now() + 2000;
          while (groupAlive(run.child.pid) && Date.now() < gone) await sleep(100);
        }
      }
      await run.settled;
      await run.afterStop?.();
      run.state = 'stopped';
      delete run.error;
      delete run.busy;
      this.leaveIfIdle();
      return this.view(app);
    }
    const away = this.elsewhere(app.repo);
    if (away?.pid) {
      await endPid(away.pid);
      this.record(app.repo, (r) => delete r.pid);
      this.runs.set(app.repo, { state: 'stopped', startedAt: away.startedAt ?? new Date().toISOString(), stop: new AbortController(), settled: Promise.resolve(), exited: Promise.resolve() });
      return this.view(app);
    }
    throw new AppError(`${app.name} is not running.`);
  }

  /** Stops the app when it runs, then starts it on the newest main. Also "Run the new version". */
  async restart(ref?: string, opts: StartOptions = {}): Promise<AppStatus> {
    const app = this.find(ref);
    const run = this.runs.get(app.repo);
    if ((run && (run.state === 'starting' || run.state === 'running')) || this.elsewhere(app.repo)) await this.stop(app.name);
    return this.start(app.name, opts);
  }

  /** The board closes: every app it started stops at once, the whole process group. */
  stopAll(): void {
    for (const [repo, run] of this.runs) {
      if (run.state !== 'starting' && run.state !== 'running') continue;
      run.stop.abort();
      if (run.child) endGroup(run.child);
      this.record(repo, (r) => delete r.pid);
    }
  }
}

const runners = new Map<string, AppRunner>();

/** The one runner for a project in this process. */
export function appRunner(bp: BoardPaths): AppRunner {
  let r = runners.get(bp.root);
  if (!r) runners.set(bp.root, (r = new AppRunner(bp)));
  return r;
}

/** The board closes the project: its apps stop with it. */
export function stopApps(bp: BoardPaths): void {
  runners.get(bp.root)?.stopAll();
  runners.delete(bp.root);
}
