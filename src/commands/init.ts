import fs from 'node:fs';
import path from 'node:path';
import { input, select, checkbox, confirm, password } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { isInteractive } from '../ui/tty.js';
import { buildPaths, SQUAD_DIR } from '../core/paths.js';
import { ensureGitignore } from '../core/gitignore.js';
import {
  DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
  saveConfig,
  type SquadConfig,
  type TrackerType,
} from '../core/config.js';
import { modelFor, providerEnvVar, resolveProviderKey } from '../core/planner-models.js';
import { copyTree, templatesDir, writeFileSafe, readFile } from '../utils/fs.js';
import { render } from '../core/template.js';
import type { PlannerConfig } from '../planner/types.js';
import type { ProviderName } from '../planner/types.js';
import { loadSecrets, saveSecrets, mergeSecrets, type SquadSecrets } from '../core/secrets.js';
import {
  runConfigSetPlanner,
  runConfigSetTracker,
  mergePlannerKeyIntoSecrets,
  promptJiraCredentials,
  promptAzureCredentials,
} from './config/index.js';

export interface InitOptions {
  agents?: string;
  tracker?: TrackerType;
  /** Jira host or Azure org; used as default in prompts and in `-y` config when set. */
  trackerWorkspace?: string;
  /** Azure project; used as default in prompts and in `-y` config when set. */
  trackerProject?: string;
  name?: string;
  language?: string;
  force?: boolean;
  yes?: boolean;
  /** Skip Jira/Azure + planner key prompts (no writes to secrets.yaml from prompts). */
  noPromptSecrets?: boolean;
  /** String provider when `--planner`; `false` when `--no-planner` (commander). */
  planner?: string | false;
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

  if (!opts.yes) {
    ui.banner();
  }

