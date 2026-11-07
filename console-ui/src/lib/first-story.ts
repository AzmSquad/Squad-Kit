import type { Ticket } from '../api/types';

/**
 * The first start, as data: the person's language for it, which story the checklist follows, where that story stands, and
 * what the first win says. The rest of the app is in English; a story's own words keep their language everywhere.
 */

export type Lang = 'en' | 'ar';

const LANG_KEY = 'squad-kit-first-start-lang';

export function readLang(): Lang {
  try {
    const kept = localStorage.getItem(LANG_KEY);
    if (kept === 'ar' || kept === 'en') return kept;
  } catch {
    // A private window can refuse storage: the browser's language says.
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // The choice then lasts for this visit only.
  }
}

/** A window this browser has been told to keep closed for a project. */
export function kept(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function keep(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // It may show again next visit, and nothing is lost.
  }
}

const isIn = (t: Ticket) => Boolean(t.mergedAt) || t.stage === 'release' || t.stage === 'done';

/**
 * The story the checklist follows: the first one a person walks through, until a story is in. Builds by itself needs
 * nobody on the way, and a story in a conversation outside has its own panel.
 */
export function storyToGuide(tickets: Ticket[], archived: Ticket[]): Ticket | null {
  if ([...tickets, ...archived].some(isIn)) return null;
  return tickets.find((t) => t.track !== 'auto' && !t.takenOver?.free) ?? null;
}

export type GuideStep = 0 | 1 | 2 | 3;

/** The checklist's line for where the story is. */
export function guideStep(t: Pick<Ticket, 'stage' | 'waiting'>): GuideStep {
  const kind = t.waiting?.kind;
  if (kind === 'proof') return 3;
  if (kind === 'spec' || kind === 'plan') return 1;
  if (t.stage === 'tickets' || kind === 'questions') return 0;
  if (t.stage === 'specs') return 1;
  return 2;
}

export type GuideHint = 'questions' | 'spec' | 'plan' | 'proof' | 'other' | 'working';

/** What the hint says. Only a waiting story says it is your turn. */
export function guideHint(t: Pick<Ticket, 'waiting'>): GuideHint {
  const kind = t.waiting?.kind;
  if (!kind) return 'working';
  if (kind === 'questions') return 'questions';
  return kind === 'spec' || kind === 'plan' || kind === 'proof' ? kind : 'other';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The story to celebrate: the only one that went in, and recently, so someone who upgrades with one old story is not
 * congratulated on it.
 */
export function firstWinOf(tickets: Ticket[], archived: Ticket[], now = Date.now()): Ticket | null {
  const inn = [...tickets, ...archived].filter(isIn);
  if (inn.length !== 1) return null;
  const t = inn[0]!;
  const at = Date.parse(t.mergedAt ?? '');
  return at && now - at < DAY_MS ? t : null;
}

/** Arabic counts differently: one and two have their own words, three to ten take the plural. */
export function arabicCount(n: number, one: string, two: string, some: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${n <= 10 ? some : one}`;
}

export interface WinStats {
  minutes: number;
  /** How many "done when" passed squad-kit's own proof. None when it did not make one. */
  doneWhen?: number;
  tests?: number;
  costUsd?: number;
}

/** Only what really happened: a number squad-kit does not have is not shown. */
export function winStats(t: Ticket): WinStats {
  const started = Date.parse(t.createdAt);
  const ended = Date.parse(t.mergedAt ?? '');
  const minutes = started && ended ? Math.max(1, Math.round((ended - started) / 60_000)) : 1;
  const doneWhen = t.gates?.proof === 'pass' ? t.criteria?.length : undefined;
  const tests = (t.gates?.ran ?? []).reduce((sum, r) => sum + (r.ok ? (r.tests ?? 0) : 0), 0);
  const cost = (t.usage ?? []).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  return { minutes, ...(doneWhen ? { doneWhen } : {}), ...(tests ? { tests } : {}), ...(cost ? { costUsd: cost } : {}) };
}
