import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { AgentSdkRuntime } from '../src/planner/runtimes/agent-sdk-runtime.js';
import { PlannerEventBus, type PlannerEvent } from '../src/planner/events.js';
import { Budget } from '../src/planner/budget.js';
import type { PlannerToolDefinition } from '../src/planner/runtimes/planner-tool-def.js';
import { ScoutOutputSchema } from '../src/planner/stages/scout-schema.js';
import { apiKeyAuth, subscriptionAuth } from './support/planner-auth-fixtures.js';

const queryMock = vi.hoisted(() => vi.fn());
const createSdkMcpServerMock = vi.hoisted(() =>
  vi.fn((opts: { name: string; version: string; tools: unknown[] }) => opts),
);
const toolMock = vi.hoisted(() =>
  vi.fn(
    (
      _name: string,
      _desc: string,
      _fields: unknown,
      exec: (args: unknown) => Promise<unknown>,
    ) => ({ exec }),
  ),
);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => (queryMock as (...a: unknown[]) => void)(...args),
  createSdkMcpServer: (...args: unknown[]) => (createSdkMcpServerMock as (...a: unknown[]) => void)(...args),
  tool: (...args: unknown[]) => (toolMock as (...a: unknown[]) => void)(...args),
}));

function textDeltaEvent(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

const budgetCfg = {
  maxFileReads: 25,
  maxContextBytes: 500_000,
  maxDurationSeconds: 120,
};

function lastDraftQueryOptions() {
  const call = queryMock.mock.calls.find(
    (c) => (c[0] as { options?: { mcpServers?: Record<string, unknown> } }).options?.mcpServers?.['squad-kit-planner'],
  );
  expect(call).toBeDefined();
  return (call![0] as { options: Record<string, unknown> }).options;
}

function lastScoutQueryOptions() {
  const call = queryMock.mock.calls.find(
    (c) => (c[0] as { options?: { mcpServers?: Record<string, unknown> } }).options?.mcpServers?.['squad-kit-scout'],
  );
  expect(call).toBeDefined();
  return (call![0] as { options: Record<string, unknown> }).options;
}

type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/**
 * Regression cover for https://github.com/AzmSquad/Squad-Kit/issues/8. On a claude.ai login the SDK
 * pulls the user's connectors in as extra MCP servers, and every tool call is gated on a permission
 * decision. Without both guards the planner's own tools were emitted but never executed: runs showed
 * `reads 0/N`, the scout exhausted its turns before reaching `respond_with_scout_result`, and the
 * session stalled. Verified against a real subscription run — 0 reads before, 8/8 after.
 */
async function runBothStages(): Promise<void> {
  const bus = new PlannerEventBus();
  const rt = new AgentSdkRuntime('claude-opus-4-7', apiKeyAuth('sk-secret'));
  const common = {
    systemPrompt: 'sys',
    userMessage: 'hi',
    bus,
    runId: 'r-issue-8',
    budget: new Budget(budgetCfg),
    maxOutputTokens: 4096,
    providerSpecific: { thinking: 'adaptive' as const, effort: 'medium' as const },
  };
  await rt.runDraft({
    ...common,
    maxSteps: 4,
    tools: [
      { name: 'read_file', description: 'x', parameters: z.object({ path: z.string() }), execute: async () => 'noop' },
    ],
  });
  await rt.runScout({ ...common, schema: z.object({ files: z.array(z.string()) }) } as never);
}

describe('AgentSdkRuntime — tool reachability (issue #8)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', result: 'ok', usage: {} };
      })(),
    );
  });

  it('keeps claude.ai connectors out of both stages', async () => {
    await runBothStages();
    expect(lastDraftQueryOptions().strictMcpConfig).toBe(true);
    expect(lastScoutQueryOptions().strictMcpConfig).toBe(true);
  });

  it('grants the planner its own MCP tools, on both stages', async () => {
    await runBothStages();
    for (const options of [lastDraftQueryOptions(), lastScoutQueryOptions()]) {
      const canUseTool = options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<PermissionDecision>;
      expect(canUseTool).toBeTypeOf('function');
      await expect(canUseTool('mcp__squad-kit-planner__read_file', { path: 'a.ts' })).resolves.toMatchObject({
        behavior: 'allow',
      });
      await expect(canUseTool('mcp__squad-kit-scout__respond_with_scout_result', {})).resolves.toMatchObject({
        behavior: 'allow',
      });
    }
  });

  it('denies anything that is not a squad-kit tool', async () => {
    await runBothStages();
    const canUseTool = lastDraftQueryOptions().canUseTool as (
      n: string,
      i: Record<string, unknown>,
    ) => Promise<PermissionDecision>;
    for (const foreign of ['Bash', 'Read', 'mcp__claude-ai-google-drive__search']) {
      const decision = await canUseTool(foreign, {});
      expect(decision.behavior).toBe('deny');
    }
  });
});

