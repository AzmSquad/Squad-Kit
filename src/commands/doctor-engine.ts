import fs from 'node:fs';
import path from 'node:path';
import { type SquadPaths } from '../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../core/config.js';
import { loadSecrets, type SquadSecrets } from '../core/secrets.js';
import { ensureGitignore, SQUAD_TRASH_PATTERN } from '../core/gitignore.js';
import {
  modelFor,
  providerEnvVar,
  resolvePlannerAuthForPaths,
  resolveProviderKeyForPaths,
} from '../core/planner-models.js';
import { describeAuth, type ResolvedPlannerAuth } from '../core/planner-auth.js';
import { MISSING_CLAUDE_BINARY_MESSAGE, resolveClaudeBinary } from '../core/claude-binary.js';
import { skipExternalProbesInAutomation } from '../core/ci-env.js';
import { probeClaudeAuth, type ProbeClaudeAuthResult } from '../planner/runtimes/auth-probe.js';
import { plannerAuthRuntimeMismatchMessage } from '../planner/runtimes/auth-runtime-mismatch.js';
import { authReasonText, credentialPresent, runtimeNameFor } from './auth/shared.js';
import { clientFor, overlayTrackerEnv, type ClientResolutionError } from '../tracker/index.js';
import type { ProviderName } from '../planner/types.js';
import {
  fetchProviderModelIds,
  probeJiraConnectivity,
  probeAzureConnectivity,
  probeGitHubConnectivity,
} from '../core/probes.js';
import { readLastRun } from '../core/last-run.js';
import { formatTokenK } from '../ui/planner-cache-summary.js';

export interface CheckResult {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
  fixHint?: string;
  fixable?: boolean;
}

/** Either the resolver answered, or it told us why it cannot. Never both. */
type AuthResolution = { ok: true; auth: ResolvedPlannerAuth } | { ok: false; error: Error };

/** `{ skipped: true }` means the run is in CI/automation, not that the login failed. */
type AuthProbeOutcome = ProbeClaudeAuthResult | { skipped: true };

/**
 * Auth state is resolved once and probed at most once per doctor run: `planner-auth-mode`,
 * `planner-cred`, `planner-model`, `planner-auth-runtime-fit` and the Agent SDK check all want it,
 * and a second `probeClaudeAuth()` would mean a second SDK subprocess.
 */
interface DoctorAuthMemo {
  resolution?: AuthResolution;
  probe?: AuthProbeOutcome;
}

export interface DoctorContext {
  config?: SquadConfig;
  configError?: Error;
  secrets?: SquadSecrets;
  secretsError?: Error;
  hasLegacyPromptsDir: boolean;
  /** Internal per-run memo; see `DoctorAuthMemo`. Not part of the `--json` output. */
  authMemo?: DoctorAuthMemo;
}

export async function gatherContext(paths: SquadPaths): Promise<DoctorContext> {
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

/**
 * Doctor is deliberately more patient than the 10s `probeClaudeAuth` default. A *cold* Agent SDK
 * subprocess start was measured at ~9.2s on a warm-cache machine (warm runs ~1.6s), so the default
 * would report a spurious timeout on the first `squad doctor` after a reboot. A timeout still
 * degrades to `warn`, never `fail` — this just stops us crying wolf on the common case.
 */
const DOCTOR_AUTH_PROBE_TIMEOUT_MS = 25_000;

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
  return { id: 'planner-config', name: 'planner configuration', status: 'ok' };
}

const LOGIN_FIX_HINT = 'Run `squad auth login` to sign in with your Claude account.';

const ORG_NOT_ALLOWED_FIX_HINT =
  'That Claude account is signed in, but its organization policy blocks this kind of access. ' +
  'Ask an administrator to allow Claude Agent SDK usage, or set `planner.auth.anthropic: api-key` ' +
  'in .squad/config.yaml and provide an ANTHROPIC_API_KEY.';

/** Planner enabled with a usable config? Every auth-aware check starts here. */
function plannerEnabled(ctx: DoctorContext): boolean {
  return ctx.config?.planner?.enabled === true;
}

