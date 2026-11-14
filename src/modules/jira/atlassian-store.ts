import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateFolder, readyPrivateFolder } from '../../core/home.js';

/**
 * squad-kit's own Atlassian sign-in on this computer (ADR-012), in its own private folder (`~/.squad-kit/atlassian`),
 * which agents never reach: the refresh token, the Jira sites Atlassian gave, the account's name, and when the refresh
 * token ends if unused. The access token is never here: it lives in memory only (atlassian-token.ts). The file is the
 * person's only (0600), written whole and never followed through a link.
 */

export const ATLASSIAN_FOLDER = 'atlassian';
const FILE = 'sign-in.json';
/** Atlassian ends a refresh token that has not been used for 90 days. */
const INACTIVE_MS = 90 * 24 * 60 * 60_000;

/** A Jira site Atlassian gave squad-kit: its cloud id, address and name. */
export interface AtlassianSite {
  id: string;
  /** https://acme.atlassian.net */
  url: string;
  name: string;
}

interface AtlassianSignIn {
  /** This sign-in's own id, kept through every refresh: a token in memory belongs to it, and to no later sign-in. */
  signIn: string;
  refreshToken: string;
  sites: AtlassianSite[];
  /** The cloud id of the site chosen for projects that have no Jira site of their own yet. */
  site?: string;
  account?: { id: string; name: string };
  /** When Atlassian last gave a new refresh token. */
  refreshedAt: string;
  /** When that refresh token ends if squad-kit does not use it: 90 days on. */
  until: string;
}

/** A cloud id goes into an address: letters, digits and dashes only. */
const CLOUD_ID = /^[A-Za-z0-9-]{1,64}$/;

const fileOf = () => path.join(privateFolder(ATLASSIAN_FOLDER), FILE);

/** The site's host, from its address: acme.atlassian.net. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** A site as Atlassian gave it, checked: an https address on a plain host, and a cloud id that can go in an address. */
export function siteFrom(raw: { id?: unknown; url?: unknown; name?: unknown }): AtlassianSite | null {
  if (typeof raw.id !== 'string' || !CLOUD_ID.test(raw.id) || typeof raw.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return { id: raw.id, url: `https://${url.host.toLowerCase()}`, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : url.host };
}

/** A real file in a real folder: a link standing in either place is never read. */
function plainFile(): string | null {
  const dir = fs.lstatSync(privateFolder(ATLASSIAN_FOLDER), { throwIfNoEntry: false });
  if (!dir?.isDirectory()) return null;
  const file = fs.lstatSync(fileOf(), { throwIfNoEntry: false });
  return file?.isFile() ? fileOf() : null;
}

/** The sign-in kept on this computer, or null: none, or a file that is not squad-kit's. */
export function readAtlassianSignIn(): AtlassianSignIn | null {
  const file = plainFile();
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AtlassianSignIn>;
    if (typeof j.refreshToken !== 'string' || !j.refreshToken || j.refreshToken.length > 8192) return null;
    const sites = (Array.isArray(j.sites) ? j.sites : []).map((s) => siteFrom(s)).filter((s): s is AtlassianSite => Boolean(s));
    const account = j.account && typeof j.account.name === 'string' && typeof j.account.id === 'string' ? { id: j.account.id, name: j.account.name } : undefined;
    return {
      signIn: typeof j.signIn === 'string' ? j.signIn : '',
      refreshToken: j.refreshToken,
      sites,
      ...(typeof j.site === 'string' && sites.some((s) => s.id === j.site) ? { site: j.site } : {}),
      ...(account ? { account } : {}),
      refreshedAt: String(j.refreshedAt ?? ''),
      until: String(j.until ?? ''),
    };
  } catch {
    return null;
  }
}

/** A new sign-in's own id. */
export const newSignInId = () => randomBytes(8).toString('hex');

/** The dates for a refresh token Atlassian gave now. */
export function freshDates(now = Date.now()): Pick<AtlassianSignIn, 'refreshedAt' | 'until'> {
  return { refreshedAt: new Date(now).toISOString(), until: new Date(now + INACTIVE_MS).toISOString() };
}

/**
 * Keeps the sign-in: written whole to a new file of the person's only, then put in place. A link standing where the
 * file goes is replaced, never written through; a link standing as the folder is taken away first.
 */
export function writeAtlassianSignIn(s: AtlassianSignIn): void {
  const dir = readyPrivateFolder(ATLASSIAN_FOLDER);
  const tmp = path.join(dir, `.${FILE}.${randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(s, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, fileOf());
}

const LOCK = 'refresh.lock';
/** A refresh lock older than this was left by a squad-kit that stopped half-way: it is taken over. */
const STALE_MS = 30_000;
const flagsNew = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

function lockOwner(file: string): string {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Holds the refresh lock in squad-kit's Atlassian folder, so one squad-kit on this computer (the board, a terminal)
 * refreshes at a time: Atlassian rotates the refresh token, and two refreshes with the same one would leave one of
 * them refused. Waits up to `waitMs`; a lock older than 30 seconds is taken over. Gives the release, or null when the
 * lock could not be had in time.
 */
export async function holdRefreshLock(waitMs: number): Promise<(() => void) | null> {
  const file = path.join(readyPrivateFolder(ATLASSIAN_FOLDER), LOCK);
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, flagsNew, 0o600);
      try {
        fs.writeFileSync(fd, mine);
      } finally {
        fs.closeSync(fd);
      }
      // Only its own lock is taken away: not one taken over after it went stale, nor a new sign-in's folder.
      return () => {
        if (lockOwner(file) === mine) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const there = fs.lstatSync(file, { throwIfNoEntry: false });
      if (there && (!there.isFile() || Date.now() - there.mtimeMs > STALE_MS)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Empties squad-kit's Atlassian folder: Disconnect, or a sign-in Atlassian ended. A link there is removed, never followed. */
export function clearAtlassianFolder(): void {
  fs.rmSync(privateFolder(ATLASSIAN_FOLDER), { recursive: true, force: true });
}
