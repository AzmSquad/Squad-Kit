import { ModuleError } from '../errors.js';
import { azAccounts, runAz, signInRefused } from './az.js';
import { isTenant, orgTenant } from './tenant.js';

/**
 * The token for Azure DevOps from squad-kit's own Microsoft sign-in (ADR-011): asked of az, kept in memory only, until a
 * few minutes before it ends. It is never written to a file, never on a command line, and never in a log, a REST answer
 * or the board. Microsoft's tokens last about an hour, so az is asked about once an hour. A request that failed is
 * remembered a minute, so being offline or on the wrong account does not start az again on every call.
 */

/** Azure DevOps' own resource id, as Microsoft's docs give it for `az account get-access-token`. */
export const DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** Asked again this long before the token ends, so a push never starts with one about to end. */
const EARLY_MS = 5 * 60_000;
/** A failed request is answered from memory this long. */
const FAILED_MS = 60_000;
/** A token az gave this recently is as fresh as az can make it: a refusal then is about access, not age. */
const FRESH_MS = 60_000;

export type TokenAnswer =
  | { ok: true; token: string; until: number }
  /**
   * missing: no az. signed-out: squad-kit is not signed in. refused: signed in, but Microsoft gives no token for this
   * directory. no-answer: Microsoft or az could not be reached just now (offline, a proxy, an outage).
   */
  | { ok: false; why: 'missing' | 'signed-out' | 'refused' | 'no-answer' };

type Failed = Extract<TokenAnswer, { ok: false }>;

/** Each directory's token, until when it lasts, and when az gave it. */
const tokens = new Map<string, { token: string; until: number; at: number }>();
const failed = new Map<string, { at: number; answer: Failed }>();
const asking = new Map<string, Promise<TokenAnswer>>();
/** Moves on with every forget: a request already on its way when it was forgotten is never kept. */
let generation = 0;

/** When the token ends: `expires_on` (seconds), else `expiresOn` (this computer's local time), else in half an hour. */
function untilOf(j: { expires_on?: number | string; expiresOn?: string }): number {
  const secs = Number(j.expires_on);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const local = j.expiresOn ? Date.parse(j.expiresOn.replace(' ', 'T')) : NaN;
  return Number.isFinite(local) ? local : Date.now() + 30 * 60_000;
}

async function ask(tenant: string | undefined): Promise<TokenAnswer> {
  const a = await runAz(['account', 'get-access-token', '--resource', DEVOPS_RESOURCE, ...(tenant ? ['--tenant', tenant] : []), '--output', 'json']);
  if (a === 'missing' || a === 'no-answer') return { ok: false, why: a };
  if (a.code !== 0) {
    if (!azAccounts().length) return { ok: false, why: 'signed-out' };
    // Only Microsoft's own no is a sign-in problem; anything else (offline, a proxy) may pass by itself.
    return { ok: false, why: signInRefused(a.err) ? 'refused' : 'no-answer' };
  }
  try {
    const j = JSON.parse(a.out) as { accessToken?: string; expires_on?: number | string; expiresOn?: string };
    if (!j.accessToken) return { ok: false, why: 'no-answer' };
    return { ok: true, token: j.accessToken, until: untilOf(j) };
  } catch {
    return { ok: false, why: 'no-answer' };
  }
}

const keyOf = (tenant?: string) => (tenant && isTenant(tenant) ? tenant : '');

