import type { LanguageModelV1 } from 'ai';
import { APICallError, generateObject, NoObjectGeneratedError } from 'ai';
import { resolveModel } from '../providers/index.js';
import type { ProviderName, ToolCall, ToolResult, Usage } from '../types.js';
import type { ChatTurn } from '../types.js';
import {
  detectModelNotFound,
  detectRateLimit,
  modelNotFoundMessage,
  rateLimitMessage,
} from '../provider-errors.js';
import { usageFromLanguageModelStep } from '../usage-map.js';
import { turnsToCoreMessages } from '../core-messages.js';
import { composeScoutedUserMessage } from '../system-prompt.js';
import { DEFAULT_PLANNER_MAX_OUTPUT_TOKENS } from '../../core/config.js';
import {
  DEFAULT_PLANNER_MAX_ITERATIONS,
  PLANNER_MARKDOWN_CONTINUATION_USER,
  type PlannerSessionLimitContext,
} from '../session-limits.js';
import { PlannerUserCancelledError, vercelToolsFromDefinitions, buildPlannerToolDefinitions } from '../tools/index.js';
import { PlannerEventBus } from '../events.js';
import { parseRetryAfterSec } from '../provider-errors.js';
import type {
  PlannerRuntime,
  RunDraftInput,
  RunDraftOutput,
  RunScoutInput,
  RunScoutOutput,
} from './types.js';
import { z } from 'zod';

const MAX_RATE_LIMIT_RETRY_SEC = 90;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

async function defaultSleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function sleepWithAbort(
  ms: number,
  sleepFn: (n: number) => Promise<void>,
  abort: AbortSignal | undefined,
): Promise<void> {
  if (!abort) {
    await sleepFn(ms);
    return;
  }
  if (abort.aborted) throw new DOMException('Aborted', 'AbortError');
  await Promise.race([
    sleepFn(ms),
    new Promise<never>((_, reject) => {
      abort.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  ]);
}

function asToolInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeToolExecutionResult(result: unknown): { content: string; isError: boolean } {
  if (typeof result === 'string') {
    try {
      const j = JSON.parse(result) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j) && 'content' in j) {
        const o = j as { content?: unknown; isError?: unknown };
        return {
          content: typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? ''),
          isError: o.isError === true,
        };
      }
    } catch {
      /* plain tool-result string */
    }
    return { content: result, isError: false };
  }
  if (result && typeof result === 'object' && !Array.isArray(result) && 'content' in result) {
    const o = result as { content?: unknown; isError?: unknown };
    return {
      content: typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? ''),
      isError: o.isError === true,
    };
  }
  return { content: typeof result === 'undefined' ? '' : JSON.stringify(result), isError: false };
}

