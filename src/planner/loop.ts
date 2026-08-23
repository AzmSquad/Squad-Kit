import path from 'node:path';
import fs from 'node:fs';
import { APICallError } from 'ai';
import type { PlannerRunStats, ProviderName, ToolCall, Usage } from './types.js';
import { Budget } from './budget.js';
import { MAX_BYTES_PER_FULL_READ, looksBinary, readFileTool, buildPlannerToolDefinitions } from './tools/index.js';
import { detectModelNotFound } from './provider-errors.js';
import { DEFAULT_PLANNER_MAX_OUTPUT_TOKENS } from '../core/config.js';
import { newRunId } from '../core/runs.js';
import { DEFAULT_PLANNER_MAX_ITERATIONS, type PlannerLimitDecision, type PlannerSessionLimitContext } from './session-limits.js';
import { VercelRuntime } from './runtimes/vercel-runtime.js';
import type { AnthropicProviderSpecific, PlannerRuntime } from './runtimes/types.js';
import type { SquadPaths } from '../core/paths.js';
import { createRunEventsStore, rotateRunEvents } from '../core/run-events-store.js';
import { PlannerEventBus } from './events.js';
import { describeAuth, type ResolvedPlannerAuth } from '../core/planner-auth.js';
import { runScout } from './stages/scout.js';
import { validatePlan, type ValidationIssue } from './validation.js';

export interface RunPlannerInput {
  root: string;
  /** Draft-stage runtime (Agent SDK on default Anthropic; Vercel AI SDK otherwise). */
  runtime: PlannerRuntime;
  provider: ProviderName;
  modelId: string;
  /** When the Anthropic provider runs both scout and draft, pass per-phase Agent SDK options. */
  anthropicProviderSpecific?: { scout?: AnthropicProviderSpecific; draft?: AnthropicProviderSpecific };
  /**
   * How this run authenticates. Resolve it once in the caller and pass the same instance to every
   * `resolveRuntime` call so scout and draft can never disagree. Omit only in tests that inject a
   * runtime directly — then no `auth_info` event is emitted.
   */
  auth?: ResolvedPlannerAuth;
  systemPrompt: string;
  userPrompt: string;
  budget: Budget;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
  onUsage?: (u: Usage) => void;
  onAssistantText?: (delta: string) => void;
  onRateLimit?: (waitSec: number) => void;
  maxIterations?: number;
  cacheEnabled?: boolean;
  sleep?: (ms: number) => Promise<void>;
  maxOutputTokens?: number;
  decideOnLimit?: (ctx: PlannerSessionLimitContext) => Promise<PlannerLimitDecision>;
  events?: PlannerEventBus;
  runId?: string;
  abort?: AbortSignal;
  stages?: {
    scout?: {
      enabled?: boolean;
      runtime?: PlannerRuntime;
      modelId?: string;
      maxFiles?: number;
      maxOutputTokens?: number;
    };
  };
  validation?: { enabled?: boolean; strict?: boolean };
  toolsEnabled?: { grep?: boolean; listDir?: boolean; rangedRead?: boolean };
  scoutSystemPrompt?: string;
  scoutedSection?: string;
  /** When set and {@link persistEvents} is not `false`, planner events are mirrored to `.squad/runs/<runId>.events.jsonl`. */
  paths?: SquadPaths;
  /** Persist run events unless `false`. Defaults to enabling persistence when {@link paths} is set. */
  persistEvents?: boolean;
}

/** Why the loop stopped when `finishedNormally` is false (non-error, non-budget, non-timeout). */
export type PlannerIncompleteKind =
  | 'max_output_tokens'
  | 'max_iterations'
  | 'wall_clock'
  | 'budget_reads';

