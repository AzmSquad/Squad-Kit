import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, UnauthorizedError } from '~/api/client';
import type { ApiActiveRun, ApiResolvedAuthMode, PlannerStreamEventWire } from '~/api/types';

const ACTIVITY_CAP = 200;
const TOKENS_CAP_FLOOR = 8192;

export type GeneratePhase =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed';

export type RateLimitStateUI = {
  provider: 'anthropic' | 'openai' | 'google';
  retryAfterSec: number;
  capSec: number;
  phase: 'retrying' | 'aborted';
  receivedAtMs: number;
  rawBody: string;
};

export type RuntimeInfo = {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  runtimeKind: 'vercel' | 'agent-sdk';
  cacheEnabled: boolean;
  scoutEnabled: boolean;
  validationEnabled: boolean;
  budgetCaps: { maxFileReads: number; maxContextBytes: number; maxDurationSeconds: number };
  providerOptions?: PlannerStreamEventWire['providerOptions'];
};

/**
 * Auth telemetry for *this* run, from the `auth_info` SSE event.
 *
 * Keyed to the run rather than to the live config on purpose: a Config save while a run is in
 * flight must not retro-change the badge on a run that already picked its credential.
 */
export type AuthInfoUI = {
  mode: ApiResolvedAuthMode;
  reason?: string;
  credentialHint?: string;
  /** From the Agent SDK init message; `oauth` proves the subscription path is live. */
  apiKeySource?: string;
  /** Live stream only — stripped before the event is written to JSONL. */
  account?: { email?: string; organization?: string; subscriptionType?: string };
};

export type StageKey = 'scout' | 'draft' | 'validation';
export type StageNodePhase = 'idle' | 'running' | 'success' | 'failed' | 'skipped';

export type StageNodeState = {
  phase: StageNodePhase;
  startedAt?: number;
  durationMs?: number;
  errorMessage?: string;
};

export type StagesState = Record<StageKey, StageNodeState>;

export type TokenTurnPoint = {
  turn: number;
  input: number;
  output: number;
  sum: number;
};

export type TokenState = {
  input: number;
  output: number;
  sum: number;
  ceiling: number;
  perTurn: TokenTurnPoint[];
};

export type BudgetState = {
  caps: RuntimeInfo['budgetCaps'] | null;
  fileReadsCompleted: number;
  contextBytesApprox: number;
};

export type ToolEventKind = 'running' | 'success' | 'error';

export interface ToolEvent {
  toolCallId: string;
  turn: number;
  name: string;
  path?: string;
  kind: ToolEventKind;
  bytesLoaded?: number;
  totalBytes?: number;
  durationMs?: number;
  errorSnippet?: string;
  startedAtMs: number;
}

export type ThinkingBlockState = 'running' | 'done';

export interface ThinkingRow {
  key: string;
  turn: number;
  blockIndex: number;
  text: string;
  summaryOnly?: boolean;
  state: ThinkingBlockState;
  durationMs?: number;
  chars?: number;
}

export type ThinkingState = { blocks: ThinkingRow[] };

export type ScoutState = {
  selected: string[] | null;
  reasoning: string | null;
  failed?: boolean;
};

export type ValidationIssue = {
  id: string;
  severity: 'warning' | 'error';
  issueKind: 'missing_path' | 'line_range_too_large' | 'symbol_not_found' | 'malformed_metadata';
  path?: string;
  detail: string;
  excerpt?: string;
};

export type ActivityStage = StageKey | 'unknown';

export type ActivityFeedRow =
  | {
      type: 'tool';
      id: string;
      stage: ActivityStage;
      toolCallId: string;
      turn: number;
      name: string;
      path?: string;
      rowState: ToolEventKind;
      bytesLoaded?: number;
      totalBytes?: number;
      durationMs?: number;
      errorSnippet?: string;
    }
  | {
      type: 'thinking';
      id: string;
      stage: ActivityStage;
      thinkingKey: string;
      turn: number;
      blockIndex: number;
      text: string;
      summaryOnly?: boolean;
      rowState: ThinkingBlockState;
      durationMs?: number;
      chars?: number;
    }
  | { type: 'scout_decision'; id: string; stage: 'scout'; selected: string[]; reasoning: string }
  | {
      type: 'validation_issue';
      id: string;
      stage: ActivityStage;
      issue: ValidationIssue;
    }
  | { type: 'stage_marker'; id: string; stage: StageKey };

