/**
 * Claude's usage limit, read from what Claude Code says when it stops on it, over ACP and in `claude -p` alike:
 * "You've hit your session limit · resets 3:40pm (Europe/London)", "Claude AI usage limit reached|1762184400", a 429
 * rate limit, and the older wordings. The engine only gets the tool-neutral signal: a limit, and when it resets.
 */

/** The messages Claude Code starts a usage-limit stop with, and the older and API wordings. */
const LIMIT = [
  /\byou've (?:hit|reached) your\b/i,
  /\byou're out of (?:extra )?usage\b/i,
  /\byour (?:org|organization|seat|group)\b.*\busage\b/i,
  /\busage allocation has been disabled\b/i,
  /\b(?:usage|spend|session|weekly|5-hour|daily|monthly)(?: credit)? limit (?:reached|exceeded|hit)\b/i,
  /\busage limit\b/i,
  /\brate[_ ]limit(?:ed|_error)?\b/i,
  /\b429\b.*\b(?:too many requests|rate)\b/i,
];

/** Messages that name a limit but are about something else, such as a tool's own output limit. */
const NOT_LIMIT = [/\bnot logged in\b/i, /\bmax(?:imum)? (?:output )?tokens\b/i, /\bcontext (?:window|length)\b/i];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** True when Claude Code stopped because the account reached its usage limit. */
export function isClaudeLimit(raw: string): boolean {
  return LIMIT.some((r) => r.test(raw)) && !NOT_LIMIT.some((r) => r.test(raw));
}

/** The usage limit Claude Code stopped on, with when it resets when it said; null for any other failure. */
export function claudeLimit(raw: string, now = Date.now()): { resetsAt?: string } | null {
  if (!raw || !isClaudeLimit(raw)) return null;
  const at = resetTime(raw, now);
  return at === null ? {} : { resetsAt: new Date(at).toISOString() };
}

/** The reset time in a limit message, as epoch milliseconds, or null when it does not say. */
export function resetTime(raw: string, now = Date.now()): number | null {
  // "Claude AI usage limit reached|1762184400": seconds since 1970 (or milliseconds).
  const epoch = /limit reached\|(\d{10,13})\b/i.exec(raw);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  // "resets in 2h 15m", "resets in 45 minutes".
  const inside = /\bresets? in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(raw);
  if (inside && (inside[1] || inside[2])) return now + (Number(inside[1] ?? 0) * 60 + Number(inside[2] ?? 0)) * 60_000;
  // "resets 2026-08-08 00:00 UTC", "resets at 2026-11-03T15:40:00Z".
  const iso = /\breset(?:s)?(?: at| on)?\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/i.exec(raw);
  if (iso) {
    const [, y, mo, d, h, mi, s, zone] = iso;
    const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    if (!zone) return localTime(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    if (/^(z|utc|gmt)$/i.test(zone)) return wall;
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.replace(/[^\d]/g, '');
    return wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  // "resets 3:40pm (Europe/London)", "resets Nov 5, 9am (Africa/Cairo)", "will reset at 3pm", "resets Oct 9 at 10am".
  const clock =
    /\breset(?:s)?(?:\s+at|\s+on)?\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?(?:\s*\(([^)]+)\))?/i.exec(raw);
  if (!clock) return null;
  const [, mon, dayText, yearText, hourText, minText, half, zoneText] = clock;
  if (!half && !minText) return null;
  let hour = Number(hourText);
  if (half) hour = (hour % 12) + (half.toLowerCase() === 'p' ? 12 : 0);
  const minute = Number(minText ?? 0);
  if (hour > 23 || minute > 59) return null;
  const zone = zoneText && validZone(zoneText.trim()) ? zoneText.trim() : undefined;
  const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
  if (mon && month < 0) return null;
  const today = partsIn(now, zone);
  if (month >= 0) {
    // A day without a year is the next one to come.
    let year = yearText ? Number(yearText) : today.year;
    let at = wallTime(year, month, Number(dayText), hour, minute, zone);
    if (!yearText && at < now - 86_400_000) at = wallTime((year += 1), month, Number(dayText), hour, minute, zone);
    return at;
  }
  // A time alone is the next one to come: later today, or tomorrow.
  let at = wallTime(today.year, today.month, today.day, hour, minute, zone);
  if (at <= now - 60_000) at = wallTime(today.year, today.month, today.day + 1, hour, minute, zone);
  return at;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date and time at `ms` in a time zone (this computer's when none is given). */
function partsIn(ms: number, zone?: string): { year: number; month: number; day: number; hour: number; minute: number } {
  if (!zone) {
    const d = new Date(ms);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: n('year'), month: n('month') - 1, day: n('day'), hour: n('hour') % 24, minute: n('minute') };
}

function localTime(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month, day, hour, minute).getTime();
}

/** A wall-clock time in a time zone, as epoch milliseconds. */
function wallTime(year: number, month: number, day: number, hour: number, minute: number, zone?: string): number {
  if (!zone) return localTime(year, month, day, hour, minute);
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (ms: number) => {
    const p = partsIn(ms, zone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  // The zone's offset at the guess, then again at the answer, for a time near a daylight saving change.
  let at = wall - offset(wall);
  const again = offset(at);
  if (again !== wall - at) at = wall - again;
  return at;
}
