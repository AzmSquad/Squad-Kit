import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { Breakdown, BreakdownJob } from '../board/requirements-types.js';
import { breakdownDir, breakdownMediaDir } from '../board/requirements-paths.js';
import { readBreakdownState, updateBreakdownState, updateJob } from '../board/requirements.js';
import { DocumentError, textParts } from '../board/requirements-text.js';
import { addRun, type UsageKey } from '../board/usage.js';
import type { AgentUsage, ToolEvent } from '../modules/ai-tool/types.js';
import { aiTool } from '../modules/registry.js';
import { readAgent } from './agents.js';
import { personLevels, resolveLevel } from './levels.js';
import { CapReached } from './caps.js';
import type { DocumentFiles } from './breakdown-prompts.js';

/**
 * What every step of the Analyst's work on a breakdown shares (engine/breakdown-job.ts runs the steps): one run of the
 * Analyst, kept on the breakdown's own line with its conversation; the job's line on the board; where the document is;
 * and the two ways a step ends early, Stop and this month's budget.
 */

/** One run of the Analyst for the job. */
export interface AnalystAsk {
  /** The Analyst's step, for its model level and the cost: questions while reading, spec while writing. */
  step: 'questions' | 'spec';
  prompt: string;
  schema?: object;
  /** A new conversation with this id; the read starts one, the rest carry on in it. */
  sessionId?: string;
  resume?: string;
  timeoutMs: number;
  /** How many times the person pressed Give it more on this step: each time doubles its caps. */
  more?: number;
  onTool?(e: ToolEvent): void;
  onText?(text: string): void;
}

export interface AnalystAnswer {
  text: string;
  structured?: unknown;
  sessionId?: string;
  usage?: AgentUsage;
}

export interface BreakdownJobDeps {
  run(ask: AnalystAsk): Promise<AnalystAnswer>;
  /** Asked before every run: the words when this month's budget holds it, so nothing is cut in half. */
  budgetHold?(): Promise<string | null>;
  /** Aborted on Stop, and when the board closes. */
  signal?: AbortSignal;
}

/** Stop was pressed, or the board closed: the step ends where it is. */
export class Stopped extends Error {}

/** This month's budget holds the next run. Its message is the plain reason. */
export class HeldAtBudget extends Error {}

/** What the Analyst used, on its model level, for the breakdown's own line. */
function usageKey(bp: BoardPaths, step: string): UsageKey {
  try {
    const agent = readAgent(bp, 'analyst');
    const lv = resolveLevel({ role: 'analyst', step, quality: readMeta(bp).quality }, agent.levels, personLevels());
    return { role: 'analyst', step, level: lv.level, model: lv.model || aiTool(agent.tool)?.modelFor(lv.level) || '' };
  } catch {
    return { role: 'analyst', step, level: 'strongest', model: '' };
  }
}

/** Where the document is, for the Analyst: its text parts and pictures, or the PDF, and the files that came with it. */
export function documentFiles(bp: BoardPaths, b: Breakdown): DocumentFiles {
  const dir = breakdownDir(bp, b.id);
  const media = breakdownMediaDir(bp, b.id);
  // The Analyst must never be paid to read nothing, or to guess from a name.
  if (b.source.kind === 'pdf' ? !fs.existsSync(path.join(dir, b.source.file)) : !textParts(dir).length) throw new DocumentError(`The document of ${b.id} is no longer in its folder. Add the BRD again.`);
  return {
    kind: b.source.kind,
    ...(b.source.kind === 'pdf' ? { pdf: path.join(dir, b.source.file), ...(b.source.pages ? { pages: b.source.pages } : {}) } : {}),
    parts: textParts(dir).map((p) => path.join(dir, p)),
    ...(fs.existsSync(media) && fs.readdirSync(media).length ? { media } : {}),
    extra: (b.source.extra ?? []).map((f) => path.join(dir, f)),
  };
}

export interface Ctx {
  bp: BoardPaths;
  id: string;
  deps: BreakdownJobDeps;
  project: string;
}

export function goOn(ctx: Ctx): void {
  if (ctx.deps.signal?.aborted || readBreakdownState(ctx.bp, ctx.id).job?.status === 'stopping') throw new Stopped();
}

export function setNow(ctx: Ctx, text: string, more: Partial<BreakdownJob> = {}): void {
  updateJob(ctx.bp, ctx.id, (j) => {
    if (j.status === 'stopping') return;
    Object.assign(j, { now: text, ...more });
  });
}

/** One run of the Analyst; what it used goes on the breakdown's own line, and its conversation is kept for the next. */
export async function ask(ctx: Ctx, a: AnalystAsk): Promise<AnalystAnswer> {
  goOn(ctx);
  const held = await ctx.deps.budgetHold?.();
  if (held) throw new HeldAtBudget(held);
  const more = readBreakdownState(ctx.bp, ctx.id).capRaise ?? 0;
  const key = usageKey(ctx.bp, a.step);
  const kept = (run: { sessionId?: string; usage?: AgentUsage }) =>
    updateBreakdownState(ctx.bp, ctx.id, (s) => {
      s.usage = addRun(s.usage, key, run.usage);
      // ACP may give a conversation a new id: the next step carries on in the one this run ended in.
      const session = run.sessionId ?? a.sessionId;
      if (session && (a.sessionId || a.resume || !s.sessions?.read)) s.sessions = { ...s.sessions, read: session };
    });
  let r: AnalystAnswer;
  try {
    r = await ctx.deps.run({ ...a, ...(more ? { more } : {}) });
  } catch (err) {
    // Stopped at a cap: what it used counts, and Give it more carries on in its conversation.
    if (err instanceof CapReached && err.run) kept(err.run);
    throw err;
  }
  kept(r);
  if (more) updateBreakdownState(ctx.bp, ctx.id, (s) => delete s.capRaise);
  goOn(ctx);
  return r;
}
