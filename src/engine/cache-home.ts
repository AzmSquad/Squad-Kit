import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import { packageCacheEnv } from './sandbox.js';

/**
 * The project's cache home: a folder of its own on this computer where every tool keeps what it downloads, for the
 * project's own commands (setup, checks, the app, gates) and for the agent's shell. The person's own caches stay read
 * only (`~/.cache`, `~/Library/Caches`, a tool's `~/.<tool>` folder): their own tools run programs from there later, with
 * no guard around them. So each tool is pointed here by its own setting, and a tool squad-kit does not know, which still
 * writes in the person's home, is given a home of the project's own when squad-kit runs its command once more (healEnv).
 *
 * Two per project, so code nobody accepted yet never writes where accepted code takes its downloads from:
 * - the stories' home, shared by every story of the project, so only the first story downloads (storiesCacheDir);
 * - the project's home, for what runs accepted code: the first setup, Your apps, your own checkout's setup after a merge
 *   and the release pipeline (projectCacheDir). What a story left in the shared one could otherwise reach your checkout,
 *   which you run with no guard, or a release.
 * Both sit with the project's other files on this computer, outside every copy, so git never sees them. They go with the
 * project.
 */

/** The cache home every story of the project shares. */
export function storiesCacheDir(bp: Pick<BoardPaths, 'localDir'>): string {
  return path.join(bp.localDir, 'caches', 'stories');
}

/**
 * A cache home ready to use: a real folder, never a link. A command may write in it, so it could put a link in its place,
 * and squad-kit, which works in it outside any guard, and the guard itself, which allows where a folder really is, would
 * follow that link out. The folder above it is squad-kit's own, out of a command's reach.
 */
export function ownFolder(dir: string): void {
  const at = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (at && !at.isDirectory()) fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** A place in the cache home whose folders really are in it: squad-kit writes there outside the guard. */
function inside(dir: string, p: string): boolean {
  try {
    const home = fs.realpathSync(dir);
    let at = path.dirname(p);
    while (!fs.existsSync(at)) at = path.dirname(at);
    const real = fs.realpathSync(at);
    return real === home || real.startsWith(`${home}${path.sep}`);
  } catch {
    return false;
  }
}

/* ── each tool's own setting ─────────────────────────────── */

/**
 * Each tool's own setting for where it keeps its downloads, in the cache home. npm, pnpm and Yarn keep their package
 * stores where they are: those check every package against the lock file.
 */
export function toolCacheEnv(dir: string): Record<string, string> {
  const at = (p: string) => path.join(dir, p);
  return {
    // The usual setting for caches, which many tools follow on a Mac too: Prisma's engines among them.
    XDG_CACHE_HOME: at('xdg'),
    // Python: pip, Poetry (and its virtual environments) and uv.
    PIP_CACHE_DIR: at('pip'),
    POETRY_CACHE_DIR: at('poetry'),
    UV_CACHE_DIR: at('uv'),
    // Dart and Flutter packages.
    PUB_CACHE: at('pub'),
    // CocoaPods, for an iPhone build: its spec repos (with its lock file) and the pods it downloads. Its settings stay
    // the person's own, in ~/.cocoapods.
    CP_REPOS_DIR: at(path.join('cocoapods', 'repos')),
    CP_CACHE_DIR: at(path.join('cocoapods', 'cache')),
    // PHP packages.
    COMPOSER_CACHE_DIR: at('composer'),
    // Maven's own folder, where the Maven wrapper keeps the Maven it downloads (its packages: MAVEN_OPTS).
    MAVEN_USER_HOME: at('maven'),
    // Go's build cache (its modules stay in the person's, checked against go.sum), Deno and Bun.
    GOCACHE: at('go-build'),
    DENO_DIR: at('deno'),
    BUN_INSTALL_CACHE_DIR: at('bun'),
    // What npm packages download for themselves: node-gyp's headers, test browsers and Electron.
    npm_config_devdir: at('node-gyp'),
    PUPPETEER_CACHE_DIR: at('puppeteer'),
    CYPRESS_CACHE_FOLDER: at('cypress'),
    electron_config_cache: at('electron'),
  };
}

/**
 * Programs the person installed stay read only, so a story's code can never change what they run later. A few lock a
 * file in their own folder on every run, only to keep two of them from downloading into it at once, which the guard
 * refuses anyway: their own setting lets them run without it. Flutter, which locks `bin/cache/lockfile` in its SDK.
 */
function installedEnv(): Record<string, string> {
  return { FLUTTER_ALREADY_LOCKED: 'true' };
}

/**
 * Tools that keep their usage reports in the person's home, which stays read only: Flutter stops at once when it cannot
 * write them, and .NET tries again for every file. CocoaPods sends its own after each install. Their own setting leaves
 * the reports out of squad-kit's commands; the person's own runs report as they chose.
 */
function noReportsEnv(): Record<string, string> {
  return { FLUTTER_SUPPRESS_ANALYTICS: 'true', DOTNET_CLI_TELEMETRY_OPTOUT: '1', COCOAPODS_DISABLE_STATS: 'true' };
}

/**
 * pnpm's store, for the project's own commands: it cannot link from its usual store in the guard, so it would make a
 * .pnpm-store in the copy, thousands of files a commit could take. pnpm reads the first name from version 11, and the
 * second before it. The agent's shell keeps the person's store, as before.
 */
function pnpmStoreEnv(dir: string): Record<string, string> {
  return { pnpm_config_store_dir: path.join(dir, 'pnpm-store'), npm_config_store_dir: path.join(dir, 'pnpm-store') };
}

/**
 * npm keeps what npx downloads beside its own cache, and that stays read only: a command could leave something there
 * that the person's own builds run later, unchecked. So a command's npm gets a cache folder of the project's own, where
 * npx works, with the shared store of packages linked in: those are checked against the lock file, and stay shared.
 */
function npmCacheEnv(dir: string, home: string): Record<string, string> {
  const npm = path.join(dir, 'npm');
  try {
    if (!inside(dir, npm)) return {};
    fs.mkdirSync(npm, { recursive: true });
    const shared = path.join(home, '.npm', '_cacache');
    const link = path.join(npm, '_cacache');
    if (fs.existsSync(shared) && !fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(shared, link);
    return { npm_config_cache: npm };
  } catch {
    // A cache folder it cannot make: npm as it is, with npx read only.
    return {};
  }
}

/**
 * Browsers this computer already downloaded, linked into a folder of the project's own, each one by its version: a tool
 * finds them there, and downloads only a version it does not have, into the project's folder. The person's own stay read
 * only, as their own tests run what is there.
 */
function linkVersions(from: string, to: string, name: RegExp): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.existsSync(from) ? fs.readdirSync(from) : []) {
    if (!name.test(entry)) continue;
    try {
      fs.symlinkSync(path.join(from, entry), path.join(to, entry));
    } catch {
      // Linked by an earlier command, or by one starting beside this.
    }
  }
}

