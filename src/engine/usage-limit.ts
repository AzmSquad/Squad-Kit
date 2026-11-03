import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import type { UsageLimit } from '../modules/ai-tool/types.js';

/**
 * The AI account's usage limit (E5). Every project in this app works on the same account, so when one step hits the
 * limit the whole queue waits: no new step starts in any project until the limit resets. Then the work carries on by
 * itself, from the step it was on, and the wait never counts as a failed try. Kept in ~/.squad-kit/usage-limit.json,
 * so the terminal sees it too and `squad try-now` can end it.
 */

export interface LimitPause {
  /** Whose limit, for people: "Claude". */
  name: string;
  since: string;
  /** When the AI tool said the limit resets. */
  resetsAt?: string;
  /** When the queue starts again: just after the reset, or the next look when the tool did not say when. */
  until: string;
  /** Where the limit was hit. */
  project?: string;
  ticket?: string;
}

/** Without a reset time, the squad looks again this often. */
export const RETRY_MS = 10 * 60_000;
/** The first try after the reset waits a little, so it does not land just before it. */
const AFTER_RESET_MS = 30_000;
/** A reset time further away than this is not believed; the squad looks again as if none was given. */
const LONGEST_MS = 8 * 86_400_000;

function pauseFile(): string {
  return path.join(squadHome(), 'usage-limit.json');
}

/** The last pause, ended or not, or null when there is none. */
export function readPause(): LimitPause | null {
  try {
    const p = JSON.parse(fs.readFileSync(pauseFile(), 'utf8')) as LimitPause;
    return p && typeof p.until === 'string' && Number.isFinite(Date.parse(p.until)) ? p : null;
  } catch {
    return null;
  }
}

/** The pause the queue waits on now, or null once its time came or someone pressed Try now. */
export function activePause(now = Date.now()): LimitPause | null {
  const p = readPause();
  return p && Date.parse(p.until) > now ? p : null;
}

/** A step hit the limit: the queue waits until it resets. A pause already running keeps the later of the two times. */
export function startPause(limit: UsageLimit, where: { project?: string; ticket?: string } = {}, now = Date.now()): LimitPause {
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  const known = Number.isFinite(reset) && reset > now - 60_000 && reset - now < LONGEST_MS;
  const until = known ? Math.max(reset, now) + AFTER_RESET_MS : now + RETRY_MS;
  const before = activePause(now);
  const keep = before && before.name === limit.name && Date.parse(before.until) >= until;
  const pause: LimitPause = keep
    ? before
    : {
        name: limit.name,
        since: before?.since ?? new Date(now).toISOString(),
        ...(known ? { resetsAt: new Date(reset).toISOString() } : {}),
        until: new Date(until).toISOString(),
        ...(where.project ? { project: where.project } : {}),
        ...(where.ticket ? { ticket: where.ticket } : {}),
      };
  if (!keep) {
    fs.mkdirSync(squadHome(), { recursive: true });
    fs.writeFileSync(pauseFile(), `${JSON.stringify(pause, null, 2)}\n`, 'utf8');
  }
  return pause;
}

/** Try now: the queue starts again at once. True when something was waiting. */
export function endPause(now = Date.now()): boolean {
  const was = activePause(now) !== null;
  fs.rmSync(pauseFile(), { force: true });
  return was;
}

/** "at 3:40 PM", "tomorrow at 9:00 AM", "on Thursday at 9:00 AM", "on Nov 12 at 9:00 AM", in this computer's time. */
export function resetWords(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `on ${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return `on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
}

/** What the board says while the queue waits: "Claude's usage limit is reached. The squad carries on at 3:40 PM by itself". */
export function limitText(p: LimitPause, now = Date.now()): string {
  const when = p.resetsAt ? `${resetWords(p.resetsAt, now)} by itself` : 'by itself when the limit resets';
  return `${p.name}'s usage limit is reached. The squad carries on ${when}`;
}

/** True for a card line written by {@link limitText}. */
export function isLimitText(status: string | undefined): boolean {
  return Boolean(status && / usage limit is reached\. The squad carries on /.test(status));
}

/**
 * Thrown when an agent run stopped on the usage limit. A ticket waits for the reset (its card says
 * {@link limitText}); anything else that shows the message, such as a chat answer, says when to ask again.
 */
export class LimitReached extends Error {
  constructor(readonly pause: LimitPause) {
    super(pause.resetsAt ? `${pause.name}'s usage limit is reached. It resets ${resetWords(pause.resetsAt)}.` : `${pause.name}'s usage limit is reached. Try again once it resets.`);
    this.name = 'LimitReached';
  }
}