/**
 * Resolve the planner auth mode once per doctor run. Errors are captured rather than thrown:
 * `PlannerAuthUnavailableError` is a finding (`planner-auth-mode` fails and names both recovery
 * paths), not a crashed check.
 */
function authFor(paths: SquadPaths, ctx: DoctorContext, provider: ProviderName): AuthResolution {
  const memo = (ctx.authMemo ??= {});
  if (!memo.resolution) {
    try {
      memo.resolution = { ok: true, auth: resolvePlannerAuthForPaths(paths, provider, ctx.config?.planner) };
    } catch (err) {
      memo.resolution = { ok: false, error: err as Error };
    }
  }
  return memo.resolution;
}

/**
 * Verify the login with the Agent SDK — at most once per run, and never when
 * `skipExternalProbesInAutomation()` says so. Note the vitest suite does NOT set `CI`:
 * `test/support/env-isolation.ts` deletes it so tests mocking `isTTY` still see
 * `isInteractive() === true`. Suite-level protection therefore comes from stubbing
 * `probeClaudeAuth`, not from this guard — an unstubbed test would spawn a real SDK
 * subprocess against the developer's own Claude login.
 */
async function probeAuthOnce(ctx: DoctorContext, auth: ResolvedPlannerAuth): Promise<AuthProbeOutcome> {
  const memo = (ctx.authMemo ??= {});
  if (!memo.probe) {
    memo.probe = skipExternalProbesInAutomation()
      ? { skipped: true }
      : await probeClaudeAuth(auth, { timeoutMs: DOCTOR_AUTH_PROBE_TIMEOUT_MS });
  }
  return memo.probe;
}

function probeWasSkipped(outcome: AuthProbeOutcome): outcome is { skipped: true } {
  return 'skipped' in outcome;
}

async function checkPlannerAuthMode(
  paths: SquadPaths,
  ctx: DoctorContext,
  _fix: boolean,
): Promise<CheckResult> {
  const id = 'planner-auth-mode';
  const name = 'planner auth mode';
  if (!plannerEnabled(ctx) || !ctx.config?.planner) {
    return { id, name, status: 'skip', detail: 'planner disabled' };
  }
  const planner = ctx.config.planner;
  const provider = planner.provider;
  if (provider !== 'anthropic') {
    return { id, name, status: 'skip', detail: `api key only for ${provider}` };
  }

  const resolution = authFor(paths, ctx, provider);
  if (!resolution.ok) {
    return { id, name, status: 'fail', detail: resolution.error.message, fixHint: LOGIN_FIX_HINT };
  }

  const auth = resolution.auth;
  const described = describeAuth(auth);
  let detail = `${described.mode} (${authReasonText(described.reason, provider)}) → ${described.credentialHint}`;

  if (auth.mode === 'subscription') {
    // A key *and* a login in `auto` — say out loud which one wins, so the change is never silent.
    const ignoredKey = resolveProviderKeyForPaths(paths, provider);
    if (ignoredKey) detail += ` · ignoring the API key from ${ignoredKey.detail}`;
  }

  const implicitApiKey = (planner.auth?.anthropic ?? 'auto') === 'auto' && auth.reason === 'auto-fallback-api-key';
  if (implicitApiKey) {
    // Deliberately NOT offered as a `--fix`. Pinning `api-key` here would look like tidying up, but
    // `auto` exists precisely so that a Claude login, once present, takes over — pinning it would
    // silently stop that from ever happening, which is the opposite of what 0.12 is for. Nothing is
    // broken in this state, so doctor explains it and leaves the choice to the user.
    return {
      id,
      name,
      status: 'ok',
      detail,
      fixHint:
        'Resolving by fallback. Set `planner.auth.anthropic` explicitly (`squad config set planner`) if you want to pin this, ' +
        'or run `squad auth login` to plan on your Claude subscription instead.',
    };
  }

  return { id, name, status: 'ok', detail };
}

