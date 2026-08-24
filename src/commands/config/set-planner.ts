import fs from 'node:fs';
import { confirm, password, select } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { modelFor, providerEnvVar, resolveProviderKey, resolvePlannerAuthForCwd } from '../../core/planner-models.js';
import { detectClaudeLogin, describeAuth, type ResolvedPlannerAuth } from '../../core/planner-auth.js';
import { fetchProviderModelIds } from '../../core/probes.js';
import type { PlannerAuthMode } from '../../core/planner-auth.js';
import type { PlannerConfig, ProviderName } from '../../planner/types.js';
import { probeClaudeAuth } from '../../planner/runtimes/auth-probe.js';
import { isInteractive } from '../../ui/tty.js';
import { mergePlannerKeyIntoSecrets, newPlannerBlock } from './shared.js';
import { runConfigUnsetPlanner } from './unset-planner.js';
import { runAuthLogin } from '../auth/login.js';
import { skipExternalProbesInAutomation } from '../../core/ci-env.js';

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

  // Anthropic is the only provider `planner.auth` applies to; OpenAI and Google stay API-key only.
  let authChoice: PlannerAuthMode | undefined;
  if (interactive && provider === 'anthropic') {
    authChoice = (await select({
      message: 'How should squad-kit authenticate with Anthropic?',
      choices: [
        {
          name: 'Use my Claude subscription (browser login) — recommended, no API key needed',
          value: 'subscription' as PlannerAuthMode,
        },
        { name: 'Use an Anthropic API key', value: 'api-key' as PlannerAuthMode },
        {
          name: 'Decide automatically (subscription if signed in, otherwise API key)',
          value: 'auto' as PlannerAuthMode,
        },
      ],
      default: 'subscription' as PlannerAuthMode,
    })) as PlannerAuthMode;
    nextPlanner = { ...nextPlanner, auth: { ...nextPlanner.auth, anthropic: authChoice } };
  }

  if (useYes) {
    if (!resolveProviderKey(provider)) {
      throw credentialError(provider);
    }
  } else {
    if (authChoice === 'subscription') {
      await offerBrowserLogin(baseSecrets);
    } else if (authChoice === 'auto') {
      ui.info(
        '`auto` resolves in this order: a detected Claude login first, then a resolvable API key ' +
          '(ANTHROPIC_API_KEY, SQUAD_PLANNER_API_KEY, or .squad/secrets.yaml).',
      );
      if (!detectClaudeLogin(baseSecrets).present && !resolveProviderKey(provider)) {
        ui.warning(
          'Neither a Claude login nor an API key resolves right now. Run `squad auth login`, or re-run ' +
            '`squad config set planner` and choose the API-key option.',
        );
      }
    } else {
      await promptForApiKey(provider, paths.secretsFile, baseSecrets);
    }

    const cacheEnabled = await confirm({
      message: 'Enable prompt caching? (Recommended — reduces billed tokens by ~70% on most providers.)',
      default: nextPlanner.cache?.enabled ?? true,
    });
    nextPlanner = { ...nextPlanner, cache: { enabled: cacheEnabled } };
  }

  const next: SquadConfig = { ...config, planner: nextPlanner };
  saveConfig(paths.configFile, next);

  // Only the interactive path can land on subscription: `--yes` never offers the auth choice, so its
  // output stays byte-identical to 0.11.0 rather than changing shape because the machine happens to
  // have a Claude login sitting in its credential store.
  const auth = interactive && provider === 'anthropic' ? tryResolveAuth(provider, nextPlanner) : undefined;
  const configuredMode = nextPlanner.auth?.anthropic;
  if (auth?.mode === 'subscription' && (configuredMode === 'subscription' || configuredMode === 'auto')) {
    await reportSubscriptionSetup(provider, nextPlanner, auth);
    return;
  }

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

  if (skipExternalProbesInAutomation() || !cred) {
    printPlannerNextSteps(Boolean(cred), 'api-key');
    return;
  }
  try {
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.warning(
      `Could not reach provider model list (${msg.slice(0, 160)}). Key was saved; run \`squad doctor\` to verify.`,
    );
  }

  printPlannerNextSteps(true, 'api-key');
}

