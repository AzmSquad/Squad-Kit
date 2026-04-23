import fs from 'node:fs';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { validateTrackerId } from '../core/tracker.js';
import { listAllStories } from '../core/stories.js';

export interface TrackerLinkOptions {
  yes?: boolean;
}

export async function runTrackerLink(
  storyPath: string | undefined,
  trackerId: string | undefined,
  opts: TrackerLinkOptions = {},
): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && process.env.CI !== 'true';

  let resolvedStoryPath = storyPath;
  if (!resolvedStoryPath) {
    if (!interactive) {
      throw new Error(
        'Usage: squad tracker link [story-path] [tracker-id]. Run `squad tracker link` without arguments in a TTY to pick from a list, or pass `--yes` to opt out of prompts.',
      );
    }
    const stories = listAllStories(paths);
    if (stories.length === 0) {
      throw new Error('No stories found under .squad/stories/. Create one with `squad new-story` first.');
    }
    resolvedStoryPath = await select({
      message: 'Story to link:',
      choices: stories.map((s) => ({
        name: `${s.feature}/${s.id}`,
        value: s.intakePath,
      })),
    });
  }

  let resolvedTrackerId = trackerId;
  if (!resolvedTrackerId) {
    if (!interactive) {
      throw new Error(
        'Usage: squad tracker link [story-path] [tracker-id]. Run `squad tracker link` without arguments in a TTY to pick from a list, or pass `--yes` to opt out of prompts.',
      );
    }
    resolvedTrackerId = (
      await input({
        message: `${config.tracker.type} work-item id:`,
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return 'Required.';
          return validateTrackerId(config.tracker.type, trimmed)
            ? true
            : `Invalid ${config.tracker.type} id format.`;
        },
      })
    ).trim();
  }

  if (!validateTrackerId(config.tracker.type, resolvedTrackerId)) {
    throw new Error(
      `Invalid tracker id "${resolvedTrackerId}" for tracker type "${config.tracker.type}". ` +
        `Run \`squad config show\` to review the expected format, or \`squad config set tracker\` if the type is wrong.`,
    );
  }

  const resolved = path.resolve(resolvedStoryPath);
  const intakeFile = resolved.endsWith('intake.md') ? resolved : path.join(resolved, 'intake.md');
  if (!fs.existsSync(intakeFile)) {
    throw new Error(
      `intake.md not found at ${intakeFile}. Run \`squad list\` to see valid paths, or \`squad new-story\` to create a story first.`,
    );
  }

  const content = fs.readFileSync(intakeFile, 'utf8');
  const updated = upsertTrackerId(content, resolvedTrackerId);
  fs.writeFileSync(intakeFile, updated, 'utf8');

  ui.success(`Linked tracker id ${resolvedTrackerId} → ${path.relative(root, intakeFile)}`);
  ui.blank();
  ui.step('Next:');
  ui.info('1) Review the intake — the Source block at the top now carries the tracker id.');
  ui.info('2) Run `squad new-plan --api` (or `--copy`) to generate the plan for this story.');
}

function upsertTrackerId(content: string, id: string): string {
  const pattern = /(-\s*\*\*Work item id:\*\*)[^\n]*/;
  if (pattern.test(content)) {
    return content.replace(pattern, `$1 ${id}`);
  }
  return content + `\n\n- **Work item id:** ${id}\n`;
}
