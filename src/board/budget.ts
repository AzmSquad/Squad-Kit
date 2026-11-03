import fs from 'node:fs';
import { addActivity, readMeta, readTicket, updateTicket, writeMeta, type BoardPaths } from './store.js';
import type { Budget, Payment, Ticket } from './types.js';
import { monthKey, readMonths, totalOf } from './usage.js';

/**
 * Budgets for a person who pays per use (an API key): one per ticket and one per month, in US dollars, for this
 * project on this computer. At 80% the ticket and the board say so. At 100% the ticket stops between two steps, never
 * in the middle of one, and asks: carry on, do the rest yourself, or make the plan smaller.
 */

/** Share of a budget where the warning starts. */
export const WARN_AT = 0.8;

export type BudgetKind = 'ticket' | 'month';

export interface BudgetState {
  ticketUsd?: number;
  monthUsd?: number;
  /** What the ticket and the month used so far, in US dollars. */
  ticketSpent?: number;
  monthSpent: number;
  /** Share of each budget used, 1 is all of it. */
  ticketShare?: number;
  monthShare?: number;
  /** At 80% or more, and not over yet. */
  warn: BudgetKind[];
  over: BudgetKind[];
}

function share(spent: number | undefined, limit: number | undefined): number | undefined {
  return limit && limit > 0 && spent !== undefined ? spent / limit : undefined;
}

/** Where a ticket (or only the month, without one) stands against the budgets. */
export function budgetState(bp: BoardPaths, t: Ticket | null, budget = readMeta(bp).budget, at = Date.now()): BudgetState {
  const monthSpent = readMonths(bp)[monthKey(at)]?.costUsd ?? 0;
  const ticketSpent = t ? (totalOf(t.usage).costUsd ?? 0) : undefined;
  const ticketShare = t ? share(ticketSpent, budget?.ticketUsd) : undefined;
  const monthShare = share(monthSpent, budget?.monthUsd);
  const warn: BudgetKind[] = [];
  const over: BudgetKind[] = [];
  for (const [kind, s] of [['ticket', ticketShare], ['month', monthShare]] as const) {
    if (s === undefined) continue;
    if (s >= 1) over.push(kind);
    else if (s >= WARN_AT) warn.push(kind);
  }
  return {
    ...(budget?.ticketUsd ? { ticketUsd: budget.ticketUsd } : {}),
    ...(budget?.monthUsd ? { monthUsd: budget.monthUsd } : {}),
    ...(ticketSpent !== undefined ? { ticketSpent } : {}),
    monthSpent,
    ...(ticketShare !== undefined ? { ticketShare } : {}),
    ...(monthShare !== undefined ? { monthShare } : {}),
    warn,
    over,
  };
}

/** "$5", "5.50", "off". Off (or 0) removes the budget; anything else is an error in words. */
export function parseUsd(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^\$/, '').replace(/\s*(usd|dollars?)$/i, '');
  if (!s || /^(off|none|no)$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${v}" is not an amount. Write it in US dollars, like 5 or 2.50, or off.`);
  return n === 0 ? null : Math.round(n * 100) / 100;
}

/** Sets either budget; null takes it away, undefined leaves it as it is. */
export function setBudget(bp: BoardPaths, change: { ticketUsd?: number | null; monthUsd?: number | null }): Budget {
  const meta = readMeta(bp);
  const next: Budget = { ...meta.budget };
  for (const k of ['ticketUsd', 'monthUsd'] as const) {
    const v = change[k];
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  writeMeta(bp, { ...meta, budget: Object.keys(next).length ? next : undefined });
  return next;
}

/** The phases that run no AI, so they never wait on a budget: the checks, an Express approval, the pull request. */
const NO_AI = new Set(['test', 'express-approve', 'publish']);

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The person answered a budget card: whichever way on they chose (carry on, do the rest themselves, a smaller plan),
 * they chose to go on with the ticket, so it counts from now on, for the ticket or for this month.
 */
function carriedOn(t: Ticket): BudgetKind | null {
  const s = t.stuck;
  if (!s?.budget || t.waiting) return null;
  return s.options.some((o) => o.chosen) ? s.budget : null;
}

/**
 * Before a step that runs an AI agent: on an API key past a budget, the ticket stops here and asks. The step before
 * it has finished, so nothing is cut in half. True when the ticket stopped.
 */
export async function budgetStop(bp: BoardPaths, id: string, phase: string, payment: () => Promise<Payment>, at = Date.now()): Promise<boolean> {
  if (NO_AI.has(phase)) return false;
  const budget = readMeta(bp).budget;
  if (!budget?.ticketUsd && !budget?.monthUsd) return false;
  let t = readTicket(bp, id);
  if (!t) return false;
  const yes = carriedOn(t);
  if (yes) {
    t = updateTicket(bp, id, (x) => {
      x.budgetOk = { ...x.budgetOk, ...(yes === 'ticket' ? { ticket: true } : { month: monthKey(at) }) };
      if (x.stuck) delete x.stuck.budget;
    });
  }
  if ((await payment()) !== 'api-key') return false;
  const state = budgetState(bp, t, budget, at);
  const over = state.over.filter((k) => (k === 'ticket' ? !t!.budgetOk?.ticket : t!.budgetOk?.month !== monthKey(at)));
  if (!over.length) return false;
  const kind = over[0]!;
  const what =
    kind === 'ticket'
      ? `${t.id} used ${usd(state.ticketSpent ?? 0)} of its ${usd(state.ticketUsd ?? 0)} budget.`
      : `The squad used ${usd(state.monthSpent)} of this month's ${usd(state.monthUsd ?? 0)} budget for ${readMeta(bp).project}.`;
  const copy = Boolean(t.worktree && fs.existsSync(t.worktree));
  updateTicket(bp, id, (x) => {
    x.live = false;
    x.squad = null;
    x.retryPhase = phase;
    x.status = kind === 'ticket' ? 'Paused at its budget' : "Paused at this month's budget";
    x.waiting = { kind: 'stuck', summary: kind === 'ticket' ? 'Reached its budget and waits for you' : "Reached this month's budget and waits for you" };
    x.stuck = {
      budget: kind,
      question: `${what} squad-kit paused it before the next step, so no step was cut in half. Carry on, or raise the budget in Settings first.`,
      options: [
        {
          do: 'retry',
          name: 'Carry on',
          note: kind === 'ticket' ? 'The squad finishes this ticket and does not stop it for its budget again.' : 'The squad goes on with this ticket this month.',
        },
        ...(copy ? [{ do: 'yourself' as const, name: 'Do the rest yourself', note: "Open the ticket's copy in your editor and finish it. Then the checks, review and proof run again." }] : []),
        { do: 'plan', name: 'Send it back to the plan', note: 'A smaller plan uses less. The Architect rewrites it with what is done so far.' },
      ],
    };
    addActivity(x, 'squad', `Paused before the next step: ${what}`);
  });
  return true;
}
