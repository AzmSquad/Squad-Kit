import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { readFile } from '../utils/fs.js';
import { render } from '../core/template.js';
import { copyToClipboard } from '../utils/clipboard.js';

export interface NewPlanOptions {
  copy?: boolean;
}

export async function runNewPlan(intakePath: string, opts: NewPlanOptions): Promise<void> {
  if (!intakePath) {
    throw new Error('intake-path is required. Usage: squad new-plan <path-to-intake.md>');
  }
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const resolved = path.resolve(intakePath);
  if (!fs.existsSync(resolved)) throw new Error(`Intake not found: ${resolved}`);
  const intakeContent = readFile(resolved);

  const metaPromptFile = path.join(paths.promptsDir, 'generate-plan.md');
  if (!fs.existsSync(metaPromptFile)) {
    throw new Error(
      `Missing meta-prompt at ${metaPromptFile}. Re-run \`squad init --force\` to restore templates.`,
    );
  }
  const metaPrompt = readFile(metaPromptFile);

  const composed = render(metaPrompt, {
    projectRoots: (config.project.projectRoots ?? ['.']).join(', '),
    primaryLanguage: config.project.primaryLanguage ?? '',
    trackerType: config.tracker.type,
    intakeContent,
  });

  process.stdout.write(composed);
  if (!composed.endsWith('\n')) process.stdout.write('\n');

  if (opts.copy !== false) {
    const ok = await copyToClipboard(composed);
    if (ok) console.error(kleur.dim('\n(copied to clipboard)'));
  }
}
