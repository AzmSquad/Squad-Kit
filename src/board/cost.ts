import { QUALITIES } from '../engine/levels.js';
import { budgetState, WARN_AT, type BudgetState } from './budget.js';
import type { PaymentInfo } from './payment.js';
import { listTickets, readMeta, type BoardPaths } from './store.js';
import type { Quality, Ticket, UsageLine, UsageTotal } from './types.js';
import { monthKey, readMonths, shortNumber, totalOf } from './usage.js';

/**
 * The Cost tab, the way the person pays. On a subscription: no extra charge, the size of the work against the
 * project's usual ticket, where the work went, and only then its value at API prices, said to be a value and not a
 * bill. On an API key: real dollars against the budgets. Both: a tip about the Express track, and for engineers the
 * models and tokens. Everything comes from what the squad already counts on this computer.
 */

/** Accepted with Looks right: merged, in a release, or released. */
export function accepted(t: Ticket): boolean {
  return t.stage === 'release' || t.stage === 'done' || Boolean(t.mergedAt);
}

/** The squad's own time on a ticket: every step that ended well, without the time it waited for the person. */
export function workSeconds(t: Ticket): number | undefined {
  if (!t.history?.length) return undefined;
  return t.history.reduce((s, h) => s + Math.max(0, (Date.parse(h.to) - Date.parse(h.from)) / 1000), 0);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A part of a whole in words, ready for "of this": "about a third of", "about half of". */
export function partWords(r: number): string {
  if (r >= 0.85) return 'about as much as';
  if (r >= 0.58) return 'about two thirds of';
  if (r >= 0.42) return 'about half of';
  if (r >= 0.29) return 'about a third of';
  if (r >= 0.21) return 'about a quarter of';
  if (r >= 0.15) return 'about a fifth of';
  if (r >= 0.07) return 'about a tenth of';
  return 'less than a tenth of';
}

export type Size = 'small' | 'medium' | 'large';

export interface SizeOfWork {
  size: Size;
  /** This ticket against the project's usual ticket: 3 is three times as much. */
  times: number;
  words: string;
  /** How many accepted tickets the usual one comes from. */
  from: number;
}

/** The size of a ticket's work against the project's usual accepted ticket, or null until there are two to compare. */
export function sizeOfWork(t: Ticket, all: Ticket[], project: string): SizeOfWork | null {
  const mine = totalOf(t.usage).costUsd;
  const others = all.filter((x) => x.id !== t.id && accepted(x)).map((x) => totalOf(x.usage).costUsd).filter((c): c is number => typeof c === 'number' && c > 0);
  if (mine === undefined || others.length < 2) return null;
  const usual = median(others);
  const times = mine / usual;
  const size: Size = times < 0.6 ? 'small' : times <= 1.6 ? 'medium' : 'large';
  const words =
    times >= 1.75
      ? `About ${Math.round(times)} times a usual ticket in ${project}.`
      : times >= 1.25
        ? `About one and a half times a usual ticket in ${project}.`
        : times >= 0.85
          ? `About the same as a usual ticket in ${project}.`
          : `${cap(partWords(times))} a usual ticket in ${project}.`;
  return { size, times, words, from: others.length };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function and(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

const runsOf = (t: Ticket, step: string) => (t.usage ?? []).filter((l) => l.step === step).reduce((n, l) => n + l.runs, 0);

/** What made the work this size, in a sentence: "It had 5 questions, a design and a second review." */
export function sizeWhy(t: Ticket): string {
  const parts: string[] = [];
  const q = t.questions?.length ?? 0;
  if (q) parts.push(`${q} ${q === 1 ? 'question' : 'questions'}`);
  if (t.track === 'express') parts.push('the Express track');
  else if (t.track === 'auto') parts.push('a design written from the breakdown');
  else if (t.decision || t.steps?.length) parts.push('a design');
  if (t.mockup) parts.push('a mockup');
  const fixes = runsOf(t, 'fix');
  if (fixes) parts.push(fixes === 1 ? 'one round of fixes' : `${fixes} rounds of fixes`);
  const reviews = runsOf(t, 'review');
  if (reviews === 2) parts.push('a second review');
  else if (reviews > 2) parts.push(`${reviews} reviews`);
  return parts.length ? `It had ${and(parts)}.` : '';
}

/** The groups of "Where the work went", in the squad's order. */
const GROUP: Record<string, string> = {
  questions: 'Questions and spec',
  spec: 'Questions and spec',
  scan: 'Reading the project',
  blueprint: 'Reading the project',
  design: 'Design',
  build: 'Build',
  fix: 'Fixes',
  review: 'Review',
  proof: 'Screenshots',
  chat: 'Talking it through',
  draft: 'Filling in the ticket',
};

export interface WorkShare {
  name: string;
  /** 0 to 1. */
  share: number;
  costUsd?: number;
}

/** Where the work went, by step, largest first: by cost, or by tokens when a run did not report its cost. */
export function whereItWent(lines: UsageLine[] | undefined): { by: 'cost' | 'tokens'; parts: WorkShare[] } {
  const all = lines ?? [];
  const byCost = all.length > 0 && all.every((l) => l.costUsd !== undefined && !l.costUnknown);
  const amount = (l: UsageLine) => (byCost ? (l.costUsd ?? 0) : (l.inputTokens ?? 0) + (l.outputTokens ?? 0));
  const groups = new Map<string, { amount: number; cost: number }>();
  for (const l of all) {
    const name = GROUP[l.step] ?? l.step;
    const g = groups.get(name) ?? { amount: 0, cost: 0 };
    g.amount += amount(l);
    g.cost += l.costUsd ?? 0;
    groups.set(name, g);
  }
  const sum = [...groups.values()].reduce((s, g) => s + g.amount, 0);
  const parts = [...groups.entries()]
    .map(([name, g]) => ({ name, share: sum > 0 ? g.amount / sum : 0, ...(byCost ? { costUsd: g.cost } : {}) }))
    .filter((p) => p.share > 0)
    .sort((a, b) => b.share - a.share);
  return { by: byCost ? 'cost' : 'tokens', parts };
}

const STEP_WORD: Record<string, string> = {
  questions: 'questions',
  spec: 'spec',
  scan: 'reading the project',
  blueprint: 'reading the project',
  design: 'design',
  build: 'the build',
  fix: 'fixes',
  review: 'review',
  proof: 'screenshots',
  chat: 'talking it through',
  draft: 'filling in the ticket',
};

/** For engineers: "Opus for questions, spec and design · Sonnet for the build", and the tokens. */
export function engineerDetails(lines: UsageLine[] | undefined): { models: string; tokens: string | null } {
  const byModel = new Map<string, string[]>();
  for (const l of lines ?? []) {
    const model = l.model || `${l.level} level`;
    const steps = byModel.get(model) ?? [];
    const w = STEP_WORD[l.step] ?? l.step;
    if (!steps.includes(w)) steps.push(w);
    byModel.set(model, steps);
  }
  const models = [...byModel.entries()].map(([m, steps]) => `${m} for ${and(steps)}`).join(' · ');
  const t = totalOf(lines);
  const tokens =
    t.inputTokens === undefined && t.outputTokens === undefined
      ? null
      : [
          t.inputTokens !== undefined ? `${shortNumber(t.inputTokens)} tokens read${t.cachedTokens && t.inputTokens ? ` (${Math.round((100 * t.cachedTokens) / t.inputTokens)}% from cache)` : ''}` : '',
          t.outputTokens !== undefined ? `${shortNumber(t.outputTokens)} written` : '',
        ]
          .filter(Boolean)
          .join(', ');
  return { models, tokens };
}

/**
 * The Express track tip, from the latest accepted Express ticket, or a general one when there is none yet. None on an
 * Express ticket, nor on a story that builds by itself (its track comes with the breakdown).
 */
export function expressTip(t: Ticket, all: Ticket[]): string | null {
  if (t.track === 'express' || t.track === 'auto') return null;
  const mine = totalOf(t.usage).costUsd;
  const x = all
    .filter((o) => o.id !== t.id && o.track === 'express' && accepted(o) && (totalOf(o.usage).costUsd ?? 0) > 0)
    .sort((a, b) => (b.mergedAt ?? b.createdAt).localeCompare(a.mergedAt ?? a.createdAt))[0];
  if (x && mine && mine > 0) {
    const r = totalOf(x.usage).costUsd! / mine;
    if (r < 0.85) return `The Express track used ${partWords(r)} this for ${x.title} (${x.id}). For a small change like that, pick Express when you make the ticket.`;
  }
  return 'For a small change, like a typo or one word on a button, pick the Express track when you make the ticket. It skips the questions and the plan approval, so it uses much less.';
}

export interface MonthTotal {
  /** "2026-11". */
  month: string;
  total: UsageTotal;
  /** The first month counted on this computer: a total from before it was kept is not in it. */
  since?: string;
}

export function monthTotal(bp: BoardPaths, at = Date.now()): MonthTotal {
  const months = readMonths(bp);
  const month = monthKey(at);
  const first = Object.keys(months).sort()[0];
  return { month, total: months[month] ?? { runs: 0 }, ...(first ? { since: first } : {}) };
}

export interface TicketCost {
  payment: PaymentInfo;
  project: string;
  total: UsageTotal;
  size: SizeOfWork | null;
  why: string;
  where: ReturnType<typeof whereItWent>;
  month: MonthTotal;
  /** On an API key only. */
  budget?: BudgetState;
  tip: string | null;
  details: { models: string; tokens: string | null };
  /** Seconds of the squad's own work, when the ticket kept its steps. */
  seconds?: number;
}

/** Everything the Cost tab shows for one ticket. */
export function ticketCost(bp: BoardPaths, t: Ticket, payment: PaymentInfo, at = Date.now()): TicketCost {
  const all = listTickets(bp);
  const meta = readMeta(bp);
  const seconds = workSeconds(t);
  return {
    payment,
    project: meta.project,
    total: totalOf(t.usage),
    size: sizeOfWork(t, all, meta.project),
    why: sizeWhy(t),
    where: whereItWent(t.usage),
    month: monthTotal(bp, at),
    ...(payment.payment === 'api-key' ? { budget: budgetState(bp, t, meta.budget, at) } : {}),
    tip: expressTip(t, all),
    details: engineerDetails(t.usage),
    ...(seconds !== undefined ? { seconds } : {}),
  };
}

export interface QualityStat {
  quality: Quality;
  /** Accepted tickets that ran on this setting. */
  tickets: number;
  /** The average cost value per accepted ticket, in US dollars, from the tickets that reported one. */
  costUsd?: number;
  /** The average time of the squad's own work per accepted ticket, in seconds, from the tickets that kept their steps. */
  seconds?: number;
}

/** Averages show once a setting has this many accepted tickets. */
export const QUALITY_AFTER = 3;

/** Per Quality setting, on this project: the average cost value and time per accepted ticket. */
export function qualityStats(bp: BoardPaths): QualityStat[] {
  const done = listTickets(bp).filter((t) => accepted(t) && t.quality);
  return QUALITIES.map((quality) => {
    const mine = done.filter((t) => t.quality === quality);
    const costs = mine.map((t) => totalOf(t.usage).costUsd).filter((c): c is number => typeof c === 'number');
    const times = mine.map(workSeconds).filter((s): s is number => typeof s === 'number');
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return { quality, tickets: mine.length, ...(costs.length ? { costUsd: avg(costs) } : {}), ...(times.length ? { seconds: avg(times) } : {}) };
  });
}

export interface BudgetWarning {
  kind: 'ticket' | 'month';
  /** The ticket, for a ticket's budget. */
  id?: string;
  title?: string;
  spent: number;
  limit: number;
  share: number;
  /** Over the budget: the ticket stops at its next step. */
  over: boolean;
}

export interface CostOverview {
  payment: PaymentInfo;
  project: string;
  month: MonthTotal;
  budget: { ticketUsd?: number; monthUsd?: number };
  /** On an API key: open tickets at 80% of their budget or more, and the month. */
  warnings: BudgetWarning[];
  quality: QualityStat[];
  qualityAfter: number;
}

/** The board's view of cost: the month, the budgets with their warnings, and the averages per Quality setting. */
export function costOverview(bp: BoardPaths, payment: PaymentInfo, at = Date.now()): CostOverview {
  const meta = readMeta(bp);
  const budget = meta.budget ?? {};
  const warnings: BudgetWarning[] = [];
  if (payment.payment === 'api-key' && (budget.ticketUsd || budget.monthUsd)) {
    const month = budgetState(bp, null, budget, at);
    if (month.monthShare !== undefined && month.monthShare >= WARN_AT) {
      warnings.push({ kind: 'month', spent: month.monthSpent, limit: budget.monthUsd!, share: month.monthShare, over: month.monthShare >= 1 });
    }
    if (budget.ticketUsd) {
      for (const t of listTickets(bp).filter((x) => !accepted(x) && !x.archived && !x.deleting)) {
        const s = budgetState(bp, t, budget, at);
        if (s.ticketShare !== undefined && s.ticketShare >= WARN_AT && !t.budgetOk?.ticket) {
          warnings.push({ kind: 'ticket', id: t.id, title: t.title, spent: s.ticketSpent ?? 0, limit: budget.ticketUsd, share: s.ticketShare, over: s.ticketShare >= 1 });
        }
      }
    }
  }
  return { payment, project: meta.project, month: monthTotal(bp, at), budget, warnings, quality: qualityStats(bp), qualityAfter: QUALITY_AFTER };
}
