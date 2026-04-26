import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { listAllStories } from '../../core/stories.js';
import type { StoryRecord } from '../../core/stories.js';
import {
  canPromptForRm,
  countOverviewDataRows,
  featureStoriesDirEmpty,
  pickStoryInteractive,
  renderPreview,
  resolveStoryFromArg,
  type RmBaseOptions,
} from './shared.js';
import { deleteStoryRecord } from '../../core/story-mutations.js';
import { runRmFeature } from './feature.js';

export interface RmStoryOptions extends RmBaseOptions {}

export async function runRmStory(storyPathOrId: string | undefined, opts: RmStoryOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const dryRun = !!opts.dryRun;
  const useTrash = !!opts.trash;
  const yes = !!opts.yes;
  const featureFilter = opts.feature?.trim() || undefined;

  const stories = listAllStories(paths).filter((s) => !featureFilter || s.feature === featureFilter);

  if (stories.length === 0) {
    ui.info('No stories to delete. Create one with `squad new-story`.');
    return;
  }

  const canPrompt = canPromptForRm({ yes });
  let story: StoryRecord | undefined;

  if (storyPathOrId?.trim()) {
    story = resolveStoryFromArg(storyPathOrId, stories, root);
    if (!story) {
      throw new Error(
        `"${storyPathOrId.trim()}" did not match any story. Run \`squad rm story\` without arguments to pick from a list, or \`squad list\` to see all stories.`,
      );
    }
  } else {
    if (stories.length === 1) {
      story = stories[0]!;
    } else if (!canPrompt) {
      throw new Error(
        'Usage: squad rm story <path-or-id> — run `squad rm story` in a TTY to pick, or pass a path/id with `-y` to skip the confirmation once a target is chosen.',
      );
    } else {
      story = await pickStoryInteractive(paths, featureFilter);
    }
  }

  const targets: Array<{ label: string; absPath: string; kind: 'dir' | 'file' }> = [
    { label: path.relative(root, story.storyDir), absPath: story.storyDir, kind: 'dir' },
  ];
  if (story.planFile) {
    const planAbs = path.join(paths.plansDir, story.feature, story.planFile);
    targets.push({ label: path.relative(root, planAbs), absPath: planAbs, kind: 'file' });
  }

  renderPreview('story', targets, {
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
        'Pass --yes to confirm deletion in a non-interactive environment, or run `squad rm story` in a TTY to confirm the prompt interactively.',
      );
    }
    const ok = await confirm({ message: 'Delete this story and related plan/overview row?', default: false });
    if (!ok) {
      ui.info('Cancelled.');
      return;
    }
  }

  const result = deleteStoryRecord({ paths, story, trash: useTrash });

  if (result.trashed) {
    ui.success(`Removed (moved to ${path.relative(root, result.trashed)}).`);
  } else {
    ui.success('Removed story folder, plan file (if any), and overview row.');
  }

  const featurePlanDir = path.join(paths.plansDir, story.feature);
  const overviewPath = path.join(featurePlanDir, '00-overview.md');
  if (fs.existsSync(overviewPath)) {
    const body = fs.readFileSync(overviewPath, 'utf8');
    const onlyShell = countOverviewDataRows(body) === 0;
    if (onlyShell && featureStoriesDirEmpty(paths, story.feature)) {
      if (canPrompt) {
        const also = await confirm({
          message: `Feature "${story.feature}" has no stories left and an empty overview table. Remove the whole feature with \`squad rm feature ${story.feature}\` now?`,
          default: false,
        });
        if (also) {
          await runRmFeature(story.feature, { dryRun: false, trash: useTrash, yes: true });
          return;
        }
      } else {
        ui.info(`Feature "${story.feature}" has no stories under .squad/stories/ and no overview rows. Run \`squad rm feature ${story.feature}\` to remove the feature directories.`);
      }
    }
  }
}
