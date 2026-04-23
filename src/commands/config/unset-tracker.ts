import fs from 'node:fs';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { isInteractive } from '../../ui/tty.js';

export interface ConfigUnsetTrackerOptions {
  removeCredentials?: boolean;
  yes?: boolean;
}

export async function runConfigUnsetTracker(opts: ConfigUnsetTrackerOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const useYes = Boolean(opts.yes);
  if (!useYes) {
    if (!isInteractive()) {
      ui.warning('Pass -y in non-interactive mode to confirm setting the tracker to none.');
      return;
    }
    const ok = await confirm({ message: 'Set tracker to none? (keeps tracker tokens in .squad/secrets.yaml.)', default: false });
    if (!ok) {
      return;
    }
  }

  const next: SquadConfig = { ...config, tracker: { type: 'none' } };
  saveConfig(paths.configFile, next);

  if (opts.removeCredentials) {
    const s: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
    if (s.tracker) {
      delete s.tracker;
      saveSecrets(paths.secretsFile, s);
    }
    ui.success('Tracker set to none; tracker credentials were removed from .squad/secrets.yaml.');
  } else {
    ui.success('Tracker set to none; any tracker credentials in .squad/secrets.yaml (if any) were preserved.');
  }
  ui.info('Re-enable any time with `squad config set tracker`.');
}
