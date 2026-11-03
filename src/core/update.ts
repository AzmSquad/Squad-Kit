import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';
import { changelogBlobUrl, type InstalledPackage } from './package-info.js';
import { detectPackageManager, installCommandFor, type PackageManager } from './package-manager.js';
import { isNewer } from './registry.js';
import { withoutTags } from '../utils/text.js';

/**
 * The parts `squad upgrade` and the app's Update button share: the one install command for this computer, what is new
 * from the GitHub release notes, and the install itself with its output kept.
 */

export interface UpgradePlan {
  pm: PackageManager;
  /** Why we think so, e.g. "install path contains pnpm". */
  reason: string;
  cmd: string;
  args: string[];
  /** The whole command, to show and to copy. */
  text: string;
}

/** The install command of the package manager that installed squad-kit. Without a version it installs the latest. */
export function upgradePlan(installed: Pick<InstalledPackage, 'name' | 'root'>, version = 'latest'): UpgradePlan {
  const found = detectPackageManager(installed.root);
  const { cmd, args } = installCommandFor(found.pm, installed.name, version);
  return { pm: found.pm, reason: found.reason, cmd, args, text: [cmd, ...args].join(' ') };
}

/** A new major version changes how squad-kit works, so it never installs before the person reads what changed. */
export function isMajorBump(latest: string, current: string): boolean {
  const major = (v: string) => parseInt(v.split('.')[0] ?? '0', 10) || 0;
  return major(latest) > major(current);
}

export interface ReleaseNotes {
  version: string;
  /** A few plain lines of what is new. Empty when the release has no notes to read. */
  lines: string[];
  /** The release page, or the changelog at that version. */
  url: string;
}

/** owner and repo of a GitHub repository URL, written the ways package.json writes it. */
export function githubRepo(url: string | undefined): { owner: string; repo: string } | null {
  const m = url ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim()) : null;
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

const NOTES_MAX = 5;

