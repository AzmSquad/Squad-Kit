import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { input, select, checkbox, confirm } from '@inquirer/prompts';
import { buildPaths, SQUAD_DIR } from '../core/paths.js';
import { saveConfig, type SquadConfig, type TrackerType } from '../core/config.js';
import { copyTree, templatesDir, writeFileSafe, readFile } from '../utils/fs.js';
import { render } from '../core/template.js';

export interface InitOptions {
  agents?: string;
  tracker?: TrackerType;
  name?: string;
  language?: string;
  force?: boolean;
  yes?: boolean;
}

const SUPPORTED_AGENTS = ['claude-code', 'cursor', 'copilot', 'gemini'] as const;
type AgentName = (typeof SUPPORTED_AGENTS)[number];

const AGENT_INSTALL: Record<AgentName, { subdir: string; srcDir: string }> = {
  'claude-code': { subdir: path.join('.claude', 'commands'), srcDir: 'claude-code' },
  cursor: { subdir: path.join('.cursor', 'commands'), srcDir: 'cursor' },
  copilot: { subdir: path.join('.github', 'prompts'), srcDir: 'copilot' },
  gemini: { subdir: path.join('.gemini', 'commands'), srcDir: 'gemini' },
};

export async function runInit(opts: InitOptions): Promise<void> {
  const root = process.cwd();
  const paths = buildPaths(root);

  if (fs.existsSync(paths.configFile) && !opts.force) {
    console.log(kleur.yellow(`A ${SQUAD_DIR}/config.yaml already exists.`));
    console.log(`  To add agents or change settings, re-run with ${kleur.bold('--force')} or edit the file directly.`);
    return;
  }

  const defaults = {
    name: opts.name ?? path.basename(root),
    language: opts.language ?? 'typescript',
    tracker: (opts.tracker ?? 'none') as TrackerType,
    agents: parseAgentsFlag(opts.agents),
  };

  const answers = opts.yes
    ? defaults
    : {
        name: await input({ message: 'Project name', default: defaults.name }),
        language: await input({ message: 'Primary language', default: defaults.language }),
        tracker: (await select({
          message: 'Issue tracker',
          choices: [
            { name: 'None', value: 'none' as TrackerType },
            { name: 'GitHub Issues', value: 'github' as TrackerType },
            { name: 'Linear', value: 'linear' as TrackerType },
            { name: 'Jira', value: 'jira' as TrackerType },
            { name: 'Azure DevOps', value: 'azure' as TrackerType },
          ],
          default: defaults.tracker,
        })) as TrackerType,
        agents: (await checkbox({
          message: 'Install slash commands for which agents?',
          choices: SUPPORTED_AGENTS.map((a) => ({ name: a, value: a, checked: defaults.agents.includes(a) })),
        })) as AgentName[],
      };

  const includeTrackerId =
    answers.tracker !== 'none'
      ? await confirmSafe('Include tracker id in plan filenames (NN-story-<slug>-<id>.md)?', true, !!opts.yes)
      : false;

  const config: SquadConfig = {
    version: 1,
    project: { name: answers.name, primaryLanguage: answers.language, projectRoots: ['.'] },
    tracker: { type: answers.tracker },
    naming: { includeTrackerId, globalSequence: true },
    agents: answers.agents,
  };

  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.mkdirSync(paths.promptsDir, { recursive: true });
  fs.mkdirSync(paths.storiesDir, { recursive: true });
  fs.mkdirSync(paths.plansDir, { recursive: true });

  copyTree(path.join(templatesDir(), 'prompts'), paths.promptsDir, !!opts.force);

  writeFileSafe(
    paths.indexFile,
    readFile(path.join(templatesDir(), 'index.md')),
    !!opts.force,
  );

  saveConfig(paths.configFile, config);

  writeFileSafe(
    path.join(paths.squadDir, 'README.md'),
    renderSquadReadme(config),
    !!opts.force,
  );

  for (const agent of answers.agents) {
    installAgent(root, agent as AgentName, !!opts.force);
  }

  console.log(kleur.green(`\n✓ Initialized ${SQUAD_DIR}/ at ${root}`));
  console.log(`  tracker: ${config.tracker.type}`);
  console.log(`  agents:  ${answers.agents.length ? answers.agents.join(', ') : '(none)'}`);
  console.log(`\nNext:`);
  console.log(`  1) ${kleur.bold('squad new-story <feature-slug>')}`);
  console.log(`  2) Fill the generated intake.md, then run ${kleur.bold('/squad-plan')} in your agent (or ${kleur.bold('squad new-plan')}).`);
}

function parseAgentsFlag(flag?: string): AgentName[] {
  if (!flag) return [];
  return flag
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgentName => (SUPPORTED_AGENTS as readonly string[]).includes(s));
}

async function confirmSafe(message: string, defaultValue: boolean, nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return defaultValue;
  return confirm({ message, default: defaultValue });
}

function installAgent(root: string, agent: AgentName, overwrite: boolean): void {
  const config = AGENT_INSTALL[agent];
  const src = path.join(templatesDir(), 'agents', config.srcDir);
  const dest = path.join(root, config.subdir);
  if (!fs.existsSync(src)) return;
  copyTree(src, dest, overwrite);
}

function renderSquadReadme(config: SquadConfig): string {
  return render(
    `# squad-kit workspace

This folder is managed by [squad-kit](https://github.com/AzmSquad/squad-kit).

- **Project:** {{name}}
- **Language:** {{language}}
- **Tracker:** {{tracker}}

## Workflow

1. **Intake** — \`squad new-story <feature-slug>\` scaffolds \`stories/<feature>/<id>/intake.md\`. Paste the tracker title, description, and acceptance criteria.
2. **Plan** — Run \`/squad-plan <intake-path>\` in your agent (or \`squad new-plan <intake-path>\` to get the composed prompt on stdout).
3. **Implement** — Open a new, scoped agent session and attach **only** the generated \`NN-story-*.md\` file. Let a cheap model execute it.

See \`prompts/generate-plan.md\` for the plan-generation meta-prompt and \`prompts/story-skeleton.md\` for the target plan structure.
`,
    { name: config.project.name, language: config.project.primaryLanguage ?? '', tracker: config.tracker.type },
  );
}
