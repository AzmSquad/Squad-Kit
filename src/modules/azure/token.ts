import { ModuleError } from '../errors.js';
import { azAccounts, runAz } from './az.js';
import { isTenant, orgTenant } from './tenant.js';

/**
 * The token for Azure DevOps from squad-kit's own Microsoft sign-in (ADR-011): asked of az, kept in memory only, until a
 * few minutes before it ends. It is never written to a file, never on a command line, and never in a log, a REST answer
 * or the board. Microsoft's tokens last about an hour, so az is asked about once an hour.
 */

/** Azure DevOps' own resource id, as Microsoft's docs give it for `az account get-access-token`. */
export const DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** Asked again this long before the token ends, so a push never starts with one about to end. */
const EARLY_MS = 5 * 60_000;

export type TokenAnswer =
  | { ok: true; token: string; until: number }
  /** missing: no az. signed-out: squad-kit is not signed in. refused: signed in, but no token for this directory. */
  | { ok: false; why: 'missing' | 'signed-out' | 'refused' | 'no-answer' };

const tokens = new Map<string, { token: string; until: number }>();
const asking = new Map<string, Promise<TokenAnswer>>();

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
  if (a.code !== 0) return { ok: false, why: azAccounts().length ? 'refused' : 'signed-out' };
  try {
    const j = JSON.parse(a.out) as { accessToken?: string; expires_on?: number | string; expiresOn?: string };
    if (!j.accessToken) return { ok: false, why: 'refused' };
    const t = { token: j.accessToken, until: untilOf(j) };
    tokens.set(tenant ?? '', t);
    return { ok: true, ...t };
  } catch {
    return { ok: false, why: 'no-answer' };
  }
}

/** A token for this directory (or az's own default one), from memory while it has more than a few minutes left. */
export function microsoftToken(tenant?: string): Promise<TokenAnswer> {
  const key = tenant && isTenant(tenant) ? tenant : '';
  const t = tokens.get(key);
  if (t && Date.now() < t.until - EARLY_MS) return Promise.resolve({ ok: true, ...t });
  const now = asking.get(key);
  if (now) return now;
  const answer = ask(key || undefined).finally(() => asking.delete(key));
  asking.set(key, answer);
  return answer;
}

/** Forget every token: after a sign-in, a sign-out, or Azure DevOps refusing one. */
export function forgetMicrosoftTokens(): void {
  tokens.clear();
}

/** Signed in with Microsoft here: squad-kit's own az has an account. A file read, never an az run. */
export function signedInWithMicrosoft(): boolean {
  return azAccounts().length > 0;
}

const AGAIN = 'Sign in with Microsoft again on the Connections page (squad connect azure), or paste a token in Settings.';

/** The words for a call that has no token, by why. */
function noToken(org: string, why: Exclude<TokenAnswer, { ok: true }>['why'] | 'personal'): ModuleError {
  if (why === 'no-answer') return new ModuleError("Microsoft's sign-in did not answer just now. squad-kit tries again in a moment.", 'offline');
  if (why === 'personal') return new ModuleError(`${org} is not on Microsoft Entra, so it needs a token. Paste one in Settings.`, 'sign-in');
  if (why === 'missing') return new ModuleError("Microsoft's Azure tool, az, is not on this computer any more. Install it from the Tools page, or paste a token in Settings.", 'sign-in');
  return new ModuleError(`squad-kit has no Microsoft sign-in for ${org}. ${AGAIN}`, 'sign-in');
}

/** The token for one organization: its own directory's when Azure DevOps says which, else az's default one. */
export async function bearerFor(org: string): Promise<string> {
  const t = await orgTenant(org);
  if (t.kind === 'personal') throw noToken(org, 'personal');
  const a = await microsoftToken(t.kind === 'entra' ? t.tenant : undefined);
  if (!a.ok) throw noToken(org, a.why);
  return a.token;
}