/** Human summary of a successful probe. Account fields are optional; never assume they are there. */
function describeProbeAccount(probe: ProbeClaudeAuthResult & { ok: true }): string {
  const bits: string[] = [];
  const email = probe.account?.email;
  const plan = probe.account?.subscriptionType;
  if (email) {
    bits.push(`signed in as ${email}${plan ? ` (${plan})` : ''}`);
  } else if (probe.unverifiable) {
    // Token auth resolves a source but never an account, so we cannot claim it is verified.
    bits.push(`credential resolved (${probe.credentialSource ?? 'token auth'}) · not verifiable without a run`);
  } else {
    bits.push('Claude login verified');
  }
  if (probe.account?.organization) bits.push(probe.account.organization);
  if (probe.apiKeySource) bits.push(`apiKeySource=${probe.apiKeySource}`);
  return bits.join(' · ');
}

async function checkPlannerCredential(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  const id = 'planner-cred';
  const name = 'planner credential resolves';
  if (!plannerEnabled(ctx) || !ctx.config?.planner) {
    return { id, name, status: 'skip', detail: 'planner disabled' };
  }
  const provider = ctx.config.planner.provider;
  const resolution = authFor(paths, ctx, provider);
  if (!resolution.ok) {
    const envVar = providerEnvVar(provider);
    return {
      id,
      name,
      status: 'fail',
      detail: `no API key found (${envVar} or .squad/secrets.yaml)`,
      fixHint: resolution.error.message,
    };
  }

  const auth = resolution.auth;
  if (auth.mode === 'api-key') {
    return { id, name, status: 'ok', detail: `source=${auth.source} (${auth.detail})` };
  }

  const credentialHint = describeAuth(auth).credentialHint;
  const probe = await probeAuthOnce(ctx, auth);
  if (probeWasSkipped(probe)) {
    return credentialPresent(auth)
      ? { id, name, status: 'ok', detail: `${credentialHint} · offline check only` }
      : {
          id,
          name,
          status: 'warn',
          detail: 'no Claude login detected · offline check only',
          fixHint: LOGIN_FIX_HINT,
        };
  }
  if (probe.ok) {
    return { id, name, status: 'ok', detail: describeProbeAccount(probe) };
  }
  switch (probe.kind) {
    case 'not-logged-in':
    case 'expired':
      return { id, name, status: 'fail', detail: probe.detail, fixHint: LOGIN_FIX_HINT };
    case 'org-not-allowed':
      return { id, name, status: 'fail', detail: probe.detail, fixHint: ORG_NOT_ALLOWED_FIX_HINT };
    case 'no-binary':
      // Not a credential problem — `agent-sdk-binary-present` owns this one.
      return { id, name, status: 'warn', detail: probe.detail, fixHint: MISSING_CLAUDE_BINARY_MESSAGE };
    default:
      // timeout / unknown: the network is not the user's config, so never fail on it *unless* the
      // offline detector already said there is no login — that signal is definitive on its own.
      return credentialPresent(auth)
        ? { id, name, status: 'warn', detail: `${probe.kind}: ${probe.detail}` }
        : {
            id,
            name,
            status: 'fail',
            detail: `no Claude login detected (live check: ${probe.kind})`,
            fixHint: LOGIN_FIX_HINT,
          };
  }
}

