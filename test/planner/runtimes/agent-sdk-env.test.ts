import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSdkRuntime } from '../../../src/planner/runtimes/agent-sdk-runtime.js';
import { PlannerEventBus, type PlannerEvent } from '../../../src/planner/events.js';
import { Budget } from '../../../src/planner/budget.js';
import type { ResolvedPlannerAuth } from '../../../src/core/planner-auth.js';
import { apiKeyAuth, subscriptionAuth } from '../../support/planner-auth-fixtures.js';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => (queryMock as (...a: unknown[]) => void)(...args),
  createSdkMcpServer: (opts: unknown) => opts,
  tool: (_n: string, _d: string, _f: unknown, exec: unknown) => ({ exec }),
}));

const budgetCfg = { maxFileReads: 25, maxContextBytes: 500_000, maxDurationSeconds: 120 };

function yields(...messages: unknown[]) {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

async function draftWith(auth: ResolvedPlannerAuth, bus = new PlannerEventBus()) {
  const rt = new AgentSdkRuntime('m', auth);
  await rt.runDraft({
    systemPrompt: 's',
    userMessage: 'u',
    tools: [],
    bus,
    runId: 'r1',
    budget: new Budget(budgetCfg),
    maxSteps: 2,
    maxOutputTokens: 256,
  });
  const call = queryMock.mock.calls.at(-1) as [{ options: Record<string, unknown> }];
  return call[0].options.env as NodeJS.ProcessEnv;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(
    yields({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }),
  );
});

describe('AgentSdkRuntime.buildSdkEnv', () => {
  it('withholds an inherited API key and auth token in subscription mode', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-inherited';
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-inherited';

    const env = await draftWith(subscriptionAuth());

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('sk-inherited');
    expect(JSON.stringify(env)).not.toContain('bearer-inherited');
  });

  it('drops mixed-case Windows-style variants of the withheld keys', async () => {
    process.env.Anthropic_Api_Key = 'sk-windows';
    process.env.anthropic_auth_token = 'bearer-windows';
    try {
      const env = await draftWith(subscriptionAuth());
      expect(JSON.stringify(env)).not.toContain('sk-windows');
      expect(JSON.stringify(env)).not.toContain('bearer-windows');
    } finally {
      delete process.env.Anthropic_Api_Key;
      delete process.env.anthropic_auth_token;
    }
  });

  it('leaves SQUAD_PLANNER_API_KEY alone — the Agent SDK never reads it', async () => {
    process.env.SQUAD_PLANNER_API_KEY = 'squad-own-var';
    const env = await draftWith(subscriptionAuth());
    expect(env.SQUAD_PLANNER_API_KEY).toBe('squad-own-var');
  });

  it('sets the key in api-key mode', async () => {
    const env = await draftWith(apiKeyAuth('sk-explicit'));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit');
  });

  it('injects CLAUDE_CODE_OAUTH_TOKEN when the subscription carries a stored token', async () => {
    const env = await draftWith(subscriptionAuth({ oauthToken: 'oauth-abc', source: 'secrets' }));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-abc');
  });

  it('omits CLAUDE_CODE_OAUTH_TOKEN entirely when there is no stored token', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const env = await draftWith(subscriptionAuth());
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
  });

  it('applies the same env to the scout stage', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-inherited';
    const rt = new AgentSdkRuntime('m', subscriptionAuth());
    const { z } = await import('zod');
    await rt.runScout({
      systemPrompt: 's',
      userMessage: 'u',
      schema: z.object({ files: z.array(z.string()) }),
      bus: new PlannerEventBus(),
      runId: 'r1',
      maxOutputTokens: 256,
    });
    const call = queryMock.mock.calls.at(-1) as [{ options: Record<string, unknown> }];
    expect((call[0].options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('AgentSdkRuntime auth_info telemetry', () => {
  function collect(bus: PlannerEventBus): PlannerEvent[] {
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    return events;
  }

  it('emits exactly one auth_info carrying apiKeySource from the SDK init message', async () => {
    queryMock.mockImplementation(
      yields(
        { type: 'system', subtype: 'init', apiKeySource: 'oauth' },
        { type: 'system', subtype: 'init', apiKeySource: 'oauth' },
        { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    );
    const bus = new PlannerEventBus();
    const events = collect(bus);
    await draftWith(subscriptionAuth(), bus);

    const authInfo = events.filter((e) => e.kind === 'auth_info');
    expect(authInfo).toHaveLength(1);
    expect(authInfo[0]).toMatchObject({
      kind: 'auth_info',
      runId: 'r1',
      mode: 'subscription',
      apiKeySource: 'oauth',
    });
  });

  it('emits auth_info only once per run across the scout and draft runtimes', async () => {
    queryMock.mockImplementation(
      yields(
        { type: 'system', subtype: 'init', apiKeySource: 'oauth' },
        { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    );
    const bus = new PlannerEventBus();
    const events = collect(bus);
    const auth = subscriptionAuth();
    const { z } = await import('zod');
    await new AgentSdkRuntime('scout-model', auth).runScout({
      systemPrompt: 's',
      userMessage: 'u',
      schema: z.object({ files: z.array(z.string()) }),
      bus,
      runId: 'shared-run',
      maxOutputTokens: 256,
    });
    await new AgentSdkRuntime('draft-model', auth).runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus,
      runId: 'shared-run',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
    });

    expect(events.filter((e) => e.kind === 'auth_info')).toHaveLength(1);
  });

  it('emits no auth_info when the run ends before the SDK init message', async () => {
    queryMock.mockImplementation(
      yields({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const bus = new PlannerEventBus();
    const events = collect(bus);
    await draftWith(subscriptionAuth(), bus);
    expect(events.filter((e) => e.kind === 'auth_info')).toHaveLength(0);
  });
});