/** A token for this directory (or az's own default one), from memory while it has more than a few minutes left. */
export function microsoftToken(tenant?: string): Promise<TokenAnswer> {
  const key = keyOf(tenant);
  const t = tokens.get(key);
  if (t && Date.now() < t.until - EARLY_MS) return Promise.resolve({ ok: true, token: t.token, until: t.until });
  const no = failed.get(key);
  if (no && Date.now() - no.at < FAILED_MS) return Promise.resolve(no.answer);
  const now = asking.get(key);
  if (now) return now;
  const asked = generation;
  const answer: Promise<TokenAnswer> = ask(key || undefined).then((a) => {
    // Forgotten on the way (a sign-in, a sign-out, a refused token): this answer is old. Ask again.
    if (asked !== generation) return microsoftToken(tenant);
    if (a.ok) tokens.set(key, { token: a.token, until: a.until, at: Date.now() });
    // Not signed in is never remembered: the profile file says so at once, and a new sign-in shows straight away.
    else if (a.why !== 'signed-out') failed.set(key, { at: Date.now(), answer: a });
    return a;
  });
  asking.set(key, answer);
  const clean = () => {
    if (asking.get(key) === answer) asking.delete(key);
  };
  answer.then(clean, clean);
  return answer;
}

/**
 * Azure DevOps refused this token for this directory. True when one more try is worth it: the token was kept a while
 * (it may have ended early on Microsoft's side), so that one token, and only it, is dropped and the next call asks az.
 * A token az gave under a minute ago is as new as az makes it: the refusal is about access, and nothing is retried.
 */
function refusedToken(tenant: string | undefined, token: string): boolean {
  const key = keyOf(tenant);
  const t = tokens.get(key);
  if (t?.token !== token) return true;
  if (Date.now() - t.at < FRESH_MS) return false;
  tokens.delete(key);
  return true;
}

/** Forget every token and every failure, and any request on its way: after a sign-in, a sign-out, or a refused token. */
export function forgetMicrosoftTokens(): void {
  generation++;
  tokens.clear();
  failed.clear();
  asking.clear();
}

/** Signed in with Microsoft here: squad-kit's own az has an account. A file read, never an az run. */
export function signedInWithMicrosoft(): boolean {
  return azAccounts().length > 0;
}

const AGAIN = 'Sign in with Microsoft again on the Connections page (squad connect azure), or paste a token in Settings.';

/** The words when an organization is backed by personal Microsoft accounts. */
export const personalOrg = (org: string) => `This organization, ${org}, uses personal Microsoft accounts, so it needs a token. Paste one in Settings.`;
/** The same, when a sign-in was asked for: why it cannot work first, then what to do. */
export const personalOrgSignIn = (org: string) => `This organization, ${org}, uses personal Microsoft accounts, so Sign in with Microsoft cannot reach it. It needs a token: paste one in Settings.`;

/** The words for a call that has no token, by why. */
function noToken(org: string, why: Failed['why'] | 'personal'): ModuleError {
  if (why === 'no-answer') return new ModuleError("Microsoft's sign-in could not be reached just now. Check the network; squad-kit tries again in a moment.", 'offline');
  if (why === 'personal') return new ModuleError(personalOrg(org), 'sign-in');
  if (why === 'missing') return new ModuleError("Microsoft's Azure tool, az, is not on this computer any more. Install it from the Tools page, or paste a token in Settings.", 'sign-in');
  return new ModuleError(`squad-kit has no Microsoft sign-in for ${org}. ${AGAIN}`, 'sign-in');
}

/** The directory az is asked about for an organization: its own when Azure DevOps says which, else az's default. */
async function tenantFor(org: string): Promise<string | undefined> {
  const t = await orgTenant(org);
  return t.kind === 'entra' ? t.tenant : undefined;
}

/** Azure DevOps refused this token for this organization: whether one more try with a new one is worth it. */
export async function refusedFor(org: string, token: string): Promise<boolean> {
  return refusedToken(await tenantFor(org), token);
}

/** The token for one organization: its own directory's when Azure DevOps says which, else az's default one. */
export async function bearerFor(org: string): Promise<string> {
  const t = await orgTenant(org);
  if (t.kind === 'personal') throw noToken(org, 'personal');
  const a = await microsoftToken(t.kind === 'entra' ? t.tenant : undefined);
  if (!a.ok) throw noToken(org, a.why);
  return a.token;
}
