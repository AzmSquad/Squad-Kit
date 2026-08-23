import type { ResolvedPlannerAuth } from '../core/planner-auth.js';
import { rateLimitMessage } from './provider-errors.js';

/**
 * The subset of `SDKAssistantMessageError` that is auth-shaped — the signals where the fix is a
 * credential or a plan, not a retry. Declared locally so the mapping is testable without loading
 * `@anthropic-ai/claude-agent-sdk` (the runtime imports that module dynamically).
 */
export const AUTH_SHAPED_SDK_ERRORS = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
] as const;

export type AuthShapedSdkError = (typeof AUTH_SHAPED_SDK_ERRORS)[number];

export interface AuthErrorContext {
  mode: 'subscription' | 'api-key';
  /**
   * Set when a stored `claude setup-token` supplied the credential. A stale stored token wins the
   * precedence contest against a fresh login, so the fix is to clear it — hence the extra hint.
   */
  oauthTokenSource?: 'env' | 'secrets';
}

export function authErrorContextFrom(auth: ResolvedPlannerAuth): AuthErrorContext {
  if (auth.mode === 'api-key') return { mode: 'api-key' };
  return auth.oauthTokenSource
    ? { mode: 'subscription', oauthTokenSource: auth.oauthTokenSource }
    : { mode: 'subscription' };
}

/**
 * Recognise an auth-shaped SDK error signal. Accepts the `error` field of an assistant message
 * as well as the free-text entries of a `result` message's `errors` array.
 */
export function detectAuthShapedSdkError(raw: unknown): AuthShapedSdkError | undefined {
  if (typeof raw === 'string') {
    const direct = AUTH_SHAPED_SDK_ERRORS.find((s) => s === raw);
    if (direct) return direct;
    return AUTH_SHAPED_SDK_ERRORS.find((s) => raw.includes(s));
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const hit = detectAuthShapedSdkError(entry);
      if (hit) return hit;
    }
  }
  return undefined;
}

function authenticationFailedMessage(ctx: AuthErrorContext): string {
  if (ctx.mode === 'api-key') {
    return (
      'Anthropic rejected the planner API key. Save a valid key with `squad config set planner`, ' +
      'or fix the exported ANTHROPIC_API_KEY, then re-run.'
    );
  }
  if (ctx.oauthTokenSource === 'env') {
    return (
      'Claude login failed or expired. This run used the token in CLAUDE_CODE_OAUTH_TOKEN — unset it ' +
      '(or replace it with a fresh `claude setup-token` value), then run `squad auth login` to sign in again and re-run.'
    );
  }
  if (ctx.oauthTokenSource === 'secrets') {
    return (
      'Claude login failed or expired. This run used the token saved in `.squad/secrets.yaml` — run ' +
      '`squad auth logout` to clear it, then `squad auth login` to sign in again, then re-run.'
    );
  }
  return 'Claude login failed or expired. Run `squad auth login` to sign in again, then re-run.';
}

function billingErrorMessage(ctx: AuthErrorContext): string {
  if (ctx.mode === 'api-key') {
    return (
      'Anthropic refused the request for billing reasons. Check your credit balance at ' +
      'https://console.anthropic.com/settings/billing, then re-run.'
    );
  }
  return (
    'Your Claude plan cannot run this request. Check your plan at claude.ai/settings, ' +
    'or switch to an API key with `squad config set planner`.'
  );
}

function rateLimitCopy(ctx: AuthErrorContext, rawBody: string): string {
  if (ctx.mode === 'api-key') {
    return rateLimitMessage({ provider: 'anthropic', rawBody });
  }
  return (
    'Claude subscription usage limit reached. Planning draws on the same limits as Claude and Claude Code ' +
    '— wait for your usage window to reset, or switch to an API key for this run with `squad config set planner`.'
  );
}

/** User-facing copy for an auth-shaped SDK error. Never contains credential material. */
export function authErrorMessage(
  signal: AuthShapedSdkError,
  ctx: AuthErrorContext,
  /** Provider detail echoed in the api-key rate-limit runbook; ignored elsewhere. */
  rawBody = '',
): string {
  switch (signal) {
    case 'authentication_failed':
      return authenticationFailedMessage(ctx);
    case 'oauth_org_not_allowed':
      return (
        "Your Claude account's organization is not allowed to use this login. Ask your admin, " +
        'or switch to an API key with `squad config set planner`.'
      );
    case 'billing_error':
      return billingErrorMessage(ctx);
    case 'rate_limit':
      return rateLimitCopy(ctx, rawBody);
  }
}
