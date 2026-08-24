import type { PlannerAuthReason, ResolvedPlannerAuth } from '../../core/planner-auth.js';
import type { PlannerConfig, ProviderName } from '../../planner/types.js';

/**
 * `claude setup-token` prints an OAuth token, not an API key. Both live under the `sk-ant-` family,
 * so the API-key rejection the plan asks for has to be narrower than "starts with `sk-ant-`" —
 * otherwise it would reject every legitimate value this command exists to accept.
 */
export const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/** Conservative, anchored on the known prefix. Used to tee the token out of the login output. */
export const OAUTH_TOKEN_PATTERN = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,}/;

const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 2048;

export class InvalidOauthTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOauthTokenError';
  }
}

/**
 * Shape-check a token before it is stored. Deliberately not a network check: a wrong-looking value
 * should fail here, and a right-looking one is verified by `probeClaudeAuth` afterwards.
 */
export function validateOauthToken(raw: string): string {
  const value = raw ?? '';
  if (value.trim().length === 0) {
    throw new InvalidOauthTokenError(
      'The token is empty. Run `squad auth login` without --token to sign in through the browser, ' +
        'or pass the value printed by `claude setup-token`.',
    );
  }
  if (/\s/.test(value.trim())) {
    throw new InvalidOauthTokenError(
      'That token contains whitespace. Paste only the single-line value printed by `claude setup-token` ' +
        '(quote it in your shell if needed).',
    );
  }
  const token = value.trim();
  if (token.startsWith('sk-ant-') && !token.startsWith(OAUTH_TOKEN_PREFIX)) {
    throw new InvalidOauthTokenError(
      'That looks like an Anthropic API key; use `squad config set planner` for keys. ' +
        '`squad auth login --token` takes the OAuth token printed by `claude setup-token`.',
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new InvalidOauthTokenError(
      `That token is only ${token.length} characters — too short to be a \`claude setup-token\` value. ` +
        'Re-run `claude setup-token` and paste the whole line.',
    );
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new InvalidOauthTokenError(
      'That token is implausibly long. Paste only the single line `claude setup-token` printed.',
    );
  }
  return token;
}

/** Pull the token out of buffered `claude setup-token` output. Returns undefined rather than guessing. */
export function extractOauthToken(output: string): string | undefined {
  const hit = OAUTH_TOKEN_PATTERN.exec(output);
  return hit ? hit[0] : undefined;
}

/** Human copy for `ResolvedPlannerAuth.reason`, shared by `squad auth status` and `squad status`. */
export function authReasonText(reason: PlannerAuthReason, provider: ProviderName): string {
  switch (reason) {
    case 'explicit-config':
      return 'explicit in .squad/config.yaml';
    case 'auto-login-detected':
      return 'auto — Claude login detected';
    case 'auto-oauth-token':
      return 'auto — stored OAuth token';
    case 'auto-fallback-api-key':
      return 'auto — no Claude login, fell back to an API key';
    case 'provider-is-api-key-only':
      return `${provider} is API-key only`;
  }
}

/** The runtime a run would use for this provider. Mirrors `resolveRuntime` without constructing one. */
export function runtimeNameFor(provider: ProviderName, planner: PlannerConfig | undefined): string {
  if (provider !== 'anthropic') return 'vercel';
  return planner?.runtime?.anthropic ?? 'agent-sdk';
}

/**
 * Offline "is a credential present?" answer. `resolvePlannerAuth` already did the detection work,
 * so this costs nothing extra — `assumed` is the one subscription shape with nothing behind it.
 */
export function credentialPresent(auth: ResolvedPlannerAuth): boolean {
  return auth.mode === 'api-key' || auth.loginHint !== 'assumed';
}

export const SUBSCRIPTION_ALTERNATIVE_HINT =
  'Prefer not to store a token? Run `claude` and use `/login` instead — squad-kit picks the OS credential ' +
  'store up automatically under `auth: subscription`.';
