import fs from 'node:fs';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { isInteractive } from '../../ui/tty.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';

export interface AuthLogoutOptions {
  yes?: boolean;
}

export async function runAuthLogout(opts: AuthLogoutOptions = {}): Promise<void> {
  const paths = buildPaths(requireSquadRoot());
  const secrets: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};

  if (!secrets.planner?.anthropicOauthToken) {
    ui.info('No Claude OAuth token is stored in .squad/secrets.yaml — nothing to remove.');
    ui.info('Your Claude Code login (OS credential store) is separate and was not touched.');
    return;
  }

  if (!opts.yes) {
    if (!isInteractive()) {
      ui.warning('Pass -y in non-interactive mode to confirm, or run `squad auth logout` in a TTY.');
      return;
    }
    const ok = await confirm({
      message: 'Remove the Claude OAuth token squad-kit stored in .squad/secrets.yaml?',
      default: false,
    });
    if (!ok) return;
  }

  // Surgical: every other planner key and every tracker secret survives untouched.
  delete secrets.planner.anthropicOauthToken;
  saveSecrets(paths.secretsFile, secrets);

  ui.success('Removed the OAuth token squad-kit stored.');
  ui.info(
    'Your Claude Code login is untouched — run `claude` and `/logout` if you also want to sign out of Claude Code.',
  );

  // The mode is deliberately left alone: logging out is not a decision to switch to API keys.
  const mode = loadConfig(paths.configFile).planner?.auth?.anthropic;
  if (mode === 'subscription') {
    ui.info(
      '`planner.auth.anthropic` is still `subscription`. If no Claude login remains on this machine, the next ' +
        'run fails with a message pointing back at `squad auth login`.',
    );
  }
}
