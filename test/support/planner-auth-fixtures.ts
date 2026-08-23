import type { ResolvedPlannerAuth } from '../../src/core/planner-auth.js';

/** Api-key auth shaped exactly like `resolvePlannerAuth` returns it, for runtime/loop tests. */
export function apiKeyAuth(key = 'sk-test'): ResolvedPlannerAuth {
  return {
    mode: 'api-key',
    reason: 'explicit-config',
    key,
    source: 'env',
    detail: 'ANTHROPIC_API_KEY',
  };
}

/** Subscription auth. Pass `oauthToken` to model a stored `claude setup-token` credential. */
export function subscriptionAuth(opts: { oauthToken?: string; source?: 'env' | 'secrets' } = {}): ResolvedPlannerAuth {
  if (opts.oauthToken) {
    const source = opts.source ?? 'secrets';
    return {
      mode: 'subscription',
      reason: 'auto-oauth-token',
      oauthToken: opts.oauthToken,
      oauthTokenSource: source,
      loginHint: source === 'env' ? 'oauth-token-env' : 'oauth-token-secrets',
    };
  }
  return { mode: 'subscription', reason: 'auto-login-detected', loginHint: 'credential-store' };
}
