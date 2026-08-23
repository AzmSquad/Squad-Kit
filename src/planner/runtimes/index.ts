import type { ResolvedPlannerAuth } from '../../core/planner-auth.js';
import type { ProviderName } from '../types.js';
import type { PlannerRuntime } from './types.js';
import { VercelRuntime } from './vercel-runtime.js';
import { AgentSdkRuntime } from './agent-sdk-runtime.js';

export * from './types.js';
export { VercelRuntime } from './vercel-runtime.js';
export { AgentSdkRuntime } from './agent-sdk-runtime.js';
export { extractAnthropicProviderSpecific, sdkEffortFromPlanner, thinkingConfigFromProviderSpecific } from './anthropic-options.js';

/**
 * Subscription auth is an OAuth credential, not an API key: `@ai-sdk/anthropic` sends it as
 * `x-api-key` and `api.anthropic.com` rejects it. Fail before any network call, with the fix.
 */
export class PlannerAuthRuntimeMismatchError extends Error {
  constructor(readonly provider: ProviderName, readonly runtimeChoice: 'agent-sdk' | 'vercel') {
    super(
      'Subscription auth needs the Claude Agent SDK runtime. ' +
        (provider === 'anthropic'
          ? 'Remove `planner.runtime.anthropic: vercel` from .squad/config.yaml (the default is agent-sdk), ' +
            'or set `planner.auth.anthropic: api-key` and provide an ANTHROPIC_API_KEY.'
          : `The planner provider is \`${provider}\`, which is API-key only. Switch to Anthropic with ` +
            '`squad config set planner`, or set `planner.auth.anthropic: api-key` and provide an ANTHROPIC_API_KEY.'),
    );
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
