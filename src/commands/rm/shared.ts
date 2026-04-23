import fs from 'node:fs';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { isInteractive } from '../../ui/tty.js';
import { formatSequence } from '../../core/sequence.js';
import { findStoryByIntake, listAllStories, listFeatures, type StoryRecord } from '../../core/stories.js';
import type { SquadPaths } from '../../core/paths.js';

const STORY_PLAN = /^(\d{2,})-story-.+\.md$/;

export interface RmBaseOptions {
  dryRun?: boolean;
  trash?: boolean;
  yes?: boolean;
  feature?: string;
}

export function canPromptForRm(opts: { yes?: boolean }): boolean {
  if (opts.yes) return false;
  return isInteractive() && Boolean(process.stdin.isTTY);
}

/**
 * Remove the overview row for a story (matched by storyId appearing in the row text).
 * Idempotent: missing row or missing file is a no-op.
 */
export function removeOverviewRow(featurePlanDir: string, storyId: string): void {
  const overview = path.join(featurePlanDir, '00-overview.md');
  if (!fs.existsSync(overview)) return;
  const src = fs.readFileSync(overview, 'utf8');
  const lines = src.split('\n');
  const filtered = lines.filter((line) => {
    if (!line.startsWith('|')) return true;
    if (line.includes('NN') && line.includes('File') && line.includes('Title')) return true;
    if (/^\|\s*-+/.test(line)) return true;
    return !line.includes(storyId);
  });
  fs.writeFileSync(overview, filtered.join('\n'), 'utf8');
}

/** Remove a table row that references a plan file basename. */
export function removeOverviewRowForPlanFile(featurePlanDir: string, planBasename: string): void {
  const overview = path.join(featurePlanDir, '00-overview.md');
  if (!fs.existsSync(overview)) return;
  const src = fs.readFileSync(overview, 'utf8');
  const token = `\`${planBasename}\``;
  const lines = src.split('\n');
  const filtered = lines.filter((line) => {
    if (!line.startsWith('|')) return true;
    if (line.includes('NN') && line.includes('File') && line.includes('Title')) return true;
    if (/^\|\s*-+/.test(line)) return true;
    return !line.includes(token);
  });
  fs.writeFileSync(overview, filtered.join('\n'), 'utf8');
}

