import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { describeAuth } from '../../core/planner-auth.js';
import { resolvePlannerAuthForCwd } from '../../core/planner-models.js';
import { skipExternalProbesInAutomation } from '../../core/ci-env.js';
import { probeClaudeAuth, type ProbeClaudeAuthResult } from '../../planner/runtimes/auth-probe.js';
import type { ProviderName } from '../../planner/types.js';
import { authReasonText, credentialPresent, runtimeNameFor } from './shared.js';

export interface AuthStatusOptions {
  json?: boolean;
  /** Skip the live probe. `squad auth status --json --offline` never spawns anything. */
  offline?: boolean;
}

/** Stable scripting shape. Never carries the token, the key, or anything else secret. */
export interface AuthStatusPayload {
  mode: 'subscription' | 'api-key';
  reason: string;
  credentialHint: string;
  runtime: string;
  loggedIn: boolean;
  account?: { email?: string; organization?: string; subscriptionType?: string };
  apiKeySource?: string;
}

export async function runAuthStatus(opts: AuthStatusOptions = {}): Promise<void> {
  const paths = buildPaths(requireSquadRoot());
  const config = loadConfig(paths.configFile);
  const planner = config.planner;
  const provider: ProviderName = planner?.provider ?? 'anthropic';

  const auth = resolvePlannerAuthForCwd(provider, planner);
  const described = describeAuth(auth);

  const probe = shouldProbe(opts, provider) ? await probeClaudeAuth(auth) : undefined;
  const payload = buildPayload({ auth: described, provider, planner, probe, fallbackLoggedIn: credentialPresent(auth) });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const kw = 15;
  ui.step('squad-kit auth');
  ui.blank();
  ui.kv('auth mode', `${payload.mode}  (${payload.reason})`, kw);
  ui.kv('credential', payload.credentialHint, kw);
  if (payload.account) {
    const account = [payload.account.email, payload.account.organization, payload.account.subscriptionType]
      .filter(Boolean)
      .join(' · ');
    if (account) ui.kv('account', account, kw);
  }
  if (payload.apiKeySource) ui.kv('api key source', payload.apiKeySource, kw);
  ui.kv('runtime', payload.runtime, kw);

  if (probe && !probe.ok) {
    ui.blank();
    ui.warning(`Live check failed (${probe.kind}).`);
    ui.info(probe.detail);
    if (probe.kind === 'not-logged-in' || probe.kind === 'expired') {
      ui.info('Run `squad auth login` to sign in again.');
    }
  } else if (!probe) {
    ui.blank();
    ui.info('Account details skipped (offline). Re-run without --offline to check the live login.');
  }
}

function shouldProbe(opts: AuthStatusOptions, provider: ProviderName): boolean {
  if (opts.offline) return false;
  if (skipExternalProbesInAutomation()) return false;
  // The probe drives the Agent SDK, which is Anthropic-only.
  return provider === 'anthropic';
}

export function buildPayload(input: {
  auth: ReturnType<typeof describeAuth>;
  provider: ProviderName;
  planner: ReturnType<typeof loadConfig>['planner'];
  probe: ProbeClaudeAuthResult | undefined;
  fallbackLoggedIn: boolean;
}): AuthStatusPayload {
  const { auth, provider, planner, probe } = input;
  const payload: AuthStatusPayload = {
    mode: auth.mode,
    reason: authReasonText(auth.reason, provider),
    credentialHint: auth.credentialHint,
    runtime: runtimeNameFor(provider, planner),
    // Without a probe the honest answer is "a credential resolved locally"; with one, the live
    // result wins. Either way the key is always present so scripts can rely on the shape.
    loggedIn: probe ? probe.ok : input.fallbackLoggedIn,
  };
  if (probe?.ok) {
    if (probe.account) payload.account = probe.account;
    if (probe.apiKeySource) payload.apiKeySource = probe.apiKeySource;
  }
  return payload;
}
