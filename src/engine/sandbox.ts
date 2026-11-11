import { androidReads } from './android-env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDirsIn } from './git.js';
import type { AiTool, BlockedAction, SandboxAsk, SandboxSupport } from '../modules/ai-tool/types.js';
import { AI_TOOLS } from '../modules/registry.js';
import { squadHome } from '../core/home.js';
import { boardPaths, readMeta, type BoardPaths } from '../board/store.js';
import type { NetworkLevel } from '../board/types.js';
import { KNOWN_BAD, RECOMMENDED, knownBadGroup } from './network-lists.js';
import { flutterOnPath, flutterStampGlobs } from './flutter-sdk.js';

/**
 * The Builder's and the Tester's shell commands run in their AI tool's sandbox, where it has one: they write only in
 * the ticket's copy, the proof folder and temp folders, reach the sites the project's network level allows (one
 * policy, networkPolicy, read by this sandbox and by the guard for the project's own commands), and never read keys,
 * sign-ins, squad-kit's own files or the project's .env files. squad-kit asks for folders and hosts; the AI tool module
 * turns them into its own settings. Without a sandbox the step runs as before, kept in its lane by squad-kit's own checks.
 */

/**
 * Package registries and download hosts every project may reach on Standard and Strict: installing and updating
 * packages needs them. The recommended list of engine/network-lists.ts, updated with each release.
 */
export const PACKAGE_HOSTS = RECOMMENDED;

/* ── the network level: one policy for both guards ───────── */

/** The level a project starts on, and keeps until an engineer picks another. */
export const DEFAULT_NETWORK: NetworkLevel = 'standard';

export const NETWORK_LEVELS: NetworkLevel[] = ['standard', 'strict', 'off'];

/** Each level by name, for people. */
export const NETWORK_NAME: Record<NetworkLevel, string> = { standard: 'Standard', strict: 'Strict', off: 'Off' };

/** Each level in one plain sentence, the same on the Harness page and in the terminal. */
export const NETWORK_WORDS: Record<NetworkLevel, string> = {
  standard: 'Any website but known-bad ones such as tunnels, paste sites and request catchers, with your keys hidden so a harmful package has nothing to take.',
  strict: "Only the official package and download sites of common tools and the websites you allow, while your project's own tests and app still reach any site for now.",
  off: 'No internet, only this computer, so the setup, the tests and the app must work with what is already here.',
};

/** A level as typed ("Strict", "off"), or null when it is none of them. */
export function parseNetwork(s: string | undefined): NetworkLevel | null {
  const v = s?.trim().toLowerCase();
  return NETWORK_LEVELS.find((l) => l === v) ?? null;
}

/**
 * The project's level, from its shared settings in the person's own folder: never from a story's copy, where an agent
 * writes. A project without settings, or with settings that cannot be read, is on the default.
 */
