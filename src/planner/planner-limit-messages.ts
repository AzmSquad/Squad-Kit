import * as ui from '../ui/index.js';
import type { PlannerSessionLimitContext } from './session-limits.js';

export function printPlannerApiCostNotice(): void {
  ui.blank();
  ui.step('Billing');
  ui.info(
    '`squad new-plan --api` sends your intake and repo context to the configured provider. ' +
      'Each model round is billed like any other API usage (input tokens, output tokens, and cache-related tokens when applicable). ' +
      'Choosing “Continue” after a limit runs more rounds and usually increases cost.',
  );
  ui.blank();
}

function kindTitle(kind: PlannerSessionLimitContext['kind']): string {
  switch (kind) {
    case 'max_output_tokens':
      return 'Output length limit (single response)';
    case 'max_iterations':
      return 'Model round limit';
    case 'wall_clock':
      return 'Wall-clock time limit';
    case 'cost_cap':
      return 'Estimated cost cap';
    case 'file_or_context_reads':
      return 'File read or context size limit';
  }
}

function kindDetail(ctx: PlannerSessionLimitContext): string[] {
  const snap = ctx.budgetSnapshot;
  const cost =
    snap.usage.costUsd !== undefined
      ? `Estimated spend so far: about $${snap.usage.costUsd.toFixed(2)} (provider-reported when available).`
      : 'Estimated spend so far: not reported by the provider for this run.';

  switch (ctx.kind) {
    case 'max_output_tokens':
      return [
        `The model hit the per-request output cap (${ctx.maxOutputTokens} completion tokens). Long plans can stop mid-markdown even though the session is otherwise healthy.`,
        'You can continue: squad-kit will ask the model to append the rest of the plan in a follow-up request (extra tokens apply).',
        cost,
      ];
    case 'max_iterations':
      return [
        `The planner reached its round cap (${ctx.maxIterations} model turns) without a clean stop.`,
        'Continuing raises the round cap and file/time budgets for this run by another full slice from your config.',
        cost,
      ];
    case 'wall_clock':
      return [
        'The configured wall-clock budget for this planning session elapsed before the model finished.',
        'Continuing adds another slice of time (and read/output/round limits) from your planner budget.',
        cost,
      ];
    case 'cost_cap':
      return [
        'Spending crossed the optional `planner.budget.maxCostUsd` ceiling for this session.',
        'Continuing raises that ceiling for this run by another slice from config (if a cap is set).',
        cost,
      ];
    case 'file_or_context_reads':
      return [
        'A `read_file` call could not run because the file-read count or total read-bytes budget was exhausted.',
        'Continuing extends read, context, time, round, and output limits for this session so the model can read again or finish without reads.',
        cost,
      ];
  }
}

export function printPlannerLimitExplanation(ctx: PlannerSessionLimitContext): void {
  ui.warning(kindTitle(ctx.kind));
  for (const line of kindDetail(ctx)) {
    ui.info(line);
  }
  ui.kv('session so far', `${snapSummary(ctx)}`, 18);
}

function snapSummary(ctx: PlannerSessionLimitContext): string {
  const s = ctx.budgetSnapshot;
  return `${s.reads} reads · ${(s.bytes / 1024).toFixed(1)} KB read context · ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens`;
}

export function printPlannerLimitNextSteps(): void {
  ui.blank();
  ui.step('If you stop here');
  ui.info('An incomplete plan is saved as `*.partial.md` with front matter `squad-kit-plan-status: partial`.');
  ui.info('Fix limits in `.squad/config.yaml` (`planner.budget`, `planner.maxOutputTokens`) or run again when ready.');
  ui.blank();
}
