import fs from 'node:fs';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { isInteractive } from '../../ui/tty.js';

export type CredentialSection = 'planner' | 'tracker';

export interface ConfigRemoveCredentialOptions {
  yes?: boolean;
}

export async function runConfigRemoveCredential(
  section: string,
  opts: ConfigRemoveCredentialOptions = {},
): Promise<void> {
  if (section !== 'planner' && section !== 'tracker') {
    throw new Error(
      'Invalid section. Run `squad config remove-credential planner` or `squad config remove-credential tracker`.',
    );
  }

  const root = requireSquadRoot();
  const paths = buildPaths(root);

  const useYes = Boolean(opts.yes);
  if (!useYes) {
    if (!isInteractive()) {
      ui.warning('Pass -y in non-interactive mode to confirm, or run `squad config remove-credential` in a TTY.');
      return;
    }
    const ok = await confirm({
      message: `Delete all ${section} credentials from .squad/secrets.yaml? (config is unchanged)`,
      default: false,
    });
    if (!ok) {
      return;
    }
  }

  const s: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
  if (section === 'planner') {
    if (s.planner) {
      delete s.planner;
    }
  } else {
    if (s.tracker) {
      delete s.tracker;
    }
  }
  saveSecrets(paths.secretsFile, s);
  ui.success(`Removed credentials for ${section}.`);
  ui.info('Run `squad config set ' + section + '` to re-enter credentials.');
}