/** The first top-level bullets of a release's notes, without Markdown, so they read as plain lines. */
export function notesFromMarkdown(md: string, max = NOTES_MAX): string[] {
  const plain = (s: string) =>
    withoutTags(
      s
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2'),
    )
      .replace(/\s+/g, ' ')
      .trim();
  const lines = md.split(/\r?\n/);
  const bullets = lines
    .filter((l) => /^[-*+]\s+\S/.test(l))
    .map((l) => plain(l.replace(/^[-*+]\s+/, '')))
    .filter(Boolean);
  if (bullets.length) return bullets.slice(0, max);
  // No list: the first lines of text instead, never headings, tables or code.
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|\||```|>)/.test(l))
    .map(plain)
    .filter(Boolean)
    .slice(0, 2);
}

/**
 * What is new in a version, from its GitHub release. Optional: with no network, no release or no notes, it gives the
 * changelog link alone.
 */
export async function fetchReleaseNotes(
  repositoryUrl: string | undefined,
  version: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReleaseNotes> {
  const fallback: ReleaseNotes = { version, lines: [], url: changelogBlobUrl(repositoryUrl, version) };
  const gh = githubRepo(repositoryUrl ?? 'https://github.com/AzmSquad/squad-kit');
  if (!gh) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await (opts.fetch ?? fetch)(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/tags/v${encodeURIComponent(version)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'squad-kit' },
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { body?: unknown; html_url?: unknown };
    return {
      version,
      lines: typeof body.body === 'string' ? notesFromMarkdown(body.body) : [],
      url: typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : fallback.url,
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** A few lines per release when several are shown together, so the banner stays short. */
export const NOTES_PER_RELEASE = 3;
/** One page of GitHub's release list covers the releases a person skips; older ones are behind the changelog link. */
const RELEASES_PAGE = 30;

const plainVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/**
 * What is new in every release after `from` up to and including `to`, newest first: a person on 1.0.1 updating to
 * 1.1.1 reads 1.1.1 and 1.1.0 too. One call to GitHub's release list; with no network or no list it falls back to the
 * one release `to`, and with nothing at all to its changelog link. Drafts and pre-releases are left out.
 */
export async function fetchReleasesBetween(
  repositoryUrl: string | undefined,
  from: string,
  to: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; perRelease?: number } = {},
): Promise<ReleaseNotes[]> {
  const per = opts.perRelease ?? NOTES_PER_RELEASE;
  const only = async () => {
    const one = await fetchReleaseNotes(repositoryUrl, to, opts);
    return [{ ...one, lines: one.lines.slice(0, per) }];
  };
  const gh = githubRepo(repositoryUrl ?? 'https://github.com/AzmSquad/squad-kit');
  if (!gh) return only();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  let list: unknown;
  try {
    const res = await (opts.fetch ?? fetch)(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=${RELEASES_PAGE}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'squad-kit' },
      signal: controller.signal,
    });
    list = res.ok ? await res.json() : null;
  } catch {
    list = null;
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(list)) return only();
  const found: ReleaseNotes[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') continue;
    const version = r.tag_name.replace(/^v/, '');
    if (!plainVersion(version) || !isNewer(version, from) || isNewer(version, to)) continue;
    if (found.some((f) => f.version === version)) continue;
    found.push({
      version,
      lines: typeof r.body === 'string' ? notesFromMarkdown(r.body, per) : [],
      url: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : changelogBlobUrl(repositoryUrl, version),
    });
  }
  // The newest is often on npm a little before its GitHub release: the older ones still show, and the app asks again.
  if (!found.length) return only();
  return found.sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
}

export interface InstallResult {
  ok: boolean;
  code: number | null;
  /** The last part of what the package manager printed, for engineers. */
  output: string;
  timedOut: boolean;
  /** The install could not start at all, e.g. the package manager is not on this computer. */
  startError?: string;
}

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_MAX = 8000;

/**
 * Runs the install with its output kept, off the terminal. Past its limit the whole process group ends (the package
 * manager starts children): TERM, then KILL after 5 s.
 */
export function runInstall(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<InstallResult> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    let output = '';
    let timedOut = false;
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: group });
    } catch (err) {
      resolve({ ok: false, code: null, output: '', timedOut: false, startError: (err as Error).message });
      return;
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Gone already.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killer = setTimeout(() => kill('SIGKILL'), 5000);
    }, opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
    const finish = (r: InstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolve(r);
    };
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_MAX);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => finish({ ok: false, code: null, output, timedOut, startError: err.message }));
    // The last output arrives with close; a child of the package manager may hold it open, so exit decides soon after.
    let code: number | null = null;
    const done = () => finish({ ok: code === 0 && !timedOut, code, output, timedOut });
    child.on('close', done);
    child.on('exit', (c) => {
      code = c;
      setTimeout(done, 1000).unref();
    });
  });
}

export interface InstallFailure {
  /** What happened, in plain words. */
  reason: string;
  /** The computer needs the person's permission: they run the command once in a terminal. */
  permission: boolean;
}

export function whyInstallFailed(r: InstallResult, cmd: string): InstallFailure {
  if (r.startError) {
    return /ENOENT/.test(r.startError)
      ? { reason: `squad-kit could not find ${cmd} on this computer.`, permission: false }
      : { reason: `The install could not start: ${r.startError}`, permission: false };
  }
  if (r.timedOut) return { reason: 'The install took longer than 5 minutes, so squad-kit stopped it.', permission: false };
  const out = r.output;
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(out)) return { reason: 'This computer needs your permission to install.', permission: true };
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(out)) {
    return { reason: 'squad-kit could not reach the npm registry. Check the internet connection, then try again.', permission: false };
  }
  if (/ENOSPC|no space left/i.test(out)) return { reason: 'The disk is full. Free some space, then try again.', permission: false };
  return { reason: `The install stopped with an error (exit code ${r.code ?? 'none'}).`, permission: false };
}