function applyStepToTurns(
  turns: ChatTurn[],
  step: {
    text: string;
    toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
    toolResults: Array<{ toolCallId: string; result: unknown }>;
  },
): void {
  const callsById = new Map<string, string>();
  const toolCalls: ToolCall[] = step.toolCalls.map((tc) => {
    callsById.set(tc.toolCallId, tc.toolName);
    return { id: tc.toolCallId, name: tc.toolName, input: asToolInput(tc.args) };
  });
  turns.push({
    role: 'assistant',
    ...(step.text ? { text: step.text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  });
  if (step.toolResults.length) {
    const toolResults: ToolResult[] = step.toolResults.map((tr) => {
      const norm = normalizeToolExecutionResult(tr.result);
      return {
        toolCallId: tr.toolCallId,
        name: callsById.get(tr.toolCallId) ?? 'read_file',
        content: norm.content,
        ...(norm.isError ? { isError: true as const } : {}),
      };
    });
    turns.push({ role: 'user', toolResults });
  }
}

function recordUsageAndEmit(
  bus: PlannerEventBus,
  onUsage: ((u: Usage) => void) | undefined,
  budget: import('../budget.js').Budget,
  runId: string,
  turn: number,
  usage: Usage,
): void {
  budget.recordUsage(usage);
  onUsage?.(usage);
  bus.emit({ kind: 'usage', runId, turn, usage });
  const u = budget.snapshot().usage;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheCreate = u.cacheCreationTokens ?? 0;
  if (cacheRead > 0 || cacheCreate > 0) {
    const inTok = u.inputTokens;
    const totalInput = inTok + cacheRead;
    const cacheHitRatio = totalInput === 0 ? 0 : Math.round((cacheRead / totalInput) * 100) / 100;
    bus.emit({
      kind: 'cache_summary',
      runId,
      turn,
      cacheHitRatio,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
    });
  }
}

function providerResponseFromApiError(provider: ProviderName, modelId: string, err: APICallError) {
  const body = err.responseBody ?? '';
  const nf = detectModelNotFound(provider, modelId, err.statusCode ?? 0, body);
  if (nf) {
    return {
      stopReason: 'error' as const,
      errorKind: 'model_not_found' as const,
      rawError: modelNotFoundMessage(nf),
    };
  }
  const rl = detectRateLimit(provider, err.statusCode ?? 0, err.responseHeaders ?? {}, body);
  if (rl) {
    return {
      stopReason: 'error' as const,
      errorKind: 'rate_limit' as const,
      retryAfterSec: rl.retryAfterSec,
      rawError: `${provider} ${err.statusCode ?? 'error'}: ${body.slice(0, 500)}`,
    };
  }
  return {
    stopReason: 'error' as const,
    rawError: `${provider} ${err.statusCode ?? 'error'}: ${body.slice(0, 500)}`,
  };
}

function composePlannerError(
  providerName: ProviderName,
  response: {
    errorKind?: 'rate_limit' | 'model_not_found';
    retryAfterSec?: number;
    rawError?: string;
  },
  retriedRateLimit: boolean,
  retrySkippedReason?: 'retry_after_too_long',
): Error {
  if (response.errorKind === 'rate_limit') {
    return new Error(
      rateLimitMessage({
        provider: providerName,
        retryAfterSec: response.retryAfterSec,
        rawBody: response.rawError ?? '',
        retryAlreadyAttempted: retriedRateLimit,
        retrySkippedReason,
        maxRetrySec: MAX_RATE_LIMIT_RETRY_SEC,
      }),
    );
  }
  if (response.errorKind === 'model_not_found') {
    return new Error(response.rawError ?? 'planner: model not found');
  }
  const base = response.rawError ?? 'planner: provider error';
  return new Error(`${base} Run \`squad doctor\` to diagnose, or retry \u2014 most 5xx errors are transient.`);
}

export class VercelRuntime implements PlannerRuntime {
  readonly kind = 'vercel' as const;
  readonly providerName: ProviderName;
  readonly modelId: string;
  readonly languageModel: LanguageModelV1;

  constructor(
    provider: ProviderName,
    modelId: string,
    apiKeyOrModel: string | LanguageModelV1,
    /** When `true`, the third argument must be a `LanguageModelV1` mock (tests only). */
    injectModel?: true,
  ) {
    this.providerName = provider;
    this.modelId = modelId;
    if (injectModel === true) {
      if (typeof apiKeyOrModel === 'string') {
        throw new Error('VercelRuntime: injectModel mode expects a LanguageModelV1 as third argument');
      }
      this.languageModel = apiKeyOrModel;
      return;
    }
    if (typeof apiKeyOrModel !== 'string') {
      throw new Error('VercelRuntime: apiKey must be a string unless injectModel is true');
    }
    // `resolveRuntime` never routes subscription auth here, but this path builds an `x-api-key`
    // client — an empty key would fail opaquely at the provider instead of at construction.
    if (!apiKeyOrModel) {
      throw new Error(
        `VercelRuntime: a non-empty ${provider} API key is required. Run \`squad config set planner\` to save one.`,
      );
    }
    this.languageModel = resolveModel(provider, modelId, apiKeyOrModel).model;
  }

  async runScout<TSchema extends z.ZodType>(
    input: RunScoutInput<TSchema>,
  ): Promise<RunScoutOutput<z.infer<TSchema>> | null> {
    let attempt = 0;
    while (true) {
      try {
        const { object, usage, providerMetadata } = await generateObject({
          model: this.languageModel,
          system: input.systemPrompt,
          prompt: input.userMessage,
          schema: input.schema,
          maxTokens: input.maxOutputTokens,
          abortSignal: input.abort,
        });
        const u = usageFromLanguageModelStep(usage, providerMetadata);
        return {
          output: object as z.infer<TSchema>,
          usage: u,
        };
      } catch (e) {
        if (NoObjectGeneratedError.isInstance(e)) {
          return null;
        }
        if (APICallError.isInstance(e) && attempt === 0) {
          const status = e.statusCode ?? 0;
          if (status === 429) {
            const ra = parseRetryAfterSec(e.responseHeaders ?? {});
            if (ra !== undefined && ra <= 90) {
              await new Promise((r) => setTimeout(r, ra * 1000));
              attempt += 1;
              continue;
            }
          }
        }
        throw e;
      }
    }
  }

  async runDraft(input: RunDraftInput): Promise<RunDraftOutput> {
    const vl = input.vercelLoop;
    if (!vl) {
      throw new Error('planner: Vercel runtime requires vercelLoop context');
    }
    const bus = input.bus;
    const runId = input.runId;
    const sleepFn = vl.sleep ?? defaultSleep;
    const baseMaxIter = input.maxSteps ?? DEFAULT_PLANNER_MAX_ITERATIONS;
    const maxIter = { current: baseMaxIter };
    const baseMaxOut = input.maxOutputTokens ?? DEFAULT_PLANNER_MAX_OUTPUT_TOKENS;
    const maxOut = { current: baseMaxOut };
    const turns: ChatTurn[] = [{ role: 'user', text: vl.userPrompt }];
    if (vl.scoutedSection?.trim()) {
      turns.push({ role: 'user', text: composeScoutedUserMessage({ scoutedSection: vl.scoutedSection }) });
    }
    let accumulatedText = '';
    let iterations = 0;
    let budgetExhausted = false;
    let finishedNormally = false;
    const decide = vl.decideOnLimit;

    const limitCtx = (kind: PlannerSessionLimitContext['kind']): PlannerSessionLimitContext => ({
      kind,
      budgetSnapshot: input.budget.snapshot(),
      iterations,
      maxIterations: maxIter.current,
      maxOutputTokens: maxOut.current,
    });

    const extendAllSessionLimits = (): void => {
      input.budget.extendSession();
      maxIter.current += baseMaxIter;
      maxOut.current += baseMaxOut;
    };

    for (;;) {
      if (input.abort?.aborted) {
        bus.emit({ kind: 'cancelled', runId });
        return {
          text: accumulatedText,
          finishedNormally: false,
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
          userCancelled: true,
        };
      }

      if (iterations >= maxIter.current) {
        if (decide) {
          const d = await decide(limitCtx('max_iterations'));
          if (d === 'cancel') {
            return {
              text: accumulatedText,
              finishedNormally: false,
              incompleteKind: 'max_iterations',
              iterations,
              finalUsage: input.budget.snapshot().usage,
              budgetExhausted,
              userCancelled: true,
            };
          }
          extendAllSessionLimits();
          continue;
        }
        return {
          text: accumulatedText,
          finishedNormally: false,
          incompleteKind: 'max_iterations',
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
        };
      }

      iterations += 1;

      if (input.budget.timedOut()) {
        if (decide) {
          const d = await decide(limitCtx('wall_clock'));
          if (d === 'cancel') {
            return {
              text: accumulatedText,
              finishedNormally: false,
              incompleteKind: 'wall_clock',
              iterations,
              finalUsage: input.budget.snapshot().usage,
              budgetExhausted,
              timedOut: true,
              userCancelled: true,
            };
          }
          extendAllSessionLimits();
          iterations -= 1;
          continue;
        }
        return {
          text: accumulatedText,
          finishedNormally: false,
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
          timedOut: true,
        };
      }

      if (iterations >= 2) {
        bus.emit({ kind: 'turn_started', runId, turn: iterations });
      }

      const toolDefs = buildPlannerToolDefinitions({
        root: vl.root,
        budget: input.budget,
        enabled: vl.toolsEnabled,
        getTurn: () => iterations,
        runId,
        bus,
        onToolCall: input.onToolCall,
        decideOnLimit: vl.decideOnLimit,
        getLimitCtx: () => limitCtx('file_or_context_reads'),
        extendSessionLimits: extendAllSessionLimits,
        getAccumulatedText: () => accumulatedText,
        setBudgetExhausted: (v) => {
          budgetExhausted = v;
        },
      });
      const tools = vercelToolsFromDefinitions(toolDefs);

      const messages = turnsToCoreMessages(input.systemPrompt, turns, {
        cacheEnabled: vl.cacheEnabled,
        provider: vl.provider,
      });

      bus.emit({ kind: 'request_sent', runId, turn: iterations });

      let attempt = 0;
      let stepResult!: {
        text: string;
        finishReason: string;
        toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
        toolResults: Array<{ toolCallId: string; result: unknown }>;
        usage: import('ai').LanguageModelUsage;
        providerMetadata: unknown;
      };
      let retrySkippedReason: 'retry_after_too_long' | undefined;
      let retriedRateLimit = false;

      const callStream = async (): Promise<void> => {
        const { streamText } = await import('ai');
        const stream = streamText({
          model: this.languageModel,
          messages,
          tools,
          toolChoice: 'auto',
          maxSteps: 1,
          maxRetries: 0,
          maxTokens: maxOut.current,
          abortSignal: input.abort,
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta') {
              accumulatedText += chunk.textDelta;
              input.onAssistantText?.(chunk.textDelta);
              bus.emit({ kind: 'assistant_text', runId, turn: iterations, delta: chunk.textDelta });
            }
          },
          onStepFinish: (step) => {
            const u = usageFromLanguageModelStep(step.usage, step.providerMetadata);
            recordUsageAndEmit(bus, input.onUsage, input.budget, runId, iterations, u);
          },
        });
        for await (const part of stream.fullStream) {
          const p = part as { type?: string; error?: unknown };
          if (p.type === 'error') {
            throw p.error;
          }
        }
        const steps = await stream.steps;
        const last = steps[steps.length - 1];
        if (!last) throw new Error('planner: empty model step');
        stepResult = {
          text: last.text,
          finishReason: last.finishReason,
          toolCalls: last.toolCalls.flatMap((tc) =>
            tc
              ? [
                  {
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    args: tc.args,
                  },
                ]
              : [],
          ),
          toolResults: last.toolResults.flatMap((tr: { toolCallId: string; result: unknown } | undefined) =>
            tr ? [{ toolCallId: tr.toolCallId, result: tr.result }] : [],
          ),
          usage: last.usage,
          providerMetadata: last.providerMetadata,
        };
      };

      try {
        while (true) {
          try {
            await callStream();
            break;
          } catch (e) {
            if (PlannerUserCancelledError.is(e)) {
              return {
                text: e.planText,
                finishedNormally: false,
                iterations,
                finalUsage: input.budget.snapshot().usage,
                budgetExhausted: false,
                userCancelled: true,
                incompleteKind: 'budget_reads',
              };
            }
            if (isAbortError(e)) {
              bus.emit({ kind: 'cancelled', runId });
              return {
                text: accumulatedText,
                finishedNormally: false,
                iterations,
                finalUsage: input.budget.snapshot().usage,
                budgetExhausted,
                userCancelled: true,
              };
            }
            if (APICallError.isInstance(e)) {
              const synthetic = providerResponseFromApiError(vl.provider, vl.modelId, e);
              if (synthetic.errorKind === 'rate_limit') {
                const asked = synthetic.retryAfterSec;
                const emitRateLimit = (phase: 'retrying' | 'aborted', waitSec: number) => {
                  bus.emit({
                    kind: 'rate_limit',
                    runId,
                    turn: iterations,
                    retryAfterSec: synthetic.retryAfterSec,
                    waitSec,
                    capSec: MAX_RATE_LIMIT_RETRY_SEC,
                    phase,
                    provider: vl.provider,
                    rawBody: (synthetic.rawError ?? '').slice(0, 200),
                  });
                };
                if (asked !== undefined && asked > MAX_RATE_LIMIT_RETRY_SEC) {
                  emitRateLimit('aborted', asked);
                  retrySkippedReason = 'retry_after_too_long';
                  throw composePlannerError(vl.provider, synthetic, false, retrySkippedReason);
                }
                if (attempt === 0) {
                  const waitSec = Math.min(asked ?? 10, MAX_RATE_LIMIT_RETRY_SEC);
                  emitRateLimit('retrying', waitSec);
                  vl.onRateLimit?.(waitSec);
                  await sleepWithAbort(waitSec * 1000, sleepFn, input.abort);
                  attempt += 1;
                  retriedRateLimit = true;
                  continue;
                }
                throw composePlannerError(vl.provider, synthetic, true, retrySkippedReason);
              }
              throw composePlannerError(vl.provider, synthetic, retriedRateLimit, retrySkippedReason);
            }
            throw e;
          }
        }
      } catch (e) {
        if (isAbortError(e)) {
          bus.emit({ kind: 'cancelled', runId });
          return {
            text: accumulatedText,
            finishedNormally: false,
            iterations,
            finalUsage: input.budget.snapshot().usage,
            budgetExhausted,
            userCancelled: true,
          };
        }
        throw e;
      }

      const finishReason = stepResult.finishReason;
      const toolCallsLen = stepResult.toolCalls.length;

      if (finishReason === 'length' && toolCallsLen === 0) {
        bus.emit({ kind: 'turn_complete', runId, turn: iterations, stopReason: 'max_tokens' });
        if (decide) {
          const d = await decide(limitCtx('max_output_tokens'));
          if (d === 'cancel') {
            return {
              text: accumulatedText,
              finishedNormally: false,
              incompleteKind: 'max_output_tokens',
              iterations,
              finalUsage: input.budget.snapshot().usage,
              budgetExhausted,
              userCancelled: true,
            };
          }
          extendAllSessionLimits();
          applyStepToTurns(turns, stepResult);
          turns.push({ role: 'user', text: PLANNER_MARKDOWN_CONTINUATION_USER });
          iterations -= 1;
          continue;
        }
        return {
          text: accumulatedText,
          finishedNormally: false,
          incompleteKind: 'max_output_tokens',
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
        };
      }

      if (finishReason === 'error' || finishReason === 'content-filter') {
        throw new Error(
          stepResult.text ||
            `planner: model reported ${finishReason}. Run \`squad doctor\` to diagnose, or retry \u2014 most 5xx errors are transient.`,
        );
      }

      if ((finishReason === 'stop' || finishReason === 'unknown') && toolCallsLen === 0) {
        bus.emit({ kind: 'turn_complete', runId, turn: iterations, stopReason: finishReason });
        finishedNormally = true;
        return {
          text: accumulatedText,
          finishedNormally,
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
        };
      }

      if (toolCallsLen === 0) {
        bus.emit({ kind: 'turn_complete', runId, turn: iterations, stopReason: finishReason });
        finishedNormally = true;
        return {
          text: accumulatedText,
          finishedNormally,
          iterations,
          finalUsage: input.budget.snapshot().usage,
          budgetExhausted,
        };
      }

      applyStepToTurns(turns, stepResult);

      if (budgetExhausted) {
        turns.push({
          role: 'user',
          text:
            'Budget is exhausted. Finalise the plan with the information you already have. ' +
            'Do not call any more tools. Output the complete plan markdown now.',
        });
      }

      bus.emit({ kind: 'turn_complete', runId, turn: iterations, stopReason: finishReason });
    }
  }
}
