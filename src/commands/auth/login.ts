import fs from 'node:fs';
import { confirm, password } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { isInteractive } from '../../ui/tty.js';
import { SquadExit } from '../../core/cli-exit.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { MISSING_CLAUDE_BINARY_MESSAGE, resolveClaudeBinary } from '../../core/claude-binary.js';
import { resolvePlannerAuthForCwd } from '../../core/planner-models.js';
import { skipExternalProbesInAutomation } from '../../core/ci-env.js';
import { probeClaudeAuth } from '../../planner/runtimes/auth-probe.js';
import { mergePlannerOauthTokenIntoSecrets } from '../config/shared.js';
import * as setupToken from './setup-token.js';
import {
  extractOauthToken,
  SUBSCRIPTION_ALTERNATIVE_HINT,
  validateOauthToken,
} from './shared.js';

export interface AuthLoginOptions {
  /** CI / remote-machine path: a `claude setup-token` value produced elsewhere. Skips the browser. */
  token?: string;
  /** Run the browser flow, print the token to stdout, store nothing, change no config. */
  printOnly?: boolean;
  yes?: boolean;
}

export const NON_TTY_LOGIN_MESSAGE =
  'A browser login needs a terminal. Generate a token elsewhere with `claude setup-token` and pass it with ' +
  '`squad auth login --token <value>`, or set CLAUDE_CODE_OAUTH_TOKEN.';

export async function runAuthLogin(opts: AuthLoginOptions = {}): Promise<void> {
  if (opts.token && opts.printOnly) {
    throw new Error(
      'Pass either --token or --print-only, not both. --print-only runs the browser flow and prints the ' +
        'token it produces; --token consumes one you already have.',
    );
  }

  const providedToken = opts.token !== undefined ? validateOauthToken(opts.token) : undefined;
  const storing = !opts.printOnly;

  // `--print-only` writes nothing, so it works outside a workspace. Everything else needs
  // `.squad/secrets.yaml`, so the root check belongs on the storing path only.
  const workspace = storing ? openWorkspace() : undefined;

  if (workspace && !(await confirmOverwrite(workspace.secrets, Boolean(opts.yes)))) return;

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    ui.warning(
      'CLAUDE_CODE_OAUTH_TOKEN is exported in this shell. It outranks the token squad-kit stores, so the ' +
        'stored one is ignored until you unset it.',
    );
  }

  const token = providedToken ?? (await runBrowserFlow());

  if (!storing) {
    ui.blank();
    ui.success('Login complete. Nothing was stored.');
    ui.info('Token (copy it somewhere safe — squad-kit did not save it):');
    process.stdout.write(`${token}\n`);
    ui.blank();
    ui.info(SUBSCRIPTION_ALTERNATIVE_HINT);
    ui.info('To store it in this workspace later: `squad auth login --token <value>`.');
    return;
  }

  const ws = workspace!;
  saveSecrets(ws.paths.secretsFile, mergePlannerOauthTokenIntoSecrets(ws.secrets, token));
  ui.success('OAuth token saved to .squad/secrets.yaml (chmod 0600 on POSIX).');

  const planner = ws.config.planner;
  if (planner) {
    saveConfig(ws.paths.configFile, {
      ...ws.config,
      planner: { ...planner, auth: { ...planner.auth, anthropic: 'subscription' } },
    });
    ui.info('Set `planner.auth.anthropic: subscription` in .squad/config.yaml.');
  } else {
    ui.warning(
      'The direct planner is not configured in this workspace, so no auth mode was written. ' +
        'Run `squad config set planner` and choose Anthropic to finish setup.',
    );
  }

  await verifyAndSummarise(planner ? { ...planner, auth: { anthropic: 'subscription' } } : undefined);

  ui.blank();
  ui.info(SUBSCRIPTION_ALTERNATIVE_HINT);
  ui.info('Next: `squad auth status` to confirm, then `squad new-plan --api`.');
}

