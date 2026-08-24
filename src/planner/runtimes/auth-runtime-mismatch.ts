import type { ProviderName } from '../types.js';

/**
 * The single copy of the "subscription auth needs the Agent SDK" text.
 *
 * Two surfaces print it: `PlannerAuthRuntimeMismatchError` throws it when a run is dispatched, and
 * `squad doctor`'s `planner-auth-runtime-fit` check offers it as a fix hint *before* a run is
 * attempted. They must say the same thing, so neither owns the string — this module does.
 *
 * Kept in its own leaf module rather than in `runtimes/index.ts` so doctor can import the copy
 * without pulling `AgentSdkRuntime` / `VercelRuntime` (and their provider SDKs) into its graph.
 */
export const SUBSCRIPTION_NEEDS_AGENT_SDK_LEAD = 'Subscription auth needs the Claude Agent SDK runtime.';

/** Anthropic provider, but `planner.runtime.anthropic: vercel`. */
export const SUBSCRIPTION_VERCEL_RUNTIME_HINT =
  'Remove `planner.runtime.anthropic: vercel` from .squad/config.yaml (the default is agent-sdk), ' +
  'or set `planner.auth.anthropic: api-key` and provide an ANTHROPIC_API_KEY.';

/** Subscription auth asked for on a provider that only speaks API keys. */
export function subscriptionProviderMismatchHint(provider: ProviderName): string {
  return (
    `The planner provider is \`${provider}\`, which is API-key only. Switch to Anthropic with ` +
    '`squad config set planner`, or set `planner.auth.anthropic: api-key` and provide an ANTHROPIC_API_KEY.'
  );
}

export function plannerAuthRuntimeMismatchMessage(provider: ProviderName): string {
  return `${SUBSCRIPTION_NEEDS_AGENT_SDK_LEAD} ${
    provider === 'anthropic' ? SUBSCRIPTION_VERCEL_RUNTIME_HINT : subscriptionProviderMismatchHint(provider)
  }`;
}