export interface GenerateRunState {
  phase: GeneratePhase;
  runId: string | null;
  startedAtMs: number | null;
  feature: string;
  storyId: string;
  mode: 'api' | 'copy';
  runtime: RuntimeInfo | null;
  stages: StagesState;
  tokens: TokenState;
  cacheHitPct: number | null;
  cacheHitPctPerTurn: number[];
  budget: BudgetState;
  tools: ToolEvent[];
  thinking: ThinkingState;
  scout: ScoutState;
  validation: ValidationIssue[];
  assistantMd: string;
  planFile: string | null;
  rateLimit: RateLimitStateUI | null;
  multiTab: { count: number };
  activities: ActivityFeedRow[];
  turn: number;
  error: string | null;
  /**
   * Machine-readable code from a failed `POST /api/runs` (`auth_unavailable`, `planner_disabled`,
   * …). `error` alone forced the UI to render every failure as a bare string; the recovery states
   * need to know *which* failure it was.
   */
  errorCode: string | null;
  auth: AuthInfoUI | null;
}

const EMPTY_STAGE: StageNodeState = { phase: 'idle' };

export const INITIAL_GENERATE_RUN_STATE: GenerateRunState = {
  phase: 'idle',
  runId: null,
  startedAtMs: null,
  feature: '',
  storyId: '',
  mode: 'api',
  runtime: null,
  stages: {
    scout: { ...EMPTY_STAGE },
    draft: { ...EMPTY_STAGE },
    validation: { ...EMPTY_STAGE },
  },
  tokens: {
    input: 0,
    output: 0,
    sum: 0,
    ceiling: TOKENS_CAP_FLOOR,
    perTurn: [],
  },
  cacheHitPct: null,
  cacheHitPctPerTurn: [],
  budget: { caps: null, fileReadsCompleted: 0, contextBytesApprox: 0 },
  tools: [],
  thinking: { blocks: [] },
  scout: { selected: null, reasoning: null },
  validation: [],
  assistantMd: '',
  planFile: null,
  rateLimit: null,
  multiTab: { count: 0 },
  activities: [],
  turn: 0,
  error: null,
  errorCode: null,
  auth: null,
};

type Action =
  | { type: 'set_story'; feature: string; storyId: string }
  | { type: 'set_mode'; mode: 'api' | 'copy' }
  | { type: 'start_post' }
  | { type: 'start_stream'; runId: string }
  | { type: 'resume'; runId: string; feature: string; storyId: string }
  | { type: 'fail'; message: string; code?: string }
  | { type: 'reset_stream_ui' }
  | { type: 'reset_all' }
  | { type: 'cancel_requested' }
  | { type: 'disconnect_stream' }
  | { type: 'set_multi_tab'; count: number }
  | { type: 'sse'; event: PlannerStreamEventWire };

let feedSeq = 0;
function nextFeedId(prefix: string) {
  feedSeq += 1;
  return `${prefix}-${feedSeq}`;
}

function cap<T>(xs: readonly T[]): T[] {
  if (xs.length <= ACTIVITY_CAP) return [...xs];
  return xs.slice(-ACTIVITY_CAP);
}

function pushActivity(rows: ActivityFeedRow[], row: ActivityFeedRow): ActivityFeedRow[] {
  return cap([...rows, row]);
}

function findToolActivityIndex(rows: ActivityFeedRow[], toolCallId: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'tool' && r.toolCallId === toolCallId) return i;
  }
  return -1;
}

function findThinkingRowIndex(blocks: ThinkingRow[], thinkingKey: string): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.key === thinkingKey) return i;
  }
  return -1;
}

function findThinkingActivityIndex(rows: ActivityFeedRow[], thinkingKey: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'thinking' && r.thinkingKey === thinkingKey) return i;
  }
  return -1;
}

function updateToolRows(
  tools: ToolEvent[],
  toolCallId: string,
  fn: (prev: ToolEvent | undefined) => ToolEvent,
): ToolEvent[] {
  const ix = tools.findIndex((t) => t.toolCallId === toolCallId);
  const prev = ix >= 0 ? tools[ix] : undefined;
  const nextTool = fn(prev);
  if (ix >= 0) {
    const copy = [...tools];
    copy[ix] = nextTool;
    return copy.slice(-ACTIVITY_CAP);
  }
  return [...tools, nextTool].slice(-ACTIVITY_CAP);
}

function readToolPath(input?: Record<string, unknown>): string | undefined {
  const p = input?.path;
  return typeof p === 'string' ? p : undefined;
}

function budgetToolName(name?: string): boolean {
  const n = (name ?? '').toLowerCase();
  return n === 'read_file' || n === 'grep' || n === 'list_dir';
}