/** The 0.11.0 credential prompt block, unchanged — reached only on the API-key branch. */
async function promptForApiKey(
  provider: ProviderName,
  secretsFile: string,
  baseSecrets: SquadSecrets,
): Promise<void> {
  const envVar = providerEnvVar(provider);
  const existing = resolveProviderKey(provider);
  if (existing) {
    const shouldUpdate = await confirm({
      message: 'A planner credential is already available. Enter a new key and save it to .squad/secrets.yaml?',
      default: false,
    });
    if (!shouldUpdate) {
      ui.info('Keeping the existing planner credential; no change to .squad/secrets.yaml for the key.');
      return;
    }
    const key = await password({
      message: `${envVar} value (input hidden):`,
      validate: (v) => (v.length >= 20 ? true : 'key looks too short'),
    });
    saveSecrets(secretsFile, mergePlannerKeyIntoSecrets(baseSecrets, provider, key));
    ui.success('Planner key saved to .squad/secrets.yaml');
    ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
    return;
  }
  const key = await password({
    message: `${envVar} value (input hidden) — required:`,
    validate: (v) => (v.length >= 20 ? true : 'key looks too short'),
  });
  saveSecrets(secretsFile, mergePlannerKeyIntoSecrets(baseSecrets, provider, key));
  ui.success('Planner key saved to .squad/secrets.yaml');
  ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
}

/**
 * Subscription mode needs no key at all — so instead of prompting for one, offer the login when
 * nothing is signed in. Calls the command function directly rather than shelling out to `squad`:
 * a subprocess would be a different (possibly published) build.
 */
async function offerBrowserLogin(baseSecrets: SquadSecrets): Promise<void> {
  if (detectClaudeLogin(baseSecrets).present) {
    ui.info('A Claude login is already available on this machine — no API key needed.');
    return;
  }
  const now = await confirm({
    message: 'No Claude login found. Run the browser login now?',
    default: true,
  });
  if (!now) {
    ui.info('Skipped. Run `squad auth login` when you are ready — planning needs it in subscription mode.');
    return;
  }
  await runAuthLogin({});
}

function tryResolveAuth(provider: ProviderName, planner: PlannerConfig): ResolvedPlannerAuth | undefined {
  try {
    return resolvePlannerAuthForCwd(provider, planner);
  } catch {
    // `PlannerAuthUnavailableError` here just means "nothing resolves yet"; the API-key branch below
    // already prints the right recovery copy.
    return undefined;
  }
}

/**
 * Subscription mode has no key to validate, so the `fetchProviderModelIds` check is skipped: that
 * probe authenticates with `x-api-key` and would fail on an OAuth credential for the wrong reason.
 */
async function reportSubscriptionSetup(
  provider: ProviderName,
  planner: PlannerConfig,
  auth: ResolvedPlannerAuth,
): Promise<void> {
  ui.blank();
  ui.success('Planner configuration updated.');
  ui.kv('provider', provider, 10);
  ui.kv('model (plan)', modelFor(provider, 'plan', planner.modelOverride), 10);
  ui.kv('model (execute)', modelFor(provider, 'execute', planner.modelOverride), 10);
  ui.kv('auth', `subscription (${describeAuth(auth).credentialHint})`, 10);

  if (!skipExternalProbesInAutomation()) {
    const probe = await probeClaudeAuth(auth);
    if (probe.ok) {
      const account = [probe.account?.email, probe.account?.organization, probe.account?.subscriptionType]
        .filter(Boolean)
        .join(' · ');
      ui.info(account ? `Credential check: signed in as ${account}.` : 'Credential check: the Claude login responded OK.');
    } else {
      ui.warning(`Credential check failed (${probe.kind}). ${probe.detail}`);
    }
  }

  printPlannerNextSteps(true, 'subscription');
}

function printPlannerNextSteps(credentialReady: boolean, mode: 'subscription' | 'api-key'): void {
  ui.blank();
  ui.step('Next:');
  if (mode === 'subscription') {
    ui.info('1) Confirm the login with `squad auth status` — it shows the account and how it resolved.');
    ui.info('2) Verify with `squad doctor` — every planner check should be green.');
    ui.info('3) Create a story:  squad new-story <feature-slug>  (or --no-tracker for a manual story).');
    ui.info('4) Fill the generated intake.md, then run `squad new-plan --api` to generate the plan.');
    ui.info(
      '   Planning draws on your Claude usage limits — there is no per-token API bill. To switch to an API key later, re-run `squad config set planner`.',
    );
    return;
  }
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