  if (fs.existsSync(paths.configFile) && !opts.force) {
    if (!isInteractive() || opts.yes) {
      ui.warning(
        `A ${SQUAD_DIR}/config.yaml already exists. Run \`squad init --force\` to overwrite, or \`squad config set planner\` / \`squad config set tracker\` to change individual sections.`,
      );
      return;
    }
    const choice = (await select({
      message: `${SQUAD_DIR}/ already exists. What do you want to do?`,
      choices: [
        { name: 'Reconfigure planner (same as `squad config set planner`)', value: 'planner' as const },
        { name: 'Reconfigure tracker (same as `squad config set tracker`)', value: 'tracker' as const },
        { name: 'Overwrite everything (same as --force)', value: 'overwrite' as const },
        { name: 'Cancel', value: 'cancel' as const },
      ],
    })) as 'planner' | 'tracker' | 'overwrite' | 'cancel';
    if (choice === 'cancel') {
      return;
    }
    if (choice === 'planner') {
      return runConfigSetPlanner({});
    }
    if (choice === 'tracker') {
      return runConfigSetTracker({});
    }
    // overwrite: fall through
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

  const allowSecretPrompts = !opts.yes && !opts.noPromptSecrets;
  let trackerWorkspace = opts.trackerWorkspace?.trim() || undefined;
  let trackerProject = opts.trackerProject?.trim() || undefined;

  if (allowSecretPrompts && answers.tracker === 'jira') {
    ui.step('Jira Cloud credentials (stored in .squad/secrets.yaml — always git-ignored)');

    const { host, email, token } = await promptJiraCredentials({ host: trackerWorkspace });

    const base = loadSecrets(paths.secretsFile);
    const merged = mergeSecrets(base, {
      tracker: { jira: { host: host.trim(), email: email.trim(), token } },
    });
    saveSecrets(paths.secretsFile, merged);

    trackerWorkspace = host.trim();
    ui.success('Jira credentials saved');
    ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
  } else if (allowSecretPrompts && answers.tracker === 'azure') {
    ui.step('Azure DevOps credentials (stored in .squad/secrets.yaml — always git-ignored)');
    const a = await promptAzureCredentials({ organization: trackerWorkspace, project: trackerProject });
    const base = loadSecrets(paths.secretsFile);
    const merged = mergeSecrets(base, {
      tracker: {
        azure: { organization: a.organization, project: a.project, pat: a.pat },
      },
    });
    saveSecrets(paths.secretsFile, merged);

    trackerWorkspace = a.organization;
    trackerProject = a.project;
    ui.success('Azure DevOps credentials saved');
    ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
  }

  let plannerBlock: PlannerConfig | undefined;
  if (opts.yes) {
    if (opts.planner && opts.planner !== 'false') {
      const provider = opts.planner;
      if (!['anthropic', 'openai', 'google'].includes(provider)) {
        throw new Error(
          '--planner must be one of anthropic | openai | google. Run `squad init --planner anthropic` (or openai / google) with `--yes` in non-interactive mode.',
        );
      }
      plannerBlock = {
        enabled: true,
        provider: provider as ProviderName,
        mode: 'auto',
        budget: {
          maxFileReads: 25,
          maxContextBytes: 50_000,
          maxDurationSeconds: 180,
        },
        cache: { enabled: true },
        maxOutputTokens: DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
      };
    }
  } else {
    const plannerEnabled = await confirm({
      message:
        'Enable automatic plan generation? (press Enter to skip — you can always edit .squad/config.yaml later)',
      default: false,
    });
    if (plannerEnabled) {
      const provider = (await select({
        message: 'Planner provider:',
        choices: [
          { name: 'Anthropic (Claude)', value: 'anthropic' as ProviderName },
          { name: 'OpenAI (GPT)', value: 'openai' as ProviderName },
          { name: 'Google (Gemini)', value: 'google' as ProviderName },
        ],
        default: 'anthropic' as ProviderName,
      })) as ProviderName;
      plannerBlock = {
        enabled: true,
        provider,
        mode: 'auto',
        budget: {
          maxFileReads: 25,
          maxContextBytes: 50_000,
          maxDurationSeconds: 180,
        },
        cache: { enabled: true },
        maxOutputTokens: DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
      };
    }
  }

  if (plannerBlock?.enabled && allowSecretPrompts) {
    const envVar = providerEnvVar(plannerBlock.provider);
    const envPresent = Boolean(process.env[envVar]);
    if (envPresent) {
      ui.info(`Planner key detected in ${envVar}; keeping env-var resolution as the primary source.`);
    } else {
      const storeKey = (await select({
        message: `No ${envVar} in your environment. How do you want to store your planner API key?`,
        choices: [
          { name: `Enter it now and save to .squad/secrets.yaml (git-ignored)`, value: 'secrets' as const },
          { name: `I'll export ${envVar} in my shell profile myself`, value: 'env' as const },
        ],
      })) as 'secrets' | 'env';

      if (storeKey === 'secrets') {
        const key = await password({
          message: `${envVar} value (input hidden):`,
          validate: (v) => (v.length >= 20 ? true : 'key looks too short'),
        });
        const base = loadSecrets(paths.secretsFile);
        const merged = mergePlannerKeyIntoSecrets(base, plannerBlock.provider, key);
        saveSecrets(paths.secretsFile, merged);
        ui.success('Planner key saved to .squad/secrets.yaml');
      } else {
        ui.info(`Remember to export ${envVar} before running \`squad new-plan\`.`);
      }
    }
  }

  const trackerConfig: SquadConfig['tracker'] = { type: answers.tracker };
  if (answers.tracker === 'jira' || answers.tracker === 'azure') {
    if (trackerWorkspace) trackerConfig.workspace = trackerWorkspace;
    if (trackerProject) trackerConfig.project = trackerProject;
  }

  const config: SquadConfig = {
    version: 1,
    project: { name: answers.name, primaryLanguage: answers.language, projectRoots: ['.'] },
    tracker: trackerConfig,
    naming: { includeTrackerId, globalSequence: true },
    agents: answers.agents,
    planner: plannerBlock,
  };

  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.mkdirSync(paths.storiesDir, { recursive: true });
  fs.mkdirSync(paths.plansDir, { recursive: true });

  writeFileSafe(
    paths.indexFile,
    readFile(path.join(templatesDir(), 'index.md')),
    !!opts.force,
  );

  saveConfig(paths.configFile, config);

  if (ensureGitignore(paths.root)) {
    ui.info('Updated .gitignore with squad-managed patterns (e.g. .squad/secrets.yaml).');
  }

  writeFileSafe(
    path.join(paths.squadDir, 'README.md'),
    renderSquadReadme(config),
    !!opts.force,
  );

  for (const agent of answers.agents) {
    installAgent(root, agent as AgentName, !!opts.force);
  }

  ui.blank();
  ui.success(`Initialized ${SQUAD_DIR}/ at ${root}`);
  ui.kv('tracker', config.tracker.type, 7);
  ui.kv('agents', answers.agents.length ? answers.agents.join(', ') : '(none)', 7);
  if (plannerBlock) {
    const envVar = providerEnvVar(plannerBlock.provider);
    const hasKey = Boolean(resolveProviderKey(plannerBlock.provider));
    const model = modelFor(plannerBlock.provider, 'plan', plannerBlock.modelOverride);
    const overrideNote = plannerBlock.modelOverride?.[plannerBlock.provider] ? ' (override)' : '';
    ui.kv('planner', `${plannerBlock.provider}/${model}${overrideNote}`);
    ui.kv('key', hasKey ? `✓ (${envVar} or .squad/secrets.yaml)` : `missing (set ${envVar})`);
    if (!hasKey) {
      ui.blank();
      ui.warning('Planner key not found in environment or .squad/secrets.yaml.');
      ui.info('Set one of these before running `squad new-plan`:');
      ui.info(`  export ${envVar}=<your-key>`);
      ui.info('  # or use a cross-provider fallback:');
      ui.info('  export SQUAD_PLANNER_API_KEY=<your-key>');
      ui.info('  # or re-run `squad init` and save the key to .squad/secrets.yaml when prompted.');
      ui.info('squad-kit never reads keys from .squad/config.yaml.');
    }
  }
  ui.blank();
  ui.step('Next:');
  ui.info('1) squad new-story <feature-slug>');
  ui.info('2) Fill the generated intake.md, then run /squad-plan in your agent (or squad new-plan).');
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

Plan meta-prompts (\`generate-plan.md\`, \`story-skeleton.md\`) ship inside the squad-kit package — they are not copied here. Upgrade squad-kit to update them.
`,
    { name: config.project.name, language: config.project.primaryLanguage ?? '', tracker: config.tracker.type },
  );
}