function activityStageMarker(stages: StagesState, runTurn: number): ActivityStage {
  if (stages.validation.phase === 'running') return 'validation';
  if (stages.draft.phase === 'running') return 'draft';
  if (stages.scout.phase === 'running') return 'scout';
  if (runTurn >= 1 && stages.draft.phase === 'success') return 'draft';
  return 'scout';
}

/** Call before hydrating a persisted event timeline so feed row ids replay deterministically. */
export function resetGenerateFeedSeqForReplay(): void {
  feedSeq = 0;
}

export function applyGenerateEvent(
  state: GenerateRunState,
  e: PlannerStreamEventWire,
  nowMs: number,
): GenerateRunState {
  let next = state;

  const ignoreRateLimit = next.phase === 'cancelled' || next.phase === 'cancelling';

  const markStage = (): ActivityStage => activityStageMarker(next.stages, e.turn ?? next.turn);

  if (
    e.kind === 'rate_limit' &&
    !ignoreRateLimit &&
    e.phase
  ) {
    next = {
      ...next,
      rateLimit: {
        provider: e.provider ?? 'anthropic',
        retryAfterSec: e.retryAfterSec ?? e.waitSec ?? 0,
        capSec: e.capSec ?? 90,
        phase: e.phase,
        receivedAtMs: nowMs,
        rawBody: e.rawBody ?? '',
      },
      phase: e.phase === 'aborted' && next.phase !== 'cancelling' ? 'failed' : next.phase,
    };
  }

  if (e.kind === 'runtime_info') {
    const caps = e.budgetCaps ?? {
      maxFileReads: 500,
      maxContextBytes: 4_194_304,
      maxDurationSeconds: 3600,
    };
    next = {
      ...next,
      runtime: {
        provider: e.provider ?? 'anthropic',
        model: e.model ?? 'unknown',
        runtimeKind: e.runtimeKind ?? 'agent-sdk',
        cacheEnabled: Boolean(e.cacheEnabled),
        scoutEnabled: Boolean(e.scoutEnabled ?? true),
        validationEnabled: Boolean(e.validationEnabled ?? true),
        budgetCaps: caps,
        providerOptions: e.providerOptions,
      },
      budget: { ...next.budget, caps },
    };
  }

  if (e.kind === 'stage_started' && e.stage) {
    const prev = next.stages[e.stage];
    const phase: StageNodePhase = prev.phase === 'skipped' ? 'skipped' : 'running';
    next = {
      ...next,
      stages: {
        ...next.stages,
        [e.stage]: {
          phase: phase === 'skipped' ? 'skipped' : 'running',
          startedAt: nowMs,
          durationMs: undefined,
          errorMessage: undefined,
        },
      },
      activities: pushActivity(next.activities, {
        type: 'stage_marker',
        id: nextFeedId('stage'),
        stage: e.stage,
      }),
    };
  }

  if (e.kind === 'stage_complete' && e.stage) {
    const success = Boolean(e.success);
    const node: StageNodeState = {
      phase: success ? 'success' : 'failed',
      durationMs: e.durationMs,
      errorMessage: e.errorMessage,
      startedAt: next.stages[e.stage].startedAt,
    };
    next = {
      ...next,
      stages: {
        ...next.stages,
        [e.stage]: node,
      },
    };
    if (e.stage === 'scout' && !success)
      next = { ...next, scout: { ...next.scout, failed: true } };
  }

  if (e.kind === 'scout_result') {
    const reasoning = typeof e.reasoning === 'string' ? e.reasoning : '';
    const selected = Array.isArray(e.selected) ? e.selected : [];
    next = {
      ...next,
      scout: {
        selected: selected.length ? selected : null,
        reasoning: reasoning || null,
        failed: false,
      },
      stages: {
        ...next.stages,
        scout:
          next.stages.scout.phase === 'idle'
            ? { phase: 'success', durationMs: 0 }
            : next.stages.scout,
      },
      activities: pushActivity(next.activities, {
        type: 'scout_decision',
        id: nextFeedId('scout'),
        stage: 'scout',
        selected: selected.length ? selected : [],
        reasoning,
      }),
    };
  }

  const st = () => markStage();

  if (e.kind === 'tool_call_started' && e.toolCallId) {
    const path = readToolPath(e.input);
    next = {
      ...next,
      tools: updateToolRows(next.tools, e.toolCallId, () => ({
        toolCallId: e.toolCallId!,
        turn: e.turn ?? next.turn,
        name: e.name ?? 'tool',
        path,
        kind: 'running',
        startedAtMs: nowMs,
      })),
      activities: pushActivity(next.activities, {
        type: 'tool',
        id: nextFeedId('tool'),
        stage: st(),
        toolCallId: e.toolCallId,
        turn: e.turn ?? next.turn,
        name: e.name ?? 'tool',
        path,
        rowState: 'running',
      }),
    };
  }

  if (e.kind === 'tool_call' && e.toolCall) {
    const path =
      readToolPath(e.toolCall.input) ?? readToolPath((e.toolCall as { input?: Record<string, unknown> }).input);
    const nm =
      typeof (e.toolCall as { name?: string }).name === 'string'
        ? (e.toolCall as { name: string }).name
        : 'read_file';

    if (e.toolCallId) {
      next = {
        ...next,
        tools: updateToolRows(next.tools, e.toolCallId, (prev) => ({
          toolCallId: e.toolCallId!,
          turn: e.turn ?? next.turn,
          name: prev?.name ?? nm,
          path: prev?.path ?? path,
          kind:
            prev?.kind === 'success' || prev?.kind === 'error'
              ? prev.kind
              : prev?.kind === 'running'
                ? 'running'
                : 'running',
          bytesLoaded: e.bytesLoaded ?? prev?.bytesLoaded,
          totalBytes: e.totalBytes ?? prev?.totalBytes,
          durationMs: prev?.durationMs,
          startedAtMs: prev?.startedAtMs ?? nowMs,
        })),
      };
      const ix = findToolActivityIndex(next.activities, e.toolCallId);
      if (ix >= 0) {
        const prev = next.activities[ix] as Extract<ActivityFeedRow, { type: 'tool' }>;
        const copy = [...next.activities];
        copy[ix] = {
          ...prev,
          bytesLoaded: e.bytesLoaded ?? prev.bytesLoaded,
          totalBytes: e.totalBytes ?? prev.totalBytes,
          path: prev.path ?? path,
        };
        next = { ...next, activities: copy };
      }
    } else {
      const synthId = `legacy-${nextFeedId('id')}`;
      next = {
        ...next,
        tools: updateToolRows(next.tools, synthId, (prev) => ({
          toolCallId: synthId,
          turn: e.turn ?? next.turn,
          name: nm,
          path,
          kind: 'success',
          bytesLoaded: e.bytesLoaded,
          totalBytes: e.totalBytes,
          startedAtMs: prev?.startedAtMs ?? nowMs,
        })),
        activities: pushActivity(next.activities, {
          type: 'tool',
          id: nextFeedId('tool'),
          stage: st(),
          toolCallId: synthId,
          turn: e.turn ?? next.turn,
          name: nm,
          path,
          rowState: 'success',
          bytesLoaded: e.bytesLoaded,
          totalBytes: e.totalBytes,
        }),
      };
    }
  }

  if (e.kind === 'tool_call_completed' && e.toolCallId) {
    const ok = !e.isError;
    const finalized = [...updateToolRows(next.tools, e.toolCallId, (prev) => ({
      toolCallId: e.toolCallId!,
      turn: e.turn ?? next.turn,
      name: prev?.name ?? e.name ?? 'tool',
      path: prev?.path,
      kind: ok ? 'success' : 'error',
      bytesLoaded: e.bytesLoaded ?? prev?.bytesLoaded,
      totalBytes: e.totalBytes ?? prev?.totalBytes,
      durationMs: e.durationMs,
      errorSnippet: e.errorSnippet ?? prev?.errorSnippet,
      startedAtMs: prev?.startedAtMs ?? nowMs,
    }))];
    const tname =
      finalized.find((t) => t.toolCallId === e.toolCallId)?.name ?? e.name;
    next = { ...next, tools: finalized };
    const ix = findToolActivityIndex(next.activities, e.toolCallId);
    if (ix >= 0) {
      const prev = next.activities[ix] as Extract<ActivityFeedRow, { type: 'tool' }>;
      const copy = [...next.activities];
      copy[ix] = {
        ...prev,
        rowState: ok ? 'success' : 'error',
        bytesLoaded: e.bytesLoaded ?? prev.bytesLoaded,
        totalBytes: e.totalBytes ?? prev.totalBytes,
        durationMs: e.durationMs,
        errorSnippet: e.errorSnippet,
      };
      next = { ...next, activities: copy };
    }
    if (ok && budgetToolName(tname)) {
      const bl = e.bytesLoaded ?? 0;
      next = {
        ...next,
        budget: {
          ...next.budget,
          fileReadsCompleted: next.budget.fileReadsCompleted + 1,
          contextBytesApprox: next.budget.contextBytesApprox + bl,
        },
      };
    }
  }

  if (e.kind === 'thinking_block_started' && typeof e.turn === 'number' && typeof e.blockIndex === 'number') {
    const thinkingKey = `${e.turn}-${e.blockIndex}`;
    const blk: ThinkingRow = {
      key: thinkingKey,
      turn: e.turn,
      blockIndex: e.blockIndex,
      text: '',
      state: 'running',
    };
    next = {
      ...next,
      thinking: { blocks: [...next.thinking.blocks, blk].slice(-ACTIVITY_CAP) },
      activities: pushActivity(next.activities, {
        type: 'thinking',
        id: nextFeedId('think'),
        stage: st(),
        thinkingKey,
        turn: e.turn,
        blockIndex: e.blockIndex,
        text: '',
        summaryOnly: false,
        rowState: 'running',
      }),
    };
  }

  if (e.kind === 'thinking_delta' && typeof e.turn === 'number' && typeof e.blockIndex === 'number') {
    const thinkingKey = `${e.turn}-${e.blockIndex}`;
    const delta = typeof e.delta === 'string' ? e.delta : '';
    const bx = findThinkingRowIndex(next.thinking.blocks, thinkingKey);
    if (bx >= 0) {
      const copyB = [...next.thinking.blocks];
      const pb = copyB[bx]!;
      copyB[bx] = { ...pb, text: delta ? pb.text + delta : pb.text };
      next = { ...next, thinking: { blocks: copyB } };
    }
    const ax = findThinkingActivityIndex(next.activities, thinkingKey);
    if (ax >= 0) {
      const pa = next.activities[ax] as Extract<ActivityFeedRow, { type: 'thinking' }>;
      const na = [...next.activities];
      na[ax] = {
        ...pa,
        text: delta ? pa.text + delta : pa.text,
        summaryOnly: delta === '' ? true : pa.summaryOnly ?? false,
      };
      next = { ...next, activities: na };
    }
  }

  if (e.kind === 'thinking_block_stopped' && typeof e.turn === 'number' && typeof e.blockIndex === 'number') {
    const thinkingKey = `${e.turn}-${e.blockIndex}`;
    const durationMs = typeof e.durationMs === 'number' ? e.durationMs : 0;
    const chars = typeof e.chars === 'number' ? e.chars : 0;
    const bx = findThinkingRowIndex(next.thinking.blocks, thinkingKey);
    if (bx >= 0) {
      const copyB = [...next.thinking.blocks];
      const pb = copyB[bx]!;
      const summaryOnly = pb.text.trim().length === 0;
      copyB[bx] = {
        ...pb,
        state: 'done',
        durationMs,
        chars,
        summaryOnly,
      };
      next = { ...next, thinking: { blocks: copyB } };
    }
    const ax = findThinkingActivityIndex(next.activities, thinkingKey);
    if (ax >= 0) {
      const pa = next.activities[ax] as Extract<ActivityFeedRow, { type: 'thinking' }>;
      const summaryOnly = pa.text.trim().length === 0;
      const na = [...next.activities];
      na[ax] = {
        ...pa,
        rowState: 'done',
        durationMs,
        chars,
        summaryOnly,
      };
      next = { ...next, activities: na };
    }
  }

  if (e.kind === 'usage' && e.usage) {
    const inn = e.usage.inputTokens ?? next.tokens.input;
    const out = e.usage.outputTokens ?? next.tokens.output;
    const sum = inn + out;
    const ceil = Math.max(next.tokens.ceiling, Math.ceil(sum * 1.15), TOKENS_CAP_FLOOR);
    const turnPt = e.turn ?? next.turn;
    const pts = [...next.tokens.perTurn];
    const ix = pts.findIndex((p) => p.turn === turnPt);
    const row: TokenTurnPoint = { turn: turnPt, input: inn, output: out, sum };
    if (ix >= 0) pts[ix] = row;
    else pts.push(row);
    next = {
      ...next,
      tokens: { input: inn, output: out, sum, ceiling: ceil, perTurn: pts.slice(-ACTIVITY_CAP) },
    };
  }

  if (e.kind === 'cache_summary' && typeof e.cacheHitRatio === 'number') {
    const pct = Math.round(e.cacheHitRatio * 100);
    const pts = [...next.cacheHitPctPerTurn, pct];
    next = {
      ...next,
      cacheHitPct: pct,
      cacheHitPctPerTurn: pts.slice(-ACTIVITY_CAP),
    };
  }

  if (e.kind === 'validation_issue' && e.issueKind && e.detail) {
    const iss: ValidationIssue = {
      id: nextFeedId('val'),
      severity: e.severity ?? 'warning',
      issueKind: e.issueKind,
      path: e.path,
      detail: e.detail,
      excerpt: e.excerpt,
    };
    next = {
      ...next,
      validation: [...next.validation, iss],
      activities: pushActivity(next.activities, {
        type: 'validation_issue',
        id: iss.id,
        stage: st(),
        issue: iss,
      }),
    };
  }

  if (e.kind === 'auth_info' && e.mode) {
    next = {
      ...next,
      auth: {
        mode: e.mode,
        reason: e.reason,
        credentialHint: e.credentialHint,
        // The Agent SDK emits a second, enriched `auth_info` at init; keep whatever the newest
        // event knows and never regress a filled field back to undefined.
        apiKeySource: e.apiKeySource ?? next.auth?.apiKeySource,
        account: e.account ?? next.auth?.account,
      },
    };
  }

  if (e.kind === 'assistant_text' && e.delta)
    next = { ...next, assistantMd: next.assistantMd + e.delta };

  if (typeof e.turn === 'number') next = { ...next, turn: e.turn };

  if (e.kind === 'cancelled') next = { ...next, phase: 'cancelled', rateLimit: null };

  if (e.kind === 'done') {
    if (next.phase === 'failed' && next.error) {
      next = { ...next, planFile: e.planFile ?? next.planFile };
      return next;
    }
    const wasCancelled = next.phase === 'cancelled' || next.phase === 'cancelling';
    next = { ...next, planFile: e.planFile ?? null };

    if (e.success) next = { ...next, phase: 'done', error: null, rateLimit: null };
    else if (wasCancelled || e.partial) next = { ...next, phase: 'cancelled' };
    else next = { ...next, phase: 'failed', error: 'Planning did not finish cleanly.' };
  }

  if (e.kind === 'error' && e.message)
    next = { ...next, phase: 'failed', error: e.message, rateLimit: null };

  return next;
}

