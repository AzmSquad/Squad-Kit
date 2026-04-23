import fs from 'node:fs';
import path from 'node:path';
import * as ui from '../ui/index.js';
import * as theme from '../ui/theme.js';
import { findSquadRoot, buildPaths, type SquadPaths } from '../core/paths.js';
import { loadConfig, type SquadConfig } from '../core/config.js';
import { loadSecrets, type SquadSecrets } from '../core/secrets.js';
import { ensureGitignore, SQUAD_TRASH_PATTERN } from '../core/gitignore.js';
import { modelFor, providerEnvVar, resolveProviderKey } from '../core/planner-models.js';
import { clientFor, overlayTrackerEnv, type ClientResolutionError } from '../tracker/index.js';
import type { ProviderName } from '../planner/types.js';
import { fetchProviderModelIds, probeJiraConnectivity, probeAzureConnectivity } from '../core/probes.js';

export interface DoctorOptions {
  fix?: boolean;
  json?: boolean;
}

export interface CheckResult {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
  fixHint?: string;
  fixable?: boolean;
}

interface DoctorContext {
  config?: SquadConfig;
  configError?: Error;
  secrets?: SquadSecrets;
  secretsError?: Error;
  hasLegacyPromptsDir: boolean;
}

async function gatherContext(paths: SquadPaths): Promise<DoctorContext> {
  const ctx: DoctorContext = { hasLegacyPromptsDir: false };
  try {
    ctx.config = loadConfig(paths.configFile);
  } catch (err) {
    ctx.configError = err as Error;
  }
  try {
    ctx.secrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
  } catch (err) {
    ctx.secretsError = err as Error;
  }
  ctx.hasLegacyPromptsDir = fs.existsSync(paths.promptsDir);
  return ctx;
}

function gitignoreHasManagedBlock(repoRoot: string): boolean {
  const gitignore = path.join(repoRoot, '.gitignore');
  return fs.existsSync(gitignore) && fs.readFileSync(gitignore, 'utf8').includes('.squad/secrets.yaml');
}

function gitignoreHasTrashPattern(repoRoot: string): boolean {
  const gitignore = path.join(repoRoot, '.gitignore');
  return fs.existsSync(gitignore) && fs.readFileSync(gitignore, 'utf8').includes(SQUAD_TRASH_PATTERN);
}

async function checkDirStructure(paths: SquadPaths, _ctx: DoctorContext, fix: boolean): Promise<CheckResult> {
  const need = [paths.squadDir, paths.storiesDir, paths.plansDir].filter((p) => !fs.existsSync(p));
  if (need.length === 0) {
    return { id: 'dirs', name: '.squad/ directory structure', status: 'ok' };
  }
  if (fix) {
    for (const p of need) {
      fs.mkdirSync(p, { recursive: true });
    }
    return { id: 'dirs', name: '.squad/ directory structure', status: 'ok', detail: 'repaired' };
  }
  return {
    id: 'dirs',
    name: '.squad/ directory structure',
    status: 'warn',
    detail: `missing: ${need.map((p) => path.relative(paths.root, p)).join(', ')}`,
    fixable: true,
    fixHint: 'squad doctor --fix',
  };
}

async function checkConfigReadable(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.configError) {
    return {
      id: 'config',
      name: '.squad/config.yaml readable',
      status: 'fail',
      detail: ctx.configError.message,
      fixHint: 'Fix or recreate .squad/config.yaml; see squad init',
    };
  }
  return { id: 'config', name: '.squad/config.yaml readable', status: 'ok' };
}

async function checkGitignore(paths: SquadPaths, _ctx: DoctorContext, fix: boolean): Promise<CheckResult> {
  if (gitignoreHasManagedBlock(paths.root)) {
    return { id: 'gitignore', name: '.gitignore managed block', status: 'ok' };
  }
  if (fix) {
    ensureGitignore(paths.root);
    return { id: 'gitignore', name: '.gitignore managed block', status: 'ok', detail: 'repaired' };
  }
  return {
    id: 'gitignore',
    name: '.gitignore managed block',
    status: 'warn',
    fixable: true,
    fixHint: 'squad doctor --fix',
  };
}