export interface RunPlannerOutput {
  planText: string;
  budgetExhausted: boolean;
  timedOut: boolean;
  finishedNormally: boolean;
  iterations: number;
  stats: PlannerRunStats;
  incompleteKind?: PlannerIncompleteKind;
  /** User declined to continue after a session limit was hit (only when `decideOnLimit` is set). */
  userCancelled?: boolean;
  scout?: { selected: string[]; reasoning: string; durationMs: number; tokensUsed: number };
  validation?: { issues: ValidationIssue[]; durationMs: number };
  stagesStats: { scout?: PlannerRunStats; draft: PlannerRunStats };
}

/** @internal Result of the draft-stage loop only (before scout/validation orchestration aggregates). */
export interface DraftStageOutput {
  planText: string;
  budgetExhausted: boolean;
  timedOut: boolean;
  finishedNormally: boolean;
  iterations: number;
  stats: PlannerRunStats;
  incompleteKind?: PlannerIncompleteKind;
  userCancelled?: boolean;
}

/** @alias RunPlannerOutput — result object including aggregated cache telemetry from Story 03. */
export type RunPlannerResult = RunPlannerOutput;

export type { PlannerLimitDecision, PlannerSessionLimitContext, PlannerSessionLimitKind } from './session-limits.js';

function buildPlannerRunStats(budget: Budget, turns: number, runStartedAt: number): PlannerRunStats {
  const u = budget.snapshot().usage;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheCreate = u.cacheCreationTokens ?? 0;
  const inTok = u.inputTokens;
  const outTok = u.outputTokens;
  const totalInput = inTok + cacheRead;
  const cacheHitRatio = totalInput === 0 ? 0 : Math.round((cacheRead / totalInput) * 100) / 100;
  return {
    turns,
    inputTokens: inTok,
    outputTokens: outTok,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    cacheHitRatio,
    durationMs: Date.now() - runStartedAt,
  };
}

