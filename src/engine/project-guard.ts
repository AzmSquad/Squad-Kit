import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import type { ProjectGuard } from '../board/types.js';
import { AI_TOOLS, BROWSERS } from '../modules/registry.js';
import { squadHome } from '../core/home.js';
import { childEnv } from './agent-env.js';
import { OWN_GROUP, track } from './process-group.js';
import { PACKAGE_CACHES, PRIVATE, packageCacheEnv, projectCacheDir, ticketCacheDir } from './sandbox.js';

/**
 * squad-kit's own guard for the project's own commands: the checks (test, lint, build), the app's start, the setup
 * commands and the release pipeline. The Builder writes that code, so a tricked Builder could make a "test" that reads
 * the person's keys or squad-kit's board token and sends them out. The guard runs each command under the operating
 * system's own sandbox (Seatbelt on a Mac, bubblewrap on Linux), where it works normally and may reach the network
 * for packages and tests, but cannot read the private files below. Network is allowed on purpose: the protection is
 * that secrets cannot be read, so there is nothing secret to send. Windows has no guard yet (the note says so).
 *
 * Everything that spawns a project command goes through spawnProject here, so nothing runs unguarded by mistake
 * (test/project-guard.test.ts fails on a new shell spawn of a project command outside this module).
 */

/** The Seatbelt binary on a Mac. */
const SEATBELT = '/usr/bin/sandbox-exec';

/** What the guard lets a command read and write, built from the project's places on this computer. */
export interface GuardSpec {
  /** The command's own copy of the code: read and write. */
  cwd: string;
  /** The person's own project folder, outside the copy: its .env files stay out of reach. */
  root: string;
  /** Folders the command may also write in: the proof folder, the package caches, the project/ticket cache. */
  write: string[];
  /** Folders the command may also read: its attachments, its own cache. */
  read: string[];
  /** Files and folders no command may read: keys, sign-ins, squad-kit's own folder, browser profiles, .env files. */
  noRead: string[];
  /** squad-kit's own files a command may read but never change (the screenshot browser build it runs itself). */
  noWrite: string[];
  /** The copy's own package cache for NuGet, Maven, Gradle and Ruby, so those tools never write the person's shared ones. */
  cache?: string;
  /** What an engineer allowed this project in Settings, on top of the above. */
  allow?: ProjectGuard;
}

/** The person's package caches a command may write in, plus the big shared caches real runs need. */
function writableCaches(home: string): string[] {
  return [
    ...PACKAGE_CACHES.map((c) => path.join(home, c)),
    // The caches the project's own tools fill: pip and Playwright browsers on a Mac, pip/npm/Playwright on Linux.
    path.join(home, 'Library', 'Caches'),
    path.join(home, '.cache'),
  ];
}

/** Browser profiles under the person's home: their saved sign-ins. The project's own browser tests never need them. */
function browserProfiles(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Chromium', 'Firefox', 'Microsoft Edge', 'BraveSoftware', 'Arc', 'Vivaldi', 'com.operasoftware.Opera'].map((b) => path.join(support, b)).concat(path.join(home, 'Library', 'Safari'), path.join(home, 'Library', 'Application Support', 'Firefox'));
  }
  return ['.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', '.mozilla'].map((b) => path.join(home, b));
}

/**
 * The person's npm and PyPI settings when they hold a token: those files mix a cache path (harmless) with an auth
 * token (secret), so squad-kit hides them only when a token is actually in them, and leaves a token-less ~/.npmrc
 * readable so a private registry URL still works. ~/.pypirc is only ever for credentials, so it is always hidden.
 */
function tokenFiles(home: string): string[] {
  const out: string[] = [path.join(home, '.pypirc')];
  const npmrc = path.join(home, '.npmrc');
  try {
    if (/(_authToken|_auth|_password)\s*=/.test(fs.readFileSync(npmrc, 'utf8'))) out.push(npmrc);
  } catch {
    // Not there, or cannot read it: nothing to hide.
  }
  return out;
}

/** The AI tools' own sign-ins and settings with keys in them, from each tool module (ADR-002). */
function aiToolPrivate(home: string): string[] {
  return AI_TOOLS.flatMap((t) => t.privateFiles?.(home) ?? []);
}