async function checkPlannerModel(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!plannerEnabled(ctx) || !ctx.config?.planner) {
    return { id: 'planner-model', name: 'planner model resolves at provider', status: 'skip', detail: 'planner disabled' };
  }
  const provider = ctx.config.planner.provider;
  const resolution = authFor(paths, ctx, provider);
  if (!resolution.ok) {
    return {
      id: 'planner-model',
      name: 'planner model resolves at provider',
      status: 'skip',
      detail: 'no credential',
    };
  }
  const auth = resolution.auth;
  if (auth.mode === 'subscription') {
    // `/v1/models` authenticates with `x-api-key`; an OAuth subscription credential is not one, and
    // a stray key in the environment would validate against a different account than the run uses.
    return {
      id: 'planner-model',
      name: 'planner model resolves at provider',
      status: 'skip',
      detail: 'model list needs an API key; skipped in subscription mode',
    };
  }
  const model = modelFor(provider, 'plan', ctx.config.planner.modelOverride);
  try {
    const listed = await fetchProviderModelIds(provider, auth.key);
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

async function checkPlannerTierAwareness(
  paths: SquadPaths,
  ctx: DoctorContext,
): Promise<CheckResult> {
  const id = 'planner-tier';
  const name = 'planner tier vs. model';
  if (!ctx.config || ctx.config.planner?.enabled !== true) {
    return { id, name, status: 'skip', detail: 'planner disabled' };
  }
  const provider = ctx.config.planner.provider;
  if (provider !== 'anthropic') {
    return { id, name, status: 'skip', detail: `not applicable for ${provider}` };
  }
  // Every branch below is about API rate tiers — ITPM ceilings, 429s, console.anthropic.com limits.
  // None of that governs a subscription run, which draws on the plan's usage window instead, so
  // warning about Tier 1 here would be advice for an account the user is not billing against.
  const tierAuth = authFor(paths, ctx, provider);
  if (tierAuth.ok && tierAuth.auth.mode === 'subscription') {
    return { id, name, status: 'skip', detail: 'not applicable on subscription auth (no API rate tier)' };
  }
  const planModel = modelFor(provider, 'plan', ctx.config.planner.modelOverride);
  if (!/opus/i.test(planModel)) {
    return { id, name, status: 'ok', detail: `${planModel} is comfortably under Tier 1` };
  }
  const cacheOn = ctx.config.planner?.cache?.enabled !== false;
  if (cacheOn) {
    return {
      id,
      name,
      status: 'warn',
      detail: 'Anthropic Tier 1 with Opus — tight but viable with prompt caching on',
      fixHint: [
        'Caching saves ~70% on billed input tokens. Keep `planner.cache.enabled: true` in config.',
        'If you still hit 429s on long runs, reduce `planner.budget.maxContextBytes` or use Haiku for plan phase.',
      ].join('\n'),
    };
  }
  return {
    id,
    name,
    status: 'warn',
    detail: `${planModel} on Anthropic Tier 1 (10k input tokens/min) is throttle-prone for plans over ~3 file reads`,
    fixHint:
      'Run `squad config set planner` and pick a Sonnet or Haiku id for planner.modelOverride.anthropic, ' +
      'or upgrade tier at https://console.anthropic.com/settings/limits. ' +
      'squad-kit will auto-retry a 429 once (waiting up to 90s), but repeated throttling means the plan model is simply too big for your quota.',
  };
}

export async function checkPlannerCache(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  const id = 'planner-cache';
  const name = 'planner cache effectiveness';
  const config = ctx.config;
  const cacheCfg = config?.planner?.cache;

  if (config?.planner?.enabled !== true) {
    return { id, name, status: 'skip', detail: 'planner disabled — cache check not applicable' };
  }

  if (cacheCfg?.enabled === false) {
    return {
      id,
      name,
      status: 'warn',
      detail: 'prompt caching is disabled in .squad/config.yaml',
      fixHint: 'Cache saves ~70% on billed tokens. Re-enable with `squad config set planner`.',
    };
  }

  const lastRun = await readLastRun(paths);
  if (!lastRun) {
    return {
      id,
      name,
      status: 'skip',
      detail: 'no planner runs logged yet',
      fixHint: 'Run `squad new-plan --api` once, then re-run `squad doctor` to see cache telemetry.',
    };
  }

  const { stats } = lastRun;
  const hitPct = Math.round(stats.cacheHitRatio * 100);

  if (stats.cacheReadTokens === 0 && stats.turns > 1) {
    return {
      id,
      name,
      status: 'fail',
      detail: `caching configured but last run saw 0% hits across ${stats.turns} turns`,
      fixHint: [
        'Possible causes:',
        '  • Planner provider is not Anthropic and the prefix is below 1024 tokens (OpenAI / Google need larger prefixes).',
        '  • System prompt is mutating between turns — check recent changes.',
        "  • Using an older model that doesn't support caching.",
        `Provider: ${lastRun.provider}/${lastRun.model}. Run \`NODE_ENV=development squad new-plan --api\` to surface prefix-mismatch warnings.`,
      ].join('\n'),
    };
  }

  if (hitPct < 30 && stats.turns > 3) {
    return {
      id,
      name,
      status: 'warn',
      detail: `low cache hit rate: ${hitPct}% (last run, ${stats.turns} turns)`,
      fixHint: 'Expected ≥60% for Anthropic, ≥40% for OpenAI, ≥50% for Google after 3+ turns. Prefix may be unstable.',
    };
  }

  return {
    id,
    name,
    status: 'ok',
    detail: `caching active — last run ${hitPct}% hit (${formatTokenK(stats.cacheReadTokens)} read, ${lastRun.provider}/${lastRun.model})`,
  };
}

async function checkPlannerRuntimeInfo(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.config?.planner?.enabled) {
    return {
      id: 'planner-runtime-info',
      name: 'planner runtime (resolved)',
      status: 'skip',
      detail: 'planner disabled',
    };
  }
  const p = ctx.config.planner;
  const anth = p.provider === 'anthropic' ? (p.runtime?.anthropic ?? 'agent-sdk') : 'vercel (openai/google use Vercel AI SDK)';
  return {
    id: 'planner-runtime-info',
    name: 'planner runtime (resolved)',
    status: 'ok',
    detail: `${p.provider} → ${String(anth)}`,
  };
}