export function buildScoutedContextSection(
  root: string,
  budget: Budget,
  selectedFiles: string[],
  bus: PlannerEventBus,
  runId: string,
  readRanges?: Array<{ path: string; offset: number; limit: number }>,
): string {
  const normalizeRel = (p: string) => p.replace(/^\.\//, '');
  const rangeByPath = new Map<string, { offset: number; limit: number }>();
  for (const rr of readRanges ?? []) {
    rangeByPath.set(normalizeRel(rr.path), rr);
  }

  const ordered: string[] = [];
  const seenPath = new Set<string>();
  for (const f of selectedFiles) {
    const c = normalizeRel(f);
    if (!seenPath.has(c)) {
      seenPath.add(c);
      ordered.push(c);
    }
  }
  for (const p of rangeByPath.keys()) {
    if (!seenPath.has(p)) {
      seenPath.add(p);
      ordered.push(p);
    }
  }

  const blocks: string[] = ['\n## Scouted context (already loaded)\n'];

  for (const cleaned of ordered) {
    const rr = rangeByPath.get(cleaned);
    if (rr) {
      const result = readFileTool(root, budget, { path: cleaned, offset: rr.offset, limit: rr.limit });
      const hi = rr.offset + rr.limit - 1;
      if (result.isError) {
        blocks.push(
          `\n### \`${cleaned}\` (lines ${rr.offset}–${hi})\n\n_${result.content}_\n`,
        );
      } else {
        blocks.push(
          `\n### \`${cleaned}\` (lines ${rr.offset}–${hi})\n\n\`\`\`\n${result.content}\n\`\`\`\n`,
        );
      }
      continue;
    }

    const resolved = path.resolve(root, cleaned);
    const rc = path.relative(root, resolved);
    if (rc.startsWith('..') || path.isAbsolute(rc)) {
      bus.emit({
        kind: 'validation_issue',
        runId,
        severity: 'warning',
        issueKind: 'missing_path',
        path: cleaned,
        detail: 'Scout-selected path escapes the project root',
      });
      continue;
    }
    if (!fs.existsSync(resolved)) {
      bus.emit({
        kind: 'validation_issue',
        runId,
        severity: 'warning',
        issueKind: 'missing_path',
        path: cleaned,
        detail: 'Scout selected this path but it does not exist on disk',
      });
      continue;
    }
    const st = fs.statSync(resolved);
    if (!st.isFile()) continue;
    const n = Math.min(st.size, MAX_BYTES_PER_FULL_READ);
    const cap = budget.canRead(n);
    if (!cap.ok) {
      blocks.push(`\n### \`${cleaned}\`\n\n_(skipped: ${cap.reason})_\n`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(resolved);
    } catch {
      continue;
    }
    if (buf.length > MAX_BYTES_PER_FULL_READ) {
      const head = buf.subarray(0, MAX_BYTES_PER_FULL_READ);
      if (looksBinary(head)) {
        blocks.push(`\n### \`${cleaned}\`\n\n_(binary file skipped)_\n`);
        continue;
      }
      budget.recordRead(head.length);
      blocks.push(
        `\n### \`${cleaned}\` (truncated: first ${MAX_BYTES_PER_FULL_READ}-byte head; full size ${buf.length} bytes)\n\n\`\`\`\n${head.toString('utf8')}\n\`\`\`\n`,
      );
      continue;
    }
    if (looksBinary(buf)) {
      blocks.push(`\n### \`${cleaned}\`\n\n_(binary file skipped)_\n`);
      continue;
    }
    budget.recordRead(buf.length);
    blocks.push(`\n### \`${cleaned}\`\n\n\`\`\`\n${buf.toString('utf8')}\n\`\`\`\n`);
  }
  return blocks.join('');
}

function scoutStageStats(usage: { inputTokens: number; outputTokens: number }, durationMs: number): PlannerRunStats {
  return {
    turns: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
    durationMs,
  };
}

async function runDraftStage(input: RunPlannerInput): Promise<DraftStageOutput> {
  const runStartedAt = Date.now();
  const bus = input.events ?? new PlannerEventBus();
  const runId = input.runId ?? newRunId();

  const iterProxy = { current: 0 };
  const limitCtx = (kind: PlannerSessionLimitContext['kind']): PlannerSessionLimitContext => ({
    kind,
    budgetSnapshot: input.budget.snapshot(),
    iterations: iterProxy.current,
    maxIterations: input.maxIterations ?? DEFAULT_PLANNER_MAX_ITERATIONS,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
  });

  let budgetExhausted = false;

  const toolDefs =
    input.runtime.kind === 'agent-sdk'
      ? buildPlannerToolDefinitions({
          root: input.root,
          budget: input.budget,
          enabled: input.toolsEnabled,
          getTurn: () => Math.max(1, iterProxy.current),
          runId,
          bus,
          onToolCall: input.onToolCall,
          decideOnLimit: input.decideOnLimit,
          getLimitCtx: () => limitCtx('file_or_context_reads'),
          extendSessionLimits: () => {
            input.budget.extendSession();
          },
          getAccumulatedText: () => '',
          setBudgetExhausted: (v) => {
            budgetExhausted = v;
          },
        })
      : [];

  const draft = await input.runtime.runDraft({
    systemPrompt: input.systemPrompt,
    userMessage: input.userPrompt,
    tools: toolDefs,
    bus,
    runId,
    budget: input.budget,
    abort: input.abort,
    maxSteps: input.maxIterations ?? DEFAULT_PLANNER_MAX_ITERATIONS,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
    providerSpecific: input.anthropicProviderSpecific?.draft,
    onAssistantText: input.onAssistantText,
    onToolCall: input.onToolCall,
    onUsage: input.onUsage,
    vercelLoop:
      input.runtime instanceof VercelRuntime
        ? {
            model: input.runtime.languageModel,
            provider: input.provider,
            modelId: input.modelId,
            root: input.root,
            userPrompt: input.userPrompt,
            scoutedSection: input.scoutedSection,
            cacheEnabled: input.cacheEnabled ?? true,
            toolsEnabled: input.toolsEnabled,
            decideOnLimit: input.decideOnLimit,
            sleep: input.sleep,
            onRateLimit: input.onRateLimit,
          }
        : undefined,
  });

  const incompleteKind = draft.incompleteKind as DraftStageOutput['incompleteKind'] | undefined;

  const u = input.budget.snapshot().usage;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheCreate = u.cacheCreationTokens ?? 0;
  const totalIn = u.inputTokens + cacheRead;
  const cacheHitRatio = totalIn === 0 ? 0 : Math.round((cacheRead / totalIn) * 100) / 100;
  bus.emit({
    kind: 'cache_summary',
    runId,
    turn: draft.iterations,
    cacheHitRatio,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
  });

  return {
    planText: draft.text,
    budgetExhausted: draft.budgetExhausted ?? budgetExhausted,
    timedOut: draft.timedOut ?? false,
    finishedNormally: draft.finishedNormally,
    iterations: draft.iterations,
    incompleteKind,
    stats: buildPlannerRunStats(input.budget, draft.iterations, runStartedAt),
    userCancelled: draft.userCancelled,
  };
}

export async function runPlanner(input: RunPlannerInput): Promise<RunPlannerOutput> {
  const bus = input.events ?? new PlannerEventBus();
  const runId = input.runId ?? newRunId();
  const cacheEnabled = input.cacheEnabled ?? true;

  const shouldPersistEvents =
    input.persistEvents !== false && input.paths !== undefined;
  if (input.persistEvents === true && !input.paths) {
    throw new Error('runPlanner: `paths` is required when `persistEvents: true`');
  }
  let persistFinalized = false;
  if (shouldPersistEvents && input.paths) {
    const persistPaths = input.paths;
    const store = createRunEventsStore(persistPaths, runId);
    const unsubPersist = bus.subscribe((e) => {
      void store.append(e);
    });
    bus.finalizeEventPersistence = async () => {
      if (persistFinalized) return;
      persistFinalized = true;
      unsubPersist();
      await store.close();
      delete bus.finalizeEventPersistence;
      await rotateRunEvents(persistPaths);
    };
  }

  bus.emit({
    kind: 'started',
    runId,
    provider: input.provider,
    model: input.modelId,
    cacheEnabled,
    plannerRuntime: input.runtime.kind,
  });

  bus.emit({
    kind: 'runtime_info',
    runId,
    provider: input.provider,
    model: input.modelId,
    runtimeKind: input.runtime.kind,
    cacheEnabled,
    scoutEnabled: input.stages?.scout?.enabled !== false,
    validationEnabled: input.validation?.enabled !== false,
    budgetCaps: input.budget.caps(),
    providerOptions:
      input.provider === 'anthropic' && input.anthropicProviderSpecific
        ? {
            anthropic: {
              thinking: input.anthropicProviderSpecific.draft?.thinking ?? 'adaptive',
              effort: input.anthropicProviderSpecific.draft?.effort,
              effortByPhase: {
                scout: input.anthropicProviderSpecific.scout?.effort,
                draft: input.anthropicProviderSpecific.draft?.effort,
              },
            },
          }
        : undefined,
  });

  if (input.auth) {
    bus.emit({ kind: 'auth_info', runId, ...describeAuth(input.auth) });
  }

  const merged: RunPlannerInput = { ...input, events: bus, runId };
  const systemPrompt = input.systemPrompt;
  let scoutSummary: RunPlannerOutput['scout'];
  let scoutStats: PlannerRunStats | undefined;
  let scoutedSection: string | undefined;

  const scoutOn = input.stages?.scout?.enabled !== false;
  const scoutRuntime = input.stages?.scout?.runtime;
  const maxScoutFiles = input.stages?.scout?.maxFiles ?? 12;
  const scoutMaxOut = input.stages?.scout?.maxOutputTokens ?? 2048;
  const scoutModelIdStr = input.stages?.scout?.modelId ?? '';

  if (scoutOn && scoutRuntime) {
    if (!input.scoutSystemPrompt?.trim()) {
      throw new Error(
        'planner: scout enabled but `scoutSystemPrompt` was not provided. ' +
          'Compose it via composeScoutSystemPrompt() or set stages.scout.enabled = false.',
      );
    }
    const t0 = Date.now();
    bus.emit({ kind: 'stage_started', runId, stage: 'scout' });
    try {
      const scoutRes = await runScout({
        runtime: scoutRuntime,
        systemPrompt: input.scoutSystemPrompt,
        userPrompt: input.userPrompt,
        budget: input.budget,
        bus,
        runId,
        abort: input.abort,
        maxTokens: scoutMaxOut,
        providerSpecific: input.anthropicProviderSpecific?.scout,
      });
      const durationMs = Date.now() - t0;
      if (scoutRes) {
        const files = scoutRes.output.selectedFiles.slice(0, maxScoutFiles);
        const tokensUsed = scoutRes.usage.inputTokens + scoutRes.usage.outputTokens;
        scoutSummary = {
          selected: files,
          reasoning: scoutRes.output.reasoning,
          durationMs,
          tokensUsed,
        };
        scoutStats = scoutStageStats(scoutRes.usage, durationMs);
        bus.emit({
          kind: 'scout_result',
          runId,
          selected: files,
          reasoning: scoutRes.output.reasoning,
        });
        scoutedSection = buildScoutedContextSection(
          input.root,
          input.budget,
          files,
          bus,
          runId,
          scoutRes.output.readRanges,
        );
        bus.emit({
          kind: 'stage_complete',
          runId,
          stage: 'scout',
          success: true,
          durationMs,
          tokensUsed,
        });
      } else {
        bus.emit({
          kind: 'stage_complete',
          runId,
          stage: 'scout',
          success: false,
          durationMs,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (APICallError.isInstance(err)) {
        const status = err.statusCode ?? 0;
        if (status === 401 || status === 403) {
          throw err;
        }
        if (
          detectModelNotFound(input.provider, scoutModelIdStr, status, err.responseBody ?? '')
        ) {
          throw err;
        }
      }
      bus.emit({
        kind: 'stage_complete',
        runId,
        stage: 'scout',
        success: false,
        durationMs: Date.now() - t0,
        errorMessage: msg.slice(0, 200),
      });
    }
  }

  const draftStarted = Date.now();
  bus.emit({ kind: 'stage_started', runId, stage: 'draft' });
  const draft = await runDraftStage({ ...merged, systemPrompt, scoutedSection });
  bus.emit({
    kind: 'stage_complete',
    runId,
    stage: 'draft',
    success: draft.finishedNormally && !draft.timedOut && !draft.userCancelled,
    durationMs: Date.now() - draftStarted,
  });

  const validationOn = input.validation?.enabled !== false;
  let issues: ValidationIssue[] = [];
  let validationDurationMs = 0;
  if (validationOn && draft.planText.trim()) {
    const v0 = Date.now();
    bus.emit({ kind: 'stage_started', runId, stage: 'validation' });
    issues = validatePlan({ root: input.root, planText: draft.planText });
    for (const iss of issues.slice(0, 100)) {
      bus.emit({
        kind: 'validation_issue',
        runId,
        severity: iss.severity,
        issueKind: iss.kind,
        path: iss.path,
        detail: iss.detail,
        excerpt: iss.excerpt,
      });
    }
    validationDurationMs = Date.now() - v0;
    bus.emit({
      kind: 'stage_complete',
      runId,
      stage: 'validation',
      success: true,
      durationMs: validationDurationMs,
    });
  }

  return {
    ...draft,
    stats: draft.stats,
    stagesStats: { scout: scoutStats, draft: draft.stats },
    scout: scoutSummary,
    validation: validationOn
      ? { issues, durationMs: validationDurationMs }
      : { issues: [], durationMs: 0 },
  };
}

export function relativisePath(root: string, p: string): string {
  return path.relative(root, p) || p;
}
