import { writeLog } from '../../core/app-log.js';
import { ModuleError } from '../errors.js';
import { atlassianFetch, atlassianReady, helperUrl } from './atlassian-app.js';
import { clearAtlassianFolder, freshDates, hostOf, readAtlassianSignIn, writeAtlassianSignIn, type AtlassianSite } from './atlassian-store.js';
import type { AtlassianCloud } from './client.js';

/**
 * The access token of squad-kit's Atlassian sign-in (ADR-012): in memory only, asked anew through the sign-in helper a
 * few minutes before it ends (about once an hour). Atlassian rotates the refresh token on each refresh, so the new one
 * is written before the access token is used, and the file is read again right before each refresh, so two squad-kits
 * on one computer never send an old one. Atlassian's no to a refresh (revoked, or unused for 90 days) signs squad-kit
 * out, in plain words; not reaching the helper or Atlassian never does, and is remembered a minute.
 */

const EARLY_MS = 5 * 60_000;
const FAILED_MS = 60_000;
/** A token Atlassian gave this recently is as new as it gets: a refusal then is about access, not age. */
const FRESH_MS = 60_000;
const CALL_MS = 30_000;

/** signed-out: no sign-in here. ended: Atlassian refused the refresh token. no-answer: not reached just now. */
type AtlassianAnswer = { ok: true; token: string } | { ok: false; why: 'signed-out' | 'ended' | 'no-answer' };
type Failed = Extract<AtlassianAnswer, { ok: false }>;
type Refreshed = { ok: true; token: string; until: number } | Failed;

let access: { token: string; until: number; at: number } | null = null;
let failed: { at: number; answer: Failed } | null = null;
let asking: Promise<AtlassianAnswer> | null = null;
/** Moves on with every forget: a refresh on its way then is never kept. */
let generation = 0;
/** Atlassian ended the sign-in: said on the Connections page until the next sign-in or Disconnect. */
let ended = false;

/** What the helper passes back from Atlassian's token endpoint. */
interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** One call to the sign-in helper: Atlassian's status and JSON, or 'no-answer' (offline, the helper or Atlassian down). */
export async function askHelper(route: 'token' | 'refresh', body: Record<string, string>): Promise<{ status: number; reply: TokenReply } | 'no-answer'> {
  try {
    const res = await atlassianFetch()(helperUrl(route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_MS),
    });
    const text = await res.text();
    if (res.status >= 500 || res.status === 429 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
      writeLog({ level: 'warn', text: `The Atlassian sign-in helper answered HTTP ${res.status} to ${route}.` });
      return 'no-answer';
    }
    return { status: res.status, reply: JSON.parse(text) as TokenReply };
  } catch (err) {
    writeLog({ level: 'warn', text: `The Atlassian sign-in helper could not be reached for ${route}: ${(err as Error).name}` });
    return 'no-answer';
  }
}

/** A token Atlassian gave now, kept in memory until a few minutes before it ends. A new sign-in starts afresh. */
export function keepAccess(token: string, expiresIn: number | undefined): void {
  forgetAtlassianTokens();
  ended = false;
  const now = Date.now();
  access = { token, until: now + (Number(expiresIn) > 0 ? Number(expiresIn) : 3600) * 1000, at: now };
}

async function refresh(again = true): Promise<Refreshed> {
  const saved = readAtlassianSignIn();
  if (!saved) return { ok: false, why: ended ? 'ended' : 'signed-out' };
  const a = await askHelper('refresh', { refresh_token: saved.refreshToken });
  if (a === 'no-answer') return { ok: false, why: 'no-answer' };
  const { access_token: token, refresh_token: next, expires_in: secs } = a.reply;
  // Signed out while the helper was asked (Disconnect): nothing is written back.
  const now = readAtlassianSignIn();
  if (!now) return { ok: false, why: ended ? 'ended' : 'signed-out' };
  if (a.status === 200 && token && next) {
    // The new refresh token first: Atlassian has already stopped the old one.
    writeAtlassianSignIn({ ...now, refreshToken: next, ...freshDates() });
    return { ok: true, token, until: Date.now() + (Number(secs) > 0 ? Number(secs) : 3600) * 1000 };
  }
  // Only Atlassian's own no to the refresh token signs squad-kit out; the helper's own trouble never does.
  if (a.reply.error !== 'invalid_grant') {
    writeLog({ level: 'warn', text: `The Atlassian sign-in helper answered HTTP ${a.status} (${a.reply.error ?? 'no code'}) to a refresh.` });
    return { ok: false, why: 'no-answer' };
  }
  // Another squad-kit on this computer may have just refreshed it: then its new one is tried, once.
  if (again && now.refreshToken !== saved.refreshToken) return refresh(false);
  writeLog({ level: 'warn', text: `Atlassian refused squad-kit's refresh token (HTTP ${a.status}, invalid_grant): signed out.` });
  clearAtlassianFolder();
  ended = true;
  return { ok: false, why: 'ended' };
}