/** squad-kit's own screenshot browser build, which it runs itself outside the guard: a command may read it, never change it. */
function squadOwnFiles(): string[] {
  return BROWSERS.flatMap((b) => b.ownFiles?.() ?? []);
}

/**
 * The guard for a project command run under a ticket: its copy, the proof folder, the ticket's own cache, and the
 * caches real builds need. squad-kit's whole folder is out of reach except those few places the command truly needs.
 */
export function ticketGuard(bp: BoardPaths, o: { cwd: string; id: string; read?: string[]; home?: string; platform?: NodeJS.Platform; allow?: ProjectGuard }): GuardSpec {
  const home = o.home ?? os.homedir();
  const cache = ticketCacheDir(bp, o.id);
  return buildGuard({ cwd: o.cwd, root: bp.root, cache, extraWrite: [bp.proofDir, cache], extraRead: [cache, ...(o.read ?? [])], home, platform: o.platform ?? process.platform, ...(o.allow ? { allow: o.allow } : {}) });
}

/**
 * The guard for a project command run with no ticket: the first setup, Your apps, the release pipeline and the
 * checkout setup after a merge. It uses the project's own cache instead of a ticket's.
 */
export function projectGuardFor(bp: BoardPaths, o: { cwd: string; read?: string[]; home?: string; platform?: NodeJS.Platform; allow?: ProjectGuard } ): GuardSpec {
  const home = o.home ?? os.homedir();
  const cache = projectCacheDir(bp);
  return buildGuard({ cwd: o.cwd, root: bp.root, cache, extraWrite: [bp.proofDir, cache], extraRead: [cache, ...(o.read ?? [])], home, platform: o.platform ?? process.platform, ...(o.allow ? { allow: o.allow } : {}) });
}

/** A path and, when it is a link (/tmp on a Mac), where it really is. */
function withReal(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    if (!d) continue;
    out.add(d);
    try {
      out.add(fs.realpathSync(d));
    } catch {
      // Not there yet.
    }
  }
  return [...out];
}

/** A path an engineer allowed, in full: "~/shared" is in the person's home. A rule with "~" in it would match nothing. */
export function allowPath(p: string, home: string = os.homedir()): string {
  return path.resolve(p.trim().replace(/^~(?=$|\/)/, home));
}

