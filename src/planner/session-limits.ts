import type { Budget } from './budget.js';

export const DEFAULT_PLANNER_MAX_ITERATIONS = 40;

export type PlannerSessionLimitKind =
  | 'max_output_tokens'
  | 'max_iterations'
  | 'wall_clock'
  | 'cost_cap'
  | 'file_or_context_reads';

export type PlannerLimitDecision = 'continue' | 'cancel';

export interface PlannerSessionLimitContext {
  kind: PlannerSessionLimitKind;
  budgetSnapshot: ReturnType<Budget['snapshot']>;
  iterations: number;
  maxIterations: number;
  maxOutputTokens: number;
}

/** User message appended after a max_tokens truncation so the model can finish the markdown without repeating prior sections. */
export const PLANNER_MARKDOWN_CONTINUATION_USER =
  'Your previous reply was cut off because it hit the per-response output token limit for this request. ' +
  'Continue the Markdown plan from the exact cut-off only: write the remainder, do not repeat headings or paragraphs already sent. ' +
  'When the plan is complete, use end_turn without unnecessary tool calls.';
