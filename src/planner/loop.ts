import path from 'node:path';
import type { ChatTurn, PlannerProvider, ToolCall, ToolResult, Usage } from './types.js';
import { Budget } from './budget.js';
import { READ_FILE_TOOL, readFileTool } from './tools.js';

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
  maxIterations?: number;
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

    const response = await input.provider.send({
      systemPrompt: input.systemPrompt,
      model: input.model,
      tools: [READ_FILE_TOOL],
      turns,
      apiKey: input.apiKey,
      maxOutputTokens: 8192,
    });

    if (response.usage) {
      input.budget.recordUsage(response.usage);
      input.onUsage?.(response.usage);
    }

    if (response.stopReason === 'error') {
      const base = response.rawError ?? 'planner: provider error';
      throw new Error(`${base} Run \`squad doctor\` to verify models and credentials.`);
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
