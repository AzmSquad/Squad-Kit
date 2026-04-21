import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { scanPlans, formatSequence } from '../core/sequence.js';

export async function runStatus(): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const scan = scanPlans(paths.plansDir);

  const storyCount = countStories(paths.storiesDir);
  const planCount = scan.usedNumbers.length;

  console.log(kleur.bold('squad-kit status'));
  console.log(`  project:        ${config.project.name}`);
  console.log(`  tracker:        ${config.tracker.type}`);
  console.log(`  agents:         ${config.agents.length ? config.agents.join(', ') : '(none)'}`);
  console.log(`  stories (drafts + planned): ${storyCount}`);
  console.log(`  plan files:     ${planCount}`);
  console.log(`  next NN:        ${formatSequence(scan.nextGlobal)}`);
  if (scan.duplicates.length > 0) {
    console.log(kleur.yellow(`  ⚠ duplicate NN numbers: ${scan.duplicates.map(formatSequence).join(', ')}`));
  }
}

function countStories(storiesDir: string): number {
  if (!fs.existsSync(storiesDir)) return 0;
  let total = 0;
  for (const feature of fs.readdirSync(storiesDir, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const featureDir = path.join(storiesDir, feature.name);
    for (const story of fs.readdirSync(featureDir, { withFileTypes: true })) {
      if (!story.isDirectory()) continue;
      if (fs.existsSync(path.join(featureDir, story.name, 'intake.md'))) total++;
    }
  }
  return total;
}