async function checkGitignoreTrashPattern(paths: SquadPaths, _ctx: DoctorContext, fix: boolean): Promise<CheckResult> {
  if (gitignoreHasTrashPattern(paths.root)) {
    return { id: 'gitignore-trash', name: '.gitignore includes .squad/.trash/', status: 'ok' };
  }
  if (fix) {
    ensureGitignore(paths.root);
    if (gitignoreHasTrashPattern(paths.root)) {
      return { id: 'gitignore-trash', name: '.gitignore includes .squad/.trash/', status: 'ok', detail: 'repaired' };
    }
  }
  return {
    id: 'gitignore-trash',
    name: '.gitignore includes .squad/.trash/',
    status: 'warn',
    fixable: true,
    fixHint: 'squad doctor --fix',
  };
}

async function checkSecretsPermissions(paths: SquadPaths, _ctx: DoctorContext, fix: boolean): Promise<CheckResult> {
  if (process.platform === 'win32') {
    return { id: 'secrets-perms', name: '.squad/secrets.yaml permissions', status: 'skip', detail: 'Windows' };
  }
  if (!fs.existsSync(paths.secretsFile)) {
    return { id: 'secrets-perms', name: '.squad/secrets.yaml permissions', status: 'ok', detail: 'not present' };
  }
  const mode = fs.statSync(paths.secretsFile).mode & 0o777;
  if (mode === 0o600) {
    return { id: 'secrets-perms', name: '.squad/secrets.yaml permissions', status: 'ok' };
  }
  if (fix) {
    fs.chmodSync(paths.secretsFile, 0o600);
    return { id: 'secrets-perms', name: '.squad/secrets.yaml permissions', status: 'ok', detail: 'repaired' };
  }
  return {
    id: 'secrets-perms',
    name: '.squad/secrets.yaml permissions',
    status: 'warn',
    detail: `mode ${mode.toString(8)} (expected 600)`,
    fixable: true,
    fixHint: 'squad doctor --fix',
  };
}

async function checkSecretsParseable(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.secretsError) {
    return {
      id: 'secrets-yaml',
      name: '.squad/secrets.yaml parseable',
      status: 'fail',
      detail: ctx.secretsError.message,
    };
  }
  if (!fs.existsSync(_paths.secretsFile)) {
    return { id: 'secrets-yaml', name: '.squad/secrets.yaml parseable', status: 'ok', detail: 'not present' };
  }
  return { id: 'secrets-yaml', name: '.squad/secrets.yaml parseable', status: 'ok' };
}

async function checkLegacyPrompts(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (ctx.hasLegacyPromptsDir) {
    return {
      id: 'legacy-prompts',
      name: 'legacy .squad/prompts/ directory',
      status: 'warn',
      detail: 'stale copy from pre-0.2 installs',
      fixHint: 'squad migrate',
    };
  }
  return { id: 'legacy-prompts', name: 'legacy .squad/prompts/ directory', status: 'ok' };
}

