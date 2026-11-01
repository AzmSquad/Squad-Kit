import type { AgentUsage } from '../modules/ai-tool/types.js';
import { STEPS } from '../engine/agents.js';
import { listTickets, readMeta, updateTicket, writeMeta, type BoardPaths } from './store.js';
import type { AgentName, UsageLine, UsageTotal } from './types.js';

/**
 * The cost on the board (ADR-001): what each run of a role used, as its AI tool reported it, added up per ticket, per
 * role, per step and per model level. A ticket's record is on the ticket; work with no ticket (reading the project,
 * filling in a new ticket) is the project's own line. Both stay on this computer. A count the tool did not report is
 * never added as zero: the total says how many runs it is missing for.
 */

/** Which run: the role, its step, and the model level and model it ran on. */
export type UsageKey = Pick<UsageLine, 'role' | 'step' | 'level' | 'model'>;

const same = (a: UsageKey, b: UsageKey) => a.role === b.role && a.step === b.step && a.level === b.level && a.model === b.model;

function addTo(t: UsageTotal, u: AgentUsage | UsageTotal | undefined, runs: number): void {
  const sum = (k: 'inputTokens' | 'cachedTokens' | 'outputTokens' | 'costUsd') => {
    const v = u?.[k];
    if (typeof v === 'number') t[k] = (t[k] ?? 0) + v;
  };
  t.runs += runs;
  sum('inputTokens');
  sum('cachedTokens');
  sum('outputTokens');
  sum('costUsd');
  // A total brings its own missing runs; one run is missing what it did not report.
  const total = u && 'runs' in u ? u : null;
  const noTokens = total ? (total.tokensUnknown ?? 0) : u?.inputTokens === undefined && u?.outputTokens === undefined ? 1 : 0;
  const noCost = total ? (total.costUnknown ?? 0) : u?.costUsd === undefined ? 1 : 0;
  if (noTokens) t.tokensUnknown = (t.tokensUnknown ?? 0) + noTokens;
  if (noCost) t.costUnknown = (t.costUnknown ?? 0) + noCost;
}

/** The lines with one more run counted. */
export function addRun(lines: UsageLine[] | undefined, key: UsageKey, usage: AgentUsage | undefined): UsageLine[] {
  const all = (lines ?? []).map((l) => ({ ...l }));
  let line = all.find((l) => same(l, key));
  if (!line) {
    line = { ...key, runs: 0 };
    all.push(line);
  }
  addTo(line, usage, 1);
  return all;
}

/** Everything in some lines, added up. */
export function totalOf(lines: UsageLine[] | undefined): UsageTotal {
  const t: UsageTotal = { runs: 0 };
  for (const l of lines ?? []) addTo(t, l, l.runs);
  return t;
}

const ROLE_ORDER: AgentName[] = ['analyst', 'architect', 'builder', 'reviewer', 'tester'];

export interface RoleUsage {
  role: AgentName;
  total: UsageTotal;
  /** One row per model level the role ran on, with the steps it took there. */
  levels: (Pick<UsageLine, 'level' | 'model'> & { steps: string[]; total: UsageTotal })[];
}

/** The lines per role, in the squad's order, and per model level inside each role. */
export function byRole(lines: UsageLine[] | undefined): RoleUsage[] {
  const out: RoleUsage[] = [];
  for (const role of ROLE_ORDER) {
    const mine = (lines ?? []).filter((l) => l.role === role);
    if (!mine.length) continue;
    const levels: RoleUsage['levels'] = [];
    for (const l of mine) {
      let row = levels.find((x) => x.level === l.level && x.model === l.model);
      if (!row) levels.push((row = { level: l.level, model: l.model, steps: [], total: { runs: 0 } }));
      if (!row.steps.includes(l.step)) row.steps.push(l.step);
      addTo(row.total, l, l.runs);
    }
    out.push({ role, total: totalOf(mine), levels });
  }
  return out;
}

/** Counts one run on its ticket, or on the project's own line when it had no ticket. */
export function recordUsage(bp: BoardPaths, ticketId: string | undefined, key: UsageKey, usage: AgentUsage | undefined): void {
  try {
    if (ticketId) {
      updateTicket(bp, ticketId, (t) => (t.usage = addRun(t.usage, key, usage)));
      return;
    }
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, usage: addRun(meta.usage, key, usage) });
  } catch {
    // The ticket was removed while it ran; nothing to count it on.
  }
}

export interface BoardUsage {
  total: UsageTotal;
  /** The project's own work, with no ticket. */
  project: UsageTotal;
  roles: RoleUsage[];
  /** Tickets with anything counted. */
  tickets: number;
}

/** Everything the squad used on this board on this computer: every ticket, finished ones too, and the project's own line. */
export function boardUsage(bp: BoardPaths): BoardUsage {
  const tickets = listTickets(bp).filter((t) => t.usage?.length);
  const project = readMeta(bp).usage ?? [];
  const all = [...tickets.flatMap((t) => t.usage!), ...project];
  return { total: totalOf(all), project: totalOf(project), roles: byRole(all), tickets: tickets.length };
}

/* ── In words, for the terminal ─────────────────────────── */

const MORE_STEPS: Record<string, string> = { chat: 'Talking it through', draft: 'Filling in a new ticket' };

/** A step's name for people: "Fixes", "Reading the project". */
export function stepWords(role: AgentName, step: string): string {
  return STEPS[role]?.find((s) => s.id === step)?.name ?? MORE_STEPS[step] ?? step;
}

/** "$1.23", "under $0.01", with the runs the tool did not report; null when no run reported a cost. */
export function costWords(t: UsageTotal): string | null {
  if (t.costUsd === undefined) return null;
  const amount = t.costUsd < 0.005 ? 'under $0.01' : `$${t.costUsd.toFixed(2)}`;
  return t.costUnknown ? `${amount}, ${t.costUnknown} ${t.costUnknown === 1 ? 'run' : 'runs'} not reported` : amount;
}

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function shortNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/** "read 120k tokens, wrote 4.1k", or null when no run reported its tokens. */
export function tokenWords(t: UsageTotal): string | null {
  if (t.inputTokens === undefined && t.outputTokens === undefined) return null;
  return [t.inputTokens !== undefined ? `read ${shortNumber(t.inputTokens)} tokens` : '', t.outputTokens !== undefined ? `wrote ${shortNumber(t.outputTokens)}` : ''].filter(Boolean).join(', ');
}