export function projectNetwork(root: string): NetworkLevel {
  try {
    return parseNetwork(readMeta(boardPaths(path.join(root, '.squad'))).network) ?? DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}

/** What one level lets each guard reach. squad-kit makes it here, once; both guards read it. */
export interface NetworkPolicy {
  level: NetworkLevel;
  /** The hosts the agents' own commands may reach. "*" is any host. Empty: none, only this computer's own ports. */
  hosts: string[];
  /** Hosts they never reach, whatever else allows them: the known-bad list. */
  noHosts: string[];
  /** What the project's own commands (setup, tests, the app) reach: the internet, or only this computer's own ports. */
  commands: 'internet' | 'this-computer';
}

/**
 * The policy for a level and the sites the project allows. Standard lets the agents' commands reach any host ("*"),
 * with the recommended list beside it, so the usual sites stay open even on a tool that stops taking "*". Strict, the
 * recommended list and the project's sites; Off, none. The known-bad list is closed on all three, and a site of the
 * project's never opens it. The project's own commands: closed to all but this computer on Off, on a Mac (Seatbelt
 * can say "only this computer"). Bubblewrap could only by giving each command a network of its own, where the app
 * squad-kit started in another command is out of reach, so Linux keeps them open; Strict for them needs a proxy that
 * sees host names, later.
 */
export function networkPolicy(level: NetworkLevel = DEFAULT_NETWORK, sites: string[] = [], platform: NodeJS.Platform = process.platform): NetworkPolicy {
  const own = sites.filter((h) => !knownBadGroup(h));
  const hosts = level === 'off' ? [] : [...new Set([...(level === 'standard' ? ['*'] : []), ...PACKAGE_HOSTS, ...own])];
  return { level, hosts, noHosts: KNOWN_BAD, commands: level === 'off' && platform === 'darwin' ? 'this-computer' : 'internet' };
}

/** One site the agents' guard refused, for engineers on Harness → Safety. */
export interface BlockedSite {
  host: string;
  /** The story it happened on. */
  story: string;
  level: NetworkLevel;
  at: string;
}

/** The most the log keeps: enough to see what a project needs, small enough to read. */
const MAX_BLOCKED_SITES = 50;

/** This computer's log of refused sites, for the project. */
function blockedSitesFile(bp: Pick<BoardPaths, 'localDir'>): string {
  return path.join(bp.localDir, 'blocked-sites.json');
}

/** The refused sites, newest first. */
export function blockedSites(bp: Pick<BoardPaths, 'localDir'>): BlockedSite[] {
  try {
    const list = JSON.parse(fs.readFileSync(blockedSitesFile(bp), 'utf8')) as unknown;
    return Array.isArray(list) ? (list as BlockedSite[]).filter((b) => b && typeof b.host === 'string').reverse() : [];
  } catch {
    return [];
  }
}

/** Notes one refused site. The same site on the same story keeps one line, with its latest time. Never fails a step. */
export function noteBlockedSite(bp: Pick<BoardPaths, 'localDir'>, site: Omit<BlockedSite, 'at'> & { at?: string }): void {
  try {
    const list = blockedSites(bp).reverse().filter((b) => b.host !== site.host || b.story !== site.story);
    list.push({ host: site.host, story: site.story, level: site.level, at: site.at ?? new Date().toISOString() });
    fs.mkdirSync(bp.localDir, { recursive: true });
    fs.writeFileSync(blockedSitesFile(bp), `${JSON.stringify(list.slice(-MAX_BLOCKED_SITES), null, 1)}\n`);
  } catch {
    // A log it cannot write: the story goes on all the same.
  }
}

/**
 * The person's own package caches a command may write in, so installing a package works. Only the ones whose packages
 * are checked against the project's lock file before use: a command cannot leave something there that the person's
 * own builds later run unchecked. Every other tool's cache stays read only: those tools get the project's cache home
 * instead (engine/cache-home.ts).
 */
export const PACKAGE_CACHES = [
  '.npm/_cacache',
  '.yarn/berry/cache',
  'Library/Caches/Yarn',
  '.cache/yarn',
  'Library/pnpm/store',
  '.local/share/pnpm/store',
  'Library/Caches/pnpm',
  '.cache/pnpm',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg/mod',
];

/** Keys and sign-ins in the person's home folder. The guard for the project's own commands keeps them out too. */
export const PRIVATE = ['.ssh', '.aws', '.gnupg', '.config/gh', '.azure', '.kube', '.docker/config.json', '.netrc', '.git-credentials'];

/** Addresses a push can go to. A remote with its own push address set in git keeps it, as git leaves that one alone. */
const PUSH_ADDRESSES = ['/', '.', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@'];

/**
 * The environment that sends every push from an agent or a story's own command nowhere, and leaves fetching alone. Only
 * they get it: squad-kit's own pushes do not. It stands behind the deny rules and the hidden keys, and a command that
 * clears it still has no keys to push with.
 */
export function noPushEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const from = Number(env.GIT_CONFIG_COUNT) || 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(from + PUSH_ADDRESSES.length) };
  PUSH_ADDRESSES.forEach((address, i) => {
    out[`GIT_CONFIG_KEY_${from + i}`] = 'url.squad-kit-no-push://.pushInsteadOf';
    out[`GIT_CONFIG_VALUE_${from + i}`] = address;
  });
  return out;
}

/**
 * The ticket's own package cache, up to 1.3.2. Its stories now share the project's cache home (engine/cache-home.ts), so
 * this is only where an older story's downloads may still be: they go with its copy, after the release and on Delete.
 */
export function ticketCacheDir(bp: Pick<BoardPaths, 'localDir'>, id: string): string {
  return path.join(bp.localDir, 'caches', id.toLowerCase());
}

/**
 * The project's own cache home on this computer, for the commands that run accepted code, with no ticket: the first setup,
 * Your apps, your checkout's setup after a merge and the release pipeline. No story writes in it (engine/cache-home.ts).
 */
export function projectCacheDir(bp: Pick<BoardPaths, 'localDir'>): string {
  return path.join(bp.localDir, 'caches', 'project');
}

/** Removes a ticket's own package cache from before 1.3.3, with its copy of the code. */
export function dropTicketCache(bp: Pick<BoardPaths, 'localDir'>, id: string): void {
  fs.rmSync(ticketCacheDir(bp, id), { recursive: true, force: true });
}

