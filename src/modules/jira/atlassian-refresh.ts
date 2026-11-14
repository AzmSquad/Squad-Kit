import { writeLog } from '../../core/app-log.js';
import { atlassianFetch, atlassianPace, helperUrl } from './atlassian-app.js';
import { clearAtlassianFolder, freshDates, holdRefreshLock, readAtlassianSignIn, writeAtlassianSignIn } from './atlassian-store.js';

/**
 * One refresh of squad-kit's Atlassian sign-in, through the sign-in helper (ADR-012). Atlassian rotates the refresh
 * token each time and stops the old one, so: one refresh at a time on this computer (a lock file in squad-kit's folder,
 * shared by the board and every terminal), the file read again once the lock is held (another squad-kit may have just
 * written a newer pair), and the new pair written back only while the file still holds the token that was sent and the
 * sign-in has not changed. Only Atlassian's own no signs squad-kit out, and only when, a moment later, the file still
 * holds the token it refused.
 */

/** Short of the lock's 30 seconds, so a refresh never outlives the lock it holds. */
const CALL_MS = 20_000;

/** What the helper passes back from Atlassian's token endpoint. */
interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * signed-out: no sign-in here (or it went while the helper was asked). ended: Atlassian refused the refresh token.
 * no-answer: the helper or Atlassian was not reached just now. stale: the sign-in changed on the way (a Disconnect, a
 * new sign-in): this answer is not kept.
 */
export type Refreshed = { ok: true; token: string; until: number; signIn: string } | { ok: false; why: 'signed-out' | 'ended' | 'no-answer' | 'stale' };

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

const seconds = (s: number | undefined) => (Number(s) > 0 ? Number(s) : 3600) * 1000;

/** The refresh itself, with the lock held. `again`: one more try when another squad-kit wrote a newer pair meanwhile. */
async function held(stillMine: () => boolean, again: boolean): Promise<Refreshed> {
  const sent = readAtlassianSignIn();
  if (!sent) return { ok: false, why: 'signed-out' };
  const a = await askHelper('refresh', { refresh_token: sent.refreshToken });
  if (a === 'no-answer') return { ok: false, why: 'no-answer' };
  const now = readAtlassianSignIn();
  // Disconnected, or signed in anew, while the helper was asked: nothing is written back over it.
  if (!now) return { ok: false, why: 'signed-out' };
  if (now.signIn !== sent.signIn || !stillMine()) return { ok: false, why: 'stale' };
  const { access_token: token, refresh_token: next, expires_in: secs } = a.reply;
  if (a.status === 200 && token && next) {
    if (now.refreshToken !== sent.refreshToken) return again ? held(stillMine, false) : { ok: false, why: 'no-answer' };
    // The new refresh token first: Atlassian has already stopped the old one.
    writeAtlassianSignIn({ ...now, refreshToken: next, ...freshDates() });
    return { ok: true, token, until: Date.now() + seconds(secs), signIn: now.signIn };
  }
  // Only Atlassian's own no to the refresh token signs squad-kit out; the helper's own trouble never does.
  if (a.reply.error !== 'invalid_grant') {
    writeLog({ level: 'warn', text: `The Atlassian sign-in helper answered HTTP ${a.status} (${a.reply.error ?? 'no code'}) to a refresh.` });
    return { ok: false, why: 'no-answer' };
  }
  // Another squad-kit may have refreshed it just before (a lock taken over): a moment, then the file again.
  await new Promise((r) => setTimeout(r, atlassianPace().settleMs));
  const later = readAtlassianSignIn();
  if (!later || later.signIn !== sent.signIn || !stillMine()) return { ok: false, why: later ? 'stale' : 'signed-out' };
  if (later.refreshToken !== sent.refreshToken) return again ? held(stillMine, false) : { ok: false, why: 'no-answer' };
  writeLog({ level: 'warn', text: `Atlassian refused squad-kit's refresh token (HTTP ${a.status}, invalid_grant): signed out.` });
  clearAtlassianFolder();
  return { ok: false, why: 'ended' };
}

/**
 * A new access token from the sign-in kept on this computer. `stillMine`: false once this squad-kit signed in anew or
 * out since the refresh began, so its answer is dropped.
 */
export async function refreshAtlassian(stillMine: () => boolean): Promise<Refreshed> {
  if (!readAtlassianSignIn()) return { ok: false, why: 'signed-out' };
  const release = await holdRefreshLock(atlassianPace().lockWaitMs);
  if (!release) {
    writeLog({ level: 'warn', text: 'Another squad-kit on this computer held the Atlassian refresh too long.' });
    return { ok: false, why: 'no-answer' };
  }
  try {
    return await held(stillMine, true);
  } finally {
    release();
  }
}
