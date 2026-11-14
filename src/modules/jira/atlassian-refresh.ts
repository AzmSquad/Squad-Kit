import { writeLog } from '../../core/app-log.js';
import { atlassianFetch, atlassianPace, helperUrl } from './atlassian-app.js';
import { holdRefreshLock } from './atlassian-lock.js';
import { endAtlassianSignIn, freshDates, readAtlassianSignIn, writeAtlassianSignIn } from './atlassian-store.js';

/**
 * One refresh of squad-kit's Atlassian sign-in, through the sign-in helper (ADR-012). Atlassian rotates the refresh
 * token each time and stops the old one, so:
 * - one refresh at a time on this computer (atlassian-lock.ts), and the file read again once the lock is held: another
 *   squad-kit may have just written a newer pair;
 * - a mark in the file before the helper is asked ("renewing"), so a lost answer is known later;
 * - the new pair written back only while the file still holds the token that was sent, for the same sign-in; when the
 *   file cannot be written, the pair is kept in memory, used, and written at the next call;
 * - only Atlassian's own no signs squad-kit out, and only when, a moment later, the file still holds the token it
 *   refused. A marker then says why, for every squad-kit on this computer.
 */

/** A slow network gets a full minute; the lock is taken over only after minutes, so a refresh never outlives it. */
const CALL_MS = 60_000;

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

/** The network never got the request out: no connection was made. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

/**
 * One call to the sign-in helper: Atlassian's status and JSON; 'unsent' when the request surely never reached Atlassian
 * (no connection, or the helper itself said no before asking it); 'no-answer' when it may have (a timeout, a cut
 * connection, Atlassian's own trouble).
 */
export async function askHelper(route: 'token' | 'refresh', body: Record<string, string>): Promise<{ status: number; reply: TokenReply } | 'no-answer' | 'unsent'> {
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
      // 502: Atlassian was asked but its answer did not come through; the rest never reached it.
      return res.status === 502 ? 'no-answer' : 'unsent';
    }
    return { status: res.status, reply: JSON.parse(text) as TokenReply };
  } catch (err) {
    const code = ((err as { cause?: { code?: string } }).cause?.code ?? (err as NodeJS.ErrnoException).code) || '';
    writeLog({ level: 'warn', text: `The Atlassian sign-in helper could not be reached for ${route}: ${(err as Error).name}${code ? ` (${code})` : ''}` });
    return NOT_SENT.has(code) ? 'unsent' : 'no-answer';
  }
}

const seconds = (s: number | undefined) => (Number(s) > 0 ? Number(s) : 3600) * 1000;

/** A pair Atlassian gave that could not be written yet: `to` replaces `from` for that sign-in. Written at the next call. */
let unsaved: { signIn: string; from: string; to: string } | null = null;