/**
 * The environment that points NuGet, Maven, Gradle, RubyGems and Bundler at a cache home (engine/cache-home.ts adds the
 * other tools). What the person set already is kept where it adds up: their Maven options, and the gems already here.
 */
export function packageCacheEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const at = (...p: string[]) => path.join(dir, ...p);
  const gems = [env.GEM_HOME, ...(env.GEM_PATH ?? '').split(path.delimiter)].filter((p): p is string => Boolean(p?.trim()));
  return {
    // NuGet: the global packages folder, its download cache and its plugins cache.
    NUGET_PACKAGES: at('nuget', 'packages'),
    NUGET_HTTP_CACHE_PATH: at('nuget', 'http-cache'),
    NUGET_PLUGINS_CACHE_PATH: at('nuget', 'plugins-cache'),
    // Maven: its local repository, after the options the person set (the last -D wins).
    MAVEN_OPTS: [env.MAVEN_OPTS?.trim(), `-Dmaven.repo.local=${at('maven', 'repository')}`].filter(Boolean).join(' '),
    // Gradle: its whole user home, with its caches and the Gradle versions the wrapper downloads.
    GRADLE_USER_HOME: at('gradle'),
    // RubyGems installs here. The gems already on this computer stay usable: the person's own gem folders, and
    // Ruby's own (a path that ends in the separator adds them).
    GEM_HOME: at('ruby', 'gems'),
    GEM_PATH: `${[...new Set(gems)].join(path.delimiter)}${path.delimiter}`,
    GEM_SPEC_CACHE: at('ruby', 'specs'),
    // Bundler installs the bundle here, and keeps its downloaded gem index here.
    BUNDLE_PATH: at('ruby', 'bundle'),
    BUNDLE_USER_CACHE: at('ruby', 'bundle-cache'),
  };
}

/**
 * What no project command or agent may write in a copy, or in a person's own checkout: its `.git`, and the git folder a
 * copy's `.git` points at (a project in a temp folder would otherwise have it writable). From there a command could
 * plant a hook or a setting, or point the copy at another folder, and squad-kit's own git, which runs outside any guard,
 * would believe it.
 */
export function gitPlaces(cwd: string): string[] {
  const link = path.join(cwd, '.git');
  try {
    const own = path.resolve(cwd, /^gitdir: (.*)$/m.exec(fs.readFileSync(link, 'utf8'))![1]!);
    return [link, own, path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim())];
  } catch {
    return [link];
  }
}

/** A path and, when it is a link (/tmp on a Mac), where it really is. */
function withReal(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    out.add(d);
    try {
      out.add(fs.realpathSync(d));
    } catch {
      // Not there.
    }
  }
  return [...out];
}

export interface SandboxFor {
  /** The folder the step works in: the ticket's copy. */
  cwd: string;
  /** The person's own project folder: its .env files stay out of reach. */
  root: string;
  /** Other folders the step reads: attachments, rule files. */
  read: string[];
  /** The proof folder: the Tester saves its screenshots there. */
  proof: string;
  /** squad-kit's secret files. */
  secrets: string[];
  /** Hosts the project allows on top of the package registries. */
  hosts?: string[];
  /** The project's network level. Left out, read from the project's own settings. */
  network?: NetworkLevel;
  /** The cache home the project's stories share (engine/cache-home.ts). */
  cache?: string;
  /** The person's Flutter folder, whose version stamps every run writes (engine/flutter-sdk.ts). Left out, the one on the PATH. */
  flutter?: string | null;
  home?: string;
}

/** What a Builder or Tester step asks of the sandbox. */
export function sandboxAsk(o: SandboxFor): SandboxAsk {
  const home = o.home ?? os.homedir();
  const temp = withReal([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]);
  const caches = PACKAGE_CACHES.map((c) => path.join(home, c)).filter((c) => fs.existsSync(c));
  const env = ['.env', '.env.*', '**/.env', '**/.env.*'].map((p) => `${o.root}/${p}`);
  const own = o.cache ? withReal([o.cache]) : [];
  const net = networkPolicy(o.network ?? projectNetwork(o.root), o.hosts ?? []);
  // Flutter's version stamps in its own folder, each exactly: the AI tool's sandbox takes a glob for the one a run names.
  const flutter = o.flutter === undefined ? flutterOnPath()?.root : o.flutter;
  return {
    write: [...new Set([...withReal([o.proof]), ...own, ...temp, ...caches, ...(flutter ? flutterStampGlobs(flutter) : [])])],
    noRead: [...new Set([...PRIVATE.map((p) => path.join(home, p)), ...withReal([squadHome()]), ...o.secrets, ...env])],
    // The step's own folders, inside squad-kit's: its copy, its proof folder, its package cache, its attachments.
    // And squad-kit's Android SDK, Java and shared Gradle home, read only, for an Android build in the shell.
    read: [...new Set(withReal([o.cwd, o.proof, ...(o.cache ? [o.cache] : []), ...o.read, ...androidReads()]))],
    noWrite: [...new Set(withReal([...gitPlaces(o.cwd), ...copyDirsIn(o.cwd).flatMap(gitPlaces)]))],
    hosts: net.hosts,
    noHosts: net.noHosts,
  };
}

