import { randomBytes } from 'node:crypto';
import { writeLog } from '../../core/app-log.js';
import type { SignInFlow } from '../connection/types.js';
import { GATEWAY, atlassianFetch, atlassianPace, authorizeUrl } from './atlassian-app.js';
import { holdRefreshLock } from './atlassian-lock.js';
import { openDoor, type Door, type DoorAnswer } from './atlassian-loopback.js';
import { askHelper } from './atlassian-refresh.js';
import { clearAtlassianFolder, freshDates, hostOf, newSignInId, readAtlassianSignIn, siteFrom, writeAtlassianSignIn, type AtlassianSite } from './atlassian-store.js';
import { forgetAtlassianTokens, grantedSite, keepAccess } from './atlassian-token.js';

/**
 * "Sign in with Atlassian" (ADR-012). squad-kit opens a one-shot door on 127.0.0.1 and gives the link to Atlassian's
 * page, where the person picks their Jira site and presses Accept; squad-kit opens no window. The answer comes back
 * through the sign-in helper to that door. The code goes to the helper for the first pair, then Atlassian says which
 * Jira sites it gave. The project's own site is used when it has one; else one site is used, and several are picked from.
 */

interface Running extends SignInFlow {
  door?: Door;
}

let flow: Running | null = null;

const shown = (f: Running): SignInFlow => {
  const { door: _door, ...rest } = f;
  return rest;
};

/** The project's site was not among those Atlassian gave. */
export const notGranted = (site: string, got: AtlassianSite[]) =>
  `Atlassian did not give squad-kit access to ${site}, this project's Jira site${got.length ? ` (it gave ${got.map((s) => hostOf(s.url)).join(', ')})` : ''}. Sign in with Atlassian again and pick ${site} on Atlassian's page.`;
const PICK = "Signed in. Pick this project's Jira site on the Connections page.";
const NO_SITE = "Atlassian gave squad-kit no Jira site. Sign in again, and pick your Jira site on Atlassian's page before you press Accept.";
const NOT_REACHED = "squad-kit's sign-in helper or Atlassian could not be reached just now. Check the network, then try again.";

