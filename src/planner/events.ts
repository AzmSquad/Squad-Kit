import type { PlannerAuthReason } from '../core/planner-auth.js';
import type { ToolCall, Usage, PlannerRunStats, ProviderName } from './types.js';

/** Mirrors the Agent SDK's `ApiKeySource`. `oauth` proves the subscription path is live. */
export type PlannerApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';

export type PlannerEvent =
  | {
      kind: 'started';
      runId: string;
      provider: string;
      model: string;
      cacheEnabled: boolean;
      plannerRuntime?: 'vercel' | 'agent-sdk';
    }
  | { kind: 'turn_started'; runId: string; turn: number }
  | { kind: 'request_sent'; runId: string; turn: number }
  | { kind: 'usage'; runId: string; turn: number; usage: Usage }
  | {
      kind: 'cache_summary';
      runId: string;
      turn: number;
      cacheHitRatio: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { kind: 'tool_call'; runId: string; turn: number; toolCall: ToolCall; bytesLoaded: number; totalBytes: number }
  | { kind: 'assistant_text'; runId: string; turn: number; delta: string }
  | {
      kind: 'rate_limit';
      runId: string;
      turn: number;
      /** Seconds the provider asked us to wait. Source-of-truth countdown. */
      retryAfterSec: number | undefined;
      /** Seconds we will actually sleep before retrying. Equals min(retryAfterSec, cap). */
      waitSec: number;
      /** Our retry cap. Lets the UI explain "we'll retry up to <cap>s". */
      capSec: number;
      /** 'retrying' = the loop is sleeping then retrying. 'aborted' = retryAfterSec > capSec, the loop will throw next. */
      phase: 'retrying' | 'aborted';
      provider: ProviderName;
      /** Same `Raw provider response` snippet as in the CLI message, capped at 200 chars. */
      rawBody?: string;
    }
  | { kind: 'turn_complete'; runId: string; turn: number; stopReason: string }
  | {
      kind: 'done';
      runId: string;
      success: boolean;
      planFile: string | null;
      partial: boolean;
      stats: PlannerRunStats;
      durationMs: number;
    }
  | { kind: 'error'; runId: string; message: string }
  | { kind: 'cancelled'; runId: string }
  | {
      kind: 'stage_started';
      runId: string;
      stage: 'scout' | 'draft' | 'validation';
    }
  | {
      kind: 'stage_complete';
      runId: string;
      stage: 'scout' | 'draft' | 'validation';
      success: boolean;
      durationMs: number;
      tokensUsed?: number;
      /** Present when success is false (truncated). */
      errorMessage?: string;
    }
  | {
      kind: 'scout_result';
      runId: string;
      selected: string[];
      reasoning: string;
    }
  | {
      kind: 'runtime_info';
      runId: string;
      provider: ProviderName;
      model: string;
      runtimeKind: 'vercel' | 'agent-sdk';
      cacheEnabled: boolean;
      scoutEnabled: boolean;
      validationEnabled: boolean;
      budgetCaps: { maxFileReads: number; maxContextBytes: number; maxDurationSeconds: number };
      /** Anthropic-only; absent for OpenAI/Google. */
      providerOptions?: {
        anthropic?: {
          thinking?: 'adaptive' | 'enabled' | 'disabled' | 'off';
          effort?: 'minimal' | 'medium' | 'high';
          effortByPhase?: { scout?: 'minimal' | 'medium' | 'high'; draft?: 'minimal' | 'medium' | 'high' };
        };
      };
    }
  | {
      /**
       * How this run authenticates. Emitted once by `runPlanner` right after `runtime_info`, and
       * again — enriched with `apiKeySource` (and `account` in subscription mode) — when the Agent
       * SDK reports its `system`/`init` message. Consumers take the most recent one; a run that is
       * cancelled before the SDK initialises only ever sees the first, so treat both as optional.
       */
      kind: 'auth_info';
      runId: string;
      mode: 'subscription' | 'api-key';
      reason: PlannerAuthReason;
      credentialHint: string;
      /** From the SDK init message. 'oauth' proves the subscription path is live. */
      apiKeySource?: PlannerApiKeySource;
      /** Live stream only — {@link redactPlannerEventForDisk} strips this before JSONL persistence. */
      account?: { email?: string; organization?: string; subscriptionType?: string };
    }
  | { kind: 'tool_call_started'; runId: string; turn: number; toolCallId: string; name: string; input: Record<string, unknown> }
  | {
      kind: 'tool_call_completed';
      runId: string;
      turn: number;
      toolCallId: string;
      name: string;
      durationMs: number;
      bytesLoaded: number;
      totalBytes: number;
      isError: boolean;
      /** First 200 chars of error message when isError. */
      errorSnippet?: string;
    }
  | {
      kind: 'thinking_delta';
      runId: string;
      turn: number;
      /** Index of the thinking block within this turn (resets per turn). */
      blockIndex: number;
      delta: string;
    }
  | { kind: 'thinking_block_started'; runId: string; turn: number; blockIndex: number }
  | {
      kind: 'thinking_block_stopped';
      runId: string;
      turn: number;
      blockIndex: number;
      durationMs: number;
      chars: number;
    }
  | {
      kind: 'validation_issue';
      runId: string;
      severity: 'warning' | 'error';
      issueKind: 'missing_path' | 'line_range_too_large' | 'symbol_not_found' | 'malformed_metadata';
      path?: string;
      detail: string;
      excerpt?: string;
    };

export type PlannerEventListener = (e: PlannerEvent) => void;

export class PlannerEventBus {
  /**
   * When `runPlanner` persists JSONL timelines, callers must await this once after emitting
   * terminal bus events (`done`) so streams flush before process exit.
   */
  finalizeEventPersistence?: () => Promise<void>;

  private listeners = new Set<PlannerEventListener>();
  emit(e: PlannerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* listener errors must not break the loop */
      }
    }
  }
  subscribe(fn: PlannerEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
