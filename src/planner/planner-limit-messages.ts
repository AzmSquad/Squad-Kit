import * as ui from '../ui/index.js';
import type { PlannerSessionLimitContext } from './session-limits.js';

/** The two resolved modes; `auto` is resolved away before any of this copy is chosen. */
type PlannerAuthMode = 'subscription' | 'api-key';

export function printPlannerApiCostNotice(authMode: PlannerAuthMode = 'api-key'): void {
  ui.blank();
  if (authMode === 'subscription') {
    ui.step('Usage');
    ui.info(
      '`squad new-plan --api` runs on your Claude subscription — there is no per-token API bill. ' +
        'Agent SDK usage draws on the same usage limits as Claude and Claude Code, so a long planning ' +
        'run consumes part of your window. Hitting the limit means waiting for the reset, not a larger invoice.',
    );
    ui.blank();
    return;
  }
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
    case 'file_or_context_reads':
      return 'File read or context size limit';
  }
}

function tokenSummary(ctx: PlannerSessionLimitContext): string {
  const snap = ctx.budgetSnapshot;
  return `Tokens so far: ${snap.usage.inputTokens} in / ${snap.usage.outputTokens} out for this session.`;
}

function kindDetail(ctx: PlannerSessionLimitContext, authMode: PlannerAuthMode): string[] {
  switch (ctx.kind) {
    case 'max_output_tokens':
      return [
        `The model hit the per-request output cap (${ctx.maxOutputTokens} completion tokens). Long plans can stop mid-markdown even though the session is otherwise healthy.`,
        'You can continue: squad-kit will ask the model to append the rest of the plan in a follow-up request ' +
          (authMode === 'subscription'
            ? '(it draws further on your Claude usage limits).'
            : '(extra tokens apply).'),
        tokenSummary(ctx),
      ];
    case 'max_iterations':
      return [
        `The planner reached its round cap (${ctx.maxIterations} model turns) without a clean stop.`,
        'Continuing raises the round cap and file/time budgets for this run by another full slice from your config.',
        tokenSummary(ctx),
      ];
    case 'wall_clock':
      return [
        'The configured wall-clock budget for this planning session elapsed before the model finished.',
        'Continuing adds another slice of time (and read/output/round limits) from your planner budget.',
        tokenSummary(ctx),
      ];
    case 'file_or_context_reads':
      return [
        'A `read_file` call could not run because the file-read count or total read-bytes budget was exhausted.',
        'Continuing extends read, context, time, round, and output limits for this session so the model can read again or finish without reads.',
        tokenSummary(ctx),
      ];
  }
}

/**
 * `authMode` defaults to `api-key` so 0.11.0 callers keep the per-token wording. Subscription runs
 * have no per-request invoice, so any copy that implies one has to branch — same reason
 * `printPlannerApiCostNotice` above does.
 */
export function printPlannerLimitExplanation(
  ctx: PlannerSessionLimitContext,
  authMode: PlannerAuthMode = 'api-key',
): void {
  ui.warning(kindTitle(ctx.kind));
  for (const line of kindDetail(ctx, authMode)) {
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