describe('AgentSdkRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runDraft aggregates streamed text deltas and final usage', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield textDeltaEvent('## ');
        yield textDeltaEvent('Done');
        yield { type: 'assistant' };
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      })(),
    );

    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const rt = new AgentSdkRuntime('claude-opus-4-7', apiKeyAuth('sk-secret'));
    const toolExec = vi.fn(async () => 'noop');
    const tools: PlannerToolDefinition[] = [
      {
        name: 'read_file',
        description: 'x',
        parameters: z.object({ path: z.string() }),
        execute: toolExec,
      },
    ];

    const out = await rt.runDraft({
      systemPrompt: 'sys',
      userMessage: 'hi',
      tools,
      bus,
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 8,
      maxOutputTokens: 4096,
      providerSpecific: { thinking: 'adaptive', effort: 'medium' },
    });

    expect(out.text).toBe('## Done');
    expect(out.finishedNormally).toBe(true);
    expect(out.finalUsage.inputTokens).toBe(100);
    expect(out.finalUsage.outputTokens).toBe(20);
    expect(events.filter((e) => e.kind === 'assistant_text').length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'usage')).toBe(true);
    expect(toolExec).not.toHaveBeenCalled();
  });

  it('runDraft emits usage from message_start before final result', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: { usage: { input_tokens: 50, output_tokens: 0 } },
          },
        };
        yield textDeltaEvent('## ');
        yield { type: 'assistant' };
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      })(),
    );

    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const rt = new AgentSdkRuntime('claude-opus-4-7', apiKeyAuth('sk-secret'));
    await rt.runDraft({
      systemPrompt: 'sys',
      userMessage: 'hi',
      tools: [],
      bus,
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 8,
      maxOutputTokens: 4096,
      providerSpecific: { thinking: 'adaptive', effort: 'medium' },
    });

    const partial = events.find(
      (e): e is Extract<PlannerEvent, { kind: 'usage' }> =>
        e.kind === 'usage' && e.usage.inputTokens === 50 && e.turn === 1,
    );
    expect(partial).toBeDefined();
  });

  it('runDraft emits thinking telemetry for thinking_block_delta', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: '`plan`' },
          },
        };
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
        yield { type: 'assistant' };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
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

    expect(events.some((e) => e.kind === 'thinking_delta')).toBe(true);
    expect(events.some((e) => e.kind === 'thinking_block_started')).toBe(true);
    expect(events.some((e) => e.kind === 'thinking_block_stopped')).toBe(true);
  });

  it('runDraft invokes PlannerToolDefinition.execute when SDK tool hook runs', async () => {
    const toolExec = vi.fn(async () => ({ content: 'file-body', isError: false }));

    queryMock.mockImplementation(() => {
      const plannerEntry = [...createSdkMcpServerMock.mock.calls].find((c) => c[0].name === 'squad-kit-planner');
      const toolsWrapped = plannerEntry?.[0].tools as Array<{ exec: (a: unknown) => Promise<unknown> }>;
      return (async function* () {
        if (toolsWrapped?.[0]) {
          await toolsWrapped[0].exec({ path: 'notes.txt' });
        }
        yield { type: 'assistant' };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 3 } };
      })();
    });

    const rt = new AgentSdkRuntime('claude-opus-4-7', apiKeyAuth('sk-secret'));
    const tools: PlannerToolDefinition[] = [
      {
        name: 'read_file',
        description: 'read',
        parameters: z.object({ path: z.string() }),
        execute: toolExec,
      },
    ];

    await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools,
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 8,
      maxOutputTokens: 4096,
      providerSpecific: { thinking: 'adaptive', effort: 'medium' },
    });

    expect(toolExec).toHaveBeenCalledWith({ path: 'notes.txt' });
  });

  it('runDraft surfaces cancellation via AbortError from iterator', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield textDeltaEvent('partial');
        throw new DOMException('Aborted', 'AbortError');
      })(),
    );

    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const rt = new AgentSdkRuntime('claude-opus-4-7', apiKeyAuth('sk-secret'));
    const out = await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus,
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 8,
      maxOutputTokens: 4096,
    });

    expect(out.text.startsWith('partial')).toBe(true);
    expect(out.finishedNormally).toBe(false);
    expect(out.userCancelled).toBe(true);
    expect(events.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('passes adaptive thinking through query options', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
      providerSpecific: { thinking: 'adaptive', effort: 'high' },
    });

    const opts = lastDraftQueryOptions();
    expect(opts.thinking).toEqual({ type: 'adaptive' });
    expect(opts.effort).toBe('high');
  });

  it('maps thinking off to disabled SDK thinking', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
      providerSpecific: { thinking: 'off', effort: 'medium' },
    });

    const opts = lastDraftQueryOptions();
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('injects API key via query env without requiring a global env mutation', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('sk-injected'));
    await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
    });

    const opts = lastDraftQueryOptions();
    expect((opts.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBe('sk-injected');
  });

  it('suppresses built-in tools and locks down MCP session options', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
    });

    const opts = lastDraftQueryOptions();
    expect(opts.tools).toEqual([]);
    expect(opts.disallowedTools).toContain('Read');
    expect(opts.persistSession).toBe(false);
    expect(opts.settingSources).toEqual([]);
  });

  it('sets max_iterations incompleteKind on error_max_turns result', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 2, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    const out = await rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus: new PlannerEventBus(),
      runId: 'r1',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
    });
    expect(out.incompleteKind).toBe('max_iterations');
    expect(out.finishedNormally).toBe(false);
  });

  it('runScout emits assistant_text before scout result is captured', async () => {
    queryMock.mockImplementation(() => {
      const scoutEntry = [...createSdkMcpServerMock.mock.calls].find((c) => c[0].name === 'squad-kit-scout');
      const scoutTools = scoutEntry?.[0].tools as Array<{ exec: (a: unknown) => Promise<unknown> }>;
      return (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Scout reasoning… ' } },
        };
        if (scoutTools?.[0]) {
          await scoutTools[0].exec({
            selectedFiles: ['./a.md'],
            reasoning: 'need a',
            suggestedReadStrategy: 'read_full',
          });
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 30, output_tokens: 10 } };
      })();
    });

    const bus = new PlannerEventBus();
    const texts: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === 'assistant_text' && e.delta) texts.push(e.delta);
    });

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    const out = await rt.runScout({
      systemPrompt: 'sys',
      userMessage: 'pick files',
      schema: ScoutOutputSchema,
      bus,
      runId: 'r-scout',
      maxOutputTokens: 1024,
      providerSpecific: { effort: 'minimal' },
    });

    expect(out).not.toBeNull();
    expect(texts.some((t) => t.includes('Scout reasoning'))).toBe(true);
  });

  it('runScout returns parsed output when respond tool runs with valid args', async () => {
    queryMock.mockImplementation(() => {
      const scoutEntry = [...createSdkMcpServerMock.mock.calls].find((c) => c[0].name === 'squad-kit-scout');
      const scoutTools = scoutEntry?.[0].tools as Array<{ exec: (a: unknown) => Promise<unknown> }>;
      return (async function* () {
        if (scoutTools?.[0]) {
          await scoutTools[0].exec({
            selectedFiles: ['./a.md'],
            reasoning: 'need a',
            suggestedReadStrategy: 'read_full',
          });
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 30, output_tokens: 10 } };
      })();
    });

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    const out = await rt.runScout({
      systemPrompt: 'sys',
      userMessage: 'pick files',
      schema: ScoutOutputSchema,
      bus: new PlannerEventBus(),
      runId: 'r-scout',
      maxOutputTokens: 1024,
      providerSpecific: { effort: 'minimal' },
    });

    expect(out).not.toBeNull();
    expect(out!.output.selectedFiles).toEqual(['./a.md']);
    expect(out!.usage.inputTokens).toBe(30);
    expect(out!.usage.outputTokens).toBe(10);
  });

  it('runScout returns null when tool args fail schema validation', async () => {
    queryMock.mockImplementation(() => {
      const scoutEntry = [...createSdkMcpServerMock.mock.calls].find((c) => c[0].name === 'squad-kit-scout');
      const scoutTools = scoutEntry?.[0].tools as Array<{ exec: (a: unknown) => Promise<unknown> }>;
      return (async function* () {
        if (scoutTools?.[0]) {
          await scoutTools[0].exec({
            selectedFiles: [],
            reasoning: 'x',
            suggestedReadStrategy: 'read_full',
          });
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    });

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    const out = await rt.runScout({
      systemPrompt: 'sys',
      userMessage: 'pick files',
      schema: ScoutOutputSchema,
      bus: new PlannerEventBus(),
      runId: 'r-scout',
      maxOutputTokens: 1024,
    });
    expect(out).toBeNull();
  });

  it('runScout returns null when the response tool is never called', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    const out = await rt.runScout({
      systemPrompt: 'sys',
      userMessage: 'pick files',
      schema: ScoutOutputSchema,
      bus: new PlannerEventBus(),
      runId: 'r-scout',
      maxOutputTokens: 1024,
    });
    expect(out).toBeNull();
  });

  it('runScout query options also disable persistence and empty tool list on scout server', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    );

    const rt = new AgentSdkRuntime('m', apiKeyAuth('k'));
    await rt.runScout({
      systemPrompt: 'sys',
      userMessage: 'u',
      schema: ScoutOutputSchema,
      bus: new PlannerEventBus(),
      runId: 'rid',
      maxOutputTokens: 256,
    });

    const opts = lastScoutQueryOptions();
    expect(opts.tools).toEqual([]);
    expect(opts.persistSession).toBe(false);
    expect(opts.settingSources).toEqual([]);
    expect(opts.includePartialMessages).toBe(true);
  });
});

