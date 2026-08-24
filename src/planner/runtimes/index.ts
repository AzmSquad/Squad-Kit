import type { ResolvedPlannerAuth } from '../../core/planner-auth.js';
import type { ProviderName } from '../types.js';
import type { PlannerRuntime } from './types.js';
import { VercelRuntime } from './vercel-runtime.js';
import { AgentSdkRuntime } from './agent-sdk-runtime.js';
import { plannerAuthRuntimeMismatchMessage } from './auth-runtime-mismatch.js';

export * from './types.js';
export {
  plannerAuthRuntimeMismatchMessage,
  SUBSCRIPTION_NEEDS_AGENT_SDK_LEAD,
  SUBSCRIPTION_VERCEL_RUNTIME_HINT,
  subscriptionProviderMismatchHint,
} from './auth-runtime-mismatch.js';
export { VercelRuntime } from './vercel-runtime.js';
export { AgentSdkRuntime } from './agent-sdk-runtime.js';
export { extractAnthropicProviderSpecific, sdkEffortFromPlanner, thinkingConfigFromProviderSpecific } from './anthropic-options.js';

/**
 * Subscription auth is an OAuth credential, not an API key: `@ai-sdk/anthropic` sends it as
 * `x-api-key` and `api.anthropic.com` rejects it. Fail before any network call, with the fix.
 */
export class PlannerAuthRuntimeMismatchError extends Error {
  constructor(readonly provider: ProviderName, readonly runtimeChoice: 'agent-sdk' | 'vercel') {
    // Shared with `squad doctor`'s planner-auth-runtime-fit check — see auth-runtime-mismatch.ts.
    super(plannerAuthRuntimeMismatchMessage(provider));
    this.name = 'PlannerAuthRuntimeMismatchError';
  }
}

export interface ResolveRuntimeInput {
  provider: ProviderName;
  modelId: string;
  auth: ResolvedPlannerAuth;
  anthropicRuntime?: 'agent-sdk' | 'vercel';
}

export function resolveRuntime(input: ResolveRuntimeInput): PlannerRuntime {
  const choice: 'agent-sdk' | 'vercel' =
    input.provider === 'anthropic' ? input.anthropicRuntime ?? 'agent-sdk' : 'vercel';
  const auth = input.auth;

  if (auth.mode === 'subscription') {
    if (input.provider !== 'anthropic' || choice !== 'agent-sdk') {
      throw new PlannerAuthRuntimeMismatchError(input.provider, choice);
    }
    return new AgentSdkRuntime(input.modelId, auth);
  }

  if (input.provider === 'anthropic' && choice === 'agent-sdk') {
    return new AgentSdkRuntime(input.modelId, auth);
  }
  return new VercelRuntime(input.provider, input.modelId, auth.key);
}