/** Builds the full spec: where the command may read and write, and what stays hidden. */
export function buildGuard(o: { cwd: string; root: string; cache?: string; extraWrite?: string[]; extraRead?: string[]; home: string; platform: NodeJS.Platform; allow?: ProjectGuard }): GuardSpec {
  const home = o.home;
  const temp = withReal([os.tmpdir(), ...(o.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/private/var/folders'])]);
  const noRead = [
    ...PRIVATE.map((p) => path.join(home, p)),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.docker'),
    path.join(home, 'Library', 'Keychains'),
    ...browserProfiles(home, o.platform),
    ...tokenFiles(home),
    ...aiToolPrivate(home),
    ...withReal([squadHome()]),
  ];
  // Seatbelt matches the canonical path (on a Mac /var is a link to /private/var), so the copy and everything the
  // command may reach are kept as their real paths, and withReal also keeps the link form where both can appear.
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return {
    cwd: real(o.cwd),
    root: o.root,
    write: [...new Set(withReal([...(o.extraWrite ?? []), ...temp, ...writableCaches(home)]))],
    read: [...new Set(withReal([...(o.extraRead ?? [])]))],
    noRead: [...new Set(noRead)],
    noWrite: [...new Set(withReal(squadOwnFiles()))],
    ...(o.cache ? { cache: real(o.cache) } : {}),
    ...(o.allow ? { allow: { ...(o.allow.allowRead ? { allowRead: withReal(o.allow.allowRead.map((p) => allowPath(p, home))) } : {}), ...(o.allow.allowWrite ? { allowWrite: withReal(o.allow.allowWrite.map((p) => allowPath(p, home))) } : {}) } } : {}),
  };
}

/* ── the Seatbelt profile (macOS) ────────────────────────── */

/** An SBPL double-quoted string: backslashes and quotes escaped. */
function sb(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * An SBPL regex literal. The string already holds the regex's own backslash escapes (\.), which SBPL passes straight
 * to the regex engine, so only a double quote is escaped here; doubling the backslashes would match a literal one.
 */
function sbRegex(s: string): string {
  return `#"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Every directory on the way from each path up to the root. The guard must let a command reach its own copy and
 * caches even when they sit inside a hidden folder (the copy lives under squad-kit's own home): resolving the path
 * and getcwd need to look up each parent. file-read-metadata allows that lookup without exposing the folder's
 * listing or any file in it, so a sibling secret stays hidden.
 */
function ancestorsOf(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    let dir = path.dirname(p);
    while (dir && dir !== path.dirname(dir)) {
      out.add(dir);
      dir = path.dirname(dir);
    }
  }
  return [...out];
}

/** The .env files under the person's project folder, by one regex: the copy is elsewhere, so its own .env is untouched. */
function envRegexFor(root: string): string {
  const base = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '');
  return `^${base}/(.*/)?\\.env(\\.[^/]*)?$`;
}

/**
 * The Seatbelt profile squad-kit writes for one command. It starts from (allow default) so compilers, Node, Python,
 * package managers and Chrome work normally, then denies reads of private places and writes outside the copy and the
 * caches. The order matters: broad allows, then the private denies, then the places the command needs are allowed back
 * (so a cache inside squad-kit's folder beats the folder's deny), then squad-kit's own files are re-denied for writing.
 */
export function profileText(spec: GuardSpec): string {
  const lines: string[] = ['(version 1)', '(allow default)'];
  const reAllow = [spec.cwd, ...spec.read, ...(spec.allow?.allowRead ?? [])];

  // Reads: everything is readable by default (so tools, the temp folder and the package caches work), then the
  // private places are hidden, then the copy and the few places the command truly needs are allowed back last, so a
  // cache that lives inside squad-kit's own folder is readable while the rest of that folder stays hidden.
  lines.push(';; reads: hide keys, sign-ins and squad-kit, then allow the copy back');
  for (const d of spec.noRead) lines.push(`(deny file-read* (subpath ${sb(d)}))`);
  lines.push(`(deny file-read* (regex ${sbRegex(envRegexFor(spec.root))}))`);
  // Let the command resolve the path to its own copy and caches even when they sit inside a hidden folder: stat the
  // parents (for getcwd and path lookup) without being able to list them or read anything in them.
  const writableForAnc = [spec.cwd, ...spec.write, ...(spec.allow?.allowWrite ?? [])];
  for (const a of ancestorsOf([...reAllow, ...writableForAnc])) lines.push(`(allow file-read-metadata (literal ${sb(a)}))`);
  for (const r of reAllow) lines.push(`(allow file-read* (subpath ${sb(r)}))`);

  // Writes only in the copy, the proof folder, the caches, temp and what an engineer allowed.
  lines.push(';; writes: only the copy and the caches');
  lines.push('(deny file-write* (subpath "/"))');
  const writable = [spec.cwd, ...spec.write, ...(spec.allow?.allowWrite ?? [])];
  for (const w of writable) lines.push(`(allow file-write* (subpath ${sb(w)}))`);
  // Devices and the terminal every tool writes to.
  for (const dev of ['/dev/null', '/dev/zero', '/dev/dtracehelper', '/dev/tty', '/dev/random', '/dev/urandom', '/dev/fd', '/dev/stdout', '/dev/stderr']) lines.push(`(allow file-write* (subpath ${sb(dev)}))`);
  // squad-kit runs its own screenshot browser from a shared cache: a command may read it, never change it.
  for (const n of spec.noWrite) lines.push(`(deny file-write* (subpath ${sb(n)}))`);

  // No new background jobs that outlive the command and squad-kit's own process-group stop.
  lines.push('(deny job-creation)');
  return `${lines.join('\n')}\n`;
}

/* ── bubblewrap (Linux) ──────────────────────────────────── */

/**
 * The bubblewrap arguments for one command: the whole computer read-only, the copy and the caches made writable, and
 * the private places hidden behind an empty mount. Same lists as the Mac profile. squad-kit checks bubblewrap works
 * before it uses this; when it does not, the command runs unguarded with the "less protected" note.
 */
export function bubblewrapArgs(spec: GuardSpec, command: string): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--unshare-ipc'];
  // Hide each private place first: a folder behind an empty tmpfs, a single file behind /dev/null. A later mount wins,
  // so the copy and the caches below override a private mount above them (a cache inside squad-kit's own folder).
  for (const d of spec.noRead) {
    if (looksLikeFile(d)) args.push('--ro-bind-try', '/dev/null', d);
    else args.push('--tmpfs', d);
  }
  const writable = [spec.cwd, ...spec.write, ...(spec.allow?.allowWrite ?? [])];
  for (const w of writable) args.push('--bind', w, w);
  for (const r of [...spec.read, ...(spec.allow?.allowRead ?? [])]) args.push('--ro-bind-try', r, r);
  // squad-kit's own browser build stays read-only even inside a writable cache.
  for (const n of spec.noWrite) args.push('--ro-bind-try', n, n);
  args.push('/bin/sh', '-c', command);
  return args;
}

function looksLikeFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return /\.[A-Za-z0-9]{1,8}$/.test(path.basename(p));
  }
}

/* ── is the guard here? ──────────────────────────────────── */

export interface GuardSupport {
  on: boolean;
  /** What runs the command in, or why there is no guard here, in words for people. */
  why: string;
  fix?: string;
}

export interface GuardHost {
  platform: NodeJS.Platform;
  release: string;
  has(program: string): boolean;
  bwrapWorks(): boolean;
}

/** Whether squad-kit can run the project's own commands in its guard on this computer. */
export function guardSupportOn(h: GuardHost): GuardSupport {
  if (h.platform === 'darwin') return h.has(SEATBELT) ? { on: true, why: "squad-kit's guard (macOS Seatbelt)" } : { on: false, why: 'macOS sandbox-exec is missing on this Mac' };
  if (h.platform === 'win32') return { on: false, why: "squad-kit's guard does not run on Windows yet" };
  if (h.platform !== 'linux') return { on: false, why: "squad-kit's guard does not run on this system" };
  if (/-Microsoft$/i.test(h.release)) return { on: false, why: 'WSL 1 has no guard', fix: 'Move this Linux to WSL 2: wsl --set-version <name> 2' };
  if (!h.has('bwrap')) return { on: false, why: 'bubblewrap is not installed', fix: 'Install it, for example: sudo apt install bubblewrap' };
  if (!h.bwrapWorks()) return { on: false, why: 'bubblewrap cannot make a guard on this Linux', fix: 'Allow unprivileged user namespaces for bwrap (on Ubuntu 24.04 this needs an AppArmor profile for it)' };
  return { on: true, why: "squad-kit's guard (bubblewrap)" };
}

let support: GuardSupport | null = null;

export function guardSupport(): GuardSupport {
  return (support ??= guardSupportOn({ platform: process.platform, release: os.release(), has: onPath, bwrapWorks }));
}

function onPath(program: string): boolean {
  if (path.isAbsolute(program)) return fs.existsSync(program);
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.some((d) => d && fs.existsSync(path.join(d, program)));
}

function bwrapWorks(): boolean {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/* ── the environment the command gets ────────────────────── */

/** squad-kit's own variables, the AI tools' keys, and the common cloud and code-host tokens: all kept out. */
function secretEnvNames(): string[] {
  return [...new Set(['SQUAD_*', ...AI_TOOLS.flatMap((t) => t.secretEnv ?? []), 'ANTHROPIC_*', 'OPENAI_*', 'CLAUDE_*', 'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'AWS_*', 'AZURE_*', 'GOOGLE_*', 'GCLOUD_*', 'GCP_*', 'JIRA_*', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])];
}

/** True when a variable's name is one of the secret names, by exact match or a "PREFIX*" prefix. */
export function isSecretEnv(name: string, names = secretEnvNames()): boolean {
  const upper = name.toUpperCase();
  return names.some((n) => (n.endsWith('*') ? upper.startsWith(n.slice(0, -1).toUpperCase()) : upper === n.toUpperCase()));
}

/**
 * The environment the project's own commands run with: every agent's environment (childEnv, which already drops the
 * subscription and engine keys) minus squad-kit's own variables, the AI tools' keys and the common cloud and
 * code-host tokens. Everything an app commonly needs (PATH, HOME, LANG, NODE_OPTIONS, DATABASE_URL and the like) is
 * kept, so only secrets are removed, never the ordinary settings a build or a test reads.
 */
export function projectEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const names = secretEnvNames();
  const env = childEnv();
  for (const key of Object.keys(env)) if (isSecretEnv(key, names)) delete env[key];
  return { ...env, ...extra };
}

/* ── the single gate: every project command spawns here ──── */

export interface SpawnProjectOptions {
  cwd: string;
  /** More environment on top of the scrubbed base: CI, the moved PORT, the package-cache paths. */
  env?: NodeJS.ProcessEnv;
  /** The guard to run it in. Left out, the command runs unguarded (no guard on this computer, or a plain unit test). */
  guard?: GuardSpec;
  stdio?: SpawnOptions['stdio'];
}

/**
 * The one place that spawns a project command. On a Mac it wraps the command in sandbox-exec with a profile squad-kit
 * writes to a temp file; on Linux in bubblewrap; elsewhere, or when no guard is given, it runs the command as before.
 * The command still runs through a shell and in its own process group, so Stop ends the whole group as it did.
 */
export function spawnProject(command: string, o: SpawnProjectOptions): ChildProcess {
  // NuGet, Maven, Gradle and Ruby write into the copy's own cache, never the person's shared ones, like the agent sandbox.
  const caches = o.guard?.cache ? packageCacheEnv(o.guard.cache) : {};
  const env = { ...projectEnv(), ...caches, ...(o.env ?? {}) };
  const stdio = o.stdio ?? ['ignore', 'pipe', 'pipe'];
  const base: SpawnOptions = { cwd: o.cwd, detached: OWN_GROUP, stdio, env };
  if (o.guard && process.platform === 'darwin') {
    const file = writeProfile(o.guard);
    const child = track(spawn(SEATBELT, ['-f', file, '/bin/sh', '-c', command], base));
    child.once('exit', () => fs.rm(file, { force: true }, () => undefined));
    return child;
  }
  if (o.guard && process.platform === 'linux') {
    return track(spawn('bwrap', bubblewrapArgs(o.guard, command), base));
  }
  return track(spawn(command, { ...base, shell: true }));
}

/** Writes the profile to a temp file squad-kit owns; the file is removed when the command ends. */
function writeProfile(guard: GuardSpec): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-guard-'));
  const file = path.join(dir, 'profile.sb');
  fs.writeFileSync(file, profileText(guard));
  return file;
}

/* ── when the guard blocked a file the project needed ────── */

/** "Operation not permitted" on a path, or Node's "EPERM: operation not permitted, open '<path>'". */
const EPERM_LINES = [/EACCES|EPERM[^\n]*?['"]([^'"\n]+)['"]/i, /operation not permitted[^\n]*?['"]([^'"\n]+)['"]/i, /([^\s'":]+): Operation not permitted/i, /Operation not permitted[^\n]*?(\/[^\s'":]+)/i];

/**
 * A path a command was refused by the guard, from its output, or null when nothing points to the guard. Only a path
 * the guard actually hides counts, so an ordinary "Operation not permitted" from the project's own code is not
 * mistaken for the guard blocking it.
 */
export function guardBlockedPath(output: string, guard: GuardSpec): string | null {
  if (!output) return null;
  for (const line of output.split('\n')) {
    for (const re of EPERM_LINES) {
      const m = re.exec(line);
      const target = m?.[1]?.trim();
      if (target && target.startsWith('/') && isHidden(target, guard)) return target;
    }
  }
  return null;
}

/** True when the path is one the guard denies: under a hidden place, or a .env in the person's project folder. */
function isHidden(target: string, guard: GuardSpec): boolean {
  const under = (base: string) => target === base || target.startsWith(`${base.replace(/\/$/, '')}/`);
  // The copy and the few places the command may use are never the guard blocking it.
  if ([guard.cwd, ...guard.read, ...(guard.cache ? [guard.cache] : []), ...(guard.allow?.allowRead ?? []), ...(guard.allow?.allowWrite ?? [])].some(under)) return false;
  // A private place squad-kit hides, or a .env in the person's project folder outside the copy.
  if (guard.noRead.some(under)) return true;
  if (under(guard.root) && /\/\.env(\.|$)/.test(target)) return true;
  return false;
}

/** The one plain sentence the person sees when the guard blocked a file the project needed. */
export const GUARD_BLOCKED = 'A check needed a file outside its copy, and squad-kit blocked it. An engineer can allow it in Settings.';

/** For engineers: which file, and the command that needs it. */
export function guardBlockedDetail(target: string, command: string): string {
  return `squad-kit's guard blocked ${target} for: ${command}\nAllow it in Settings, or: squad config set allow-read ${target} (or allow-write).`;
}
