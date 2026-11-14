import { ModuleError } from '../errors.js';
import { atlassianReady } from './atlassian-app.js';
import { refreshAtlassian, saveAtlassianPair, unsavedAtlassianPair, type Refreshed } from './atlassian-refresh.js';
import { hostOf, readAtlassianEnded, readAtlassianSignIn, type AtlassianSite, type EndedWhy } from './atlassian-store.js';
import { forgetMissingScopes, type AtlassianCloud } from './client.js';

/**
 * The access token of squad-kit's Atlassian sign-in (ADR-012): in memory only, asked anew a few minutes before it ends
 * (about once an hour) through atlassian-refresh.ts. In those last minutes callers keep the token they have while the
 * refresh runs behind them; only a token really at its end makes them wait. Every caller shares one refresh on its way,
 * and Check again never starts a second one. The token belongs to the sign-in it came with: once the file holds another sign-in (a Disconnect,
 * a new sign-in in a terminal), it is dropped. Not reaching the helper or Atlassian is remembered a minute and never
 * signs out; Atlassian's own no does, in plain words.
 */

/** A refresh starts this long before the token ends, behind the callers. */
const EARLY_MS = 5 * 60_000;
/** Closer to its end than this, a token is not handed out: the caller waits for the new one. */
const LAST_MS = 30_000;
const FAILED_MS = 60_000;
/** A token Atlassian gave this recently is as new as it gets: a refusal then is about access, not age. */
const FRESH_MS = 60_000;

/** signed-out: no sign-in here. ended: Atlassian refused the refresh token. no-answer: not reached just now. */
type AtlassianAnswer = { ok: true; token: string } | { ok: false; why: 'signed-out' | 'ended' | 'no-answer' };
type Failed = Extract<AtlassianAnswer, { ok: false }>;

/** The token, until when it lasts, when it came, and the sign-in it belongs to. */
let access: { token: string; until: number; at: number; signIn: string } | null = null;
let failed: { at: number; answer: Failed } | null = null;
let asking: Promise<AtlassianAnswer> | null = null;
/** Moves on with every sign-in and sign-out here: a refresh begun before is never kept. Check again does not move it. */
let generation = 0;

/** A token Atlassian gave at sign-in, kept in memory for that sign-in until a few minutes before it ends. */
export function keepAccess(token: string, expiresIn: number | undefined, signIn: string): void {
  generation++;
  failed = null;
  forgetMissingScopes();
  const now = Date.now();
  access = { token, until: now + (Number(expiresIn) > 0 ? Number(expiresIn) : 3600) * 1000, at: now, signIn };
}

/** The access token: from memory while it lasts, else one refresh shared by every caller. */
export function atlassianToken(): Promise<AtlassianAnswer> {
  // A new pair that could not be written before: written now, behind the caller.
  if (unsavedAtlassianPair()) void saveAtlassianPair();
  // A token of another sign-in than the file's (a Disconnect, a new sign-in in a terminal) is never used.
  if (access && readAtlassianSignIn()?.signIn !== access.signIn) access = null;
  const left = access ? access.until - Date.now() : 0;
  if (access && left > EARLY_MS) return Promise.resolve({ ok: true, token: access.token });
  // In its last minutes: the token still works, and the new one comes behind the caller.
  if (access && left > LAST_MS) {
    if (!asking && !(failed && Date.now() - failed.at < FAILED_MS)) void refresh();
    return Promise.resolve({ ok: true, token: access.token });
  }
  if (failed && Date.now() - failed.at < FAILED_MS) return Promise.resolve(failed.answer);
  return asking ?? refresh();
}

/** The one refresh on its way, shared by every caller until it ends. */
function refresh(): Promise<AtlassianAnswer> {
  const asked = generation;
  const answer: Promise<AtlassianAnswer> = refreshAtlassian(() => asked === generation)
    .catch((): Refreshed => ({ ok: false, why: 'no-answer' }))
    .then((a): AtlassianAnswer | Promise<AtlassianAnswer> => {
      if (asking === answer) asking = null;
      // Signed in anew or out on the way: this answer is old. Ask again, for the sign-in there is now.
      if (asked !== generation || (!a.ok && a.why === 'stale')) return atlassianToken();
      if (a.ok) {
        access = { token: a.token, until: a.until, at: Date.now(), signIn: a.signIn };
        return { ok: true, token: a.token };
      }
      // Signed out or ended is never remembered: the file says so at once, and a new sign-in shows straight away.
      if (a.why === 'no-answer') failed = { at: Date.now(), answer: { ok: false, why: 'no-answer' } };
      // Ended by Atlassian, here or in another squad-kit on this computer: its marker says so.
      return { ok: false, why: a.why === 'stale' ? 'no-answer' : a.why === 'signed-out' && readAtlassianEnded() ? 'ended' : a.why };
    });
  asking = answer;
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

/** Signed out here: the token and the remembered failure go. A refresh on its way is left to end, and is not kept. */
export function forgetAtlassianTokens(): void {
  generation++;
  access = null;
  failed = null;
}

/** Check again: Atlassian is asked afresh after a failure. A token in memory and a refresh on its way stay. */
export function forgetAtlassianFailure(): void {
  failed = null;
}

/** Why Atlassian ended squad-kit's sign-in on this computer (here or in another squad-kit), until a sign-in or Disconnect. */
export function atlassianEnded(): EndedWhy | null {
  return readAtlassianEnded()?.why ?? null;
}

const AGAIN = 'Sign in with Atlassian on the Connections page (squad connect jira), or paste an API token in Settings.';

/** Why the sign-in ended, in plain words: the reason only. */
export function endedReason(why: EndedWhy | null): string {
  return why === 'lost'
    ? "squad-kit lost Atlassian's answer while renewing your sign-in, so Atlassian no longer takes it."
    : "Atlassian ended squad-kit's sign-in: it was not used for 90 days, or it was removed under Connected apps.";
}

/** The words for a call that has no token, by why. */
function noToken(why: Failed['why']): ModuleError {
  if (why === 'no-answer') return new ModuleError("Atlassian's sign-in could not be reached just now. Check the network; squad-kit tries again in a moment.", 'offline');
  if (why === 'ended') return new ModuleError(`${endedReason(atlassianEnded())} ${AGAIN}`, 'sign-in');
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
