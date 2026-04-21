import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { validateTrackerId } from '../core/tracker.js';

export async function runTrackerLink(storyPath: string, trackerId: string): Promise<void> {
  if (!storyPath || !trackerId) {
    throw new Error('Usage: squad tracker link <story-folder-or-intake> <tracker-id>');
  }
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  if (!validateTrackerId(config.tracker.type, trackerId)) {
    throw new Error(`Invalid tracker id "${trackerId}" for tracker type "${config.tracker.type}".`);
  }

  const resolved = path.resolve(storyPath);
  const intakeFile = resolved.endsWith('intake.md') ? resolved : path.join(resolved, 'intake.md');
  if (!fs.existsSync(intakeFile)) throw new Error(`intake.md not found at ${intakeFile}`);

  const content = fs.readFileSync(intakeFile, 'utf8');
  const updated = upsertTrackerId(content, trackerId);
  fs.writeFileSync(intakeFile, updated, 'utf8');

  console.log(kleur.green(`✓ Linked tracker id ${trackerId} → ${path.relative(root, intakeFile)}`));
}

function upsertTrackerId(content: string, id: string): string {
  const pattern = /(-\s*\*\*Work item id:\*\*)[^\n]*/;
  if (pattern.test(content)) {
    return content.replace(pattern, `$1 ${id}`);
  }
  return content + `\n\n- **Work item id:** ${id}\n`;
}
