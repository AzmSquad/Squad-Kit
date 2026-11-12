import { androidCommandEnv, androidReads, usesAndroid } from './android-env.js';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import type { ProjectGuard } from '../board/types.js';
import { AI_TOOLS, BROWSERS } from '../modules/registry.js';
import { squadHome, squadHomes } from '../core/home.js';
import { childEnv } from './agent-env.js';
import { copyDbEnv } from './db-env.js';
import { partEnv } from './part-env.js';
import { ownHomeEnv } from './own-home.js';
import { OWN_GROUP, track } from './process-group.js';
import { PACKAGE_CACHES, PRIVATE, gitPlaces, networkPolicy, noPushEnv, packageCacheEnv, projectCacheDir, projectNetwork, ticketCacheDir } from './sandbox.js';
import type { NetworkLevel } from '../board/types.js';
import { cacheHomeEnv, homeCachePlace, ownFolder, storiesCacheDir } from './cache-home.js';
import { flutterOnPath, flutterStampFolders, flutterStampRegexes } from './flutter-sdk.js';

/**
 * squad-kit's own guard for the project's own commands: the checks (test, lint, build), the app's start, the setup
 * commands and the release pipeline. The Builder writes that code, so a tricked Builder could make a "test" that reads
 * the person's keys or squad-kit's board token and sends them out. The guard runs each command under the operating
 * system's own sandbox (Seatbelt on a Mac, bubblewrap on Linux), where it works normally and may reach the network
 * for packages and tests, but cannot read the private files below. Network is allowed on purpose: the protection is
 * that secrets cannot be read, so there is nothing secret to send. On the project's Off network level a Mac closes it
 * to all but this computer (networkPolicy in sandbox.ts). Windows has no guard yet (the note says so).
 *
 * Everything that spawns a project command goes through spawnProject here, so nothing runs unguarded by mistake
 * (test/project-guard.test.ts fails on a new shell spawn of a project command outside this module).
 */

/** The Seatbelt binary on a Mac. */
const SEATBELT = '/usr/bin/sandbox-exec';

/** Set for every command that runs in the guard, so what cannot run there (a sandbox inside it) knows and skips. */
export const IN_GUARD = 'SQUAD_KIT_IN_GUARD';