export function generateRunReducer(state: GenerateRunState, action: Action): GenerateRunState {
  switch (action.type) {
    case 'set_multi_tab':
      return { ...state, multiTab: { count: action.count } };
    case 'set_story':
      return { ...state, feature: action.feature, storyId: action.storyId };
    case 'set_mode':
      return { ...state, mode: action.mode };
    case 'start_post':
      return {
        ...state,
        phase: 'starting',
        error: null,
        errorCode: null,
        auth: null,
        rateLimit: null,
        assistantMd: '',
        planFile: null,
        cacheHitPct: null,
        cacheHitPctPerTurn: [],
        activities: [],
        tools: [],
        thinking: { blocks: [] },
        scout: { selected: null, reasoning: null },
        validation: [],
        tokens: {
          input: 0,
          output: 0,
          sum: 0,
          ceiling: TOKENS_CAP_FLOOR,
          perTurn: [],
        },
        budget: { caps: null, fileReadsCompleted: 0, contextBytesApprox: 0 },
        runtime: null,
        stages: {
          scout: { ...EMPTY_STAGE },
          draft: { ...EMPTY_STAGE },
          validation: { ...EMPTY_STAGE },
        },
        turn: 0,
        startedAtMs: Date.now(),
      };
    case 'start_stream':
      return {
        ...state,
        phase: 'streaming',
        runId: action.runId,
        startedAtMs: state.startedAtMs ?? Date.now(),
        rateLimit: null,
      };
    case 'resume':
      return {
        ...INITIAL_GENERATE_RUN_STATE,
        phase: 'streaming',
        runId: action.runId,
        feature: action.feature,
        storyId: action.storyId,
        mode: 'api',
        startedAtMs: Date.now(),
        error: null,
        errorCode: null,
      };
    case 'cancel_requested':
      if (state.phase !== 'streaming' && state.phase !== 'starting') return state;
      return { ...state, phase: 'cancelling' };
    case 'disconnect_stream':
      return { ...state, runId: null, phase: 'cancelled', rateLimit: null };
    case 'reset_stream_ui':
      return {
        ...state,
        phase: 'idle',
        runId: null,
        error: null,
        errorCode: null,
        auth: null,
        rateLimit: null,
        startedAtMs: null,
        planFile: null,
        assistantMd: '',
        activities: [],
        tools: [],
        thinking: { blocks: [] },
        scout: { selected: null, reasoning: null },
        validation: [],
        cacheHitPct: null,
        cacheHitPctPerTurn: [],
        tokens: {
          input: 0,
          output: 0,
          sum: 0,
          ceiling: TOKENS_CAP_FLOOR,
          perTurn: [],
        },
        budget: { caps: null, fileReadsCompleted: 0, contextBytesApprox: 0 },
        runtime: null,
        stages: {
          scout: { ...EMPTY_STAGE },
          draft: { ...EMPTY_STAGE },
          validation: { ...EMPTY_STAGE },
        },
        turn: 0,
      };
    case 'reset_all':
      return INITIAL_GENERATE_RUN_STATE;
    case 'fail':
      return { ...state, phase: 'failed', error: action.message, errorCode: action.code ?? null, runId: null };
    case 'sse':
      return applyGenerateEvent(state, action.event, Date.now());
    default:
      return state;
  }
}