describe('AgentSdkRuntime auth-shaped SDK errors', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  function draft(rt: AgentSdkRuntime, bus: PlannerEventBus) {
    return rt.runDraft({
      systemPrompt: 's',
      userMessage: 'u',
      tools: [],
      bus,
      runId: 'r-err',
      budget: new Budget(budgetCfg),
      maxSteps: 2,
      maxOutputTokens: 256,
    });
  }

  function errorRun(...messages: unknown[]) {
    queryMock.mockImplementation(() =>
      (async function* () {
        for (const m of messages) yield m;
      })(),
    );
  }

  it('maps authentication_failed to the subscription recovery message', async () => {
    errorRun(
      { type: 'assistant', error: 'authentication_failed' },
      { type: 'result', subtype: 'error_during_execution', usage: {} },
    );
    await expect(draft(new AgentSdkRuntime('m', subscriptionAuth()), new PlannerEventBus())).rejects.toThrow(
      /Claude login failed or expired.*squad auth login/s,
    );
  });

  it('maps authentication_failed to the key message in api-key mode', async () => {
    errorRun(
      { type: 'assistant', error: 'authentication_failed' },
      { type: 'result', subtype: 'error_during_execution', usage: {} },
    );
    await expect(draft(new AgentSdkRuntime('m', apiKeyAuth('k')), new PlannerEventBus())).rejects.toThrow(
      /rejected the planner API key/,
    );
  });

  it('routes a terminal rate limit through the existing rate_limit event channel', async () => {
    errorRun(
      { type: 'assistant', error: 'rate_limit' },
      { type: 'result', subtype: 'error_during_execution', usage: {} },
    );
    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    await expect(draft(new AgentSdkRuntime('m', subscriptionAuth()), bus)).rejects.toThrow(
      /usage limit reached/,
    );
    const rl = events.filter((e) => e.kind === 'rate_limit');
    expect(rl).toHaveLength(1);
    expect(rl[0]).toMatchObject({ phase: 'aborted', provider: 'anthropic' });
  });

  it('forwards an SDK api_retry rate limit as phase: retrying', async () => {
    errorRun(
      { type: 'system', subtype: 'api_retry', error: 'rate_limit', retry_delay_ms: 4200 },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    );
    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    await draft(new AgentSdkRuntime('m', subscriptionAuth()), bus);
    const rl = events.filter((e) => e.kind === 'rate_limit');
    expect(rl).toHaveLength(1);
    expect(rl[0]).toMatchObject({ phase: 'retrying', waitSec: 5, capSec: 90 });
  });

  it('leaves non-auth error subtypes on the existing incomplete path', async () => {
    errorRun({ type: 'result', subtype: 'error_max_turns', usage: {} });
    const out = await draft(new AgentSdkRuntime('m', apiKeyAuth('k')), new PlannerEventBus());
    expect(out.finishedNormally).toBe(false);
    expect(out.incompleteKind).toBe('max_iterations');
  });
});
