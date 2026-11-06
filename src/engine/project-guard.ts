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
import { PACKAGE_CACHES, PRIVATE, gitPlaces, packageCacheEnv, projectCacheDir, ticketCacheDir } from './sandbox.js';

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
  /** What a command may read but never change: squad-kit's own browser build, the copy's `.git` and git's folder. */
  noWrite: string[];
  /** Where a container runtime listens: no command connects here, unless an engineer allowed it. */
  noConnect: string[];
  /** The one socket squad-kit opened for its own `docker compose up` (compose-run.ts). No other command gets this. */
  openSocket?: string;
  /** The throwaway git folder a commit's hooks run on (git.ts): theirs to read and write, whatever else is closed. */
  hookGit?: string;
  /** The copy's own package cache for NuGet, Maven, Gradle and Ruby, so those tools never write the person's shared ones. */
  cache?: string;
  /** What an engineer allowed this project in Settings, on top of the above. */
  allow?: ProjectGuard;
}

/**
 * The person's package caches a command may write in. Not all of `~/.cache` or `~/Library/Caches`: the person's own tools
 * run programs from there later, a browser or a hook of theirs, and what a command left would run with no guard.
 */
function writableCaches(home: string): string[] {
  return PACKAGE_CACHES.map((c) => path.join(home, c));
}

/** Browser profiles under the person's home: their saved sign-ins. The project's own browser tests never need them. */
function browserProfiles(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Chromium', 'Firefox', 'Microsoft Edge', 'BraveSoftware', 'Arc', 'Vivaldi', 'com.operasoftware.Opera'].map((b) => path.join(support, b)).concat(path.join(home, 'Library', 'Safari'), path.join(home, 'Library', 'Application Support', 'Firefox'));
  }
  return ['.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', '.mozilla'].map((b) => path.join(home, b));
}

/** Finch's virtual machine on a Mac lives in the app's own folder, not the home folder. */
const FINCH_ON_MAC = '/Applications/Finch/lima/data';

/**
 * Where a container runtime listens on this computer. Talking to one is all it takes to start a container with any folder
 * mounted in it, so a command that reaches it can read everything the guard hides: Docker Desktop, colima, lima, Rancher
 * Desktop, OrbStack, Finch and Podman, wherever each keeps its sockets. Other sockets stay open, such as a local database
 * and the one DNS goes through on a Mac.
 */
function runtimeSockets(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const inHome = ['.docker', '.colima', '.config/colima', '.lima', '.rd', '.orbstack', '.finch', '.local/share/containers/podman'];
  if (platform === 'darwin') {
    for (const app of ['Containers/com.docker.docker', 'Group Containers/group.com.docker', 'Group Containers/HUAUUMT7XC.dev.orbstack', 'Application Support/rancher-desktop']) inHome.push(path.join('Library', app));
  }
  const inRun = ['docker.sock', 'podman.sock', 'podman', 'finch.sock', 'containerd'];
  const uid = process.getuid?.();
  const own = [env.XDG_RUNTIME_DIR, ...(platform === 'linux' && uid !== undefined ? [`/run/user/${uid}`] : [])].filter((d): d is string => Boolean(d));
  const named = /^unix:\/\/(\/.+)$/.exec(env.DOCKER_HOST?.trim() ?? '')?.[1];
  return [
    ...inHome.map((p) => path.join(home, p)),
    ...['/var/run', '/run', ...own].flatMap((d) => inRun.map((p) => path.join(d, p))),
    // Podman's machine on a Mac keeps its socket in the temp folder.
    ...[os.tmpdir(), '/tmp'].map((d) => path.join(d, 'podman')),
    ...(platform === 'darwin' ? [path.join(FINCH_ON_MAC, 'finch/sock')] : []),
    ...(named ? [named] : []),
  ];
}

/** The keys into a runtime's virtual machine, whose disk holds what its containers mount. */
const RUNTIME_KEYS = ['.lima/_config', '.colima/_lima/_config', '.orbstack/ssh', '.local/share/containers/podman/machine/machine', '.finch/lima/data/_config', '.local/share/rancher-desktop/lima/_config', 'Library/Application Support/rancher-desktop/lima/_config'];

