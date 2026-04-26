import fs from 'node:fs';
import path from 'node:path';
import type { SquadConfig, TrackerType } from './config.js';
import { readFile, templatesDir, writeFileSafe } from '../utils/fs.js';
import { escapeTemplateValue, render } from './template.js';
import type { DownloadedAttachment, FetchIssueResult } from '../tracker/types.js';

export function buildIntakeTemplateVars(args: {
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

export function buildSourcePreamble(
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

export function buildFallbackPreamble(reason: string, hint?: string): string {
  const hintLine = hint ? `\n> Hint: ${hint}` : '';
  return `> **Tracker auto-fetch skipped.**  \n> ${reason}${hintLine}\n\n---\n\n`;
}

export function buildSkippedTrackerPreamble(trackerType: TrackerType): string {
  return [
    '> **Source:** manual entry (tracker skipped via `--no-tracker`).',
    `> Active tracker for this workspace: \`${trackerType}\` — this story is not linked. `,
    '> Run `squad tracker link <story-path> <tracker-id>` later if you want to attach one.',
    '',
    '',
  ].join('\n');
}

export function ensureFeatureOverview(featurePlanDir: string, slug: string): void {
  fs.mkdirSync(featurePlanDir, { recursive: true });
  const overviewFile = path.join(featurePlanDir, '00-overview.md');
  if (fs.existsSync(overviewFile)) return;
  const template = readFile(path.join(templatesDir(), 'overview.md'));
  writeFileSafe(overviewFile, render(template, { featureSlug: slug }), false);
}
