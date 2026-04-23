import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { findSquadRoot, buildPaths, type SquadPaths } from '../core/paths.js';
import { loadConfig, saveConfig, serializeConfig } from '../core/config.js';
import { ensureGitignore } from '../core/gitignore.js';

export interface MigrateOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface Migration {
  id: string;
  name: string;
  /** true if, after this function returns, there is nothing left to migrate of this type. */
  isApplied: (paths: SquadPaths) => boolean | Promise<boolean>;
  /** The destructive side-effect. Only called when --dry-run is false and the user confirmed. */
  apply: (paths: SquadPaths) => void | Promise<void>;
  /** Human-readable one-liner describing what apply() will do. */
  describe: (paths: SquadPaths) => string;
}

const LEGACY_PROMPTS_MIGRATION: Migration = {
  id: 'legacy-prompts',
  name: 'Remove legacy .squad/prompts/',
  isApplied: (paths) => !fs.existsSync(paths.promptsDir),
  describe: (paths) =>
    `delete ${path.relative(paths.root, paths.promptsDir)} (prompts are now bundled in squad-kit)`,
  apply: (paths) => {
    const target = paths.promptsDir;
    if (!target.includes(path.sep + '.squad' + path.sep + 'prompts')) {
      throw new Error(
        `Refusing to delete suspicious path: ${target}. This is a safety check — run \`squad doctor\` if .squad/ paths look wrong.`,
      );
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  },
};

const GITIGNORE_MIGRATION: Migration = {
  id: 'gitignore',
  name: 'Ensure .gitignore managed block',
  isApplied: (paths) => {
    const f = path.join(paths.root, '.gitignore');
    return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('.squad/secrets.yaml');
  },
  describe: () => 'add squad-kit managed block to .gitignore',
  apply: (paths) => {
    ensureGitignore(paths.root);
  },
};

const SECRETS_PERMS_MIGRATION: Migration = {
  id: 'secrets-perms',
  name: 'Tighten .squad/secrets.yaml permissions',
  isApplied: (paths) => {
    if (process.platform === 'win32') return true;
    if (!fs.existsSync(paths.secretsFile)) return true;
    const st = fs.statSync(paths.secretsFile);
    return (st.mode & 0o777) === 0o600;
  },
  describe: (paths) => `chmod 0600 ${path.relative(paths.root, paths.secretsFile)}`,
  apply: (paths) => {
    if (process.platform === 'win32') return;
    if (fs.existsSync(paths.secretsFile)) fs.chmodSync(paths.secretsFile, 0o600);
  },
};

const PLANNER_BUDGET_DEFAULTS_MIGRATION: Migration = {
  id: 'planner-budget-defaults',
  name: 'Backfill planner.budget defaults in config.yaml',
  isApplied: (paths) => {
    if (!fs.existsSync(paths.configFile)) return true;
    try {
      const raw = fs.readFileSync(paths.configFile, 'utf8');
      if (!/^\s*planner:/m.test(raw)) return true;
      if (/^\s*budget:/m.test(raw)) return true;
      const cfg = loadConfig(paths.configFile);
      return !cfg.planner?.enabled;
    } catch {
      return true;
    }
  },
  describe: () => 'add planner.budget defaults to config.yaml',
  apply: (paths) => {
    const cfg = loadConfig(paths.configFile);
    if (cfg.planner?.enabled) saveConfig(paths.configFile, cfg);
  },
};

const CONFIG_NORMALIZE_MIGRATION: Migration = {
  id: 'config-normalize',
  name: 'Normalise .squad/config.yaml formatting',
  isApplied: (paths) => {
    if (!fs.existsSync(paths.configFile)) return true;
    try {
      const raw = fs.readFileSync(paths.configFile, 'utf8');
      const cfg = loadConfig(paths.configFile);
      return raw.trim() === serializeConfig(cfg).trim();
    } catch {
      return true;
    }
  },
  describe: () => 'rewrite config.yaml with canonical YAML formatting (drops comments)',
  apply: (paths) => {
    if (!fs.existsSync(paths.configFile)) return;
    const cfg = loadConfig(paths.configFile);
    saveConfig(paths.configFile, cfg);
  },
};

export const MIGRATIONS: Migration[] = [
  LEGACY_PROMPTS_MIGRATION,
  GITIGNORE_MIGRATION,
  SECRETS_PERMS_MIGRATION,
  PLANNER_BUDGET_DEFAULTS_MIGRATION,
  CONFIG_NORMALIZE_MIGRATION,
];

export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const root = findSquadRoot();
  if (!root) {
    ui.failure('No .squad/ directory found. Run `squad init` first.');
    process.exit(1);
  }
  const paths = buildPaths(root);

  const pending: Migration[] = [];
  for (const m of MIGRATIONS) {
    const already = await Promise.resolve(m.isApplied(paths));
    if (!already) pending.push(m);
  }

  ui.divider('squad migrate');
  ui.info(`workspace  ${root}`);
  ui.info('');

  if (pending.length === 0) {
    ui.success('No migrations needed. Your .squad/ is up to date.');
    return;
  }

  ui.info(`${pending.length} migration(s) pending:`);
  for (const m of pending) {
    ui.line(`  · ${m.name} — ${m.describe(paths)}`);
  }
  ui.info('');

  if (opts.dryRun) {
    ui.info('Dry run: no changes applied. Re-run without --dry-run to apply.');
    return;
  }

  if (!opts.yes) {
    const interactive = Boolean(process.stdin.isTTY) && process.env.CI !== 'true';
    if (!interactive) {
      ui.failure(
        'Refusing to apply migrations without --yes in a non-interactive shell. Run `squad migrate --yes` to apply without a prompt, or re-run in a TTY to confirm interactively.',
      );
      process.exit(1);
    }
    const go = await confirm({ message: `Apply ${pending.length} migration(s)?`, default: true });
    if (!go) {
      ui.info('Cancelled. No changes applied.');
      return;
    }
  }

  let applied = 0;
  for (const m of pending) {
    const spin = ui.spinner(m.name);
    try {
      await Promise.resolve(m.apply(paths));
      spin.succeed(`${m.name} — applied`);
      applied++;
    } catch (err) {
      spin.fail(`${m.name} — failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  ui.info('');
  ui.success(`Applied ${applied}/${pending.length} migration(s).`);
  ui.blank();
  ui.step('Next:');
  ui.info('1) Run `squad doctor` to verify every check is green.');
  ui.info('2) If you were upgrading from 0.1.x, review .squad/config.yaml — new defaults (planner, cache) may have been added.');
  ui.info('3) Continue your usual workflow: `squad new-story` → fill intake → `squad new-plan`.');
}
