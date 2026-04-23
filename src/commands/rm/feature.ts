import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { listFeatures } from '../../core/stories.js';
import { listAllPlanListEntries, canPromptForRm, pickFeatureInteractive, trashOrDelete, type RmBaseOptions } from './shared.js';

function countStoryDirs(storiesDir: string, feature: string): number {
  const d = path.join(storiesDir, feature);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).length;
}

export interface RmFeatureOptions extends RmBaseOptions {}

export async function runRmFeature(featureSlug: string | undefined, opts: RmFeatureOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const dryRun = !!opts.dryRun;
  const useTrash = !!opts.trash;
  const yes = !!opts.yes;
  const canPrompt = canPromptForRm({ yes });

  const feats = listFeatures(paths);
  if (feats.length === 0) {
    ui.info('No feature directories found under .squad/stories/.');
    return;
  }

  let feature: string;
  if (featureSlug?.trim()) {
    const t = featureSlug.trim();
    if (!feats.includes(t)) {
      throw new Error(
        `No feature "${t}" found. Run \`squad list\` or \`squad rm feature\` without arguments to pick a feature.`,
      );
    }
    feature = t;
  } else {
    if (feats.length === 1) {
      feature = feats[0]!;
    } else if (!canPrompt) {
      throw new Error(
        'This command removes an entire feature. Run `squad rm feature <slug> --yes` in CI, or `squad rm feature` in a TTY to pick a feature interactively.',
      );
    } else {
      feature = await pickFeatureInteractive(paths);
    }
  }

  const storyDir = path.join(paths.storiesDir, feature);
  const planDir = path.join(paths.plansDir, feature);
  const nStories = countStoryDirs(paths.storiesDir, feature);
  const nPlans = listAllPlanListEntries(paths, feature).length;
  const hasOverview = fs.existsSync(path.join(planDir, '00-overview.md')) ? 1 : 0;

  const targets: Array<{ label: string; absPath: string; kind: 'dir' | 'file' }> = [];
  if (fs.existsSync(storyDir)) {
    targets.push({ label: path.relative(root, storyDir), absPath: storyDir, kind: 'dir' });
  }
  if (fs.existsSync(planDir)) {
    targets.push({ label: path.relative(root, planDir), absPath: planDir, kind: 'dir' });
  }

  ui.divider('squad rm feature');
  ui.info(`Feature:  ${feature}`);
  ui.info(`Delete:   ${nStories} stories, ${nPlans} plans, ${hasOverview} overview file`);
  ui.info('Paths:');
  for (const t of targets) {
    ui.line(`  ${t.label}/`);
  }
  ui.blank();
  ui.step(dryRun ? 'Dry run — nothing will be changed.' : 'About to remove:');
  for (const t of targets) {
    ui.kv(t.kind, t.label, 6);
  }
  if (useTrash) {
    ui.info(`Items will move to ${path.relative(process.cwd(), paths.trashDir)}/<timestamp>/`);
  } else if (!dryRun) {
    ui.warning('This is a permanent delete. Pass --trash to move to .squad/.trash/ instead.');
  }

  if (dryRun) {
    ui.info('Dry run: no changes applied. Re-run without --dry-run to delete.');
    return;
  }

  if (targets.length === 0) {
    ui.info('Nothing to remove for this feature.');
    return;
  }

  if (!yes) {
    if (!canPrompt) {
      throw new Error(
        'This command removes an entire feature. Run `squad rm feature --yes` in CI, or `squad rm feature` in a TTY to confirm the prompt interactively.',
      );
    }
    const ok = await confirm({
      message: `Delete all of feature "${feature}" (stories + plans)?`,
      default: false,
    });
    if (!ok) {
      ui.info('Cancelled.');
      return;
    }
  }

  const result = trashOrDelete(
    targets.map((t) => t.absPath),
    paths.trashDir,
    useTrash,
  );

  if (result.trashed) {
    ui.success(`Feature removed. Items moved to ${path.relative(root, result.trashed)}.`);
  } else {
    ui.success('Feature removed (stories and plans directories).');
  }
  ui.info('Run `squad doctor` to confirm the workspace is in a clean state.');
}