function openWorkspace(): {
  paths: ReturnType<typeof buildPaths>;
  config: ReturnType<typeof loadConfig>;
  secrets: SquadSecrets;
} {
  const paths = buildPaths(requireSquadRoot());
  return {
    paths,
    config: loadConfig(paths.configFile),
    secrets: fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {},
  };
}

async function confirmOverwrite(secrets: SquadSecrets, yes: boolean): Promise<boolean> {
  if (!secrets.planner?.anthropicOauthToken) return true;
  if (yes) return true;
  if (!isInteractive()) {
    throw new Error(
      'A Claude OAuth token is already stored in .squad/secrets.yaml. Pass -y to overwrite it non-interactively.',
    );
  }
  const ok = await confirm({
    message: 'A Claude OAuth token is already stored. Replace it with a new one?',
    default: false,
  });
  if (!ok) ui.info('Keeping the existing token; nothing changed.');
  return ok;
}

/**
 * Spawn `claude setup-token` and get the token back.
 *
 * Default is the teeing path: the child's stdout is mirrored to the terminal so the user sees the
 * authorization URL, and buffered so the printed token can be extracted. `claude setup-token` does
 * not save the token anywhere, so capturing it is our job. When extraction fails we do not guess —
 * we fall through to the paste prompt, which is the plan's second path.
 */
async function runBrowserFlow(): Promise<string> {
  // Order matters: never spawn a browser flow nothing can complete, and answer that before we
  // start hunting for a binary — the non-TTY fix is a flag, not an install.
  if (!isInteractive()) throw new Error(NON_TTY_LOGIN_MESSAGE);
  const binary = resolveClaudeBinary();
  if (!binary) throw new Error(MISSING_CLAUDE_BINARY_MESSAGE);

  ui.step('Starting the Anthropic browser authorization flow…');
  ui.info(`Using ${binary.source === 'bundled' ? 'the bundled Agent SDK binary' : 'the `claude` on your PATH'}.`);
  ui.blank();

  const result = await setupToken.spawnSetupToken(binary.path);

  if (result.signal) {
    throw new SquadExit(130, 'Login cancelled — nothing was stored.');
  }
  if (result.code !== 0) {
    throw new SquadExit(
      result.code ?? 1,
      `\`claude setup-token\` exited with code ${result.code}. Nothing was stored. Re-run \`squad auth login\` to try again.`,
    );
  }

  const extracted = extractOauthToken(result.output);
  if (extracted) return validateOauthToken(extracted);

  ui.blank();
  ui.warning('Could not read the token from the login output. Paste it here:');
  const pasted = await password({
    message: 'Token (input hidden):',
    validate: (v) => {
      try {
        validateOauthToken(v);
        return true;
      } catch (e) {
        return e instanceof Error ? e.message : 'invalid token';
      }
    },
  });
  return validateOauthToken(pasted);
}

/** Verify with the free `accountInfo()` probe and print what the workspace will actually use. */
async function verifyAndSummarise(planner: ReturnType<typeof loadConfig>['planner']): Promise<void> {
  if (!planner || skipExternalProbesInAutomation()) return;
  const auth = resolvePlannerAuthForCwd('anthropic', planner);
  const spin = ui.spinner('verifying the Claude login…');
  const probe = await probeClaudeAuth(auth);
  if (!probe.ok) {
    spin.fail(`could not verify the login (${probe.kind})`);
    ui.warning(probe.detail);
    return;
  }
  if (probe.unverifiable) {
    // Token auth never reports an account, valid or not, so "verified" would be a lie here.
    spin.succeed('login stored');
    if (probe.credentialSource) ui.kv('credential', probe.credentialSource, 15);
    ui.info(probe.unverifiable);
    return;
  }

  spin.succeed('login verified');
  const account = [probe.account?.email, probe.account?.organization, probe.account?.subscriptionType]
    .filter(Boolean)
    .join(' · ');
  if (account) ui.kv('account', account, 15);
  if (probe.apiKeySource) ui.kv('api key source', probe.apiKeySource, 15);
}
