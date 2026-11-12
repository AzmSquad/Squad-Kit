import { inbox } from '../../board/actions.js';
import { liveNow } from '../../board/now.js';
import { listReleases, listTickets, type BoardPaths } from '../../board/store.js';
import { readUsual } from '../../board/usual.js';
import { dayKey, readDays } from '../../board/usage.js';
import type { MorningBrief } from './types.js';

/**
 * The morning brief, a routine the person turns on: what happened since yesterday evening, from the board's own data,
 * with no AI call. Merged and released stories, who works on what now, what stopped, what waits for the person, and
 * what the AI used.
 */

/** Yesterday at 6 in the evening, this computer's time: where "since yesterday evening" starts. */
export function sinceYesterday(at = Date.now()): number {
  const d = new Date(at);
  d.setDate(d.getDate() - 1);
  d.setHours(18, 0, 0, 0);
  return d.getTime();
}

const list = (ids: string[]) => (ids.length <= 2 ? ids.join(' and ') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`);

export function morningBrief(bp: BoardPaths, at = Date.now()): MorningBrief {
  const since = sinceYesterday(at);
  const after = (iso?: string) => Boolean(iso) && Date.parse(iso!) >= since;
  const all = listTickets(bp);
  const usual = readUsual(bp);
  const merged = all.filter((t) => after(t.mergedAt)).map((t) => t.id);
  const released = listReleases(bp).filter((r) => r.status === 'released' && after(r.date)).map((r) => r.version);
  const working = all.filter((t) => t.stage !== 'done' && !t.archived && liveNow(t, usual, at).state === 'working').map((t) => t.id);
  const stopped = all.filter((t) => t.waiting?.kind === 'stuck' && t.activity.some((a) => after(a.at))).map((t) => t.id);
  const waiting = inbox(bp).length;
  const days = readDays(bp);
  const counted = [dayKey(since), dayKey(at)].filter((k, i, a) => a.indexOf(k) === i).map((k) => days[k]).filter(Boolean);
  const cost = counted.some((d) => d!.costUsd !== undefined) ? counted.reduce((s, d) => s + (d!.costUsd ?? 0), 0) : undefined;
  const parts = [
    merged.length ? `${list(merged)} merged.` : 'Nothing merged.',
    released.length ? `Released ${list(released)}.` : '',
    working.length ? `The squad is on ${list(working)}.` : 'Nobody is working right now.',
    stopped.length ? `${list(stopped)} stopped and wait${stopped.length === 1 ? 's' : ''} for you.` : 'Nothing failed.',
  ].filter(Boolean);
  return { since: new Date(since).toISOString(), headline: parts.join(' '), merged, released, working, stopped, waiting, ...(cost !== undefined ? { costUsd: Math.round(cost * 100) / 100 } : {}) };
}