async function checkPlannerConfig(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config) {
    return {
      id: 'planner-config',
      name: 'planner configuration',
      status: 'skip',
      detail: 'config unavailable',
    };
  }
  const p = ctx.config.planner;
  if (p?.enabled !== true) {
    return { id: 'planner-config', name: 'planner configuration', status: 'skip', detail: 'disabled' };
  }
  if (!['anthropic', 'openai', 'google'].includes(p.provider)) {
    return {
      id: 'planner-config',
      name: 'planner configuration',
      status: 'fail',
      detail: `unsupported planner.provider "${p.provider}"`,
    };
  }
  const mo = p.modelOverride;
  if (mo) {
    for (const key of ['anthropic', 'openai', 'google'] as const) {
      const v = mo[key];
      if (v !== undefined && (typeof v !== 'string' || v.trim().length === 0)) {
        return {
          id: 'planner-config',
          name: 'planner configuration',
          status: 'fail',
          detail: `planner.modelOverride.${key} must be a non-empty string when set`,
        };
      }
    }
  }
  if (p.budget.maxFileReads <= 0 || p.budget.maxContextBytes <= 0 || p.budget.maxDurationSeconds <= 0) {
    return {
      id: 'planner-config',
      name: 'planner configuration',
      status: 'fail',
      detail: 'planner budget limits must be > 0',
    };
  }
  if (p.budget.maxCostUsd !== undefined && p.budget.maxCostUsd <= 0) {
    return {
      id: 'planner-config',
      name: 'planner configuration',
      status: 'fail',
      detail: 'planner.budget.maxCostUsd must be > 0 when set',
    };
  }
  return { id: 'planner-config', name: 'planner configuration', status: 'ok' };
}

async function checkPlannerCredential(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config || ctx.config.planner?.enabled !== true) {
    return { id: 'planner-cred', name: 'planner credential resolves', status: 'skip', detail: 'planner disabled' };
  }
  const provider = ctx.config.planner.provider;
  const resolved = resolveProviderKey(provider);
  if (!resolved) {
    const envVar = providerEnvVar(provider);
    return {
      id: 'planner-cred',
      name: 'planner credential resolves',
      status: 'fail',
      detail: `no API key found (${envVar} or .squad/secrets.yaml)`,
      fixHint: `Set ${envVar} or save a key via 'squad init' interactive setup`,
    };
  }
  return {
    id: 'planner-cred',
    name: 'planner credential resolves',
    status: 'ok',
    detail: `source=${resolved.source} (${resolved.detail})`,
  };
}

async function checkPlannerModel(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config || ctx.config.planner?.enabled !== true) {
    return { id: 'planner-model', name: 'planner model resolves at provider', status: 'skip', detail: 'planner disabled' };
  }
  const provider = ctx.config.planner.provider;
  const cred = resolveProviderKey(provider);
  if (!cred) {
    return {
      id: 'planner-model',
      name: 'planner model resolves at provider',
      status: 'skip',
      detail: 'no credential',
    };
  }
  const model = modelFor(provider, 'plan', ctx.config.planner.modelOverride);
  try {
    const listed = await fetchProviderModelIds(provider, cred.value);
    if (!listed.ok) {
      const st = listed.status;
      if (st === 401 || st === 403) {
        return {
          id: 'planner-model',
          name: 'planner model resolves at provider',
          status: 'warn',
          detail: `models API HTTP ${st}`,
        };
      }
      return {
        id: 'planner-model',
        name: 'planner model resolves at provider',
        status: 'warn',
        detail: `models API HTTP ${st}: ${listed.body.slice(0, 120)}`,
      };
    }
    if (!listed.ids.has(model)) {
      return {
        id: 'planner-model',
        name: 'planner model resolves at provider',
        status: 'fail',
        detail: `model "${model}" not listed by provider`,
        fixHint: `Upgrade squad-kit for updated pins, set planner.modelOverride.${provider} in .squad/config.yaml, or switch planner.provider to a provider that exposes this model id.`,
      };
    }
    return {
      id: 'planner-model',
      name: 'planner model resolves at provider',
      status: 'ok',
      detail: `${model} (${provider})`,
    };
  } catch (err) {
    return {
      id: 'planner-model',
      name: 'planner model resolves at provider',
      status: 'warn',
      detail: (err as Error).message,
    };
  }
}