/** What the guard lets a command read and write, built from the project's places on this computer. */
export interface GuardSpec {
  /** The command's own copy of the code: read and write. */
  cwd: string;
  /** The person's own project folder, outside the copy: its .env files stay out of reach. */
  root: string;
  /**
   * The setup squad-kit runs in the person's own checkout after a merge: it may read that checkout's .env files, as it
   * does when they run it themselves. Everything else stays hidden. A command in a copy never gets this.
   */
  ownEnv?: boolean;
  /** Folders the command may also write in: the proof folder, the package caches, the project/ticket cache. */
  write: string[];
  /** Folders the command may also read: its attachments, its own cache. */
  read: string[];
  /** A story's command: it has no business pushing. The release pipeline's may. */
  noPush?: boolean;
  /** Files and folders no command may read: keys, sign-ins, squad-kit's own folder, browser profiles, .env files. */
  noRead: string[];
  /** What a command may read but never change: squad-kit's own browser build, the copy's `.git` and git's folder. */
  noWrite: string[];
  /** Where a container runtime listens: no command connects here, unless an engineer allowed it. */
  noConnect: string[];
  /** The one socket squad-kit opened for its own `docker compose up` (compose-run.ts). No other command gets this. */
  openSocket?: string;
  /** The project's network level is Off: the command reaches nothing but this computer's own ports (networkPolicy). */
  offline?: boolean;
  /** The throwaway git folder a commit's hooks run on (git.ts): theirs to read and write, whatever else is closed. */
  hookGit?: string;
  /** The project's cache home (engine/cache-home.ts): every tool keeps its downloads there, never in the person's own caches. */
  cache?: string;
  /** Single files a command may write, each a whole-path regex: Flutter's own version stamps (engine/flutter-sdk.ts). */
  writeExactly?: string[];
  /**
   * The folders those files are in. Bubblewrap cannot open a file named by the run, so on Linux each folder is a throwaway
   * one for the command: the real files back in, read only, all but those, which it writes there and which go when it ends.
   */
  writeExactlyIn?: string[];
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
 * readable so a private registry URL still works. ~/.pypirc is only ever for credentials, so it is always hidden, as are
 * Composer's auth.json (its tokens for GitHub and private packages, in either of its homes) and RubyGems' credentials.
 */
function tokenFiles(home: string): string[] {
  const out: string[] = [path.join(home, '.pypirc'), path.join(home, '.composer', 'auth.json'), path.join(home, '.config', 'composer', 'auth.json'), path.join(home, '.gem', 'credentials')];
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
 * The guard for a project command run under a ticket: its copy, the proof folder, the cache home all the project's stories
 * share, and the caches real builds need. squad-kit's whole folder is out of reach except those few places the command
 * truly needs.
 */
export function ticketGuard(bp: BoardPaths, o: { cwd: string; id: string; read?: string[]; home?: string; platform?: NodeJS.Platform; allow?: ProjectGuard }): GuardSpec {
  const home = o.home ?? os.homedir();
  const cache = storiesCacheDir(bp);
  ownFolder(cache);
  return { ...buildGuard({ cwd: o.cwd, root: bp.root, cache, extraWrite: [bp.proofDir, cache], extraRead: [cache, ...(o.read ?? [])], home, platform: o.platform ?? process.platform, ...(o.allow ? { allow: o.allow } : {}) }), noPush: true };
}

/**
 * The guard for a project command that runs accepted code, with no ticket: the first setup, Your apps, the release
 * pipeline and the checkout setup after a merge. It uses the project's own cache home, where no story writes.
 */
export function projectGuardFor(bp: BoardPaths, o: { cwd: string; read?: string[]; home?: string; platform?: NodeJS.Platform; allow?: ProjectGuard } ): GuardSpec {
  const home = o.home ?? os.homedir();
  const cache = projectCacheDir(bp);
  ownFolder(cache);
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

/** The same, as the team's settings file keeps it: a place in this person's home stays "~/…", so it works on any computer. */
export function sharedPath(p: string, home: string = os.homedir()): string {
  const full = allowPath(p, home);
  return full === home || full.startsWith(`${home}${path.sep}`) ? `~${full.slice(home.length).split(path.sep).join('/')}` : full;
}

/** Keys and sign-ins in the person's home folder: no project command and no agent reads them. */
export function privatePlaces(home: string, platform: NodeJS.Platform): string[] {
  return [
    ...PRIVATE.map((p) => path.join(home, p)),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.docker'),
    ...RUNTIME_KEYS.map((p) => path.join(home, p)),
    ...(platform === 'darwin' ? [path.join(FINCH_ON_MAC, '_config')] : []),
    path.join(home, 'Library', 'Keychains'),
    ...browserProfiles(home, platform),
    ...tokenFiles(home),
    ...aiToolPrivate(home),
  ];
}

/**
 * What no agent may read or change, wherever it works. The sandbox covers a step's shell commands only, and read-only
 * agents have none, so their file tools need this too. squad-kit's own folder holds what agents must read, so only its
 * secrets are named: the sign-ins and link tokens of the app and of every project.
 */
export function agentPrivatePlaces(home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  return [...privatePlaces(home, platform), ...squadHomes(home).flatMap((own) => [...['secrets.yaml', 'app.json', 'console.json'].map((f) => path.join(own, f)), ...['secrets.yaml', 'console.json'].map((f) => path.join(own, 'projects', '*', f))])];
}

/**
 * Builds the full spec: where the command may read and write, and what stays hidden. The network comes from the
 * project's level, read from its own settings unless given: the same policy the agents' commands get.
 */
export function buildGuard(o: { cwd: string; root: string; cache?: string; extraWrite?: string[]; extraRead?: string[]; home: string; platform: NodeJS.Platform; allow?: ProjectGuard; network?: NetworkLevel; flutter?: string | null }): GuardSpec {
  const home = o.home;
  // The person's Flutter writes its version stamps on every run: those few files open, each exactly, and nothing else of it.
  const flutter = o.flutter === undefined ? flutterOnPath()?.root : o.flutter;
  const temp = withReal([os.tmpdir(), ...(o.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/private/var/folders'])]);
  const noRead = [...privatePlaces(home, o.platform), ...withReal(squadHomes(home))];
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
    // squad-kit's Android SDK, its Java and its shared Gradle home: read only, so an Android build finds them.
    read: [...new Set(withReal([...(o.extraRead ?? []), ...androidReads()]))],
    noRead: [...new Set(noRead)],
    noWrite: [...new Set(withReal([...squadOwnFiles(), ...gitPlaces(real(o.cwd))]))],
    noConnect: [...new Set(withReal(runtimeSockets(home, o.platform)))],
    ...(o.cache ? { cache: real(o.cache) } : {}),
    ...(flutter ? { writeExactly: flutterStampRegexes(real(flutter)), writeExactlyIn: flutterStampFolders(real(flutter)) } : {}),
    ...(o.allow ? { allow: { ...(o.allow.allowRead ? { allowRead: withReal(o.allow.allowRead.map((p) => allowPath(p, home))) } : {}), ...(o.allow.allowWrite ? { allowWrite: withReal(o.allow.allowWrite.map((p) => allowPath(p, home))) } : {}) } } : {}),
    ...(networkPolicy(o.network ?? projectNetwork(o.root), [], o.platform).commands === 'this-computer' ? { offline: true } : {}),
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
  // A command in the person's own checkout: its .env files stay out of reach there too, unless an engineer allowed them,
  // or it is the setup after a merge, which reads that checkout's own .env files.
  const realRoot = realPlace(spec.root);
  if (!spec.ownEnv && (spec.cwd === realRoot || spec.cwd.startsWith(`${realRoot}/`))) {
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
  // Single files, each exactly: Flutter's version stamps in its own folder.
  for (const r of spec.writeExactly ?? []) lines.push(`(allow file-write* (regex ${sbRegex(r)}))`);
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
  // Off: no address but this computer's own (127.0.0.1 and ::1), so a test still reaches the app squad-kit started in
  // another command. Sockets stay as above: DNS answers, and what it finds is out of reach. After the socket rules: a
  // socket deny after "localhost" closed this computer's own addresses too (seen on a real Mac). Docker's port after it.
  if (spec.offline) lines.push('(deny network-outbound (remote ip "*:*"))', '(allow network-outbound (remote ip "localhost:*"))');
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
 * The bubblewrap arguments for one command: the whole computer read-only, the copy and the caches made writable, the
 * private places hidden behind an empty mount, and Flutter's stamps written in a throwaway folder. Same lists as the Mac
 * profile. squad-kit checks bubblewrap works before it uses this; when it does not, the command runs unguarded with the
 * "less protected" note.
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
  // Single files, each exactly (Flutter's version stamps). One is named by the run, and bubblewrap opens only whole files
  // and folders, so their folder is a throwaway one for this command: the real one stays as it was. First, so whatever is
  // hidden or opened below still wins.
  for (const dir of at(spec.writeExactlyIn ?? [])) args.push(...throwawayFolder(dir, spec.writeExactly ?? []));
  // A later mount wins: what the copy and the caches need comes after the private places (a cache inside squad-kit's own folder).
  hide(spec.noRead);
  // The copy must be there. The others may not be on this computer: bubblewrap stops at a folder it cannot find.
  args.push('--bind', spec.cwd, spec.cwd);
  for (const r of at(spec.read)) args.push('--ro-bind-try', r, r);
  // After what it reads, as a cache is both.
  for (const w of at(spec.write)) args.push('--bind-try', w, w);
  // A runtime's socket and the project's .env files, after the folders that may hold them: temp holds a socket of Podman's.
  // Read only is no bar to a connection. A port stays open here: only a network of its own could close it, and commands need the network.
  // The setup after a merge reads its own checkout's .env files; the others stay hidden.
  const own = realPlace(spec.cwd);
  hide([...spec.noConnect, ...envFilesIn(spec.root).filter((f) => !spec.ownEnv || !realPlace(f).startsWith(`${own}/`))]);
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

/**
 * A throwaway folder in place of a real one, for one bubblewrap command: an empty tmpfs, with each real file and folder of
 * it bound back in, read only, and each link made again, all but the files the regexes name. A command writes those, and
 * new files, in the tmpfs, which goes when it ends. Nothing when the folder is not there: bubblewrap could not mount on it.
 */
function throwawayFolder(dir: string, leaveOut: string[]): string[] {
  let names: string[];
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = ['--tmpfs', dir];
  for (const name of names) {
    const at = path.join(dir, name);
    if (leaveOut.some((r) => new RegExp(r).test(at))) continue;
    try {
      if (fs.lstatSync(at).isSymbolicLink()) out.push('--symlink', fs.readlinkSync(at), at);
      else out.push('--ro-bind-try', at, at);
    } catch {
      // Gone since the folder was read.
    }
  }
  return out;
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
  /** This squad-kit itself runs inside another one's guard: a story of squad-kit's own code, or its tests there. */
  inGuard?: boolean;
}

/**
 * Whether squad-kit can run the project's own commands in its guard on this computer. Inside another squad-kit's guard
 * it cannot: the system refuses a second sandbox inside the first ("sandbox_apply: Operation not permitted" on a Mac),
 * and the outer guard already holds everything this one runs.
 */
export function guardSupportOn(h: GuardHost): GuardSupport {
  if (h.inGuard) return { on: false, why: "squad-kit runs inside another squad-kit's guard here, which holds everything it runs: a guard cannot hold a second one" };
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
  return (support ??= guardSupportOn({ platform: process.platform, release: os.release(), has: onPath, bwrapWorks, inGuard: process.env[IN_GUARD] === '1' }));
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
 * What a guarded command gets on top of the scrubbed base: every tool keeps its downloads in the project's cache home,
 * never the person's own caches, as in the agent's shell, and a story's command pushes nowhere. A command squad-kit runs
 * outside the guard by its one rule (outsideTheGuard in engine/checks.ts) gets the same.
 */
export function guardEnv(guard: GuardSpec | undefined, cwd: string): Record<string, string> {
  return { ...(guard?.cache ? cacheHomeEnv(guard.cache, { wall: 'project', cwd }) : {}), ...(guard?.noPush ? noPushEnv() : {}) };
}

/**
 * The one place that spawns a project command. On a Mac it wraps the command in sandbox-exec, with the profile passed as
 * text: a file could be swapped by something an earlier command left running. On Linux in bubblewrap; elsewhere, or when no
 * guard is given, it runs the command as before.
 * The command still runs through a shell and in its own process group, so Stop ends the whole group as it did.
 */
export function spawnProject(command: string, o: SpawnProjectOptions): ChildProcess {
  // In a story's copy with a database of its own, the setting points at it, whatever the person's environment says.
  // A command that builds an Android app gets squad-kit's Android tools, with their folders in the cache home (android-env.ts).
  // The part's env file comes first, filled in from that same start, and everything squad-kit sets goes on top (part-env.ts).
  // A squad-kit the command starts gets a home of its copy's own, never the person's board (own-home.ts), and a command in
  // the guard can tell it is there (SQUAD_KIT_IN_GUARD), so a test that cannot run inside it skips with a reason.
  const start = projectEnv();
  const guarded = Boolean(o.guard && (process.platform === 'darwin' || process.platform === 'linux'));
  const env = { ...start, ...partEnv(command, o.cwd, start), ...guardEnv(o.guard, o.cwd), ...ownHomeEnv(o.guard?.cwd ?? o.cwd, o.guard?.cache), ...(guarded ? { [IN_GUARD]: '1' } : {}), ...(usesAndroid(command) ? androidCommandEnv(o.guard?.cache ? { cache: o.guard.cache } : {}) : {}), ...(o.env ?? {}), ...copyDbEnv(o.cwd) };
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
  // Dart's: "Cannot open file, path = '<path>' (OS Error: Operation not permitted, errno = 1)".
  /['"](\/[^'"\n]+)['"][^\n]*?(?:Operation not permitted|Read-only file system)/i,
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
 * The places in the person's home a tool's cache is in that a command could not write, from what it printed: each
 * `~/.cache/<tool>`, `~/Library/Caches/<tool>` or `~/.<tool>` once (engine/cache-home.ts says which count). Empty when
 * nothing it printed is that, so a command that failed for another reason is not run again.
 */
export function homeCachesRefused(output: string, guard: GuardSpec, home: string = os.homedir()): string[] {
  if (!output) return [];
  const said = [NPM_REFUSED.exec(output)?.[1]?.trim(), ...output.split('\n').flatMap((line) => BLOCKED_LINES.map((re) => re.exec(line)?.[1]?.trim()))];
  const places = said.flatMap((p) => {
    const target = p && path.resolve(guard.cwd, p);
    const place = target && isBlocked(target, guard) ? homeCachePlace(target, home, guard.noRead) : null;
    return place ? [place] : [];
  });
  return [...new Set(places)];
}

/**
 * True when the guard denies this path: under what it hides, a .env in the person's project folder, or anywhere a
 * command may read but not write. The copy and the places it may write are never the guard blocking it.
 */
function isBlocked(target: string, guard: GuardSpec): boolean {
  const under = (base: string) => target === base || target.startsWith(`${base.replace(/\/$/, '')}/`);
  if (guard.noWrite.some(under)) return true;
  if ((guard.writeExactly ?? []).some((r) => new RegExp(r).test(target))) return false;
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