function anthropicPlanModelLooksPost47(modelId: string): boolean {
  return /opus[-_]4[-._]?7/i.test(modelId) || /claude-opus-4-7/i.test(modelId);
}

async function checkPlannerAnthropicRuntimeModelFit(_paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  const id = 'planner-anthropic-runtime-model-fit';
  const name = 'Anthropic Opus 4.7+ vs Vercel runtime';
  if (!ctx.config?.planner?.enabled || ctx.config.planner.provider !== 'anthropic') {
    return { id, name, status: 'skip', detail: 'not applicable' };
  }
  const p = ctx.config.planner;
  if ((p.runtime?.anthropic ?? 'agent-sdk') !== 'vercel') {
    return { id, name, status: 'ok', detail: 'using Agent SDK or default' };
  }
  const planModel = modelFor('anthropic', 'plan', p.modelOverride);
  if (!anthropicPlanModelLooksPost47(planModel)) {
    return { id, name, status: 'ok', detail: `${planModel} is fine on the Vercel runtime` };
  }
  return {
    id,
    name,
    status: 'warn',
    detail: `Plan model ${planModel} needs the Agent SDK request shape; config uses Vercel runtime.`,
    fixHint:
      'Remove planner.runtime.anthropic: vercel (default is agent-sdk), or set planner.modelOverride.anthropic to a pre-4.7 id (e.g. claude-sonnet-4-5-20250929).',
  };
}

async function checkPlannerAuthRuntimeFit(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  const id = 'planner-auth-runtime-fit';
  const name = 'planner auth vs. runtime';
  if (!plannerEnabled(ctx) || !ctx.config?.planner) {
    return { id, name, status: 'skip', detail: 'planner disabled' };
  }
  const planner = ctx.config.planner;
  const provider = planner.provider;
  const configuredMode = planner.auth?.anthropic ?? 'auto';

  if (provider !== 'anthropic') {
    if (configuredMode === 'subscription') {
      return {
        id,
        name,
        status: 'fail',
        detail: `planner.auth.anthropic: subscription with planner.provider: ${provider}`,
        fixHint: plannerAuthRuntimeMismatchMessage(provider),
      };
    }
    return { id, name, status: 'skip', detail: `api key only for ${provider}` };
  }

  const runtime = runtimeNameFor(provider, planner);
  const resolution = authFor(paths, ctx, provider);
  if (!resolution.ok) {
    return { id, name, status: 'skip', detail: 'auth unresolved' };
  }
  const mode = resolution.auth.mode;
  if (mode === 'subscription' && runtime !== 'agent-sdk') {
    return {
      id,
      name,
      status: 'fail',
      detail: `subscription auth with planner.runtime.anthropic: ${runtime}`,
      fixHint: plannerAuthRuntimeMismatchMessage(provider),
    };
  }
  return { id, name, status: 'ok', detail: `${mode} + ${runtime} runtime` };
}

