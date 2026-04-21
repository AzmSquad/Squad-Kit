import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { input } from '@inquirer/prompts';
import { buildPaths, requireSquadRoot, slugify } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { validateTrackerId, trackerIdForFilename } from '../core/tracker.js';
import { readFile, templatesDir, writeFileSafe } from '../utils/fs.js';
import { render } from '../core/template.js';

export interface NewStoryOptions {
  id?: string;
  title?: string;
  yes?: boolean;
}

export async function runNewStory(featureSlug: string, opts: NewStoryOptions): Promise<void> {
  if (!featureSlug) {
    throw new Error('feature-slug is required. Usage: squad new-story <feature-slug> [--id <tracker-id>] [--title "..."]');
  }
  const slug = slugify(featureSlug);
  if (!slug) throw new Error(`Invalid feature slug: "${featureSlug}"`);

  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  const trackerNeedsId = config.tracker.type !== 'none' && config.naming.includeTrackerId;

  let id = opts.id;
  let title = opts.title;

  if (!id && trackerNeedsId) {
    if (!interactive) {
      throw new Error(
        `Tracker "${config.tracker.type}" is configured and naming.includeTrackerId is true. Pass --id <tracker-id>.`,
      );
    }
    id = await input({
      message: `${config.tracker.type} work-item id:`,
      validate: (v) => (validateTrackerId(config.tracker.type, v.trim()) ? true : `Invalid ${config.tracker.type} id format.`),
    });
    id = id.trim();
  }

  if (id && !validateTrackerId(config.tracker.type, id)) {
    throw new Error(
      `Invalid tracker id "${id}" for tracker type "${config.tracker.type}". Check .squad/config.yaml or pass --id in the right format.`,
    );
  }

  if (!id && !title) {
    if (!interactive) {
      throw new Error('Provide either --id <tracker-id> or --title "..." so the story folder has a distinct name.');
    }
    title = (await input({ message: 'Short story title:' })).trim();
    if (!title) throw new Error('Title cannot be empty.');
  }

  if (interactive && !title) {
    const maybe = (await input({ message: 'Short title (optional, press Enter to skip):', default: '' })).trim();
    if (maybe) title = maybe;
  }

  const storyFolderName = id ? trackerIdForFilename(config.tracker.type, id) : slugify(title!);
  if (!storyFolderName) throw new Error('Could not derive a story folder name from --id or --title.');
  const storyDir = path.join(paths.storiesDir, slug, storyFolderName);
  const intakeFile = path.join(storyDir, 'intake.md');
  const attachmentsDir = path.join(storyDir, 'attachments');

  if (fs.existsSync(intakeFile)) {
    throw new Error(`Intake already exists: ${intakeFile}`);
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });

  const template = readFile(path.join(templatesDir(), 'prompts', 'intake.md'));
  const rendered = render(template, {
    featureSlug: slug,
    storyId: storyFolderName,
    trackerType: config.tracker.type,
    projectRoots: (config.project.projectRoots ?? ['.']).join(', '),
    primaryLanguage: config.project.primaryLanguage ?? '',
  });

  const preamble = title ? `> **Title hint (from CLI):** ${title}\n\n` : '';
  writeFileSafe(intakeFile, preamble + rendered, false);

  ensureFeatureOverview(path.join(paths.plansDir, slug), slug);

  console.log(kleur.green(`✓ Created intake:`));
  console.log(`  ${path.relative(root, intakeFile)}`);
  console.log(`  ${path.relative(root, attachmentsDir)}${path.sep}`);
  console.log(`\nNext: paste the tracker title, description, and acceptance criteria into the intake, then:`);
  console.log(`  ${kleur.bold(`squad new-plan ${path.relative(root, intakeFile)}`)}`);
  console.log(`  (or run ${kleur.bold('/squad-plan')} in your agent)`);
}

function ensureFeatureOverview(featurePlanDir: string, slug: string): void {
  fs.mkdirSync(featurePlanDir, { recursive: true });
  const overviewFile = path.join(featurePlanDir, '00-overview.md');
  if (fs.existsSync(overviewFile)) return;
  const template = readFile(path.join(templatesDir(), 'overview.md'));
  writeFileSafe(overviewFile, render(template, { featureSlug: slug }), false);
}