/** Docker's own port, for a person who turned it on. A port has no folder to allow, so a project that needs Docker uses its socket. */
const RUNTIME_PORTS = [2375, 2376];

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

/** Where a path really is, or will be when it is made: the deepest folder that is there, followed through its links. */
function realPlace(p: string): string {
  const rest: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync(at), ...rest);
    } catch {
      if (at === path.dirname(at)) return p;
      rest.unshift(path.basename(at));
    }
  }
}

/** A path and, when it is a link (/tmp on a Mac), where it really is. */
function withReal(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    if (!d) continue;
    out.add(d);
    out.add(realPlace(d));
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
    ...RUNTIME_KEYS.map((p) => path.join(home, p)),
    ...(o.platform === 'darwin' ? [path.join(FINCH_ON_MAC, '_config')] : []),
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
    noWrite: [...new Set(withReal([...squadOwnFiles(), ...gitPlaces(real(o.cwd))]))],
    noConnect: [...new Set(withReal(runtimeSockets(home, o.platform)))],
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
  const allowRead = spec.allow?.allowRead ?? [];
  const allowWrite = spec.allow?.allowWrite ?? [];
  const reAllow = [spec.cwd, ...spec.read, ...allowRead, ...(spec.hookGit ? [spec.hookGit] : [])];
  const envRule = `(deny file-read* (regex ${sbRegex(envRegexFor(realPlace(spec.root)))}))`;

  // Reads: everything is readable by default (so tools, the temp folder and the package caches work), then the
  // private places are hidden, then the copy and the few places the command truly needs are allowed back last, so a
  // cache that lives inside squad-kit's own folder is readable while the rest of that folder stays hidden.
  lines.push(';; reads: hide keys, sign-ins and squad-kit, then allow the copy back');
  for (const d of spec.noRead) lines.push(`(deny file-read* (subpath ${sb(d)}))`);
  lines.push(envRule);
  // Let the command resolve the path to its own copy and caches even when they sit inside a hidden folder: stat the
  // parents (for getcwd and path lookup) without being able to list them or read anything in them.
  const writable = [spec.cwd, ...spec.write, ...allowWrite];
  for (const a of ancestorsOf([...reAllow, ...writable])) lines.push(`(allow file-read-metadata (literal ${sb(a)}))`);
  for (const r of reAllow) lines.push(`(allow file-read* (subpath ${sb(r)}))`);
  // A command in the person's own checkout: its .env files stay out of reach there too, unless an engineer allowed them.
  const realRoot = realPlace(spec.root);
  if (spec.cwd === realRoot || spec.cwd.startsWith(`${realRoot}/`)) {
    lines.push(envRule);
    for (const a of allowRead) lines.push(`(allow file-read* (subpath ${sb(a)}))`);
  }

  // Writes only in the copy, the proof folder, the caches, temp and what an engineer allowed.
  lines.push(';; writes: only the copy and the caches');
  lines.push('(deny file-write* (subpath "/"))');
  for (const w of writable) lines.push(`(allow file-write* (subpath ${sb(w)}))`);
  // Devices and the terminal every tool writes to.
  for (const dev of ['/dev/null', '/dev/zero', '/dev/dtracehelper', '/dev/tty', '/dev/random', '/dev/urandom', '/dev/fd', '/dev/stdout', '/dev/stderr']) lines.push(`(allow file-write* (subpath ${sb(dev)}))`);
  // A runtime's socket stays where it is: moved, it could be reached from its new place.
  for (const s of spec.noConnect) lines.push(`(deny file-write* (subpath ${sb(s)}))`);
  for (const a of allowWrite) lines.push(`(allow file-write* (subpath ${sb(a)}))`);
  // The copy, and every folder above git's own, stay where they are: moved away and another put in their place, squad-kit's
  // own git would believe the settings it found there, and start a program of theirs outside the guard.
  for (const a of [spec.cwd, ...ancestorsOf([spec.cwd, ...spec.noWrite])]) lines.push(`(deny file-write-unlink (literal ${sb(a)}))`, `(deny file-write-create (literal ${sb(a)}))`);
  // Read only whatever came before, even a temp folder they sit in: squad-kit's own screenshot browser, the copy's `.git`, git's folder.
  for (const n of spec.noWrite) lines.push(`(deny file-write* (subpath ${sb(n)}))`);
  if (spec.hookGit) lines.push(`(allow file-write* (subpath ${sb(spec.hookGit)}))`);

  // Seatbelt looks at where a socket really is, so a link to one, or a path from another folder, is refused all the same.
  lines.push(';; connections: nothing in a hidden place, and no container runtime, unless an engineer allowed its folder');
  for (const d of spec.noRead) lines.push(`(deny network-outbound (subpath ${sb(d)}))`);
  for (const a of [spec.cwd, ...spec.read, ...spec.write, ...(spec.hookGit ? [spec.hookGit] : [])]) lines.push(`(allow network-outbound (subpath ${sb(a)}))`);
  for (const s of spec.noConnect) lines.push(`(deny network-outbound (subpath ${sb(s)}))`);
  for (const port of RUNTIME_PORTS) lines.push(`(deny network-outbound (remote tcp "localhost:${port}"))`);
  for (const a of [...allowRead, ...allowWrite]) lines.push(`(allow network-outbound (subpath ${sb(a)}))`);
  if (spec.openSocket) lines.push(`(allow network-outbound (literal ${sb(spec.openSocket)}))`);

  // Signals only to what the command itself started: not to squad-kit, and not to the person's own programs.
  lines.push('(deny signal)', '(allow signal (target same-sandbox))');
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
  // A mount goes where a place really is. Bubblewrap cannot make its way through an absolute link, as /var/run is on most
  // Linux, and it would stop there, and with it every command.
  const at = (places: string[]) => [...new Set(places.map(realPlace))];
  // A folder goes behind an empty tmpfs, anything else behind /dev/null. What is not on this computer has nothing to hide,
  // and the rest of the computer is read-only, so bubblewrap could not make a place to mount it on anyway.
  const hide = (places: string[]) => {
    for (const d of at(places)) {
      if (!fs.existsSync(d)) continue;
      if (looksLikeFile(d)) args.push('--ro-bind-try', '/dev/null', d);
      else args.push('--tmpfs', d);
    }
  };
  // A later mount wins: what the copy and the caches need comes after the private places (a cache inside squad-kit's own folder).
  hide(spec.noRead);
  // The copy must be there. The others may not be on this computer: bubblewrap stops at a folder it cannot find.
  args.push('--bind', spec.cwd, spec.cwd);
  for (const r of at(spec.read)) args.push('--ro-bind-try', r, r);
  // After what it reads, as a cache is both.
  for (const w of at(spec.write)) args.push('--bind-try', w, w);
  // A runtime's socket and the project's .env files, after the folders that may hold them: temp holds a socket of Podman's.
  // Read only is no bar to a connection. A port stays open here: only a network of its own could close it, and commands need the network.
  hide([...spec.noConnect, ...envFilesIn(spec.root)]);
  for (const r of at(spec.allow?.allowRead ?? [])) args.push('--ro-bind-try', r, r);
  for (const w of at(spec.allow?.allowWrite ?? [])) args.push('--bind-try', w, w);
  // Read only whatever came before, even a temp folder they sit in: squad-kit's own browser build, the copy's `.git`, git's folder.
  for (const n of at(spec.noWrite)) args.push('--ro-bind-try', n, n);
  if (spec.hookGit) {
    args.push('--bind', spec.hookGit, spec.hookGit);
    // In here, the copy's `.git` leads to that folder, so a tool that clears GIT_DIR lands there whichever git it runs.
    if (fs.lstatSync(path.join(spec.cwd, '.git'), { throwIfNoEntry: false })?.isFile()) args.push('--ro-bind-try', path.join(spec.hookGit, HOOK_GIT_LINK), path.join(spec.cwd, '.git'));
  }
  args.push('/bin/sh', '-c', command);
  return args;
}