/** The sandbox a tool has here, or why there is none. */
export function sandboxOf(tool: AiTool): SandboxSupport {
  return tool.sandbox?.() ?? { available: false, why: `${tool.label} has no sandbox squad-kit can use` };
}

/** Each AI tool squad-kit can run, and whether its steps run in a sandbox on this computer. */
export function sandboxStatus(): ({ tool: string } & SandboxSupport)[] {
  return AI_TOOLS.filter((t) => t.canRun).map((t) => ({ tool: t.label, ...sandboxOf(t) }));
}

/** What the Harness page says when the agents' own commands have no guard here, in plain words. */
export interface GuardNote {
  title: string;
  text: string;
}

/**
 * Windows has no guard for the agents' own commands yet (decision 1 of the agent's room plan): the Harness page says so
 * plainly. Those commands can read any file there, squad-kit's own too, so the note promises nothing it cannot keep.
 * The window still does the screenshots and the app. Null where a guard runs, or where the tools say why not.
 */
export function guardNote(platform: NodeJS.Platform = process.platform, tools: SandboxSupport[] = sandboxStatus()): GuardNote | null {
  if (platform !== 'win32' || tools.some((t) => t.available)) return null;
  return {
    title: 'Windows: less protected',
    text: "On Windows, squad-kit does not guard the agents' own commands, or the project's own tests and app, so they can reach other files on this computer. Use it on projects you trust.",
  };
}

/** A path for people: inside the home folder as ~/… */
function shown(file: string, home: string): string {
  return file === home ? '~' : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

/**
 * One line in plain words for something the sandbox refused. A site asks nothing of the person and stops nothing: the
 * agent reads the refusal in its command's output and goes on another way, and engineers see it on Harness → Safety.
 */
export function blockedLine(b: BlockedAction, home = os.homedir()): string {
  if (b.kind === 'host') return `A download from ${b.target} was not allowed for this project; the work goes on without it.`;
  const file = shown(b.target, home);
  if (b.kind === 'write') return `Writing ${file} was blocked: the squad writes only in the ticket's copy, the proof folder and temp folders.`;
  const base = path.basename(b.target);
  const why = /^\.env(\.|$)/.test(base)
    ? "the project's .env files stay private"
    : b.target.startsWith(squadHome())
      ? "squad-kit's own files stay private"
      : 'keys and sign-ins stay private';
  return `Reading ${file} was blocked: ${why}.`;
}

/** What a tool's sandbox refused, from a command's output, whichever AI tool ran it. */
export function blockedIn(output: string): BlockedAction[] {
  if (!output) return [];
  for (const t of AI_TOOLS) {
    const found = t.blocked?.(output) ?? [];
    if (found.length) return found;
  }
  return [];
}

/**
 * Hosts a person typed for the project, cleaned: "https://Nexus.Example.com/repo" is nexus.example.com. A lone "*"
 * would open every host, so it is refused like anything that is not a host name. A known-bad site is set apart: no
 * project opens one.
 */
export function parseHosts(list: string[]): { hosts: string[]; bad: string[]; closed: string[] } {
  const hosts: string[] = [];
  const bad: string[] = [];
  const closed: string[] = [];
  for (const raw of list.flatMap((x) => String(x).split(/[\s,]+/))) {
    const s = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    if (!raw.trim()) continue;
    if (!/^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) || s === '*') bad.push(raw.trim());
    else if (knownBadGroup(s)) closed.push(s);
    else hosts.push(s);
  }
  return { hosts: [...new Set(hosts)], bad, closed };
}

/** Why a typed list of hosts cannot be saved, in plain words, or null when it can. */
export function hostsProblem(p: { bad: string[]; closed: string[] }): string | null {
  if (p.bad.length) return `"${p.bad[0]}" is not a host name. Write it like nexus.example.com, or *.example.com for all of its subdomains.`;
  if (p.closed.length) return `${p.closed[0]} stays closed for every project: it is one of the ${knownBadGroup(p.closed[0]!)!.toLowerCase()}, which a build never needs.`;
  return null;
}
