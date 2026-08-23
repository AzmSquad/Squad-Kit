import type { PlannerAuthMode } from '../core/planner-auth.js';

export type PlannerPhase = 'plan' | 'execute' | 'scout';

export type ProviderName = 'anthropic' | 'openai' | 'google';

export interface PlannerModelOverride {
  anthropic?: string;
  openai?: string;
  google?: string;
}

export interface PlannerCacheConfig {
  enabled: boolean;
}

export interface PlannerStagesConfig {
  scout?: { enabled?: boolean; modelOverride?: string; maxFiles?: number; maxOutputTokens?: number };
}

export interface PlannerToolsConfig {
  grep?: boolean;
  listDir?: boolean;
  rangedRead?: boolean;
}

export interface PlannerValidationConfig {
  enabled?: boolean;
  /** When true, plans with validation issues are written as `*.partial.md`. */
  strict?: boolean;
}

export type AnthropicPlannerThinkingMode = 'adaptive' | 'enabled' | 'disabled' | 'off';

export type AnthropicPlannerEffort = 'minimal' | 'medium' | 'high';

export interface AnthropicPlannerProviderOptions {
  thinking?: AnthropicPlannerThinkingMode;
  effort?: AnthropicPlannerEffort;
  effortByPhase?: { scout?: AnthropicPlannerEffort; draft?: AnthropicPlannerEffort };
  /** Used when `thinking` is `enabled` (fixed budget). */
  thinkingBudget?: number;
}

export interface PlannerConfig {
  enabled: boolean;
  provider: ProviderName;
  mode: 'auto' | 'copy';
  budget: BudgetConfig;
  /**
   * Optional per-provider model override. When set, replaces the pinned MAP value
   * for the plan phase. Executors: used when providers deprecate a pinned snapshot
   * between squad-kit releases, or to trial a newer model ahead of pinning.
   */
  modelOverride?: PlannerModelOverride;
  /**
   * Prompt caching. When enabled (default), squad-kit attaches provider-specific cache markers
   * (Anthropic cache_control) and relies on OpenAI / Google implicit caching. Cached tokens
   * bill at ~10–25% of normal rate and do not consume ITPM the same way, which is critical
   * for Anthropic Tier 1 users planning with Opus.
   *
   * Only turn this off for debugging or when comparing billed costs with/without caching.
   */
  cache?: PlannerCacheConfig;
  /**
   * Max completion tokens per provider request in the planner loop (each model round).
   * Long plans can hit the API output cap and truncate mid-document. Omitted defaults to 16384.
   * Anthropic/OpenAI/Google each enforce their own upper bounds.
   */
  maxOutputTokens?: number;
  /** Multi-stage planner: cheap scout pre-ranks files before the draft model runs. */
  stages?: PlannerStagesConfig;
  tools?: PlannerToolsConfig;
  validation?: PlannerValidationConfig;
  /**
   * Planner LLM runtime. Anthropic defaults to the Agent SDK so Opus 4.7+ request shapes work;
   * OpenAI and Google always use the Vercel AI SDK path inside the implementation.
   */
  runtime?: { anthropic?: 'agent-sdk' | 'vercel' };
  /** Provider-specific request tuning (Anthropic thinking/effort for Agent SDK path). */
  providerOptions?: { anthropic?: AnthropicPlannerProviderOptions };
  /**
   * How each provider authenticates. Per-provider map so the shape can extend later;
   * only `anthropic` is populated today. Merges to `auto` when absent.
   */
  auth?: {
    anthropic?: PlannerAuthMode;
  };
}

export interface PlannerRunStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** cacheReadTokens / (inputTokens + cacheReadTokens), rounded to a 2-decimal fraction. 0 when no input tokens. */
  cacheHitRatio: number;
  durationMs: number;
}

export interface BudgetConfig {
  maxFileReads: number;
  maxContextBytes: number;
  maxDurationSeconds: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  /** Matches the original ToolCall.name (grep, list_dir, read_file, …). */
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export type ProviderErrorKind = 'rate_limit' | 'model_not_found' | 'unknown';

export interface ProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage?: Usage;
  rawError?: string;
  /**
   * Structured error classification. Set by provider adapters when the shape of the error
   * is recognised; used by `runPlanner` to pick the right retry behaviour and the right
   * user-facing hint. Absent when the adapter did not classify the error.
   */
  errorKind?: ProviderErrorKind;
  /** For `errorKind === 'rate_limit'`: seconds the provider asked us to wait. */
  retryAfterSec?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the provider cache on this turn (first time this prefix was seen). */
  cacheCreationTokens?: number;
  /** Tokens served from the provider cache on this turn (not billed at full rate, does not count ITPM). */
  cacheReadTokens?: number;
}
