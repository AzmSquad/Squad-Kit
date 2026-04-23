import fs from 'node:fs';
import { confirm } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { isInteractive } from '../../ui/tty.js';

export interface ConfigUnsetPlannerOptions {
  removeCredentials?: boolean;
  yes?: boolean;
}

export async function runConfigUnsetPlanner(opts: ConfigUnsetPlannerOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const useYes = Boolean(opts.yes);
  if (!useYes) {
    if (!isInteractive()) {
      ui.warning('Pass -y in non-interactive mode to confirm disabling the planner.');
      return;
    }
    const ok = await confirm({ message: 'Disable the direct planner? (keeps any keys in .squad/secrets.yaml.)', default: false });
    if (!ok) {
      return;
    }
  }

  const next: SquadConfig = { ...config };
  delete next.planner;
  saveConfig(paths.configFile, next);

  if (opts.removeCredentials) {
    const s: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
    if (s.planner) {
      delete s.planner;
      saveSecrets(paths.secretsFile, s);
    }
    ui.success('Planner disabled; planner credentials were removed from .squad/secrets.yaml.');
  } else {
    ui.success('Planner disabled; existing planner keys in .squad/secrets.yaml (if any) were preserved.');
  }
  ui.info('Re-enable any time with `squad config set planner`.');
}
