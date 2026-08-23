import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialSource } from './planner-models.js';
import type { SquadSecrets } from './secrets.js';
import type { ProviderName } from '../planner/types.js';

export type PlannerAuthMode = 'subscription' | 'api-key' | 'auto';

export const PLANNER_AUTH_MODES: readonly PlannerAuthMode[] = ['subscription', 'api-key', 'auto'];

/** Why the resolver landed where it did — surfaced by doctor, status, and the console. */
export type PlannerAuthReason =
  | 'explicit-config'
  | 'auto-login-detected'
  | 'auto-oauth-token'
  | 'auto-fallback-api-key'
  | 'provider-is-api-key-only';

export type ResolvedPlannerAuth =
  | {
      mode: 'subscription';
      reason: PlannerAuthReason;
      /** Present only when a setup-token credential was found; absent means "use the OS login store". */
      oauthToken?: string;
      oauthTokenSource?: 'env' | 'secrets';
      /** How the login was detected, for doctor/status copy. Never contains a secret. */
      loginHint: 'oauth-token-env' | 'oauth-token-secrets' | 'credential-store' | 'assumed';
    }
  | {
      mode: 'api-key';
      reason: PlannerAuthReason;
      key: string;
      source: 'env' | 'secrets' | 'fallback-env';
      detail: string;
    };

/**
 * Env var that carries each provider's API key. Duplicated from `providerEnvVar` in
 * `planner-models.ts` on purpose: that module imports this one at runtime for the
 * `resolvePlannerAuthFor*` wrappers, so importing it back would form a module cycle.
 */
const PROVIDER_ENV_VAR: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function buildUnavailableMessage(provider: ProviderName, configuredMode: PlannerAuthMode): string {
  if (provider === 'anthropic') {
    const lead =
      configuredMode === 'api-key'
        ? 'planner.auth.anthropic is `api-key`, but no Anthropic API key resolved.'
        : 'No Anthropic credential available.';
    return (
      `${lead} Either log in with your Claude subscription (\`squad auth login\`) ` +
      'or save an API key (`squad config set planner`, or export ANTHROPIC_API_KEY).'
    );
  }
  return (
    `No ${provider} API key available. ` +
    `Run \`squad config set planner\` to save one, or export ${PROVIDER_ENV_VAR[provider]}.`
  );
}

export class PlannerAuthUnavailableError extends Error {
  constructor(readonly provider: ProviderName, readonly configuredMode: PlannerAuthMode) {
    super(buildUnavailableMessage(provider, configuredMode));
    this.name = 'PlannerAuthUnavailableError';
  }
}

export interface LoginProbe {
  present: boolean;
  hint: 'oauth-token-env' | 'oauth-token-secrets' | 'credential-store' | 'none';
  detail: string; // e.g. "macOS Keychain", "~/.claude/.credentials.json", "CLAUDE_CODE_OAUTH_TOKEN"
  /**
   * The setup-token value, and only for the `oauth-token-*` hints where we already hold it.
   * A credential-store login is never read, so this stays undefined there. Keep it out of
   * anything that logs a probe — `hint` and `detail` are the safe-to-print fields.
   */
  token?: string;
}

/**
 * Confirmed on macOS 26.6 with `security find-generic-password -s "Claude Code-credentials"`
 * (exit 0). Existence only — never `-w` / `-g`, we do not read the credential.
 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const NOT_LOGGED_IN: LoginProbe = { present: false, hint: 'none', detail: 'no Claude login detected' };

/** `CLAUDE_CONFIG_DIR` may be relative; resolve it before touching the filesystem. */
function claudeConfigDir(): string | undefined {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) return path.resolve(process.cwd(), override.trim());
  try {
    return path.join(os.homedir(), '.claude');
  } catch {
    return undefined;
  }
}

function keychainItemExists(): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    // Missing item, missing `security` binary (containers), or a hung lookup — all mean "unknown".
    return false;
  }
}

/**
 * Probe for a usable Claude subscription login. Reads a token only where squad-kit itself
 * stored it (env or `.squad/secrets.yaml`); the OS credential store is checked for existence
 * and never read.
 */