/** Writes the unsaved pair while the file still holds the token it replaced; gone, or replaced since: forgotten. */
function saveUnsaved(): void {
  if (!unsaved) return;
  const now = readAtlassianSignIn();
  if (!now || now.signIn !== unsaved.signIn || now.refreshToken !== unsaved.from) {
    unsaved = null;
    return;
  }
  const { renewing: _mark, ...rest } = now;
  try {
    writeAtlassianSignIn({ ...rest, refreshToken: unsaved.to, ...freshDates() });
    unsaved = null;
  } catch (err) {
    writeLog({ level: 'warn', text: `squad-kit still cannot write its Atlassian sign-in: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
  }
}

/** A new pair is waiting to be written. */
export function unsavedAtlassianPair(): boolean {
  return Boolean(unsaved);
}

/** Writes the waiting pair, with the lock held. */
export async function saveAtlassianPair(): Promise<void> {
  if (!unsaved) return;
  const release = await holdRefreshLock(atlassianPace().lockWaitMs);
  if (!release) return;
  try {
    saveUnsaved();
  } finally {
    release();
  }
}

/** A write that may fail without stopping the refresh: the mark. */
function tryWrite(s: Parameters<typeof writeAtlassianSignIn>[0]): void {
  try {
    writeAtlassianSignIn(s);
  } catch (err) {
    writeLog({ level: 'warn', text: `squad-kit could not mark its Atlassian renewal: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
  }
}

/** The refresh itself, with the lock held. `again`: one more try when another squad-kit wrote a newer pair meanwhile. */
async function held(stillMine: () => boolean, again: boolean): Promise<Refreshed> {
  saveUnsaved();
  const file = readAtlassianSignIn();
  if (!file) return { ok: false, why: 'signed-out' };
  // A pair kept in memory, not written yet, is the newest: it is the one to send.
  const sending = unsaved?.signIn === file.signIn && unsaved.from === file.refreshToken ? unsaved.to : file.refreshToken;
  tryWrite({ ...file, renewing: new Date().toISOString() });
  const a = await askHelper('refresh', { refresh_token: sending });
  // No answer: the mark stays, as the answer may be lost (the next refresh then says so). Never sent: the mark goes.
  if (a === 'no-answer') return { ok: false, why: 'no-answer' };
  if (a === 'unsent') {
    const back = readAtlassianSignIn();
    if (back?.signIn === file.signIn && back.refreshToken === file.refreshToken) tryWrite(file);
    return { ok: false, why: 'no-answer' };
  }
  const now = readAtlassianSignIn();
  // Disconnected, or signed in anew, while the helper was asked: nothing is written back over it.
  if (!now) return { ok: false, why: 'signed-out' };
  if (now.signIn !== file.signIn || !stillMine()) return { ok: false, why: 'stale' };
  const { renewing: _mark, ...rest } = now;
  const { access_token: token, refresh_token: next, expires_in: secs } = a.reply;
  if (a.status === 200 && token && next) {
    if (now.refreshToken !== file.refreshToken) return again ? held(stillMine, false) : { ok: false, why: 'no-answer' };
    // The new refresh token first: Atlassian has already stopped the old one. Not written: kept, used, written later.
    try {
      writeAtlassianSignIn({ ...rest, refreshToken: next, ...freshDates() });
      unsaved = null;
    } catch (err) {
      unsaved = { signIn: now.signIn, from: now.refreshToken, to: next };
      writeLog({ level: 'warn', text: `squad-kit could not write its renewed Atlassian sign-in, and keeps it in memory: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
    }
    return { ok: true, token, until: Date.now() + seconds(secs), signIn: now.signIn };
  }
  // Only Atlassian's own no to the refresh token signs squad-kit out; the helper's own trouble never does. Either way an
  // answer came: the mark goes.
  if (a.reply.error !== 'invalid_grant') {
    tryWrite(rest);
    writeLog({ level: 'warn', text: `The Atlassian sign-in helper answered HTTP ${a.status} (${a.reply.error ?? 'no code'}) to a refresh.` });
    return { ok: false, why: 'no-answer' };
  }
  // Another squad-kit may have refreshed it just before: a moment, then the file again.
  await new Promise((r) => setTimeout(r, atlassianPace().settleMs));
  const later = readAtlassianSignIn();
  if (!later || later.signIn !== file.signIn || !stillMine()) return { ok: false, why: later ? 'stale' : 'signed-out' };
  if (later.refreshToken !== file.refreshToken) return again ? held(stillMine, false) : { ok: false, why: 'no-answer' };
  // A mark from before this refresh: an earlier renewal's answer was lost, and with it the token that replaced this one.
  const why = file.renewing ? 'lost' : 'refused';
  writeLog({ level: 'warn', text: `Atlassian refused squad-kit's refresh token (HTTP ${a.status}, invalid_grant${why === 'lost' ? ', after a renewal whose answer was lost' : ''}): signed out.` });
  endAtlassianSignIn(why);
  unsaved = null;
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