function useEventSourceBridge(runId: string | null, dispatch: React.Dispatch<Action>) {
  useEffect(() => {
    if (!runId) return;

    const token = sessionStorage.getItem('squad.console.token');
    if (!token) return;

    const url = `/api/runs/${encodeURIComponent(runId)}/stream?t=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    const on = (name: string, fn: (data: string) => void) => {
      es.addEventListener(name, (ev) => fn((ev as MessageEvent).data as string));
    };

    const handlePayload = (data: string) => {
      try {
        const parsed = JSON.parse(data) as PlannerStreamEventWire;
        dispatch({ type: 'sse', event: parsed });
      } catch {
        /* ignore */
      }
    };

    on('stage_started', handlePayload);
    on('stage_complete', handlePayload);
    on('scout_result', handlePayload);
    on('validation_issue', handlePayload);
    on('started', handlePayload);
    on('runtime_info', handlePayload);
    on('auth_info', handlePayload);
    on('turn_started', handlePayload);
    on('request_sent', handlePayload);
    on('usage', handlePayload);
    on('cache_summary', handlePayload);
    on('tool_call', handlePayload);
    on('tool_call_started', handlePayload);
    on('tool_call_completed', handlePayload);
    on('assistant_text', handlePayload);
    on('thinking_delta', handlePayload);
    on('thinking_block_started', handlePayload);
    on('thinking_block_stopped', handlePayload);
    on('rate_limit', handlePayload);
    on('turn_complete', handlePayload);
    on('done', handlePayload);
    on('error', handlePayload);
    on('cancelled', handlePayload);
    on('ping', () => {});

    es.addEventListener('closed', () => es.close());

    return () => es.close();
  }, [runId, dispatch]);
}

export function useGenerateRun(): {
  state: GenerateRunState & {
    telemetryPartialUi: boolean;
    stopWatchingShown: boolean;
  };
  setStory: (feature: string, storyId: string) => void;
  setMode: (m: 'api' | 'copy') => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  disconnectStreamOnly: () => void;
  reset: () => void;
  resetStreamingUiOnly: () => void;
  dispatchReduce: React.Dispatch<Action>;
} {
  const [state, dispatch] = useReducer(generateRunReducer, INITIAL_GENERATE_RUN_STATE);
  const [telemetryPartialUi, setTelemetryPartialUi] = useState(false);
  const [stopWatchingShown, setStopWatchingShown] = useState(false);
  const clientIdRef = useRef('');
  const runIdLiveRef = useRef<string | null>(null);

  runIdLiveRef.current = state.runId;

  const peersRef = useRef<Map<string, number>>(new Map());
  const dispatchStable = useCallback((a: Action) => dispatch(a), []);

  useEffect(() => {
    clientIdRef.current =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2)}`;
  }, []);

  useEventSourceBridge(state.runId, dispatchStable);

  useEffect(() => {
    const ch =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('squad.generate.runs') : null;
    if (!ch) return undefined;

    const prune = () => {
      const now = Date.now();
      for (const id of [...peersRef.current.keys()])
        if (now - peersRef.current.get(id)! > 14_000) peersRef.current.delete(id);
    };

    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; runId?: string; clientId?: string };
      const curRun = runIdLiveRef.current;
      if (
        curRun &&
        d?.runId === curRun &&
        d.clientId &&
        d.clientId !== clientIdRef.current &&
        (d.type === 'ping' || d.type === 'attach')
      ) {
        peersRef.current.set(d.clientId, Date.now());
      }
    };
    ch.addEventListener('message', onMsg);

    const ping = window.setInterval(() => {
      const r = runIdLiveRef.current;
      if (!r) return;
      prune();
      ch.postMessage({ type: 'ping', runId: r, clientId: clientIdRef.current });
    }, 5000);

    const ticker = window.setInterval(() => {
      prune();
      const cur = runIdLiveRef.current;
      if (!cur) {
        dispatch({ type: 'set_multi_tab', count: 0 });
        return;
      }
      const now = Date.now();
      let n = 0;
      for (const [id, t] of peersRef.current) if (now - t < 12_000) n += 1;
      dispatch({ type: 'set_multi_tab', count: n });
    }, 750);

    if (runIdLiveRef.current) {
      ch.postMessage({
        type: 'attach',
        runId: runIdLiveRef.current,
        clientId: clientIdRef.current,
      });
    }

    return () => {
      ch.removeEventListener('message', onMsg);
      window.clearInterval(ping);
      window.clearInterval(ticker);
      peersRef.current.clear();
      ch.close();
    };
  }, [state.runId]);

  useEffect(() => {
    if (!state.runId || state.runtime) {
      setTelemetryPartialUi(false);
      return;
    }
    if (state.phase !== 'streaming' && state.phase !== 'starting' && state.phase !== 'cancelling') {
      setTelemetryPartialUi(false);
      return;
    }
    const tid = window.setTimeout(() => setTelemetryPartialUi(true), 2000);
    return () => window.clearTimeout(tid);
  }, [state.runId, state.runtime, state.phase]);

  useEffect(() => {
    if (state.phase !== 'cancelling') {
      setStopWatchingShown(false);
      return;
    }
    const t = window.setTimeout(() => setStopWatchingShown(true), 30_000);
    return () => window.clearTimeout(t);
  }, [state.phase]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (state.phase !== 'idle') return;
      try {
        const active = await api<ApiActiveRun[]>('/api/runs/active');
        if (cancelled || active.length !== 1) return;
        const a = active[0]!;
        dispatch({ type: 'resume', runId: a.runId, feature: a.feature, storyId: a.storyId });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase]);

  const setStory = useCallback((feature: string, storyId: string) => {
    dispatch({ type: 'set_story', feature, storyId });
  }, []);

  const setMode = useCallback((m: 'api' | 'copy') => {
    dispatch({ type: 'set_mode', mode: m });
  }, []);

  const start = useCallback(async () => {
    if (!state.feature || !state.storyId) return;
    dispatch({ type: 'start_post' });
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionStorage.getItem('squad.console.token') ?? ''}`,
        },
        body: JSON.stringify({ feature: state.feature, storyId: state.storyId }),
      });
      if (res.status === 401) throw new UnauthorizedError();
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        // `auth_unavailable` (and `planner_disabled`) are recoverable states with their own UI,
        // not anonymous strings — carry the code through so the page can render the fix.
        const err = new Error(j.detail ?? j.error ?? `${res.status}`) as Error & { code?: string };
        err.code = j.error;
        throw err;
      }
      const body = (await res.json()) as { runId: string };
      dispatch({ type: 'start_stream', runId: body.runId });
    } catch (e) {
      dispatch({
        type: 'fail',
        message: e instanceof Error ? e.message : String(e),
        code: (e as { code?: string } | null)?.code,
      });
    }
  }, [state.feature, state.storyId]);

  const cancel = useCallback(async () => {
    if (!state.runId) return;
    dispatch({ type: 'cancel_requested' });
    try {
      await fetch(`/api/runs/${encodeURIComponent(state.runId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${sessionStorage.getItem('squad.console.token') ?? ''}` },
      });
    } catch {
      /* ignore */
    }
  }, [state.runId]);

  const disconnectStreamOnly = useCallback(() => {
    dispatch({ type: 'disconnect_stream' });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'reset_all' });
  }, []);

  const resetStreamingUiOnly = useCallback(() => {
    dispatch({ type: 'reset_stream_ui' });
  }, []);

  const merged = useMemo(
    () =>
      ({
        ...state,
        telemetryPartialUi: telemetryPartialUi && !state.runtime,
        stopWatchingShown,
      }) as GenerateRunState & { telemetryPartialUi: boolean; stopWatchingShown: boolean },
    [state, telemetryPartialUi, stopWatchingShown],
  );

  return {
    state: merged,
    setStory,
    setMode,
    start,
    cancel,
    disconnectStreamOnly,
    reset,
    resetStreamingUiOnly,
    dispatchReduce: dispatch,
  };
}