export function detectClaudeLogin(secrets?: SquadSecrets): LoginProbe {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return {
      present: true,
      hint: 'oauth-token-env',
      detail: 'CLAUDE_CODE_OAUTH_TOKEN',
      token: envToken.trim(),
    };
  }

  const savedToken = secrets?.planner?.anthropicOauthToken;
  if (savedToken && savedToken.trim().length > 0) {
    return {
      present: true,
      hint: 'oauth-token-secrets',
      detail: '.squad/secrets.yaml',
      token: savedToken.trim(),
    };
  }

  if (process.platform === 'darwin') {
    return keychainItemExists()
      ? { present: true, hint: 'credential-store', detail: 'macOS Keychain' }
      : NOT_LOGGED_IN;
  }

  const configDir = claudeConfigDir();
  if (!configDir) return NOT_LOGGED_IN;
  const credentialsFile = path.join(configDir, '.credentials.json');
  try {
    if (fs.existsSync(credentialsFile)) {
      return { present: true, hint: 'credential-store', detail: credentialsFile };
    }
  } catch {
    return NOT_LOGGED_IN;
  }
  return NOT_LOGGED_IN;
}

function apiKeyAuth(apiKey: CredentialSource, reason: PlannerAuthReason): ResolvedPlannerAuth {
  return {
    mode: 'api-key',
    reason,
    key: apiKey.value,
    source: apiKey.source,
    detail: apiKey.detail,
  };
}

function subscriptionAuth(login: LoginProbe, reason: PlannerAuthReason): ResolvedPlannerAuth {
  if (login.hint === 'oauth-token-env' || login.hint === 'oauth-token-secrets') {
    return {
      mode: 'subscription',
      reason,
      oauthToken: login.token,
      oauthTokenSource: login.hint === 'oauth-token-env' ? 'env' : 'secrets',
      loginHint: login.hint,
    };
  }
  return {
    mode: 'subscription',
    reason,
    loginHint: login.hint === 'credential-store' ? 'credential-store' : 'assumed',
  };
}

/**
 * Single source of truth for *how* the planner authenticates. Pure and synchronous: the caller
 * supplies the already-resolved API key and login probe.
 */
export function resolvePlannerAuth(input: {
  provider: ProviderName;
  configuredMode?: PlannerAuthMode;
  apiKey?: CredentialSource; // from resolveProviderKey / readProviderKeyForPaths
  login: LoginProbe;
}): ResolvedPlannerAuth {
  const { provider, apiKey, login } = input;
  const configuredMode = input.configuredMode ?? 'auto';

  // OpenAI and Google are API-key only; `planner.auth` never applies to them.
  if (provider !== 'anthropic') {
    if (apiKey) return apiKeyAuth(apiKey, 'provider-is-api-key-only');
    throw new PlannerAuthUnavailableError(provider, configuredMode);
  }

  if (configuredMode === 'api-key') {
    if (apiKey) return apiKeyAuth(apiKey, 'explicit-config');
    throw new PlannerAuthUnavailableError(provider, configuredMode);
  }

  if (configuredMode === 'subscription') {
    // Deliberately never throws: the Agent SDK is the authority on whether the login works,
    // and a stale probe must not block a user who is genuinely logged in.
    return subscriptionAuth(login, 'explicit-config');
  }

  if (login.present) {
    return subscriptionAuth(login, login.hint === 'credential-store' ? 'auto-login-detected' : 'auto-oauth-token');
  }
  if (apiKey) return apiKeyAuth(apiKey, 'auto-fallback-api-key');
  throw new PlannerAuthUnavailableError(provider, configuredMode);
}

/** Safe-to-log projection. Used by run events, doctor --json, and the console API. */
export function describeAuth(auth: ResolvedPlannerAuth): {
  mode: 'subscription' | 'api-key';
  reason: PlannerAuthReason;
  credentialHint: string; // "Claude login (macOS Keychain)" | "ANTHROPIC_API_KEY" | ".squad/secrets.yaml"
} {
  if (auth.mode === 'api-key') {
    return { mode: 'api-key', reason: auth.reason, credentialHint: auth.detail };
  }
  return { mode: 'subscription', reason: auth.reason, credentialHint: loginCredentialHint(auth.loginHint) };
}

function loginCredentialHint(loginHint: 'oauth-token-env' | 'oauth-token-secrets' | 'credential-store' | 'assumed'): string {
  switch (loginHint) {
    case 'oauth-token-env':
      return 'Claude login (CLAUDE_CODE_OAUTH_TOKEN)';
    case 'oauth-token-secrets':
      return 'Claude login (.squad/secrets.yaml)';
    case 'credential-store':
      return process.platform === 'darwin'
        ? 'Claude login (macOS Keychain)'
        : 'Claude login (~/.claude/.credentials.json)';
    case 'assumed':
      return 'Claude login (assumed — not verified locally)';
  }
}