async function checkTrackerConfig(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config) {
    return { id: 'tracker-config', name: 'tracker configuration', status: 'skip', detail: 'config unavailable' };
  }
  const t = ctx.config.tracker;
  if (t.type === 'none') {
    return { id: 'tracker-config', name: 'tracker configuration', status: 'skip', detail: 'none' };
  }
  if (t.type === 'jira' && !t.workspace?.trim()) {
    return {
      id: 'tracker-config',
      name: 'tracker configuration',
      status: 'fail',
      detail: 'Jira requires tracker.workspace (host)',
    };
  }
  if (t.type === 'azure' && (!t.workspace?.trim() || !t.project?.trim())) {
    return {
      id: 'tracker-config',
      name: 'tracker configuration',
      status: 'fail',
      detail: 'Azure DevOps requires tracker.workspace (organization) and tracker.project',
    };
  }
  return { id: 'tracker-config', name: 'tracker configuration', status: 'ok' };
}

function formatClientError(err: ClientResolutionError): string {
  return `${err.message} ${err.detail}`.trim();
}

async function checkTrackerCredential(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config) {
    return { id: 'tracker-cred', name: 'tracker credential resolves', status: 'skip', detail: 'config unavailable' };
  }
  if (ctx.config.tracker.type === 'none') {
    return { id: 'tracker-cred', name: 'tracker credential resolves', status: 'skip', detail: 'none' };
  }
  const secrets = ctx.secrets ?? {};
  const overlay = overlayTrackerEnv(secrets);
  const { client, error } = clientFor(ctx.config, overlay);
  if (error) {
    return {
      id: 'tracker-cred',
      name: 'tracker credential resolves',
      status: 'fail',
      detail: formatClientError(error),
    };
  }
  if (!client) {
    return {
      id: 'tracker-cred',
      name: 'tracker credential resolves',
      status: 'fail',
      detail: 'no tracker client',
    };
  }
  return { id: 'tracker-cred', name: 'tracker credential resolves', status: 'ok' };
}

async function checkTrackerConnectivity(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config || ctx.config.tracker.type === 'none') {
    return { id: 'tracker-live', name: 'tracker connectivity', status: 'skip', detail: 'none' };
  }
  const secrets = ctx.secrets ?? {};
  const overlay = overlayTrackerEnv(secrets);
  const { client, error } = clientFor(ctx.config, overlay);
  if (error || !client) {
    return { id: 'tracker-live', name: 'tracker connectivity', status: 'skip', detail: 'no credential' };
  }
  if (client.name === 'jira') {
    const r = await probeJiraConnectivity(secrets, ctx.config);
    if (r.ok) return { id: 'tracker-live', name: 'tracker connectivity', status: 'ok', detail: 'Jira REST' };
    return {
      id: 'tracker-live',
      name: 'tracker connectivity',
      status: 'fail',
      detail: r.status !== undefined ? `HTTP ${r.status}` : r.detail ?? 'request failed',
    };
  }
  if (client.name === 'azure') {
    const r = await probeAzureConnectivity(secrets, ctx.config);
    if (r.ok) return { id: 'tracker-live', name: 'tracker connectivity', status: 'ok', detail: 'Azure DevOps' };
    return {
      id: 'tracker-live',
      name: 'tracker connectivity',
      status: 'fail',
      detail: r.status !== undefined ? `HTTP ${r.status}` : r.detail ?? 'request failed',
    };
  }
  return {
    id: 'tracker-live',
    name: 'tracker connectivity',
    status: 'skip',
    detail: 'unsupported client',
  };
}

async function guardCheck(checkName: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      id: 'unexpected',
      name: checkName,
      status: 'fail',
      detail: (err as Error).message,
    };
  }
}

