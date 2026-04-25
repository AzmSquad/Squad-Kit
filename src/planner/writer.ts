import fs from 'node:fs';
import path from 'node:path';
import { slugify, type SquadPaths } from '../core/paths.js';
import { formatSequence, scanPlans } from '../core/sequence.js';
import type { SquadConfig } from '../core/config.js';
import type { StoryRecord } from '../core/stories.js';
import { trackerIdForFilename } from '../core/tracker.js';

export interface WritePlanInput {
  paths: SquadPaths;
  config: SquadConfig;
  story: StoryRecord;
  planBodyMarkdown: string;
  metadataHeader: string;
  /**
   * When true, writes `*.partial.md`, reuses an existing partial for the same story when present,
   * and expects `metadataHeader` to include the partial front matter (see `buildMetadataHeader`).
   */
  partial?: boolean;
}

export interface WritePlanOutput {
  planFile: string;
  sequenceNumber: number;
  overwrote: boolean;
}

/** Stem after `NN-story-`: always the story folder id (`slugify(story.id)`), never the title hint (keeps paths short). */
function planFileSlugParts(config: SquadConfig, story: StoryRecord): { baseSlug: string; trackerPart: string } {
  const baseSlug = slugify(story.id);
  const trackerId =
    config.naming.includeTrackerId && config.tracker.type !== 'none'
      ? trackerIdForFilename(config.tracker.type, story.id)
      : '';
  const trackerPart =
    trackerId && trackerId.toLowerCase() !== baseSlug ? `-${trackerId}` : '';
  return { baseSlug, trackerPart };
}

/** Concurrent runs against the same intake can race on overview / sequence; callers should serialize if needed. */
export function writePlanFile(input: WritePlanInput): WritePlanOutput {
  const { paths, config, story } = input;

  const featurePlanDir = path.join(paths.plansDir, story.feature);
  fs.mkdirSync(featurePlanDir, { recursive: true });

  if (input.partial) {
    return writePartialPlanFile(input, featurePlanDir, paths, config, story);
  }

  const existing = findExistingPlan(featurePlanDir, story.id);
  let targetPath: string;
  let nn: number;
  let overwrote = false;

  if (existing) {
    targetPath = existing.absPath;
    nn = existing.nn;
    overwrote = true;
  } else {
    nn = scanPlans(paths.plansDir).nextGlobal;
    const { baseSlug, trackerPart } = planFileSlugParts(config, story);
    targetPath = path.join(featurePlanDir, `${formatSequence(nn)}-story-${baseSlug}${trackerPart}.md`);
  }

  const body = `${input.metadataHeader.trimEnd()}\n\n${input.planBodyMarkdown.trimStart()}\n`;
  fs.writeFileSync(targetPath, body, 'utf8');

  upsertOverviewRow(featurePlanDir, story.feature, nn, path.basename(targetPath), story, false);

  return { planFile: targetPath, sequenceNumber: nn, overwrote };
}

function writePartialPlanFile(
  input: WritePlanInput,
  featurePlanDir: string,
  paths: SquadPaths,
  config: SquadConfig,
  story: StoryRecord,
): WritePlanOutput {
  const existingPartial = findExistingPartialPlan(featurePlanDir, story.id);
  let targetPath: string;
  let nn: number;
  let overwrote = false;

  if (existingPartial) {
    targetPath = existingPartial.absPath;
    nn = existingPartial.nn;
    overwrote = true;
  } else {
    nn = scanPlans(paths.plansDir).nextGlobal;
    const { baseSlug, trackerPart } = planFileSlugParts(config, story);
    targetPath = path.join(featurePlanDir, `${formatSequence(nn)}-story-${baseSlug}${trackerPart}.partial.md`);
  }

  const body = `${input.metadataHeader.trimEnd()}\n\n${input.planBodyMarkdown.trimStart()}\n`;
  fs.writeFileSync(targetPath, body, 'utf8');

  upsertOverviewRow(featurePlanDir, story.feature, nn, path.basename(targetPath), story, true);

  return { planFile: targetPath, sequenceNumber: nn, overwrote };
}

function findExistingPlan(featureDir: string, storyId: string): { absPath: string; nn: number } | undefined {
  if (!fs.existsSync(featureDir)) return undefined;
  const pattern = /^(\d{2,})-story-.+\.md$/;
  for (const entry of fs.readdirSync(featureDir)) {
    if (entry.endsWith('.partial.md')) continue;
    const m = entry.match(pattern);
    if (!m) continue;
    if (entry.includes(storyId)) return { absPath: path.join(featureDir, entry), nn: parseInt(m[1]!, 10) };
  }
  return undefined;
}

function findExistingPartialPlan(
  featureDir: string,
  storyId: string,
): { absPath: string; nn: number } | undefined {
  if (!fs.existsSync(featureDir)) return undefined;
  const pattern = /^(\d{2,})-story-.+\.partial\.md$/;
  for (const entry of fs.readdirSync(featureDir)) {
    const m = entry.match(pattern);
    if (!m) continue;
    if (entry.includes(storyId)) return { absPath: path.join(featureDir, entry), nn: parseInt(m[1]!, 10) };
  }
  return undefined;
}

function upsertOverviewRow(
  featureDir: string,
  feature: string,
  nn: number,
  filename: string,
  story: StoryRecord,
  isPartial: boolean,
): void {
  const overviewPath = path.join(featureDir, '00-overview.md');
  const titleCell = isPartial ? `${story.titleHint ?? story.id} (partial)` : (story.titleHint ?? story.id);
  const row = `| ${formatSequence(nn)} | \`${filename}\` | ${titleCell} | ${story.id} | — |`;
  if (!fs.existsSync(overviewPath)) {
    const content = `# ${feature} — plan overview\n\nEntry point for the **${feature}** feature. Stories execute in order by their \`NN\` prefix.\n\n## Stories\n\n| NN | File | Title | Tracker id | Depends on |\n|----|------|-------|------------|------------|\n${row}\n`;
    fs.writeFileSync(overviewPath, content, 'utf8');
    return;
  }

  const current = fs.readFileSync(overviewPath, 'utf8');
  const lines = current.split('\n');
  const existingIdx = lines.findIndex((l) => l.includes(`\`${filename}\``) || l.includes(`| ${formatSequence(nn)} |`));
  if (existingIdx >= 0) {
    lines[existingIdx] = row;
  } else {
    const tableEnd = findTableEnd(lines);
    lines.splice(tableEnd, 0, row);
  }
  fs.writeFileSync(overviewPath, lines.join('\n'), 'utf8');
}

function findTableEnd(lines: string[]): number {
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!inTable && line.startsWith('|')) {
      inTable = true;
      continue;
    }
    if (inTable && !line.startsWith('|')) return i;
  }
  return lines.length;
}

export function buildMetadataHeader(args: {
  provider: string;
  model: string;
  reads: number;
  bytes: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd?: number;
  /** When `partial`, appends YAML front matter after the HTML comment. */
  planStatus?: 'complete' | 'partial';
}): string {
  const parts = [
    `generated by ${args.provider}/${args.model}`,
    `at ${new Date().toISOString()}`,
    `${args.reads} reads / ${(args.bytes / 1024).toFixed(1)} KB context`,
    `${args.inputTokens} in / ${args.outputTokens} out tokens`,
    args.costUsd !== undefined ? `~$${args.costUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  const line1 = `<!-- squad-kit: ${parts.join(', ')} -->`;
  if (args.planStatus === 'partial') {
    return `${line1}\n\n---\nsquad-kit-plan-status: partial\n---`;
  }
  return line1;
}