/** Where the person keeps a tool's cache: `~/Library/Caches` on a Mac, `~/.cache` (or where they moved it) elsewhere. */
function theirCaches(home: string, env: NodeJS.ProcessEnv, mac = process.platform === 'darwin'): string {
  return mac ? path.join(home, 'Library', 'Caches') : (env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
}

/**
 * Playwright locks and writes in its browsers' folder even with nothing to download, and that folder stays read only. So
 * a command's Playwright gets a folder of the project's own, with the browsers this computer has linked in.
 */
function browserCacheEnv(dir: string, home: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const set = env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0' || process.platform === 'win32') return {};
  const playwright = path.join(dir, 'ms-playwright');
  try {
    if (!inside(dir, playwright)) return {};
    linkVersions(set ? path.resolve(set) : path.join(theirCaches(home, env), 'ms-playwright'), playwright, /^[a-z_]+-\d+$/);
    // Puppeteer's browsers, one folder per kind of browser: always in ~/.cache, on a Mac too.
    const puppeteer = path.join(home, '.cache', 'puppeteer');
    for (const kind of fs.existsSync(puppeteer) ? fs.readdirSync(puppeteer) : []) {
      if (/^chrome(-headless-shell)?$|^chromedriver$|^firefox$/.test(kind)) linkVersions(path.join(puppeteer, kind), path.join(dir, 'puppeteer', kind), /^[\w.-]+-[\w.]+$/);
    }
    return { PLAYWRIGHT_BROWSERS_PATH: playwright };
  } catch {
    // A folder it cannot make: Playwright as it is, with its folder read only.
    return {};
  }
}

/** Where the person keeps their Dart and Flutter packages: where they set it, or pub's own place. */
function theirPub(home: string, env: NodeJS.ProcessEnv, win = process.platform === 'win32'): string {
  if (env.PUB_CACHE) return path.resolve(env.PUB_CACHE);
  return win ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Pub', 'Cache') : path.join(home, '.pub-cache');
}

/**
 * The Dart and Flutter packages this computer downloaded already, linked into the project's own pub folder, each one by
 * its version with the hash pub checks it by: a Flutter app's story finds them there, and downloads only what is
 * missing, into the project's folder. The person's own stay read only, as their own builds run what is there. Only for
 * a Dart or Flutter project, as there can be thousands.
 */
function pubLinks(dir: string, cwd: string | undefined, home: string, env: NodeJS.ProcessEnv): void {
  if (!cwd || !fs.existsSync(path.join(cwd, 'pubspec.yaml'))) return;
  const theirs = theirPub(home, env);
  const mine = path.join(dir, 'pub');
  try {
    if (!inside(dir, mine) || path.resolve(theirs) === path.resolve(mine)) return;
    for (const host of fs.existsSync(path.join(theirs, 'hosted')) ? fs.readdirSync(path.join(theirs, 'hosted')) : []) {
      if (host.startsWith('.')) continue;
      linkVersions(path.join(theirs, 'hosted', host), path.join(mine, 'hosted', host), /^[a-z0-9_]+-\d[\w.+-]*$/);
      linkVersions(path.join(theirs, 'hosted-hashes', host), path.join(mine, 'hosted-hashes', host), /^[a-z0-9_]+-\d[\w.+-]*\.sha256$/);
    }
  } catch {
    // A folder it cannot make: pub downloads what it needs instead.
  }
}

/**
 * The person's own CocoaPods spec repos, a company's private one among them, linked into the project's own, read only:
 * CocoaPods finds them there by their address. Not trunk, CocoaPods' public one, which it writes in on each install as
 * it downloads what it needs: the project's own trunk starts empty. Nor the lock file CocoaPods keeps beside them.
 */
function specRepoLinks(dir: string, home: string, env: NodeJS.ProcessEnv): void {
  const theirs = env.CP_REPOS_DIR ? path.resolve(env.CP_REPOS_DIR) : path.join(env.CP_HOME_DIR ? path.resolve(env.CP_HOME_DIR) : path.join(home, '.cocoapods'), 'repos');
  const mine = path.join(dir, 'cocoapods', 'repos');
  try {
    if (!fs.existsSync(theirs) || !inside(dir, mine) || theirs === path.resolve(mine)) return;
    linkVersions(theirs, mine, /^(?!trunk$|Spec_Lock$)[^.]/);
  } catch {
    // A folder it cannot make: CocoaPods downloads what it needs instead.
  }
}

/** Small caches that are slow to make again: they start as a copy of the person's. Prisma's engines, a few files a version. */
const START_AS_COPY: { mine: (home: string, env: NodeJS.ProcessEnv) => string; theirs: (home: string, env: NodeJS.ProcessEnv) => string; most: number }[] = [
  { mine: () => path.join('xdg', 'prisma'), theirs: (home, env) => path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'prisma'), most: 400 * 2 ** 20 },
];

