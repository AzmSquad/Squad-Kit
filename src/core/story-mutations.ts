import fs from 'node:fs';
import path from 'node:path';
import type { SquadConfig } from './config.js';
import type { SquadPaths } from './paths.js';
import { slugify } from './paths.js';
import { readBundledPrompt, writeFileSafe } from '../utils/fs.js';
import { render } from './template.js';
import { validateTrackerId, trackerIdForFilename } from './tracker.js';
import { removeOverviewRow, trashOrDelete } from '../commands/rm/shared.js';
import type { StoryRecord } from './stories.js';
import type { DownloadedAttachment, FetchIssueResult, TrackerClient } from '../tracker/types.js';
import {
  buildIntakeTemplateVars,
  buildSkippedTrackerPreamble,
  buildSourcePreamble,
  ensureFeatureOverview,
} from './story-intake-helpers.js';

export interface CreatedStory {
  storyDir: string;
  intakePath: string;
  feature: string;
  id: string;
}

/**
 * Persists a new story intake to disk. Used by the CLI (after optional tracker fetch) and the console API.
 * Caller must have already decided feature slug, folder name, preambles, and fetch data.
 */
export function writeNewStoryToDisk(input: {
  paths: SquadPaths;
  config: SquadConfig;
  featureSlug: string;
  storyFolderName: string;
  id: string | undefined;
  title: string | undefined;
  noTracker: boolean;
  sourceBlock: string;
  fetchedIssue: FetchIssueResult | undefined;
}): CreatedStory {
  const { paths, config, featureSlug, storyFolderName, id, title, noTracker, sourceBlock, fetchedIssue } = input;
  const storyDir = path.join(paths.storiesDir, featureSlug, storyFolderName);
  const intakeFile = path.join(storyDir, 'intake.md');
  const attachmentsDir = path.join(storyDir, 'attachments');
  if (fs.existsSync(intakeFile)) {
    const rel = path.relative(paths.root, intakeFile);
    throw new Error(
      `Intake already exists: ${intakeFile}. Run \`squad new-plan ${rel}\` to plan it, or \`squad rm story\` to remove the story first.`,
    );
  }
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const template = readBundledPrompt('intake.md');
  const rendered = render(
    template,
    buildIntakeTemplateVars({
      config,
      featureSlug,
      storyFolderName,
      trackerId: id,
      title,
      fetchedIssue,
    }),
  );
  const skippedPreamble =
    noTracker && config.tracker.type !== 'none' && !sourceBlock
      ? buildSkippedTrackerPreamble(config.tracker.type)
      : '';
  writeFileSafe(intakeFile, skippedPreamble + sourceBlock + rendered, false);
  ensureFeatureOverview(path.join(paths.plansDir, featureSlug), featureSlug);
  return { storyDir, intakePath: intakeFile, feature: featureSlug, id: storyFolderName };
}

/**
 * console API: non-interactive new story, never fetches the tracker. Same rules as
 * `squad new-story` with --yes, --no-fetch, and (when no `trackerId`) skip-tracker naming for linked workspaces.
 */
export function createStoryRecord(input: {
  paths: SquadPaths;
  config: SquadConfig;
  feature: string;
  title?: string;
  trackerId?: string;
}): CreatedStory {
  const feature = slugify(input.feature);
  if (!feature) {
    throw new Error(`Invalid feature slug: "${input.feature}". Use kebab-case (letters, digits, hyphens).`);
  }
  const rawId = input.trackerId?.trim() || undefined;
  const noTracker = input.config.tracker.type !== 'none' && !rawId;
  let id: string | undefined = rawId;
  if (noTracker) id = undefined;

  if (id && !validateTrackerId(input.config.tracker.type, id)) {
    throw new Error(
      `Invalid tracker id "${id}" for tracker type "${input.config.tracker.type}". ` +
        `Check the expected format, or \`squad config set tracker\` if the tracker type is wrong.`,
    );
  }

  const title = input.title?.trim() || undefined;
  const storyFolderName = id ? trackerIdForFilename(input.config.tracker.type, id) : slugify(title ?? '');
  if (!storyFolderName) {
    throw new Error(
      'Could not derive a story folder name. Pass a "title" when not linking a tracker id, or provide a "trackerId" to name the folder after it.',
    );
  }

  return writeNewStoryToDisk({
    paths: input.paths,
    config: input.config,
    featureSlug: feature,
    storyFolderName,
    id,
    title,
    noTracker,
    sourceBlock: '',
    fetchedIssue: undefined,
  });
}

export interface CreateStoryFromIssueInput {
  paths: SquadPaths;
  feature: string;
  issue: FetchIssueResult;
  withAttachments: boolean;
  client: TrackerClient;
  config: SquadConfig;
}

/**
 * Create a story from an already-fetched issue (e.g. console import). Reuses the same
 * intake template and source preamble as `squad new-story` with tracker fetch.
 */
export async function createStoryRecordFromIssue(input: CreateStoryFromIssueInput): Promise<CreatedStory> {
  const feature = slugify(input.feature);
  if (!feature) {
    throw new Error(`Invalid feature slug: "${input.feature}". Use kebab-case (letters, digits, hyphens).`);
  }
  const id = input.issue.id.trim();
  if (!validateTrackerId(input.config.tracker.type, id)) {
    throw new Error(
      `Invalid tracker id "${id}" for tracker type "${input.config.tracker.type}". ` +
        `Check the expected format, or \`squad config set tracker\` if the tracker type is wrong.`,
    );
  }
  const title = input.issue.title;
  const storyFolderName = trackerIdForFilename(input.config.tracker.type, id);
  const storyDir = path.join(input.paths.storiesDir, feature, storyFolderName);
  const intakeFile = path.join(storyDir, 'intake.md');
  const attachmentsDir = path.join(storyDir, 'attachments');
  if (fs.existsSync(intakeFile)) {
    const rel = path.relative(input.paths.root, intakeFile);
    throw new Error(
      `Intake already exists: ${intakeFile}. Run \`squad new-plan ${rel}\` to plan it, or \`squad rm story\` to remove the story first.`,
    );
  }
  fs.mkdirSync(attachmentsDir, { recursive: true });

  let downloads: DownloadedAttachment[] = [];
  if (input.withAttachments && input.issue.attachments.length > 0) {
    downloads = await input.client.downloadAttachments(input.issue.attachments, attachmentsDir);
  } else if (!input.withAttachments && input.issue.attachments.length > 0) {
    downloads = input.issue.attachments.map((source) => ({
      source,
      outcome: 'skipped-error' as const,
      bytesWritten: 0,
      skipReason: 'not downloaded',
    }));
  }
  const sourceBlock = buildSourcePreamble(input.issue, downloads, input.config.tracker.type);
  return writeNewStoryToDisk({
    paths: input.paths,
    config: input.config,
    featureSlug: feature,
    storyFolderName,
    id,
    title,
    noTracker: false,
    sourceBlock,
    fetchedIssue: input.issue,
  });
}

export interface DeleteStoryInput {
  paths: SquadPaths;
  story: StoryRecord;
  trash: boolean;
}

export interface DeletedStory {
  removed: string[];
  trashed?: string;
}

export function deleteStoryRecord(input: DeleteStoryInput): DeletedStory {
  const targets: string[] = [input.story.storyDir];
  if (input.story.planFile) {
    targets.push(path.join(input.paths.plansDir, input.story.feature, input.story.planFile));
  }
  const result = trashOrDelete(targets, input.paths.trashDir, input.trash);
  removeOverviewRow(path.join(input.paths.plansDir, input.story.feature), input.story.id);
  return result;
}
