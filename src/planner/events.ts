import type { ToolCall, Usage, PlannerRunStats } from './types.js';

export type PlannerEvent =
  | { kind: 'started'; runId: string; provider: string; model: string; cacheEnabled: boolean }
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
  | { kind: 'rate_limit'; runId: string; turn: number; waitSec: number }
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
  | { kind: 'cancelled'; runId: string };

export type PlannerEventListener = (e: PlannerEvent) => void;

export class PlannerEventBus {
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