/** Folders that hold no .env of the person's, and would take long to look through. */
const NO_ENV_IN = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '.venv', '.git', '.squad']);

/** The .env files of the person's project folder, 3 folders down: a mount has no patterns, so each is named. */
function envFilesIn(root: string, depth = 3): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const at = path.join(root, e.name);
    if (e.isDirectory()) return depth > 0 && !NO_ENV_IN.has(e.name) ? envFilesIn(at, depth - 1) : [];
    return /^\.env(\.|$)/.test(e.name) ? [at] : [];
  });
}

function looksLikeFile(p: string): boolean {
  try {
    return !fs.statSync(p).isDirectory();
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
 * The one place that spawns a project command. On a Mac it wraps the command in sandbox-exec, with the profile passed as
 * text: a file could be swapped by something an earlier command left running. On Linux in bubblewrap; elsewhere, or when no
 * guard is given, it runs the command as before.
 * The command still runs through a shell and in its own process group, so Stop ends the whole group as it did.
 */
export function spawnProject(command: string, o: SpawnProjectOptions): ChildProcess {
  // NuGet, Maven, Gradle and Ruby write into the copy's own cache, never the person's shared ones, like the agent sandbox.
  const caches = o.guard?.cache ? { ...packageCacheEnv(o.guard.cache), ...npmCacheEnv(o.guard.cache), ...ownCacheEnv(o.guard.cache), ...browserCacheEnv(o.guard.cache) } : {};
  const env = { ...projectEnv(), ...caches, ...(o.env ?? {}) };
  const stdio = o.stdio ?? ['ignore', 'pipe', 'pipe'];
  const base: SpawnOptions = { cwd: o.cwd, detached: OWN_GROUP, stdio, env };
  if (o.guard && process.platform === 'darwin') {
    return track(spawn(SEATBELT, ['-p', profileText(o.guard), '/bin/sh', '-c', command], base));
  }
  if (o.guard && process.platform === 'linux') {
    makeOwnFolders(o.guard);
    return track(spawn('bwrap', bubblewrapArgs(o.guard, command), base));
  }
  return track(spawn(command, { ...base, shell: true }));
}

/**
 * The caches a command's tools would keep in `~/.cache` or `~/Library/Caches`, which stay read only: in the copy's own. A
 * Mac's tools look in their own places, so they are named one by one. The first build of a ticket downloads again.
 */
function ownCacheEnv(cache: string): Record<string, string> {
  const at = (p: string) => path.join(cache, p);
  return { XDG_CACHE_HOME: at('xdg'), GOCACHE: at('go-build'), PIP_CACHE_DIR: at('pip'), POETRY_CACHE_DIR: at('poetry'), DENO_DIR: at('deno'), npm_config_devdir: at('node-gyp'), PUPPETEER_CACHE_DIR: at('puppeteer'), electron_config_cache: at('electron') };
}

/**
 * Playwright locks and writes in its browsers' folder even with nothing to download, and that folder stays read only: the
 * person's own Playwright runs what is there. So a command's Playwright gets a folder of the copy's own, with the browsers
 * this computer has linked in, and what it downloads stays with the copy.
 */
function browserCacheEnv(cache: string): Record<string, string> {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0' || process.platform === 'win32') return {};
  const home = os.homedir();
  const theirs = set ? path.resolve(set) : path.join(process.platform === 'darwin' ? path.join(home, 'Library', 'Caches') : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache')), 'ms-playwright');
  const dir = path.join(cache, 'ms-playwright');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.existsSync(theirs) ? fs.readdirSync(theirs) : []) {
      if (!/^[a-z_]+-\d+$/.test(name)) continue;
      try {
        fs.symlinkSync(path.join(theirs, name), path.join(dir, name));
      } catch {
        // Linked by an earlier command, or by one starting beside this.
      }
    }
    return { PLAYWRIGHT_BROWSERS_PATH: dir };
  } catch {
    // A folder it cannot make: Playwright as it is, with its folder read only.
    return {};
  }
}

/**
 * npm keeps what npx downloads beside its own cache, and that stays read only: a command could leave something there
 * that the person's own builds run later, unchecked. So a command's npm gets a cache folder of the copy's own, where
 * npx works, with the shared store of packages linked in: those are checked against the lock file, and stay shared.
 */
function npmCacheEnv(cache: string): Record<string, string> {
  const dir = path.join(cache, 'npm');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const shared = path.join(os.homedir(), '.npm', '_cacache');
    const link = path.join(dir, '_cacache');
    if (fs.existsSync(shared) && !fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(shared, link);
    return { npm_config_cache: dir };
  } catch {
    // A cache folder it cannot make: npm as it is, with npx read only.
    return {};
  }
}

/** The file in the throwaway git folder that the copy's `.git` shows, inside bubblewrap. */
export const HOOK_GIT_LINK = 'dotgit';

/** The places in git that matter to a commit and its hooks. */
export interface CommitPlaces {
  /** The repo's git folder, shared by all its copies. */
  common: string;
  /** The copy's own part of it. */
  own: string;
  /** The throwaway git folder the hooks run on, outside the project. */
  gitDir: string;
}

/**
 * The guard for the commit the project's hooks run on, which are the project's own code, like its tests: everything a
 * project command gets, and one more folder, the throwaway one. The real git folder stays read only, all of it, wherever
 * the project sits: objects, branches, settings, the stash, the hooks.
 */
export function commitGuard(guard: GuardSpec, at: CommitPlaces): GuardSpec {
  return { ...guard, noWrite: [...new Set([...guard.noWrite, at.common, at.own])], hookGit: at.gitDir };
}

/** The proof folder and the caches inside squad-kit's own folder: a folder not there yet could not be written in at all. */
export function makeOwnFolders(guard: GuardSpec, home: string = squadHome()): void {
  for (const w of guard.write) {
    if (path.relative(home, w).startsWith('..')) continue;
    try {
      fs.mkdirSync(w, { recursive: true });
    } catch {
      // Bubblewrap skips a folder it cannot find.
    }
  }
}

/* ── when the guard blocked a file the project needed ────── */

/**
 * A path a command was refused, from what it printed: "Operation not permitted" on a Mac, "Read-only file system" on
 * Linux, in Node's words, the shell's, git's ('<path>': ...) and npm's.
 */
const BLOCKED_LINES = [
  /(?:EPERM|EROFS)[^\n]*?['"]([^'"\n]+)['"]/i,
  /(?:operation not permitted|read-only file system)[^\n]*?['"]([^'"\n]+)['"]/i,
  /['"]([^'"\n]+)['"]: (?:Operation not permitted|Read-only file system)/i,
  /([^\s'":]+): (?:Operation not permitted|Read-only file system)/i,
  /(?:Operation not permitted|Read-only file system)[^\n]*?(\/[^\s'":]+)/i,
];

/** npm says it on lines of its own: the failed step, then the path it was refused. */
const NPM_REFUSED = /npm (?:error|ERR!) code (?:EPERM|EROFS|EACCES)[\s\S]*?npm (?:error|ERR!) path (\/[^\n]+)/;

/** A socket a tool could not connect to: in docker's words, Go's and Node's. */
const SOCKET_REFUSED = [/\bunix:\/\/(\/[^\s'":]+?)\.?(?=[\s'":]|$)/, /dial unix (\/[^\s'":]+)/, /connect E[A-Z]+ (\/[^\s'":]+)/];
/** Docker's port, in the same words. */
const PORT_REFUSED = /(?:dial tcp |connect E[A-Z]+ |daemon at tcp:\/\/)(?:127\.0\.0\.1|\[?::1\]?|localhost):(2375|2376)\b/;
/** Docker's test and client libraries, which do not say where they looked, and the docker command with its plugins out of reach. */
const RUNTIME_NOT_FOUND = /Could not find a (?:working container runtime|valid Docker environment)|Error while fetching server API version|docker: (?:unknown command: docker compose|'compose' is not a docker command)/;

/** What a command could not reach of a container runtime, from what it printed, or null. An engineer's own choice is no refusal. */
function runtimeRefused(output: string, guard: GuardSpec): string | null {
  const under = (place: string, base: string) => place === base || place.startsWith(`${base.replace(/\/$/, '')}/`);
  const allowed = [...(guard.allow?.allowRead ?? []), ...(guard.allow?.allowWrite ?? [])];
  const open = guard.noConnect.some((s) => allowed.some((a) => under(s, a) || under(a, s)));
  for (const line of output.split('\n')) {
    for (const re of SOCKET_REFUSED) {
      const place = re.exec(line)?.[1];
      if (place && guard.noConnect.some((s) => under(place, s)) && !allowed.some((a) => under(place, a))) return place;
    }
    const port = PORT_REFUSED.exec(line)?.[1];
    if (port) return `localhost:${port}`;
    if (!open && RUNTIME_NOT_FOUND.test(line)) return 'Docker';
  }
  return null;
}

/**
 * A path a command was refused by the guard, from its output, or null when nothing points to the guard. Only a path
 * the guard really blocks counts, so an ordinary "Operation not permitted" from the project's own code is not mistaken
 * for the guard blocking it.
 */
export function guardBlockedPath(output: string, guard: GuardSpec): string | null {
  if (!output) return null;
  const runtime = runtimeRefused(output, guard);
  if (runtime) return runtime;
  const npm = NPM_REFUSED.exec(output)?.[1]?.trim();
  if (npm && isBlocked(npm, guard)) return npm;
  for (const line of output.split('\n')) {
    for (const re of BLOCKED_LINES) {
      const said = re.exec(line)?.[1]?.trim();
      const target = said && path.resolve(guard.cwd, said);
      if (target && isBlocked(target, guard)) return target;
    }
  }
  return null;
}

/**
 * True when the guard denies this path: under what it hides, a .env in the person's project folder, or anywhere a
 * command may read but not write. The copy and the places it may write are never the guard blocking it.
 */
function isBlocked(target: string, guard: GuardSpec): boolean {
  const under = (base: string) => target === base || target.startsWith(`${base.replace(/\/$/, '')}/`);
  if (guard.noWrite.some(under)) return true;
  // The copy and the few places the command may use are never the guard blocking it.
  if ([guard.cwd, ...guard.read, ...(guard.cache ? [guard.cache] : []), ...(guard.allow?.allowRead ?? []), ...(guard.allow?.allowWrite ?? [])].some(under)) return false;
  // A private place squad-kit hides, or a .env in the person's project folder outside the copy.
  if (guard.noRead.some(under)) return true;
  if (under(guard.root) && /\/\.env(\.|$)/.test(target)) return true;
  // Anywhere else a command may read, but write only in the places it was given. The system's own answer for themselves.
  return !guard.write.some(under) && !/^\/(?:dev|proc|sys)\//.test(target);
}

/** The one plain sentence the person sees when the guard blocked a file the project needed. */
export const GUARD_BLOCKED = 'A check needed a file outside its copy, and squad-kit blocked it. An engineer can allow it in Settings.';

/** The same when what it needed was Docker. */
export const GUARD_BLOCKED_DOCKER = "A check tried to use Docker, which is not open to the project's own commands. An engineer can allow it in Settings.";

/** The plain sentence for a command that failed because the guard kept Docker from it, or null when that is not why. */
export function dockerBlockedWords(output: string, guard: GuardSpec | undefined): string | null {
  if (!guard) return null;
  const target = guardBlockedPath(output, guard);
  return target && blockedDocker(target, guard) ? GUARD_BLOCKED_DOCKER : null;
}

/** True when what the guard blocked is a container runtime and not a file: a socket, its port, or Docker by name. */
export function blockedDocker(target: string, guard: GuardSpec): boolean {
  return !target.startsWith('/') || guard.noConnect.some((s) => target === s || target.startsWith(`${s}/`));
}

/** For engineers: which file, and the command that needs it. */
export function guardBlockedDetail(target: string, command: string, guard?: GuardSpec): string {
  if (!guard || !blockedDocker(target, guard)) return `squad-kit's guard blocked ${target} for: ${command}\nAllow it in Settings, or: squad config set allow-read ${target} (or allow-write).`;
  const way = target.startsWith('/') ? `Allow it in Settings, or: squad config set allow-write ${target}` : `Allow the folder of its socket in Settings, or: squad config set allow-write <that folder>`;
  return `squad-kit's guard blocked Docker (${target}) for: ${command}\nDocker is not open to the project's own commands, since a container can read any folder on this computer. ${way}`;
}
