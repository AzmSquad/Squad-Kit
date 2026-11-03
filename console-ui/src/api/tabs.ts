import type { AgentName, Quality, TimedStep, UsageTotal } from './types';

/** The Conversation tab's "What happened" and the Cost tab, as the engine sends them (src/board/happened.ts, cost.ts). */

export type HandedIn =
  | { kind: 'questions'; items: { from: 'analyst' | 'architect'; text: string; answer?: string }[] }
  | { kind: 'spec'; story?: string; criteria: string[] }
  | { kind: 'design'; title?: string; chosen?: string; steps: string[]; mockup: boolean; follows: string[]; adr?: string }
  | { kind: 'files'; added: string[]; changed: string[]; removed: string[]; steps: string[] }
  | { kind: 'checks'; ok: boolean; text: string }
  | { kind: 'verdict'; approved: boolean; notes: string[] }
  | { kind: 'shots'; shots: { criterion: string; file: string }[] };

export type SessionKey = 'intake' | 'build' | 'review' | 'tester';

export interface HappenedStep {
  who: AgentName | 'squad';
  step: TimedStep;
  name: string;
  from?: string;
  to?: string;
  seconds?: number;
  running?: boolean;
  summary: string;
  handedIn?: HandedIn;
  tab?: 'plan' | 'changes' | 'proof';
  notes: string[];
  session?: SessionKey;
  actions?: number;
  skipped?: number;
}

export interface Happened {
  steps: HappenedStep[];
  seconds: number;
}

export interface PaymentInfo {
  payment: 'subscription' | 'api-key';
  from: 'you' | 'found' | 'guess';
  found: { kind: 'subscription' | 'api-key'; label: string } | null;
  tool: string;
  /** Whose plan: "Claude". */
  name: string;
}

export interface MonthTotal {
  month: string;
  total: UsageTotal;
  since?: string;
}

export interface BudgetState {
  ticketUsd?: number;
  monthUsd?: number;
  ticketSpent?: number;
  monthSpent: number;
  ticketShare?: number;
  monthShare?: number;
  warn: ('ticket' | 'month')[];
  over: ('ticket' | 'month')[];
}

export interface TicketCost {
  payment: PaymentInfo;
  project: string;
  total: UsageTotal;
  size: { size: 'small' | 'medium' | 'large'; times: number; words: string; from: number } | null;
  why: string;
  where: { by: 'cost' | 'tokens'; parts: { name: string; share: number; costUsd?: number }[] };
  month: MonthTotal;
  budget?: BudgetState;
  tip: string | null;
  details: { models: string; tokens: string | null };
  seconds?: number;
}

export interface QualityStat {
  quality: Quality;
  tickets: number;
  costUsd?: number;
  seconds?: number;
}

export interface BudgetWarning {
  kind: 'ticket' | 'month';
  id?: string;
  title?: string;
  spent: number;
  limit: number;
  share: number;
  over: boolean;
}

export interface CostOverview {
  payment: PaymentInfo;
  project: string;
  month: MonthTotal;
  budget: { ticketUsd?: number; monthUsd?: number };
  warnings: BudgetWarning[];
  quality: QualityStat[];
  qualityAfter: number;
}