/** The Jira sites the new token reaches, from Atlassian's accessible-resources. The token goes only to Atlassian's gateway. */
async function sitesOf(token: string): Promise<AtlassianSite[] | null> {
  try {
    const res = await atlassianFetch()(`${GATEWAY}/oauth/token/accessible-resources`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as { id?: unknown; url?: unknown; name?: unknown; scopes?: unknown }[];
    if (!Array.isArray(list)) return null;
    // Only Jira's: a site given for another Atlassian product has no Jira scope.
    const jira = list.filter((r) => Array.isArray(r.scopes) && r.scopes.some((s) => typeof s === 'string' && s.includes('jira')));
    return jira.map((r) => siteFrom(r)).filter((s): s is AtlassianSite => Boolean(s));
  } catch {
    return null;
  }
}

/** Who signed in, as Jira on that site says. Nothing when it does not answer: the name is only for people. */
async function accountOn(site: AtlassianSite, token: string): Promise<{ id: string; name: string } | undefined> {
  try {
    const res = await atlassianFetch()(`${GATEWAY}/ex/jira/${site.id}/rest/api/3/myself`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const me = res.ok ? ((await res.json()) as { accountId?: string; displayName?: string }) : {};
    return me.accountId && me.displayName ? { id: me.accountId, name: me.displayName } : undefined;
  } catch {
    return undefined;
  }
}

const fail = (f: Running, line: string) => Object.assign(f, { state: 'failed' as const, line });

/** Atlassian's answer at the door: the code becomes a sign-in kept on this computer, or a plain failure. */
async function finish(f: Running, a: DoorAnswer, projectSite: string | undefined, done: () => void): Promise<void> {
  if (f.state !== 'waiting') return;
  if ('error' in a) {
    fail(f, a.error === 'access_denied' ? "You pressed Cancel on Atlassian's page. Nothing changed." : `Atlassian did not finish the sign-in (${a.error}). Try again.`);
    return;
  }
  const got = await askHelper('token', { code: a.code });
  if (f.state !== 'waiting') return;
  if (got === 'no-answer' || got === 'unsent') return void fail(f, NOT_REACHED);
  const { access_token: token, refresh_token: refresh, expires_in: secs, error_description: why } = got.reply;
  if (got.status !== 200 || !token) return void fail(f, `Atlassian did not accept the sign-in${why ? `: ${why.slice(0, 160).replace(/\.$/, '')}` : ''}. Try again.`);
  if (!refresh) return void fail(f, 'Atlassian gave squad-kit no lasting sign-in. Try again.');
  const sites = await sitesOf(token);
  if (f.state !== 'waiting') return;
  if (!sites) return void fail(f, NOT_REACHED);
  if (!sites.length) return void fail(f, NO_SITE);
  // The project's own site first; else the site chosen before when it is still given; else the only one.
  const before = readAtlassianSignIn()?.site;
  const own = projectSite ? grantedSite(sites, projectSite) : undefined;
  const chosen = own ?? sites.find((s) => s.id === before) ?? (sites.length === 1 ? sites[0] : undefined);
  const account = await accountOn(chosen ?? sites[0]!, token);
  if (f.state !== 'waiting') return;
  const signIn = newSignInId();
  // Never in the middle of another squad-kit's refresh of an older sign-in: it writes the same file.
  await underLock(() => {
    if (f.state !== 'waiting') return;
    writeAtlassianSignIn({ signIn, refreshToken: refresh, sites, ...(chosen ? { site: chosen.id } : {}), ...(account ? { account } : {}), ...freshDates() });
    keepAccess(token, secs, signIn);
  });
  if (f.state !== 'waiting') return;
  done();
  if (projectSite && !own) return void fail(f, notGranted(projectSite, sites));
  Object.assign(f, { state: 'done', ...(account ? { account: account.name } : {}), ...(chosen ? {} : { line: PICK }) });
}

/** Opens the door and gives the link. Cancelled while the door opened: the door closes at once. */
async function open(projectSite: string | undefined, done: () => void): Promise<SignInFlow> {
  const f: Running = { state: 'waiting', startedAt: new Date().toISOString() };
  flow = f;
  const nonce = randomBytes(32).toString('base64url');
  let door: Door;
  try {
    door = await openDoor(nonce, atlassianPace().lifeMs);
  } catch (err) {
    writeLog({ level: 'warn', text: `squad-kit could not open its sign-in door on 127.0.0.1: ${(err as Error).message}` });
    return shown(fail(f, 'squad-kit could not wait for Atlassian’s answer on this computer. Try again.'));
  }
  f.door = door;
  if (f.state !== 'waiting') {
    door.close();
    return shown(f);
  }
  f.url = authorizeUrl(`${door.port}.${nonce}`);
  void door.answer.then(async (a) => {
    if (!a) {
      if (f.state === 'waiting') fail(f, 'The sign-in waited 15 minutes. Try again.');
      return;
    }
    await finish(f, a, projectSite, done).catch((err: unknown) => {
      writeLog({ level: 'warn', text: `Sign in with Atlassian did not finish: ${(err as Error).message}` });
      if (f.state === 'waiting') fail(f, 'squad-kit could not keep the sign-in on this computer. Try again.');
    });
  });
  return shown(f);
}

let starting: Promise<SignInFlow> | null = null;

/**
 * Starts the sign-in: the door, then the link to Atlassian's page. One at a time: a second start, even one that comes
 * while the door is still opening, shows the first.
 */
export function startAtlassianSignIn(projectSite: string | undefined, done: () => void): Promise<SignInFlow> {
  if (starting) return starting;
  if (flow?.state === 'waiting' && flow.door) return Promise.resolve(shown(flow));
  starting = open(projectSite, done).finally(() => (starting = null));
  return starting;
}

/** Cancel: closes the door. A code already on its way is not kept. */
export function cancelAtlassianSignIn(): SignInFlow | null {
  if (!flow) return null;
  if (flow.state === 'waiting') flow.state = 'cancelled';
  flow.door?.close();
  return shown(flow);
}

export function atlassianSignInNow(): SignInFlow | null {
  return flow ? shown(flow) : null;
}

/**
 * Runs a change of the sign-in file with the lock held, so it never lands in the middle of a refresh. Not had in time
 * (a refresh hanging on a slow network): it runs all the same, as the person asked for it.
 */
async function underLock(change: () => void): Promise<void> {
  const release = await holdRefreshLock(atlassianPace().lockWaitMs).catch(() => null);
  try {
    change();
  } finally {
    release?.();
  }
}

/**
 * Signs squad-kit out of Atlassian on this computer: a sign-in still waiting stops, and squad-kit's Atlassian folder
 * is emptied, with the lock held, so a refresh on its way finishes first and never writes the sign-in back. No call
 * goes out, so it works offline; Atlassian's Connected apps page takes the app's access away.
 */
export async function signOutOfAtlassian(): Promise<void> {
  cancelAtlassianSignIn();
  await underLock(clearAtlassianFolder);
  forgetAtlassianTokens();
}

/** A test starts afresh. */
export function forgetAtlassianFlow(): void {
  flow?.door?.close();
  flow = null;
}
