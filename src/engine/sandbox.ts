import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiTool, BlockedAction, SandboxAsk, SandboxSupport } from '../modules/ai-tool/types.js';
import { AI_TOOLS } from '../modules/registry.js';
import { squadHome } from '../core/home.js';
import type { BoardPaths } from '../board/store.js';

/**
 * The Builder's and the Tester's shell commands run in their AI tool's sandbox, where it has one: they write only in
 * the ticket's copy, the proof folder and temp folders, reach only package registries (and the hosts the project
 * allows), and never read keys, sign-ins, squad-kit's own files or the project's .env files. squad-kit asks for
 * folders and hosts; the AI tool module turns them into its own settings. Without a sandbox the step runs as before,
 * kept in its lane by squad-kit's own checks.
 */

/** Package registries and download hosts every project may reach: installing and updating packages needs them. */
export const PACKAGE_HOSTS = [
  // npm, pnpm and Yarn
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  // PyPI
  'pypi.org',
  'files.pythonhosted.org',
  // Maven and Gradle
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'downloads.gradle.org',
  // NuGet
  'api.nuget.org',
  'globalcdn.nuget.org',
  // RubyGems
  'rubygems.org',
  'index.rubygems.org',
  // crates.io
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  // The Go module proxy
  'proxy.golang.org',
  'sum.golang.org',
  // GitHub release downloads, and packages installed from GitHub
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  // Browsers for the project's own browser tests
  'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com',
  'playwright.azureedge.net',
];

/**
 * The person's own package caches a command may write in, so installing a package works. Only the ones whose packages
 * are checked against the project's lock file before use: a command cannot leave something there that the person's
 * own builds later run unchecked. The shared caches of NuGet, Maven, Gradle and RubyGems/Bundler stay read only:
 * those tools get the ticket's own cache instead (ticketCacheDir), and npx and browsers get none.
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

/**
 * The ticket's own package cache on this computer, for the package managers whose shared caches stay read only
 * (NuGet, Maven, Gradle, RubyGems and Bundler). It sits with the project's other files on this computer, outside the
 * ticket's copy, so git never sees it, and nothing downloaded into it reaches the person's own caches. It goes with
 * the copy: after the release, and on Delete. The cost: a ticket's first build downloads its packages again.
 */
export function ticketCacheDir(bp: Pick<BoardPaths, 'localDir'>, id: string): string {
  return path.join(bp.localDir, 'caches', id.toLowerCase());
}

/**
 * The project's own package cache on this computer, for the commands squad-kit runs with no ticket: the first setup,
 * Your apps, your checkout's setup after a merge and the release pipeline. The same package managers as a ticket's.
 */
export function projectCacheDir(bp: Pick<BoardPaths, 'localDir'>): string {
  return path.join(bp.localDir, 'caches', 'project');
}

/** Removes a ticket's own package cache, with its copy of the code. */
export function dropTicketCache(bp: Pick<BoardPaths, 'localDir'>, id: string): void {
  fs.rmSync(ticketCacheDir(bp, id), { recursive: true, force: true });
}

/**
 * The environment that points those package managers at the ticket's cache, for a sandboxed step's commands. What
 * the person set already is kept where it adds up: their Maven options, and the gems already on this computer.
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
  /** The ticket's own package cache (ticketCacheDir). */
  cache?: string;
  home?: string;
}

/** What a Builder or Tester step asks of the sandbox. */
export function sandboxAsk(o: SandboxFor): SandboxAsk {
  const home = o.home ?? os.homedir();
  const temp = withReal([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]);
  const caches = PACKAGE_CACHES.map((c) => path.join(home, c)).filter((c) => fs.existsSync(c));
  const env = ['.env', '.env.*', '**/.env', '**/.env.*'].map((p) => `${o.root}/${p}`);
  const own = o.cache ? withReal([o.cache]) : [];
  return {
    write: [...new Set([...withReal([o.proof]), ...own, ...temp, ...caches])],
    noRead: [...new Set([...PRIVATE.map((p) => path.join(home, p)), ...withReal([squadHome()]), ...o.secrets, ...env])],
    // The step's own folders, inside squad-kit's: its copy, its proof folder, its package cache, its attachments.
    read: [...new Set(withReal([o.cwd, o.proof, ...(o.cache ? [o.cache] : []), ...o.read]))],
    hosts: [...new Set([...PACKAGE_HOSTS, ...(o.hosts ?? [])])],
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

/** What Settings says when the agents' own commands have no guard here, in plain words. */
export interface GuardNote {
  title: string;
  text: string;
}

/**
 * Windows has no guard for the agents' own commands yet (decision 1 of the agent's room plan): Settings says so
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

/** One line in plain words for something the sandbox refused, with what to do when the person can allow it. */
export function blockedLine(b: BlockedAction, home = os.homedir()): string {
  if (b.kind === 'host') return `Reaching ${b.target} was blocked: not a package registry. Allow it in Settings.`;
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
 * would open every host, so it is refused like anything that is not a host name.
 */
export function parseHosts(list: string[]): { hosts: string[]; bad: string[] } {
  const hosts: string[] = [];
  const bad: string[] = [];
  for (const raw of list.flatMap((x) => String(x).split(/[\s,]+/))) {
    const s = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    if (!raw.trim()) continue;
    if (/^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) && s !== '*') hosts.push(s);
    else bad.push(raw.trim());
  }
  return { hosts: [...new Set(hosts)], bad };
}
