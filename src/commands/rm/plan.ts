import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { listStories } from '../../core/stories.js';
import {
  canPromptForRm,
  listAllPlanListEntries,
  pickPlanInteractive,
  removeOverviewRowForPlanFile,
  renderPreview,
  resolvePlanFromArg,
  trashOrDelete,
  type PlanListEntry,
  type RmBaseOptions,
} from './shared.js';

export interface RmPlanOptions extends RmBaseOptions {}

export async function runRmPlan(planPathOrSequence: string | undefined, opts: RmPlanOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const dryRun = !!opts.dryRun;
  const useTrash = !!opts.trash;
  const yes = !!opts.yes;
  const featureFilter = opts.feature?.trim() || undefined;

  const allPlans = listAllPlanListEntries(paths, featureFilter);
  if (allPlans.length === 0) {
    ui.info('No plan files to delete. Run `squad new-plan` to generate one.');
    return;
  }

  const canPrompt = canPromptForRm({ yes });
  let plan: PlanListEntry | undefined;

  if (planPathOrSequence?.trim()) {
    plan = resolvePlanFromArg(planPathOrSequence, paths, featureFilter);
    if (!plan) {
      throw new Error(
        `Could not find a plan matching "${planPathOrSequence.trim()}". Run \`squad rm plan\` without arguments to pick from a list.`,
      );
    }
  } else {
    if (allPlans.length === 1) {
      plan = allPlans[0]!;
    } else if (!canPrompt) {
      throw new Error(
        'Usage: squad rm plan <path|NN> — run `squad rm plan` in a TTY to pick, or pass `squad rm plan <path|NN> --yes` in CI.',
      );
    } else {
      plan = await pickPlanInteractive(paths, featureFilter);
    }
  }

  const storyRows = listStories(paths, { feature: plan.feature });
  const linked = storyRows.find((s) => s.planFile === plan.file);

  const targets = [{ label: path.relative(root, plan.abs), absPath: plan.abs, kind: 'file' as const }];
  renderPreview('plan', targets, {
    dryRun,
    trash: useTrash,
    trashRoot: paths.trashDir,
  });

  if (dryRun) {
    ui.info('Dry run: no changes applied. Re-run without --dry-run to delete.');
    return;
  }

  if (!yes) {
    if (!canPrompt) {
      throw new Error(
        'Pass --yes to confirm deletion in a non-interactive environment, or run `squad rm plan` in a TTY.',
      );
    }
    const ok = await confirm({ message: 'Delete this plan file only? (intake and config are kept.)', default: false });
    if (!ok) {
      ui.info('Cancelled.');
      return;
    }
  }

  trashOrDelete([plan.abs], paths.trashDir, useTrash);
  removeOverviewRowForPlanFile(path.join(paths.plansDir, plan.feature), plan.file);

  const intakeHint = linked
    ? path.relative(root, linked.intakePath)
    : `under .squad/stories/${plan.feature}/`;
  ui.success(`Plan removed. Run \`squad new-plan ${intakeHint}\` to regenerate.`);
}
