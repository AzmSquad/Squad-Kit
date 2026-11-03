import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from './store.js';
import type { AgentName, TimedStep, Track } from './types.js';

/**
 * How long each kind of step usually takes in this project, learned from its own history: the time of every step that
 * ended well, per role, step and track. It is this computer's pace (its AI account, its machine), so it is kept in
 * this computer's folder for the project, not in .squad/. Until a kind has a few runs, squad-kit's own guess stands in.
 */

/** The runs kept per kind, newest last. */
const KEEP = 20;
/** Runs needed before the project's own history replaces the guess. */
export const LEARN_AFTER = 3;

/** squad-kit's guess, in seconds, until the project has its own history. The Builder's is for one plan step. */
export const DEFAULT_USUAL: Record<TimedStep, [number, number]> = {
  questions: [60, 180],
  spec: [60, 180],
  design: [120, 300],
  build: [120, 240],
  fix: [120, 300],
  checks: [60, 180],
  review: [120, 240],
  proof: [60, 180],
};

/** A usual time as a range in seconds, and whether it comes from the project's own history. */
export interface Usual {
  low: number;
  high: number;
  learned: boolean;
  runs: number;
}

/** Step times in seconds by kind ("builder.build.full"), newest last. */
export type UsualBook = Record<string, number[]>;

export function usualKey(who: AgentName | 'squad', step: TimedStep, track?: Track): string {
  return `${who}.${step}.${track ?? 'full'}`;
}

export function usualFile(bp: BoardPaths): string {
  return path.join(bp.localDir, 'usual-times.json');
}

export function readUsual(bp: BoardPaths): UsualBook {
  try {
    const raw = JSON.parse(fs.readFileSync(usualFile(bp), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const book: UsualBook = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) book[k] = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    }
    return book;
  } catch {
    // No history yet, or a broken file: the guesses stand in.
    return {};
  }
}

/** A step ended well: its time joins the history of its kind. */
export function recordUsual(bp: BoardPaths, key: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 1) return;
  try {
    const book = readUsual(bp);
    book[key] = [...(book[key] ?? []), Math.round(seconds)].slice(-KEEP);
    fs.mkdirSync(path.dirname(usualFile(bp)), { recursive: true });
    const tmp = `${usualFile(bp)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(book, null, 1)}\n`);
    fs.renameSync(tmp, usualFile(bp));
  } catch {
    // Timing is a help, never a reason for a step to fail.
  }
}

function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** The usual time of a kind of step: the middle half of its history, or the guess until it has a few runs. */
export function usualOf(book: UsualBook, who: AgentName | 'squad', step: TimedStep, track?: Track): Usual {
  const runs = book[usualKey(who, step, track)] ?? [];
  if (runs.length < LEARN_AFTER) {
    const [low, high] = DEFAULT_USUAL[step];
    return { low, high, learned: false, runs: runs.length };
  }
  const sorted = [...runs].sort((a, b) => a - b);
  return { low: quantile(sorted, 0.25), high: quantile(sorted, 0.75), learned: true, runs: runs.length };
}

/** The middle of a usual time, for adding up what is left. */
export function middle(u: Usual): number {
  return (u.low + u.high) / 2;
}

/** "2 to 4 min", "about 1 min", "under 1 min". */
export function rangeWords(u: Pick<Usual, 'low' | 'high'>): string {
  if (u.high < 60) return 'under 1 min';
  const low = Math.max(1, Math.round(u.low / 60));
  const high = Math.max(low, Math.round(u.high / 60));
  return low === high ? `about ${low} min` : `${low} to ${high} min`;
}

/** "usually 2 to 4 min". */
export function usualWords(u: Pick<Usual, 'low' | 'high'>): string {
  return `usually ${rangeWords(u)}`;
}

/** Time so far, short, for a card: "40 s", "2 min", "1 h 5 min". */
export function durationWords(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.max(1, Math.floor(s))} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Time in a sentence: "40 seconds", "1 minute", "14 minutes". */
export function minutesWords(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.floor(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.floor(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
