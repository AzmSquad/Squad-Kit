import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { detectClaudeLogin, resolvePlannerAuth } from '../../../src/core/planner-auth.js';
import { resolveRuntime } from '../../../src/planner/runtimes/index.js';
import { PlannerEventBus, type PlannerEvent } from '../../../src/planner/events.js';

/**
 * The money path: a machine with a real Claude login and a deliberately exported
 * `ANTHROPIC_API_KEY` must still authenticate as `oauth`. A leaked key would either bill API
 * credits (if valid) or fail the run outright (with the sentinel below), so this proves the
 * withholding in `buildSdkEnv` actually reaches the SDK subprocess.
 *
 * Skipped unless `SQUAD_INTEGRATION_TEST=1` and a Claude login is detectable locally.
 */
const LOGIN = process.env.SQUAD_INTEGRATION_TEST === '1' ? detectClaudeLogin() : { present: false as const };
const SHOULD_RUN = process.env.SQUAD_INTEGRATION_TEST === '1' && LOGIN.present;

const LIVE_MODEL = process.env.SQUAD_AGENT_SDK_LIVE_MODEL ?? 'claude-3-5-haiku-20241022';
const SENTINEL_KEY = 'sk-ant-squad-kit-sentinel-must-not-be-used';

describe.skipIf(!SHOULD_RUN)('Agent SDK runtime (live subscription auth)', () => {
  it(
    'reports apiKeySource=oauth even with ANTHROPIC_API_KEY exported',
    async () => {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = SENTINEL_KEY;
      try {
        const auth = resolvePlannerAuth({
          provider: 'anthropic',
          configuredMode: 'subscription',
          login: detectClaudeLogin(),
        });
        expect(auth.mode).toBe('subscription');

        const runtime = resolveRuntime({
          provider: 'anthropic',
          modelId: LIVE_MODEL,
          auth,
          anthropicRuntime: 'agent-sdk',
        });

        const bus = new PlannerEventBus();
        const events: PlannerEvent[] = [];
        bus.subscribe((e) => events.push(e));

        const result = await runtime.runScout({
          systemPrompt:
            'You are a file scout. Respond by calling `respond_with_scout_result` with files: ["README.md"].',
          userMessage: 'Pick README.md.',
          schema: z.object({ files: z.array(z.string()), reasoning: z.string().optional() }),
          bus,
          runId: 'live-subscription',
          maxOutputTokens: 512,
        });

        const authInfo = events.filter((e) => e.kind === 'auth_info');
        expect(authInfo.length).toBe(1);
        expect(authInfo[0]).toMatchObject({ mode: 'subscription', apiKeySource: 'oauth' });
        expect(result).not.toBeNull();
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
    },
    240_000,
  );
});
