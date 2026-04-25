import fs from 'node:fs';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot, slugify, type SquadPaths } from '../core/paths.js';
import { listFeatures } from '../core/stories.js';
import { loadConfig, type SquadConfig, type TrackerType } from '../core/config.js';
import { validateTrackerId, trackerIdForFilename } from '../core/tracker.js';
import { loadSecrets } from '../core/secrets.js';
import { readFile, readBundledPrompt, templatesDir, writeFileSafe } from '../utils/fs.js';
import { escapeTemplateValue, render } from '../core/template.js';
import { clientFor, overlayTrackerEnv } from '../tracker/index.js';
import { TrackerError, type DownloadedAttachment, type FetchIssueResult } from '../tracker/types.js';

export function validateFeatureSlugForPrompt(v: string): true | string {
  const trimmed = v.trim();
  if (!trimmed) return 'Required.';
  const s = slugify(trimmed);
  if (!s) return 'Required.';
  if (s !== trimmed) return 'Use lowercase kebab-case (letters, digits, hyphens).';
  return true;
}

export interface NewStoryOptions {
  id?: string;
  title?: string;
  yes?: boolean;
  /** default true; --no-fetch sets false */
  fetch?: boolean;
  /** default true; --no-attachments sets false */
  attachments?: boolean;
  attachmentMb?: number;
  /** default true; --no-tracker sets false. When false, behave as if tracker.type === 'none' for this call. */
  tracker?: boolean;
}