/** The settings files of a tool that lives in the cache home now: linked in, so the person's own settings still count. */
const LINKED_SETTINGS: { mine: string; theirs: string }[] = [
  // Gradle's own settings (proxies, a company's repository) and its scripts that run in every build.
  { mine: 'gradle/gradle.properties', theirs: '.gradle/gradle.properties' },
  { mine: 'gradle/init.d', theirs: '.gradle/init.d' },
  // Maven's: a company's mirror and its passwords file.
  { mine: 'maven/settings.xml', theirs: '.m2/settings.xml' },
  { mine: 'maven/settings-security.xml', theirs: '.m2/settings-security.xml' },
  { mine: 'maven/toolchains.xml', theirs: '.m2/toolchains.xml' },
];

/** Bytes in a folder, until there are more than `most`. */
function sizeOf(p: string, most: number): number {
  let total = 0;
  const walk = (at: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      if (total > most) return;
      const full = path.join(at, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(p);
  return total;
}

/** A folder made beside its place and moved there whole, so a command starting beside this never sees half of it. */
function madeWhole(to: string, make: (part: string) => void): void {
  const part = `${to}.making-${process.pid}`;
  fs.rmSync(part, { recursive: true, force: true });
  try {
    make(part);
    fs.renameSync(part, to);
  } catch {
    // Made by a command beside this one first, or not made: the tool downloads what it needs instead.
    fs.rmSync(part, { recursive: true, force: true });
  }
}

/** A copy, made whole. Where the disk can, each file is a clone, which takes no time and no room until one side changes it. */
function copyWhole(from: string, to: string): void {
  madeWhole(to, (part) => fs.cpSync(from, part, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE }));
}

/** The copies and links a new cache home starts with. Each is made once; what is there already stays. */
function startHome(dir: string, home: string, env: NodeJS.ProcessEnv): void {
  for (const c of START_AS_COPY) {
    const to = path.join(dir, c.mine(home, env));
    const from = c.theirs(home, env);
    try {
      if (fs.lstatSync(to, { throwIfNoEntry: false }) || !fs.existsSync(from) || !inside(dir, to) || sizeOf(from, c.most) > c.most) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      copyWhole(from, to);
    } catch {
      // Not copied: the tool downloads what it needs instead.
    }
  }
  for (const s of LINKED_SETTINGS) {
    const to = path.join(dir, s.mine);
    const from = path.join(home, s.theirs);
    try {
      if (fs.lstatSync(to, { throwIfNoEntry: false }) || !fs.existsSync(from) || !inside(dir, to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(from, to);
    } catch {
      // Linked by a command beside this one.
    }
  }
}

/**
 * The Gradle a project's wrapper asks for, when this computer has it, as downloading it takes minutes. The wrapper keeps
 * each one in a folder named after its address and locks a file in that folder on every run, so the folder is the
 * project's own, with the person's unpacked Gradle linked in and their mark that it is whole. Gradle never writes where
 * it is installed: theirs stays read only, the same program they run. Their downloaded zip stays behind.
 */
function gradleWrapper(dir: string, cwd: string, home: string, env: NodeJS.ProcessEnv): void {
  let said = '';
  try {
    said = fs.readFileSync(path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  } catch {
    return;
  }
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(said)?.[1]?.trim().replace(/\\(.)/g, '$1');
  const url = value('distributionUrl');
  // Only where the wrapper keeps them by default; a project that keeps its Gradle elsewhere has it already.
  if (!url || (value('distributionBase') ?? 'GRADLE_USER_HOME') !== 'GRADLE_USER_HOME' || (value('distributionPath') ?? 'wrapper/dists') !== 'wrapper/dists') return;
  const name = path.basename(url).replace(/\.zip$/, '');
  // The wrapper's own name for the folder: the address's MD5 in base 36.
  const hash = BigInt(`0x${createHash('md5').update(url).digest('hex')}`).toString(36);
  const rel = path.join('wrapper', 'dists', name, hash);
  const theirs = path.join(env.GRADLE_USER_HOME ?? path.join(home, '.gradle'), rel);
  const mine = path.join(dir, 'gradle', rel);
  const ok = `${name}.zip.ok`;
  if (fs.lstatSync(mine, { throwIfNoEntry: false }) || !fs.existsSync(path.join(theirs, ok)) || !inside(dir, mine)) return;
  // The wrapper takes the one folder it finds there as Gradle.
  const unpacked = fs.readdirSync(theirs, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (unpacked.length !== 1) return;
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  madeWhole(mine, (part) => {
    fs.mkdirSync(part);
    fs.symlinkSync(path.join(theirs, unpacked[0]!.name), path.join(part, unpacked[0]!.name));
    fs.copyFileSync(path.join(theirs, ok), path.join(part, ok));
  });
}

/**
 * What this computer downloaded already, which a tool can read without writing in it: Gradle's read-only cache, NuGet's
 * fallback folders and Maven's chained repository (3.9 and later). A story finds its packages there and downloads only
 * what is missing, into the cache home. The person's own stay read only, and as they are.
 */
function theirsToRead(home: string, env: NodeJS.ProcessEnv, mavenOpts: string): Record<string, string> {
  const out: Record<string, string> = {};
  const gradle = path.join(env.GRADLE_USER_HOME ?? path.join(home, '.gradle'), 'caches');
  if (!env.GRADLE_RO_DEP_CACHE && fs.existsSync(path.join(gradle, 'modules-2'))) out.GRADLE_RO_DEP_CACHE = gradle;
  const nuget = env.NUGET_PACKAGES ?? path.join(home, '.nuget', 'packages');
  if (fs.existsSync(nuget)) out.NUGET_FALLBACK_PACKAGES = [env.NUGET_FALLBACK_PACKAGES?.trim(), nuget].filter(Boolean).join(';');
  const maven = path.join(home, '.m2', 'repository');
  if (fs.existsSync(maven) && !/-Dmaven\.repo\.local\.tail=/.test(mavenOpts)) out.MAVEN_OPTS = `${mavenOpts} -Dmaven.repo.local.tail=${maven}`;
  return out;
}

/** Which wall a command runs in: the project's own commands (squad-kit's guard), or the agent's shell. */
export type CacheWall = 'project' | 'agent';

/**
 * The environment that points every tool at the cache home, ready to use. The same for both walls, except pnpm's store,
 * which only the project's own commands need moved. What the person set already is kept where it adds up (their Maven
 * options, the gems already on this computer).
 */
export function cacheHomeEnv(dir: string, o: { wall: CacheWall; cwd?: string; env?: NodeJS.ProcessEnv; home?: string }): Record<string, string> {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  try {
    ownFolder(dir);
    startHome(dir, home, env);
    if (o.cwd) gradleWrapper(dir, o.cwd, home, env);
    pubLinks(dir, o.cwd, home, env);
    if (process.platform === 'darwin') specRepoLinks(dir, home, env);
  } catch {
    // A folder it cannot make, or a copy it could not finish: each tool's setting still points there, and it downloads.
  }
  const packages = packageCacheEnv(dir, env);
  return {
    ...packages,
    ...theirsToRead(home, env, packages.MAVEN_OPTS!),
    ...toolCacheEnv(dir),
    ...installedEnv(),
    ...noReportsEnv(),
    ...npmCacheEnv(dir, home),
    ...browserCacheEnv(dir, home, env),
    ...(o.wall === 'project' ? pnpmStoreEnv(dir) : {}),
  };
}

/* ── a tool that still wrote in the person's home ────────── */

/** The plain line on the story when squad-kit ran a command once more with the project's own folder. */
export const HEALED_LINE = 'A tool could not save its downloads in your home folder, so squad-kit gave it the project\'s own folder and ran it again.';

/** Folders in the home that are no tool's cache: settings, and the programs a person installed with a version manager. */
const NOT_A_CACHE = new Set(['.config', '.local', '.Trash', '.nvm', '.rvm', '.rbenv', '.pyenv', '.sdkman', '.rustup', '.volta', '.asdf', '.jenv', '.nodenv', '.goenv', '.fnm']);

/** Tools on Java, which take their home from the system and not from HOME. */
const ON_JAVA = new Set(['.gradle', '.m2', '.android', '.kotlin', '.konan', '.sbt', '.ivy2', '.java', '.skiko']);

/**
 * The place in the person's home a refused write was in, when it is a tool's cache: `~/.cache/<tool>`,
 * `~/Library/Caches/<tool>` or a tool's own `~/.<tool>` (a folder or a file). Never a place the guard hides or one that
 * holds such a place, never settings (`~/.config`, the rest of `~/Library`), and never a program the person installed.
 */
export function homeCachePlace(target: string, home: string, hidden: string[]): string | null {
  const rel = path.relative(home, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const top = parts[0]!;
  const depth = top === '.cache' ? 2 : top === 'Library' && parts[1] === 'Caches' ? 3 : top.startsWith('.') && !NOT_A_CACHE.has(top) ? 1 : 0;
  if (!depth) return null;
  // A command that could not even make `~/.cache` gets that folder of its own.
  const place = path.join(home, ...parts.slice(0, Math.min(depth, parts.length)));
  const near = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`);
  if (hidden.some((h) => near(place, h) || near(h, place))) return null;
  return place;
}

/** A folder in the cache home that really is one: what a command left in its place goes. */
function realFolderAt(p: string): void {
  const at = fs.lstatSync(p, { throwIfNoEntry: false });
  if (at?.isDirectory()) return;
  if (at) fs.rmSync(p, { force: true });
  fs.mkdirSync(p);
}

/** Links in `to` to each entry of `from`, except the ones named, and the places the guard hides, which get none at all. */
function linkEntries(from: string, to: string, skip: Set<string>, hidden: Set<string>): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(from);
  } catch {
    return;
  }
  for (const name of names) {
    const theirs = path.join(from, name);
    if (skip.has(name) || hidden.has(theirs)) continue;
    const mine = path.join(to, name);
    const at = fs.lstatSync(mine, { throwIfNoEntry: false });
    // A place an earlier run made the project's own keeps what the tool put there.
    if (at && !at.isSymbolicLink()) continue;
    if (at && fs.readlinkSync(mine) === theirs) continue;
    if (at) fs.rmSync(mine, { force: true });
    fs.symlinkSync(theirs, mine);
  }
}

/** The most a place in the person's home is copied as: past this, the project's own place starts with links to what it holds. */
const COPY_MOST = 200 * 2 ** 20;

/** The project's own place for one of the person's: a copy when it is small, links to what it holds when not. Made once. */
function ownPlace(from: string, to: string, hidden: Set<string>): void {
  const at = fs.lstatSync(to, { throwIfNoEntry: false });
  if (at && !at.isSymbolicLink()) return;
  if (at) fs.rmSync(to, { force: true });
  const theirs = fs.statSync(from, { throwIfNoEntry: false });
  if (!theirs) return;
  if (theirs.isFile()) return fs.copyFileSync(from, to);
  if (!theirs.isDirectory()) return;
  if (sizeOf(from, COPY_MOST) <= COPY_MOST) return copyWhole(from, to);
  fs.mkdirSync(to);
  linkEntries(from, to, new Set(), hidden);
}

/**
 * A home of the project's own, for a command squad-kit runs once more: the person's home seen through links, one for each
 * thing in it, except the places a tool could not write in, which are the project's own (a copy of the person's when small,
 * so what the tool had is still there). Places the guard hides get no link at all. A link leads to the person's own file,
 * so the guard still keeps it read only, and hidden what it hides.
 */
export function healHome(dir: string, places: string[], o: { home: string; hidden: string[] }): string {
  const own = path.join(dir, 'home');
  ownFolder(dir);
  realFolderAt(own);
  const hidden = new Set(o.hidden);
  // Each folder on the way to a place, from the home down, with the names below it that are places or lead to one.
  const ways = new Map<string, Set<string>>();
  for (const place of places) {
    const parts = path.relative(o.home, place).split(path.sep);
    parts.forEach((part, i) => {
      const at = parts.slice(0, i).join(path.sep);
      ways.set(at, (ways.get(at) ?? new Set()).add(part));
    });
  }
  const placed = new Set(places.map((p) => path.relative(o.home, p)));
  const walk = (rel: string) => {
    const mine = path.join(own, rel);
    linkEntries(path.join(o.home, rel), mine, ways.get(rel) ?? new Set(), hidden);
    for (const name of ways.get(rel) ?? []) {
      const next = rel ? path.join(rel, name) : name;
      if (placed.has(next)) ownPlace(path.join(o.home, next), path.join(own, next), hidden);
      else {
        realFolderAt(path.join(own, next));
        walk(next);
      }
    }
  };
  walk('');
  return own;
}

/** The environment for a command run with a home of the project's own. Java tools take their home from a setting of Java's. */
export function healEnv(dir: string, places: string[], o: { home?: string; hidden: string[]; env?: NodeJS.ProcessEnv }): Record<string, string> {
  const home = o.home ?? os.homedir();
  const own = healHome(dir, places, { home, hidden: o.hidden });
  const java = places.some((p) => ON_JAVA.has(path.relative(home, p).split(path.sep)[0]!));
  const opts = (o.env ?? process.env).JAVA_TOOL_OPTIONS?.trim();
  return { HOME: own, ...(java ? { JAVA_TOOL_OPTIONS: [opts, `-Duser.home=${own}`].filter(Boolean).join(' ') } : {}) };
}

/**
 * What squad-kit learned: the places each command needed a home of the project's own for, so it starts with one from then
 * on, and no other story waits for a second run. Kept beside the cache home, where no command and no agent can write.
 */
function learnedFile(dir: string): string {
  return `${dir}.healed.json`;
}

/** The places a command needed its own home for before. Each is checked again: the file is read outside the guard. */
export function healedBefore(dir: string, command: string, o: { home?: string; hidden: string[] }): string[] {
  const home = o.home ?? os.homedir();
  try {
    const all = JSON.parse(fs.readFileSync(learnedFile(dir), 'utf8')) as Record<string, unknown>;
    const said = all[command];
    return Array.isArray(said) ? said.filter((p): p is string => typeof p === 'string' && homeCachePlace(p, home, o.hidden) === p) : [];
  } catch {
    return [];
  }
}

/** Keeps the places a command needed its own home for. */
export function rememberHealed(dir: string, command: string, places: string[]): void {
  const file = learnedFile(dir);
  let all: Record<string, string[]> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
  } catch {
    // The first one.
  }
  all[command] = [...new Set(places)];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // Not kept: the next run of it runs once more again, as this one did.
  }
}
