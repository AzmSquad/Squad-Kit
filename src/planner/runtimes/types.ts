import type { z } from 'zod';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { Budget } from '../budget.js';
import type { PlannerEventBus } from '../events.js';
import type { Usage, ToolCall, ProviderName } from '../types.js';
import type { PlannerLimitDecision, PlannerSessionLimitContext } from '../session-limits.js';
import type { PlannerToolDefinition } from './planner-tool-def.js';

export type { PlannerToolDefinition } from './planner-tool-def.js';

export interface RunDraftInput {
  systemPrompt: string;
  userMessage: string;
  tools: PlannerToolDefinition[];
  bus: PlannerEventBus;
  runId: string;
  budget: Budget;
  abort?: AbortSignal;
  maxSteps: number;
  maxOutputTokens: number;
  /** Per-runtime extras — Anthropic Agent SDK uses thinking/effort; Vercel ignores. */
  providerSpecific?: AnthropicProviderSpecific;
  /** Called per assistant text delta to feed live UI. */
  onAssistantText?: (delta: string) => void;
  /** Called when the model reports token usage (per-step on Vercel; once at end on Agent SDK). */
  onUsage?: (u: Usage) => void;
  /** Called per `read_file` / `grep` / `list_dir` tool execution. */
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
  /** Used by `VercelRuntime` only — rebuild planner tools each turn with an updated turn counter. */
  vercelLoop?: VercelDraftLoopConfig;
}

export interface VercelDraftLoopConfig {
  model: LanguageModelV2;
  provider: ProviderName;
  modelId: string;
  root: string;
  userPrompt: string;
  scoutedSection?: string;
  cacheEnabled: boolean;
  toolsEnabled?: { grep?: boolean; listDir?: boolean; rangedRead?: boolean };
  decideOnLimit?: (ctx: PlannerSessionLimitContext) => Promise<PlannerLimitDecision>;
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (waitSec: number) => void;
}

export interface RunDraftOutput {
  text: string;
  finishedNormally: boolean;
  incompleteKind?: 'max_output_tokens' | 'max_iterations' | 'wall_clock' | 'budget_reads';
  iterations: number;
  finalUsage: Usage;
  budgetExhausted?: boolean;
  timedOut?: boolean;
  userCancelled?: boolean;
}

export interface RunScoutInput<TSchema extends z.ZodType = z.ZodType> {
  systemPrompt: string;
  userMessage: string;
  schema: TSchema;
  bus: PlannerEventBus;
  runId: string;
  abort?: AbortSignal;
  maxOutputTokens: number;
  providerSpecific?: AnthropicProviderSpecific;
}

export interface RunScoutOutput<T> {
  output: T;
  usage: Usage;
}

export interface AnthropicProviderSpecific {
  thinking?: 'adaptive' | 'enabled' | 'disabled' | 'off';
  thinkingBudget?: number;
  effort?: 'minimal' | 'medium' | 'high';
}

export interface PlannerRuntime {
  readonly kind: 'vercel' | 'agent-sdk';
  readonly providerName: 'anthropic' | 'openai' | 'google';
  readonly modelId: string;

  runDraft(input: RunDraftInput): Promise<RunDraftOutput>;

  runScout<TSchema extends z.ZodType>(
    input: RunScoutInput<TSchema>,
  ): Promise<RunScoutOutput<z.infer<TSchema>> | null>;
}