export async function runNewStory(featureSlug: string | undefined, opts: NewStoryOptions): Promise<void> {
  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && process.env.CI !== 'true';

  let featureSlugInput: string | undefined = featureSlug;
  if (!featureSlugInput) {
    if (!interactive) {
      throw new Error(
        'feature-slug is required. Run `squad new-story` in a TTY to pick interactively, or pass a slug like `squad new-story <feature-slug>`, or add `--yes` to fail fast in scripts.',
      );
    }
    const rootForPrompt = requireSquadRoot();
    const pathsForPrompt = buildPaths(rootForPrompt);
    const existing = listFeatures(pathsForPrompt);
    if (existing.length > 0) {
      const choice = await select({
        message: 'Feature:',
        choices: [
          ...existing.map((f) => ({ name: f, value: f })),
          { name: '─── new feature ───', value: '__NEW__' },
        ],
      });
      if (choice !== '__NEW__') {
        featureSlugInput = choice;
      }
    }
    if (!featureSlugInput) {
      featureSlugInput = (
        await input({
          message: 'New feature slug (kebab-case):',
          validate: validateFeatureSlugForPrompt,
        })
      ).trim();
    }
  }

  const slug = slugify(featureSlugInput!);
  if (!slug) {
    throw new Error(
      `Invalid feature slug: "${featureSlugInput}". Run \`squad new-story\` and use kebab-case (letters, digits, hyphens).`,
    );
  }

  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  let noTracker = opts.tracker === false && config.tracker.type !== 'none';
  let id = opts.id;
  if (noTracker) id = undefined;
  let trackerNeedsId =
    !noTracker && config.tracker.type !== 'none' && config.naming.includeTrackerId;

  let title = opts.title;

  if (!id && trackerNeedsId) {
    if (!interactive) {
      throw new Error(
        `Tracker "${config.tracker.type}" is configured and naming.includeTrackerId is true. ` +
          `Run \`squad new-story <feature-slug> --id <tracker-id>\` to link now, or \`squad new-story <feature-slug> --no-tracker\` to skip the tracker for this story only.`,
      );
    }
    const mode = await select({
      message: `This workspace requires a ${config.tracker.type} id for new stories. How do you want to proceed?`,
      choices: [
        { name: `Enter a ${config.tracker.type} id now`, value: 'enter' },
        { name: 'Skip tracker for this story (same as --no-tracker)', value: 'skip' },
      ],
      default: 'enter',
    });
    if (mode === 'skip') {
      opts.tracker = false;
      noTracker = true;
      trackerNeedsId = false;
    } else {
      id = (
        await input({
          message: `${config.tracker.type} work-item id:`,
          validate: (v) =>
            validateTrackerId(config.tracker.type, v.trim())
              ? true
              : `Invalid ${config.tracker.type} id format.`,
        })
      ).trim();
    }
  }

  if (id && !validateTrackerId(config.tracker.type, id)) {
    throw new Error(
      `Invalid tracker id "${id}" for tracker type "${config.tracker.type}". ` +
        `Run \`squad config show\` to review the expected format, or \`squad config set tracker\` if the tracker type is wrong.`,
    );
  }

  if (!id && !title) {
    if (!interactive) {
      if (!noTracker) {
        throw new Error(
          'Provide either --id <tracker-id> or --title "..." so the story folder has a distinct name. ' +
            'Run `squad new-story <feature-slug> --id ...` or `squad new-story <feature-slug> --title "..."` (or `--no-tracker` with a title).',
        );
      }
    } else {
      title = (await input({ message: 'Short story title:' })).trim();
      if (!title) throw new Error('Title cannot be empty. Run `squad new-story` again and enter a short title, or add `--yes` to fail fast in scripts.');
    }
  }

  if (interactive && !title) {
    const maybe = (await input({ message: 'Short title (optional, press Enter to skip):', default: '' })).trim();
    if (maybe) title = maybe;
  }

  const storyFolderName = id ? trackerIdForFilename(config.tracker.type, id) : slugify(title ?? '');
  if (!storyFolderName) {
    throw new Error(
      'Could not derive a story folder name. Pass `--title "<hint>"` when using `--no-tracker`, or `--id <tracker-id>` to name the folder after the tracker id.',
    );
  }
  const storyDir = path.join(paths.storiesDir, slug, storyFolderName);
  const intakeFile = path.join(storyDir, 'intake.md');
  const attachmentsDir = path.join(storyDir, 'attachments');

  if (fs.existsSync(intakeFile)) {
    throw new Error(
      `Intake already exists: ${intakeFile}. Run \`squad new-plan ${path.relative(root, intakeFile)}\` to plan it, or \`squad rm story\` to remove the story first.`,
    );
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });

  let sourceBlock = '';
  let fetchedSummary: { id: string; written: number } | undefined;
  let fetchedIssue: FetchIssueResult | undefined;

  const shouldFetch =
    !noTracker && opts.fetch !== false && Boolean(id) && config.tracker.type !== 'none';
  if (shouldFetch) {
    const outcome = await tryFetchIssue(config, id!, opts, paths, attachmentsDir);
    if (outcome.outcome === 'ok') {
      fetchedIssue = outcome.issue;
      sourceBlock = buildSourcePreamble(outcome.issue, outcome.downloads, config.tracker.type);
      if (!title) title = outcome.issue.title;
      const written = outcome.downloads.filter((d) => d.outcome === 'written').length;
      fetchedSummary = { id: outcome.issue.id, written };
    } else {
      ui.warning(`Tracker fetch skipped: ${outcome.reason}`);
      if (outcome.hint) ui.info(outcome.hint);
      sourceBlock = buildFallbackPreamble(outcome.reason, outcome.hint);
    }
  }

  const template = readBundledPrompt('intake.md');
  const rendered = render(
    template,
    buildIntakeTemplateVars({
      config,
      featureSlug: slug,
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

  ensureFeatureOverview(path.join(paths.plansDir, slug), slug);

  const relativePath = path.relative(root, intakeFile);
  const relAttachDir = path.relative(root, attachmentsDir);
  ui.success('Created intake');
  if (noTracker && config.tracker.type !== 'none') {
    ui.warning('Created without a tracker link. Use `squad tracker link` later to attach one.');
  }
  ui.kv('intake', relativePath, 11);
  ui.kv('attachments', relAttachDir + path.sep, 11);
  if (fetchedSummary && fetchedSummary.written > 0) {
    ui.kv('fetched', `${fetchedSummary.id} · ${fetchedSummary.written} attachments saved`, 11);
  }
  ui.blank();
  ui.step('Next: review the intake (Source block at top is from the tracker), then:');
  ui.info(`squad new-plan ${relativePath}`);
}

type FetchOutcome =
  | { outcome: 'ok'; issue: FetchIssueResult; downloads: DownloadedAttachment[] }
  | { outcome: 'skipped'; reason: string; hint?: string }
  | { outcome: 'failed'; reason: string; hint?: string };

async function tryFetchIssue(
  config: SquadConfig,
  id: string,
  opts: NewStoryOptions,
  paths: SquadPaths,
  attachmentsDir: string,
): Promise<FetchOutcome> {
  const secretsFromFile = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
  const secrets = overlayTrackerEnv(secretsFromFile);
  const resolution = clientFor(config, secrets);
  if (resolution.error) {
    return { outcome: 'skipped', reason: resolution.error.message, hint: resolution.error.detail };
  }
  const client = resolution.client!;

  const spin = ui.spinner(`Fetching ${config.tracker.type} ${id}…`);
  let issue: FetchIssueResult;
  try {
    issue = await client.fetchIssue(id);
  } catch (err) {
    spin.fail('Tracker fetch failed');
    if (err instanceof TrackerError) {
      return { outcome: 'failed', reason: err.message, hint: explainTrackerErrorHint(err) };
    }
    return { outcome: 'failed', reason: (err as Error).message };
  }
  spin.succeed(`Fetched ${issue.id}: ${truncate(issue.title, 60)}`);

  let downloads: DownloadedAttachment[] = [];
  if (opts.attachments !== false && issue.attachments.length > 0) {
    const attachSpin = ui.spinner(`Downloading ${issue.attachments.length} attachment(s)…`);
    downloads = await client.downloadAttachments(issue.attachments, attachmentsDir, {
      maxMegabytes: opts.attachmentMb,
    });
    const written = downloads.filter((d) => d.outcome === 'written').length;
    const skipped = downloads.length - written;
    attachSpin.succeed(`Attachments: ${written} saved, ${skipped} skipped`);
  } else if (opts.attachments === false && issue.attachments.length > 0) {
    downloads = issue.attachments.map((source) => ({
      source,
      outcome: 'skipped-error' as const,
      bytesWritten: 0,
      skipReason: 'not downloaded (--no-attachments)',
    }));
  }

  return { outcome: 'ok', issue, downloads };
}

function explainTrackerErrorHint(err: TrackerError): string | undefined {
  switch (err.kind) {
    case 'auth':
      return 'Run `squad config set tracker` to re-enter credentials, or `squad doctor` to verify.';
    case 'not-found':
      return 'Run `squad config show` to check workspace settings, or `squad tracker link` with a valid work-item id.';
    case 'rate-limited':
      return 'Wait a minute, then retry, or run `squad new-story` with --no-fetch.';
    case 'network':
      return 'Run `squad doctor` to verify connectivity, or `squad new-story` with --no-fetch to skip.';
    default:
      return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function buildIntakeTemplateVars(args: {
  config: SquadConfig;
  featureSlug: string;
  storyFolderName: string;
  trackerId: string | undefined;
  title: string | undefined;
  fetchedIssue: FetchIssueResult | undefined;
}): Record<string, string> {
  const e = escapeTemplateValue;
  const { config, featureSlug, storyFolderName, trackerId, title, fetchedIssue } = args;
  return {
    featureSlug,
    storyId: storyFolderName,
    trackerType: config.tracker.type,
    trackerWorkItemId: e((fetchedIssue?.id ?? trackerId ?? '').trim()),
    trackerWorkItemType: e((fetchedIssue?.type ?? '').trim()),
    trackerStatus: e((fetchedIssue?.status ?? '').trim()),
    trackerAssignee: e((fetchedIssue?.assignee ?? '').trim()),
    trackerLabels: e((fetchedIssue?.labels ?? []).join(', ').trim()),
    trackerTitle: e((title ?? '').trim()),
    trackerDescription: e((fetchedIssue?.description ?? '').trim()),
    trackerAcceptanceCriteria: e((fetchedIssue?.acceptanceCriteria ?? '').trim()),
    projectRoots: (config.project.projectRoots ?? ['.']).join(', '),
    primaryLanguage: config.project.primaryLanguage ?? '',
  };
}

function buildSourcePreamble(
  issue: FetchIssueResult,
  downloads: DownloadedAttachment[],
  trackerType: TrackerType,
): string {
  const header =
    `> **Fetched from ${trackerType}:** [${issue.id}](${issue.url})  ` +
    `\n> *Fetched ${issue.fetchedAt}. Edit the sections below as needed; the planner reads this file verbatim.*\n\n`;

  const metaLines: string[] = [];
  metaLines.push(`**Title:** ${issue.title}`);
  if (issue.type) metaLines.push(`**Type:** ${issue.type}`);
  if (issue.status) metaLines.push(`**Status:** ${issue.status}`);
  if (issue.assignee) metaLines.push(`**Assignee:** ${issue.assignee}`);
  if (issue.labels.length > 0) metaLines.push(`**Labels:** ${issue.labels.join(', ')}`);

  const description =
    issue.description.trim().length > 0 ? issue.description.trim() : '*(tracker returned an empty description)*';

  const attachmentsTable = renderAttachmentsTable(downloads);

  return [
    header,
    '## Source — work item (from tracker)',
    '',
    metaLines.join('  \n'),
    '',
    '### Description',
    '',
    description,
    '',
    attachmentsTable,
    '',
    '---',
    '',
  ].join('\n');
}

function renderAttachmentsTable(downloads: DownloadedAttachment[]): string {
  if (downloads.length === 0) return '### Attachments\n\nNone.';
  const rows = downloads.map((d) => {
    const sizeNum = (d.bytesWritten || d.source.size) / 1024;
    const size = `${sizeNum | 0} KB`;
    switch (d.outcome) {
      case 'written':
        return `| \`attachments/${path.basename(d.absolutePath!)}\` | ${size} | downloaded |`;
      case 'skipped-oversize':
        return `| ${d.source.filename} | ${size} | **skipped** — ${d.skipReason} |`;
      case 'skipped-error':
        return `| ${d.source.filename} | — | **skipped** — ${d.skipReason} |`;
    }
  });
  return ['### Attachments', '', '| File | Size | Status |', '| ---- | ---- | ------ |', ...rows].join('\n');
}

function buildFallbackPreamble(reason: string, hint?: string): string {
  const hintLine = hint ? `\n> Hint: ${hint}` : '';
  return `> **Tracker auto-fetch skipped.**  \n> ${reason}${hintLine}\n\n---\n\n`;
}

function buildSkippedTrackerPreamble(trackerType: TrackerType): string {
  return [
    '> **Source:** manual entry (tracker skipped via `--no-tracker`).',
    `> Active tracker for this workspace: \`${trackerType}\` — this story is not linked. `,
    '> Run `squad tracker link <story-path> <tracker-id>` later if you want to attach one.',
    '',
    '',
  ].join('\n');
}

function ensureFeatureOverview(featurePlanDir: string, slug: string): void {
  fs.mkdirSync(featurePlanDir, { recursive: true });
  const overviewFile = path.join(featurePlanDir, '00-overview.md');
  if (fs.existsSync(overviewFile)) return;
  const template = readFile(path.join(templatesDir(), 'overview.md'));
  writeFileSafe(overviewFile, render(template, { featureSlug: slug }), false);
}
