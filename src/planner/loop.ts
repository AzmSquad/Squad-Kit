import path from 'node:path';
import type {
  ChatTurn,
  PlannerProvider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolResult,
  Usage,
} from './types.js';
import { Budget } from './budget.js';
import { READ_FILE_TOOL, readFileTool } from './tools.js';
import { rateLimitMessage } from './provider-errors.js';

/**
 * Upper bound on the auto-retry wait. Chosen to cover the common Anthropic Tier 1 /
 * OpenAI free-tier "wait 60-90s" asks; anything longer means the org is badly over
 * quota and retrying would only burn another request, so we skip and surface guidance.
 */
const MAX_RATE_LIMIT_RETRY_SEC = 90;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RunPlannerInput {
  root: string;
  provider: PlannerProvider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  budget: Budget;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
  onUsage?: (u: Usage) => void;
  onAssistantText?: (delta: string) => void;
  /** Invoked when the loop is about to sleep before retrying a 429. The arg is seconds. */
  onRateLimit?: (waitSec: number) => void;
  maxIterations?: number;
  /** Test injection for `setTimeout`. Defaults to the real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunPlannerOutput {
  planText: string;
  budgetExhausted: boolean;
  timedOut: boolean;
  finishedNormally: boolean;
  iterations: number;
}

export async function runPlanner(input: RunPlannerInput): Promise<RunPlannerOutput> {
  const maxIter = input.maxIterations ?? 40;
  const turns: ChatTurn[] = [{ role: 'user', text: input.userPrompt }];
  let accumulatedText = '';
  let iterations = 0;
  let budgetExhausted = false;
  let finishedNormally = false;

  while (iterations < maxIter) {
    iterations += 1;

    if (input.budget.timedOut()) {
      return { planText: accumulatedText, budgetExhausted, timedOut: true, finishedNormally: false, iterations };
    }
    if (input.budget.overCost()) {
      return { planText: accumulatedText, budgetExhausted: true, timedOut: false, finishedNormally: false, iterations };
    }

    const request: ProviderRequest = {
      systemPrompt: input.systemPrompt,
      model: input.model,
      tools: [READ_FILE_TOOL],
      turns,
      apiKey: input.apiKey,
      maxOutputTokens: 8192,
    };

    let response = await input.provider.send(request);
    if (response.usage) {
      input.budget.recordUsage(response.usage);
      input.onUsage?.(response.usage);
    }

    let retriedRateLimit = false;
    let retrySkippedReason: 'retry_after_too_long' | undefined;
    if (response.stopReason === 'error' && response.errorKind === 'rate_limit') {
      const asked = response.retryAfterSec;
      if (asked !== undefined && asked > MAX_RATE_LIMIT_RETRY_SEC) {
        // Provider asked for longer than we're willing to block; a retry now would
        // fail inside the same window and burn a request. Skip straight to guidance.
        retrySkippedReason = 'retry_after_too_long';
      } else {
        const waitSec = Math.min(asked ?? 10, MAX_RATE_LIMIT_RETRY_SEC);
        input.onRateLimit?.(waitSec);
        await (input.sleep ?? defaultSleep)(waitSec * 1000);
        response = await input.provider.send(request);
        if (response.usage) {
          input.budget.recordUsage(response.usage);
          input.onUsage?.(response.usage);
        }
        retriedRateLimit = true;
      }
    }

    if (response.stopReason === 'error') {
      throw composePlannerError(input.provider.name, response, retriedRateLimit, retrySkippedReason);
    }

    if (response.text) {
      accumulatedText += response.text;
      input.onAssistantText?.(response.text);
    }

    if (response.stopReason === 'max_tokens' && !response.toolCalls?.length) {
      return { planText: accumulatedText, budgetExhausted, timedOut: false, finishedNormally: false, iterations };
    }

    if (response.stopReason === 'end_turn' || !response.toolCalls?.length) {
      finishedNormally = true;
      return { planText: accumulatedText, budgetExhausted, timedOut: false, finishedNormally, iterations };
    }

    turns.push({
      role: 'assistant',
      text: response.text,
      toolCalls: response.toolCalls,
    });

    const toolResults: ToolResult[] = [];
    for (const tc of response.toolCalls) {
      if (tc.name !== READ_FILE_TOOL.name) {
        toolResults.push({ toolCallId: tc.id, content: `unknown tool "${tc.name}"`, isError: true });
        continue;
      }
      const before = input.budget.snapshot().bytes;
      const result = readFileTool(input.root, input.budget, tc.input);
      const after = input.budget.snapshot().bytes;
      input.onToolCall?.(tc, after - before, after);
      if (result.isError && (/budget/i.test(result.content) || /max file reads/i.test(result.content))) {
        budgetExhausted = true;
      }
      toolResults.push({ toolCallId: tc.id, content: result.content, isError: result.isError });
    }

    turns.push({ role: 'user', toolResults });

    if (budgetExhausted) {
      turns.push({
        role: 'user',
        text:
          'Budget is exhausted. Finalise the plan with the information you already have. ' +
          'Do not call any more tools. Output the complete plan markdown now.',
      });
    }
  }

  return { planText: accumulatedText, budgetExhausted, timedOut: false, finishedNormally: false, iterations };
}

export function relativisePath(root: string, p: string): string {
  return path.relative(root, p) || p;
}

function composePlannerError(
  providerName: PlannerProvider['name'],
  response: ProviderResponse,
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