async function checkAgentSdkBinaryPresent(paths: SquadPaths, ctx: DoctorContext): Promise<CheckResult> {
  const id = 'agent-sdk-binary-present';
  const name = 'Anthropic Agent SDK install';
  if (!ctx.config?.planner?.enabled || ctx.config.planner.provider !== 'anthropic') {
    return { id, name, status: 'skip', detail: 'not applicable' };
  }
  const resolution = authFor(paths, ctx, 'anthropic');
  const subscription = resolution.ok && resolution.auth.mode === 'subscription';
  // Subscription mode needs the binary whatever `runtime.anthropic` says — and `planner-auth-runtime-fit`
  // has already failed the vercel combination by the time this row is read.
  if ((ctx.config.planner.runtime?.anthropic ?? 'agent-sdk') === 'vercel' && !subscription) {
    return { id, name, status: 'skip', detail: 'vercel runtime selected' };
  }
  try {
    await import('@anthropic-ai/claude-agent-sdk');
  } catch (e) {
    return {
      id,
      name,
      status: 'warn',
      detail: (e as Error).message.slice(0, 160),
      fixHint: 'Run pnpm install / npm install in the squad-kit package so the Agent SDK (and its platform binary) is present.',
    };
  }
  const binary = resolveClaudeBinary();
  if (!binary) {
    // A login runs *through* the binary, so in subscription mode its absence is fatal; with an API
    // key the SDK can still work, so it is only a warning.
    return {
      id,
      name,
      status: subscription ? 'fail' : 'warn',
      detail: 'package resolves; no `claude` executable found',
      fixHint: MISSING_CLAUDE_BINARY_MESSAGE,
    };
  }
  return {
    id,
    name,
    status: 'ok',
    detail: `package + ${binary.source === 'bundled' ? 'bundled' : 'PATH'} binary`,
  };
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
  if (t.type === 'github' && (!t.workspace?.trim() || !t.project?.trim())) {
    return {
      id: 'tracker-config',
      name: 'tracker configuration',
      status: 'fail',
      detail: 'GitHub requires tracker.workspace (owner) and tracker.project (repo)',
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
  if (client.name === 'github') {
    const r = await probeGitHubConnectivity(secrets, ctx.config);
    if (r.ok) return { id: 'tracker-live', name: 'tracker connectivity', status: 'ok', detail: 'GitHub REST' };
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

export async function runAllChecks(paths: SquadPaths, ctx: DoctorContext, fix: boolean): Promise<CheckResult[]> {
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
  await add('planner auth mode', () => checkPlannerAuthMode(paths, ctx, fix));
  await add('planner credential resolves', () => checkPlannerCredential(paths, ctx));
  await add('planner model resolves at provider', () => checkPlannerModel(paths, ctx));
  await add('planner tier vs. model', () => checkPlannerTierAwareness(paths, ctx));
  await add('planner cache effectiveness', () => checkPlannerCache(paths, ctx));
  await add('planner runtime (resolved)', () => checkPlannerRuntimeInfo(paths, ctx));
  await add('planner auth vs. runtime', () => checkPlannerAuthRuntimeFit(paths, ctx));
  await add('Anthropic Opus 4.7+ vs Vercel runtime', () => checkPlannerAnthropicRuntimeModelFit(paths, ctx));
  await add('Anthropic Agent SDK install', () => checkAgentSdkBinaryPresent(paths, ctx));
  await add('tracker configuration', () => checkTrackerConfig(paths, ctx));
  await add('tracker credential resolves', () => checkTrackerCredential(paths, ctx));
  await add('tracker connectivity', () => checkTrackerConnectivity(paths, ctx));
  return checks;
}

export function summarise(checks: CheckResult[]): { ok: number; warn: number; fail: number; skip: number } {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };
}