export function trashOrDelete(
  absPaths: string[],
  trashRoot: string,
  useTrash: boolean,
): { removed: string[]; trashed?: string } {
  if (!useTrash) {
    for (const p of absPaths) fs.rmSync(p, { recursive: true, force: true });
    return { removed: absPaths };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bucket = path.join(trashRoot, ts);
  fs.mkdirSync(bucket, { recursive: true });
  for (const src of absPaths) {
    const rel = path.basename(src);
    let dst = path.join(bucket, rel);
    let n = 0;
    while (fs.existsSync(dst)) {
      n += 1;
      dst = path.join(bucket, `${n}_${rel}`);
    }
    fs.renameSync(src, dst);
  }
  return { removed: absPaths, trashed: bucket };
}

export function renderPreview(
  kind: 'story' | 'plan' | 'feature',
  targets: Array<{ label: string; absPath: string; kind: 'dir' | 'file' }>,
  opts: { dryRun: boolean; trash: boolean; trashRoot: string },
): void {
  ui.divider(`squad rm ${kind}`);
  ui.step(opts.dryRun ? 'Dry run — nothing will be changed.' : 'About to remove:');
  for (const t of targets) {
    ui.kv(t.kind, t.label, 6);
  }
  if (opts.trash) {
    ui.info(`Items will move to ${path.relative(process.cwd(), opts.trashRoot)}/<timestamp>/`);
  } else if (!opts.dryRun) {
    ui.warning('This is a permanent delete. Pass --trash to move to .squad/.trash/ instead.');
  }
}

export interface PlanListEntry {
  feature: string;
  file: string;
  abs: string;
}

export function listAllPlanListEntries(paths: SquadPaths, featureFilter?: string): PlanListEntry[] {
  if (!fs.existsSync(paths.plansDir)) return [];
  const out: PlanListEntry[] = [];
  for (const ent of fs.readdirSync(paths.plansDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (featureFilter && ent.name !== featureFilter) continue;
    const featureDir = path.join(paths.plansDir, ent.name);
    for (const name of fs.readdirSync(featureDir)) {
      if (!STORY_PLAN.test(name)) continue;
      out.push({ feature: ent.name, file: name, abs: path.join(featureDir, name) });
    }
  }
  return out.sort((a, b) => (a.feature + a.file).localeCompare(b.feature + b.file));
}

export async function pickStoryInteractive(paths: SquadPaths, featureFilter?: string): Promise<StoryRecord> {
  const stories = listAllStories(paths).filter((s) => !featureFilter || s.feature === featureFilter);
  if (stories.length === 0) {
    throw new Error('No stories to pick. Run `squad new-story` first, or `squad list` to verify paths.');
  }
  if (stories.length === 1) return stories[0]!;
  const choice = await select<StoryRecord>({
    message: 'Story to remove:',
    choices: stories.map((s) => ({
      name: `${s.feature}/${s.id}  ·  ${s.titleHint ?? s.id}`,
      value: s,
    })),
  });
  return choice;
}

export async function pickPlanInteractive(paths: SquadPaths, featureFilter?: string): Promise<PlanListEntry> {
  const plans = listAllPlanListEntries(paths, featureFilter);
  if (plans.length === 0) {
    throw new Error('No plan files to pick. Run `squad new-plan` first, or `squad list` to see plans.');
  }
  if (plans.length === 1) return plans[0]!;
  return select<PlanListEntry>({
    message: 'Plan file to remove:',
    choices: plans.map((p) => ({
      name: `${p.feature}/${p.file}`,
      value: p,
    })),
  });
}

export async function pickFeatureInteractive(paths: SquadPaths): Promise<string> {
  const feats = listFeatures(paths);
  if (feats.length === 0) {
    throw new Error('No features to pick. Run `squad new-story` first, or `squad list` to see features.');
  }
  if (feats.length === 1) return feats[0]!;
  return select<string>({
    message: 'Feature to remove:',
    choices: feats.map((f) => ({ name: f, value: f })),
  });
}

export function resolveStoryFromArg(
  arg: string,
  stories: StoryRecord[],
  root: string,
): StoryRecord | undefined {
  const t = arg.trim();
  for (const s of stories) {
    if (s.id === t) return s;
    if (`${s.feature}/${s.id}` === t) return s;
  }
  const abs = path.isAbsolute(t) ? t : path.resolve(root, t);
  const withIntake = t.endsWith('intake.md') ? abs : path.join(abs, 'intake.md');
  return findStoryByIntake(stories, withIntake) ?? findStoryByIntake(stories, abs);
}

function isSequenceToken(s: string): boolean {
  return /^\d{1,4}$/.test(s) && s.length > 0;
}

function tryParsePlanFilePath(absPath: string, paths: SquadPaths, featureFilter: string | undefined): PlanListEntry | undefined {
  if (!fs.existsSync(absPath) || !STORY_PLAN.test(path.basename(absPath))) return undefined;
  const planRoot = fs.realpathSync(path.resolve(paths.plansDir));
  const fileReal = fs.realpathSync(path.resolve(absPath));
  const rel = path.relative(planRoot, fileReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const segs = rel.split(path.sep);
  if (segs.length < 2) return undefined;
  const feature = segs[0]!;
  const file = segs.slice(1).join(path.sep);
  if (featureFilter && feature !== featureFilter) return undefined;
  return { feature, file, abs: path.resolve(absPath) };
}

export function resolvePlanFromArg(
  arg: string,
  paths: SquadPaths,
  featureFilter: string | undefined,
): PlanListEntry | undefined {
  const t = arg.trim();
  if (!t) return undefined;

  const asPath = path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
  const a = tryParsePlanFilePath(asPath, paths, featureFilter);
  if (a) return a;
  if (!path.isAbsolute(t)) {
    const under = tryParsePlanFilePath(path.join(paths.plansDir, t), paths, featureFilter);
    if (under) return under;
  }

  if (isSequenceToken(t)) {
    const nn = formatSequence(parseInt(t, 10));
    const prefix = `${nn}-`;
    const cands: PlanListEntry[] = [];
    for (const p of listAllPlanListEntries(paths, featureFilter)) {
      if (p.file.startsWith(prefix)) cands.push(p);
    }
    if (cands.length === 1) return cands[0]!;
    if (cands.length > 1) {
      throw new Error(
        `Multiple plans match sequence "${t}". Run \`squad rm plan\` in a TTY, or add \`--feature <slug>\` to disambiguate.`,
      );
    }
  }

  return undefined;
}

export function countOverviewDataRows(overviewContent: string): number {
  let n = 0;
  for (const line of overviewContent.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (line.includes('NN') && line.includes('File') && line.includes('Title')) continue;
    n++;
  }
  return n;
}

export function featureStoriesDirEmpty(paths: SquadPaths, feature: string): boolean {
  const d = path.join(paths.storiesDir, feature);
  if (!fs.existsSync(d)) return true;
  return fs.readdirSync(d).length === 0;
}