/** The access token, from memory while it has more than a few minutes left, else a refresh shared by every caller. */
export function atlassianToken(): Promise<AtlassianAnswer> {
  if (access && Date.now() < access.until - EARLY_MS) return Promise.resolve({ ok: true, token: access.token });
  if (failed && Date.now() - failed.at < FAILED_MS) return Promise.resolve(failed.answer);
  if (asking) return asking;
  const asked = generation;
  const answer: Promise<AtlassianAnswer> = refresh()
    .catch((err: unknown): Refreshed => {
      writeLog({ level: 'warn', text: `squad-kit could not keep its Atlassian sign-in: ${(err as Error).message}` });
      return { ok: false, why: 'no-answer' };
    })
    .then((a) => {
      // Forgotten on the way (a sign-in, a sign-out, Check again): this answer is old. Ask again.
      if (asked !== generation) {
        if (asking === answer) asking = null;
        return atlassianToken();
      }
      if (a.ok) {
        access = { token: a.token, until: a.until, at: Date.now() };
        return { ok: true, token: a.token };
      }
      // Signed out or ended is never remembered: the file says so at once, and a new sign-in shows straight away.
      if (a.why === 'no-answer') failed = { at: Date.now(), answer: a };
      return a;
    });
  asking = answer;
  const clean = () => {
    if (asking === answer) asking = null;
  };
  answer.then(clean, clean);
  return answer;
}

/**
 * Jira refused this token. True when one more try with a new one is worth it: that token, and only it, is dropped. A
 * token under a minute old is as new as it gets: the refusal is about access, and nothing is tried again.
 */
function refusedAtlassianToken(token: string): boolean {
  if (access?.token !== token) return true;
  if (Date.now() - access.at < FRESH_MS) return false;
  access = null;
  return true;
}

/** Forget the token, the remembered failure and a refresh on its way: a sign-in, a sign-out, Check again. */
export function forgetAtlassianTokens(): void {
  generation++;
  access = null;
  failed = null;
  asking = null;
}

/** Disconnect: the person chose it, so nothing is said about an ended sign-in. */
export function forgetAtlassianEnded(): void {
  ended = false;
}

/** Atlassian ended squad-kit's sign-in since this squad-kit started. */
export function atlassianEnded(): boolean {
  return ended && !readAtlassianSignIn();
}

const AGAIN = 'Sign in with Atlassian on the Connections page (squad connect jira), or paste an API token in Settings.';

/** The words for a call that has no token, by why. */
function noToken(why: Failed['why']): ModuleError {
  if (why === 'no-answer') return new ModuleError("Atlassian's sign-in could not be reached just now. Check the network; squad-kit tries again in a moment.", 'offline');
  if (why === 'ended') return new ModuleError(`Atlassian ended squad-kit's sign-in: it was not used for 90 days, or it was removed. ${AGAIN}`, 'sign-in');
  return new ModuleError(`squad-kit is not signed in with Atlassian. ${AGAIN}`, 'sign-in');
}

/** The site among those Atlassian gave, by its host. */
export function grantedSite(sites: AtlassianSite[], host: string): AtlassianSite | undefined {
  return sites.find((x) => hostOf(x.url) === host);
}

/**
 * The sign-in for one Jira site, when squad-kit's Atlassian sign-in covers it: who, and the cloud access the Jira client
 * calls api.atlassian.com with. Null when the app is not registered yet, nobody is signed in, or the site was not given.
 */
export function atlassianCloud(host: string): { who: string; cloud: AtlassianCloud } | null {
  if (!atlassianReady()) return null;
  const s = readAtlassianSignIn();
  const site = s ? grantedSite(s.sites, host) : undefined;
  if (!s || !site) return null;
  return {
    who: s.account?.name ?? 'your Atlassian account',
    cloud: {
      id: site.id,
      bearer: async () => {
        const a = await atlassianToken();
        if (!a.ok) throw noToken(a.why);
        return a.token;
      },
      refused: refusedAtlassianToken,
    },
  };
}

/** The site squad-kit's Atlassian sign-in chose (or the only one it has), for a project with no Jira site yet. */
export function atlassianSiteHost(): string | undefined {
  if (!atlassianReady()) return undefined;
  const s = readAtlassianSignIn();
  const site = s?.sites.find((x) => x.id === s.site) ?? (s?.sites.length === 1 ? s.sites[0] : undefined);
  return site ? hostOf(site.url) : undefined;
}

/** The other way, for a site with no token here: sign in, or sign in again for a site the sign-in does not cover. */
export function orSignIn(site: string): string {
  return readAtlassianSignIn()
    ? `squad-kit's Atlassian sign-in does not cover ${site}: sign in again on the Connections page and pick ${site} on Atlassian's page.`
    : 'Or Sign in with Atlassian on the Connections page.';
}