async function runAllChecks(paths: SquadPaths, ctx: DoctorContext, fix: boolean): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const add = async (label: string, fn: () => Promise<CheckResult>) => {
    checks.push(await guardCheck(label, fn));
  };
  await add('.squad/ directory structure', () => checkDirStructure(paths, ctx, fix));
  await add('.squad/config.yaml readable', () => checkConfigReadable(paths, ctx));
  await add('.gitignore managed block', () => checkGitignore(paths, ctx, fix));
  await add('.gitignore includes .squad/.trash/', () => checkGitignoreTrashPattern(paths, ctx, fix));
  await add('.squad/secrets.yaml permissions', () => checkSecretsPermissions(paths, ctx, fix));
  await add('.squad/secrets.yaml parseable', () => checkSecretsParseable(paths, ctx));
  await add('legacy .squad/prompts/ directory', () => checkLegacyPrompts(paths, ctx));
  await add('planner configuration', () => checkPlannerConfig(paths, ctx));
  await add('planner credential resolves', () => checkPlannerCredential(paths, ctx));
  await add('planner model resolves at provider', () => checkPlannerModel(paths, ctx));
  await add('tracker configuration', () => checkTrackerConfig(paths, ctx));
  await add('tracker credential resolves', () => checkTrackerCredential(paths, ctx));
  await add('tracker connectivity', () => checkTrackerConnectivity(paths, ctx));
  return checks;
}

function summarise(checks: CheckResult[]): { ok: number; warn: number; fail: number; skip: number } {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };
}

function colorForStatus(s: CheckResult['status']): (t: string) => string {
  switch (s) {
    case 'ok':
      return theme.primary;
    case 'warn':
      return theme.warn;
    case 'fail':
      return theme.danger;
    case 'skip':
      return theme.dim;
    default:
      return (x) => x;
  }
}

function symbolForStatus(s: CheckResult['status']): string {
  switch (s) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    case 'fail':
      return '✗';
    case 'skip':
      return '·';
    default:
      return '?';
  }
}

function renderChecks(root: string, checks: CheckResult[]): void {
  ui.divider('squad doctor');
  ui.info(`workspace  ${root}`);
  ui.info('');
  for (const c of checks) {
    const sym = symbolForStatus(c.status);
    const col = colorForStatus(c.status);
    const detail = c.detail ? theme.dim(` — ${c.detail}`) : '';
    ui.line(`  ${col(sym)}  ${c.name}${detail}`);
    if (c.fixHint) ui.line(`       ${theme.dim('↳ ' + c.fixHint)}`);
  }
  ui.info('');
  const counts = summarise(checks);
  ui.info(`${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail · ${counts.skip} skip`);
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const fix = opts.fix ?? false;
  const json = opts.json ?? false;

  const root = findSquadRoot();
  if (!root) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ error: 'No .squad/ directory found. Run `squad init` first.', checks: [] }, null, 2) + '\n',
      );
    } else {
      ui.failure('No .squad/ directory found. Run `squad init` first.');
    }
    process.exit(1);
  }
  const paths = buildPaths(root);

  const ctx = await gatherContext(paths);
  const checks = await runAllChecks(paths, ctx, fix);

  if (json) {
    process.stdout.write(JSON.stringify({ root, checks }, null, 2) + '\n');
  } else {
    renderChecks(root, checks);
  }

  if (fix) {
    const repaired = checks.filter((c) => c.detail === 'repaired').length;
    if (repaired > 0 && !json) {
      ui.info('');
      ui.info(`Applied ${repaired} repair(s).`);
    }
  }

  if (!json) {
    const fixableWarns = checks.filter((c) => c.status === 'warn' && c.fixable).length;
    const migrateNeeded = checks.filter((c) => c.id === 'legacy-prompts' && c.status === 'warn').length;
    if (!fix && (fixableWarns > 0 || migrateNeeded > 0)) {
      ui.info('');
      if (fixableWarns > 0) {
        ui.info(
          `${fixableWarns} fixable issue(s) found. Run \`squad doctor --fix\` to apply non-destructive repairs.`,
        );
      }
      if (migrateNeeded > 0) {
        ui.info(`${migrateNeeded} destructive issue requires \`squad migrate\`.`);
      }
    }
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  if (fails > 0) process.exit(1);
}
