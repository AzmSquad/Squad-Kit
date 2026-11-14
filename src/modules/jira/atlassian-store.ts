import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateFolder, readyPrivateFolder } from '../../core/home.js';

/**
 * squad-kit's own Atlassian sign-in on this computer (ADR-012), in its own private folder (`~/.squad-kit/atlassian`),
 * which agents never reach: the refresh token, the Jira sites Atlassian gave, the account's name, and when the refresh
 * token ends if unused. The access token is never here: it lives in memory only (atlassian-token.ts). The file is the
 * person's only (0600), written whole and never followed through a link. When Atlassian ends the sign-in, a small
 * marker says why and when, so every squad-kit on this computer can say so; Disconnect takes everything away.
 */

export const ATLASSIAN_FOLDER = 'atlassian';
const FILE = 'sign-in.json';
const ENDED = 'ended.json';
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
  /**
   * When a refresh was sent with this refresh token, until its answer is kept. Still here at the next refresh: that
   * answer was lost (Atlassian may have already stopped this token).
   */
  renewing?: string;
}

/** Why Atlassian ended the sign-in: it refused the token (unused 90 days, removed), or squad-kit lost a renewal's answer. */
export type EndedWhy = 'refused' | 'lost';

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
      ...(typeof j.renewing === 'string' ? { renewing: j.renewing } : {}),
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

/** A rename Windows refuses for a moment (another program has the file open), or a full disk: tried again. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRIES = [20, 60, 150, 400];

/** Waits without giving way: only between the few tries of a rename refused for a moment. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A file in squad-kit's Atlassian folder, written whole to a new file of the person's only, then put in place. A link
 * standing where the file goes is replaced, never written through; a link standing as the folder is taken away first.
 * The new file never stays behind, written or not.
 */
function writeWhole(name: string, data: unknown): void {
  const dir = readyPrivateFolder(ATLASSIAN_FOLDER);
  const tmp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tmp, flags, 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    for (let i = 0; ; i += 1) {
      try {
        fs.renameSync(tmp, path.join(dir, name));
        return;
      } catch (err) {
        if (!BUSY.has((err as NodeJS.ErrnoException).code ?? '') || i >= TRIES.length) throw err;
        pause(TRIES[i]!);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Keeps the sign-in. Signed in again: the marker of an ended sign-in goes. */
export function writeAtlassianSignIn(s: AtlassianSignIn): void {
  writeWhole(FILE, s);
  fs.rmSync(path.join(privateFolder(ATLASSIAN_FOLDER), ENDED), { force: true });
}

/** Atlassian ended the sign-in: it goes, and a marker says why and when, for every squad-kit on this computer. */
export function endAtlassianSignIn(why: EndedWhy): void {
  fs.rmSync(fileOf(), { force: true });
  writeWhole(ENDED, { why, at: new Date().toISOString() });
}

/** Why and when Atlassian ended the sign-in, while nobody has signed in again or disconnected. */
export function readAtlassianEnded(): { why: EndedWhy; at: string } | null {
  if (readAtlassianSignIn()) return null;
  const dir = fs.lstatSync(privateFolder(ATLASSIAN_FOLDER), { throwIfNoEntry: false });
  const file = path.join(privateFolder(ATLASSIAN_FOLDER), ENDED);
  if (!dir?.isDirectory() || !fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { why?: unknown; at?: unknown };
    return j.why === 'refused' || j.why === 'lost' ? { why: j.why, at: String(j.at ?? '') } : null;
  } catch {
    return null;
  }
}

/** Empties squad-kit's Atlassian folder: Disconnect. A link there is removed, never followed. */
export function clearAtlassianFolder(): void {
  fs.rmSync(privateFolder(ATLASSIAN_FOLDER), { recursive: true, force: true });
}
