import fs from 'node:fs';
import { confirm, password, select } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { modelFor, providerEnvVar, resolveProviderKey } from '../../core/planner-models.js';
import { fetchProviderModelIds } from '../../core/probes.js';
import type { PlannerConfig, ProviderName } from '../../planner/types.js';
import { isInteractive } from '../../ui/tty.js';
import { mergePlannerKeyIntoSecrets, newPlannerBlock } from './shared.js';
import { runConfigUnsetPlanner } from './unset-planner.js';

function parseProvider(arg: string): ProviderName {
  if (!['anthropic', 'openai', 'google'].includes(arg)) {
    throw new Error(
      `Invalid --provider "${arg}". Use anthropic | openai | google, or run \`squad config set planner\` to pick a provider interactively.`,
    );
  }
  return arg as ProviderName;
}

function credentialError(provider: ProviderName): Error {
  const ev = providerEnvVar(provider);
  return new Error(
    `Planner credential for \`${provider}\` not found. Run \`squad config set planner\` (no --yes) to enter a key interactively, or export ${ev}.`,
  );
}

export interface ConfigSetPlannerOptions {
  provider?: string;
  yes?: boolean;
}

export async function runConfigSetPlanner(opts: ConfigSetPlannerOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const baseSecrets: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};

  const useYes = Boolean(opts.yes);
  const interactive = !useYes && isInteractive();

  if (interactive && config.planner?.enabled === true) {
    const action = await select({
      message: 'The direct planner is enabled. What do you want to do?',
      choices: [
        { name: 'Change provider, key, or model', value: 'change' },
        { name: 'Disable the direct planner', value: 'disable' },
      ],
      default: 'change',
    });
    if (action === 'disable') {
      return runConfigUnsetPlanner({ yes: true, removeCredentials: false });
    }
  }

  let provider: ProviderName;
  if (opts.provider) {
    provider = parseProvider(opts.provider);
  } else if (useYes) {
    throw new Error(
      'Pass --provider (anthropic|openai|google) when using --yes in non-interactive mode, or run `squad config set planner` without --yes in a TTY.',
    );
  } else {
    const current = (config.planner?.enabled === true && config.planner.provider) || 'anthropic';
    provider = (await select({
      message: 'Planner provider',
      choices: [
        { name: 'Anthropic (Claude)', value: 'anthropic' as ProviderName },
        { name: 'OpenAI (GPT)', value: 'openai' as ProviderName },
        { name: 'Google (Gemini)', value: 'google' as ProviderName },
      ],
      default: current,
    })) as ProviderName;
  }

  if (interactive) {
    if (!config.planner || config.planner.enabled !== true) {
      const enable = await confirm({ message: 'Enable the direct planner?', default: true });
      if (!enable) {
        return;
      }
    }
  }

  const prev = config.planner;
  let nextPlanner: PlannerConfig;
  if (!prev || prev.enabled !== true) {
    nextPlanner = newPlannerBlock(provider);
  } else {
    nextPlanner = { ...prev, provider, enabled: true };
  }

  if (useYes) {
    if (!resolveProviderKey(provider)) {
      throw credentialError(provider);
    }
  } else {
    const existing = resolveProviderKey(provider);
    if (existing) {
      const shouldUpdate = await confirm({
        message: 'A planner credential is already available. Enter a new key and save it to .squad/secrets.yaml?',
        default: false,
      });
      if (shouldUpdate) {
        const envVar = providerEnvVar(provider);
        const key = await password({
          message: `${envVar} value (input hidden):`,
          validate: (v) => (v.length >= 20 ? true : 'key looks too short'),
        });
        const merged = mergePlannerKeyIntoSecrets(baseSecrets, provider, key);
        saveSecrets(paths.secretsFile, merged);
        ui.success('Planner key saved to .squad/secrets.yaml');
        ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
      } else {
        ui.info('Keeping the existing planner credential; no change to .squad/secrets.yaml for the key.');
      }
    } else {
      const envVar = providerEnvVar(provider);
      const key = await password({
        message: `${envVar} value (input hidden) — required:`,
        validate: (v) => (v.length >= 20 ? true : 'key looks too short'),
      });
      const merged = mergePlannerKeyIntoSecrets(baseSecrets, provider, key);
      saveSecrets(paths.secretsFile, merged);
      ui.success('Planner key saved to .squad/secrets.yaml');
      ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
    }

    const cacheEnabled = await confirm({
      message: 'Enable prompt caching? (Recommended — reduces billed tokens by ~70% on most providers.)',
      default: nextPlanner.cache?.enabled ?? true,
    });
    nextPlanner = { ...nextPlanner, cache: { enabled: cacheEnabled } };
  }

  const next: SquadConfig = { ...config, planner: nextPlanner };
  saveConfig(paths.configFile, next);

  const cred = resolveProviderKey(provider);
  if (!cred) {
    ui.warning(
      'Planner key could not be resolved. Run `squad config set planner` to save a key, or set the provider env var, then re-run `squad doctor` to verify.',
    );
  } else {
    const sourceText =
      cred.source === 'env' ? cred.detail : cred.source === 'secrets' ? '.squad/secrets.yaml' : cred.detail;
    const planModel = modelFor(provider, 'plan', nextPlanner.modelOverride);
    const execModel = modelFor(provider, 'execute', nextPlanner.modelOverride);
    ui.blank();
    ui.success('Planner configuration updated.');
    ui.kv('provider', provider, 10);
    ui.kv('model (plan)', planModel, 10);
    ui.kv('model (execute)', execModel, 10);
    ui.kv('credential', `${cred.source} (${sourceText})`, 10);
  }

  if (process.env.CI === 'true' || !cred) {
    printPlannerNextSteps(Boolean(cred));
    return;
  }
  const listed = await fetchProviderModelIds(provider, cred.value);
  if (!listed.ok) {
    const st = listed.status;
    if (st === 401 || st === 403) {
      ui.warning(`Could not list models (HTTP ${st}); check your key.`);
    } else {
      ui.warning(`Model list probe failed (HTTP ${st}): ${listed.body.slice(0, 120)}`);
    }
  } else {
    ui.info('Credential check: models API responded OK for this key.');
  }

  printPlannerNextSteps(true);
}

function printPlannerNextSteps(credentialReady: boolean): void {
  ui.blank();
  ui.step('Next:');
  if (!credentialReady) {
    ui.info('1) Save a planner key: re-run `squad config set planner` and paste the key when prompted.');
    ui.info('2) Verify with `squad doctor` — all planner checks should turn green.');
    ui.info('3) Then run `squad new-story <slug>` and `squad new-plan --api` to generate your first plan.');
    return;
  }
  ui.info('1) Verify with `squad doctor` — every planner check should be green.');
  ui.info('2) Create a story:  squad new-story <feature-slug>  (or --no-tracker for a manual story).');
  ui.info('3) Fill the generated intake.md, then run `squad new-plan --api` to generate the plan.');
  ui.info(
    '4) To change provider, key, or disable caching later: re-run `squad config set planner`. Model overrides are edited directly in .squad/config.yaml (planner.modelOverride).',
  );
}
