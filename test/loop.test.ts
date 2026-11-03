import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { runPlanner, buildScoutedContextSection } from '../src/planner/loop.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';
import { PlannerEventBus, type PlannerEvent } from '../src/planner/events.js';
import * as scoutStages from '../src/planner/stages/scout.js';
import { Budget } from '../src/planner/budget.js';
import { READ_FILE_TOOL_NAME } from '../src/planner/tools/index.js';
import { textParts } from './support/model-stream.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const budgetCfg = {
  maxFileReads: 25,
  maxContextBytes: 500_000,
  maxDurationSeconds: 120,
};

function vercelTestRuntime(model: LanguageModelV2, modelId = 'm') {
  return new VercelRuntime('anthropic', modelId, model, true);
}

function tok(p: number, o: number) {
  return { inputTokens: p, outputTokens: o, totalTokens: p + o };
}

function streamOk(chunks: LanguageModelV2StreamPart[]) {
  return {
    stream: simulateReadableStream({ chunks }),
  };
}

function queueStreamModel(rounds: LanguageModelV2StreamPart[][]) {
  let i = 0;
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => {
      const chunks = rounds[i++];
      if (!chunks) throw new Error('mock stream queue exhausted');
      return streamOk(chunks);
    },
  });
}

describe('runPlanner', () => {
  it('emits runtime_info right after started', async () => {
    const model = queueStreamModel([
      [
        ...textParts('# plan\n'),
        { type: 'finish', finishReason: 'stop', usage: tok(1, 1) },
      ],
    ]);
    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget: new Budget(budgetCfg),
      events: bus,
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.kind).toBe('started');
    expect(events[1]?.kind).toBe('runtime_info');
  });

  it('returns planText and finishedNormally when assistant ends with end_turn and no tool calls', async () => {
    const model = queueStreamModel([
      [
        ...textParts('# My plan\n'),
        { type: 'finish', finishReason: 'stop', usage: tok(1, 2) },
      ],
    ]);
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.planText).toBe('# My plan\n');
    expect(result.finishedNormally).toBe(true);
    expect(result.budgetExhausted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('passes cacheReadTokens through onUsage unmodified', async () => {
    const onUsage = vi.fn();
    // Anthropic reports cache reads on the usage and cache writes in provider metadata.
    const meta = {
      anthropic: { cacheCreationInputTokens: 0 },
    };
    const model = queueStreamModel([
      [
        ...textParts('# My plan\n'),
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { ...tok(1, 2), cachedInputTokens: 100 },
          providerMetadata: meta,
        },
      ],
    ]);
    await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget: new Budget(budgetCfg),
      onUsage,
    });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 100, cacheCreationTokens: 0 }),
    );
  });

  it('handles read_file tool call then end_turn on next turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-'));
    try {
      fs.writeFileSync(path.join(root, 'hello.txt'), 'world', 'utf8');
      const model = queueStreamModel([
        [
          ...textParts('Reading…'),
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: READ_FILE_TOOL_NAME,
            input: JSON.stringify({ path: 'hello.txt' }),
          },
          { type: 'finish', finishReason: 'tool-calls', usage: tok(1, 1) },
        ],
        [
          ...textParts('# Done\n'),
          { type: 'finish', finishReason: 'stop', usage: tok(2, 2) },
        ],
      ]);
      const budget = new Budget(budgetCfg);
      const result = await runPlanner({
        root,
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget,
      });
      expect(result.planText).toContain('Reading…');
      expect(result.planText).toContain('# Done');
      expect(result.finishedNormally).toBe(true);
      expect(budget.snapshot().reads).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns finishedNormally false on max_tokens with no tool calls', async () => {
    const model = queueStreamModel([
      [
        ...textParts('partial only'),
        { type: 'finish', finishReason: 'length', usage: tok(1, 8) },
      ],
    ]);
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.planText).toBe('partial only');
    expect(result.finishedNormally).toBe(false);
    expect(result.incompleteKind).toBe('max_output_tokens');
  });

  it('continues after max_tokens when decideOnLimit returns continue', async () => {
    const model = queueStreamModel([
      [
        ...textParts('part-a'),
        { type: 'finish', finishReason: 'length', usage: tok(1, 1) },
      ],
      [
        ...textParts('part-b'),
        { type: 'finish', finishReason: 'stop', usage: tok(1, 1) },
      ],
    ]);
    const budget = new Budget(budgetCfg);
    const decideOnLimit = vi.fn().mockResolvedValue('continue' as const);
    const result = await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
      maxOutputTokens: 100,
      maxIterations: 5,
      decideOnLimit,
    });
    expect(result.planText).toBe('part-apart-b');
    expect(result.finishedNormally).toBe(true);
    expect(decideOnLimit).toHaveBeenCalledTimes(1);
  });

  it('throws on stopReason error with rawError and generic retry hint', async () => {
    const model = queueStreamModel([
      [{ type: 'finish', finishReason: 'error', usage: tok(0, 0) }],
    ]);
    const budget = new Budget(budgetCfg);
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget,
      }),
    ).rejects.toThrow(/planner: model reported error[\s\S]*squad doctor[\s\S]*5xx errors are transient/);
  });

  it('emits rate_limit phase retrying before retrying and continues when the retry succeeds', async () => {
    const sleepCalls: number[] = [];
    const onRateLimit = vi.fn();
    const bus = new PlannerEventBus();
    const busEvents: PlannerEvent[] = [];
    bus.subscribe((ev) => busEvents.push(ev));
    let n = 0;
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        n += 1;
        if (n === 1) {
          throw new APICallError({
            message: '429',
            url: 'https://example.com',
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after': '3' },
            responseBody: 'anthropic 429: {...}',
          });
        }
        return streamOk([
          ...textParts('# after retry\n'),
          { type: 'finish', finishReason: 'stop', usage: tok(1, 1) },
        ]);
      },
    });
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      onRateLimit,
      events: bus,
      runId: 'run-test',
    });
    expect(sleepCalls).toEqual([3000]);
    expect(onRateLimit).toHaveBeenCalledWith(3);
    expect(result.planText).toContain('after retry');
    expect(result.finishedNormally).toBe(true);
    const rl = busEvents.filter((e) => e.kind === 'rate_limit');
    expect(rl).toHaveLength(1);
    expect(rl[0]).toMatchObject({
      kind: 'rate_limit',
      runId: 'run-test',
      phase: 'retrying',
      provider: 'anthropic',
      capSec: 90,
      waitSec: 3,
      retryAfterSec: 3,
    });
  });

  it('honours retry-after up to the 90s cap', async () => {
    const sleepCalls: number[] = [];
    let n = 0;
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        n += 1;
        if (n === 1) {
          throw new APICallError({
            message: '429',
            url: 'https://example.com',
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after': '60' },
            responseBody: '429',
          });
        }
        return streamOk([{ type: 'finish', finishReason: 'stop', usage: tok(0, 0) }]);
      },
    });
    await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget: new Budget(budgetCfg),
      sleep: async (ms) => void sleepCalls.push(ms),
    });
    expect(sleepCalls).toEqual([60_000]);
  });

  it('skips the retry entirely when retry-after is longer than the 90s cap', async () => {
    const sleepCalls: number[] = [];
    const onRateLimit = vi.fn();
    const bus = new PlannerEventBus();
    const busEvents: PlannerEvent[] = [];
    bus.subscribe((ev) => busEvents.push(ev));
    let sends = 0;
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        sends += 1;
        throw new APICallError({
          message: '429',
          url: 'https://example.com',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '132' },
          responseBody: 'anthropic 429: {too-long}',
        });
      },
    });
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget: new Budget(budgetCfg),
        sleep: async (ms) => void sleepCalls.push(ms),
        onRateLimit,
        events: bus,
        runId: 'run-abort',
      }),
    ).rejects.toThrow(/did not auto-retry[\s\S]*132s wait is longer than our 90s cap/);
    expect(sleepCalls).toEqual([]);
    expect(onRateLimit).not.toHaveBeenCalled();
    expect(sends).toBe(1);
    const rl = busEvents.filter((e) => e.kind === 'rate_limit');
    expect(rl).toHaveLength(1);
    expect(rl[0]).toMatchObject({
      kind: 'rate_limit',
      runId: 'run-abort',
      phase: 'aborted',
      provider: 'anthropic',
      capSec: 90,
      waitSec: 132,
      retryAfterSec: 132,
    });
    expect((rl[0] as { rawBody?: string }).rawBody).toContain('anthropic 429');
  });

  it('throws an actionable rate-limit error when both attempts are rate-limited', async () => {
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        throw new APICallError({
          message: '429',
          url: 'https://example.com',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '5' },
          responseBody: 'anthropic 429: one',
        });
      },
    });
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget: new Budget(budgetCfg),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/anthropic rate limit hit[\s\S]*already retried[\s\S]*squad config set planner[\s\S]*console\.anthropic\.com/);
  });

  it('does not retry for a non-rate-limit error', async () => {
    const sleep = vi.fn(async () => undefined);
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget: new Budget(budgetCfg),
        sleep,
      }),
    ).rejects.toThrow(/boom/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('preserves the model_not_found message verbatim without extra hint', async () => {
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        throw new APICallError({
          message: '404',
          url: 'https://example.com',
          requestBodyValues: {},
          statusCode: 404,
          responseBody: JSON.stringify({
            error: { type: 'not_found_error', message: 'model not_found' },
          }),
        });
      },
    });
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(model, 'claude-x'),
        provider: 'anthropic',
        modelId: 'claude-x',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget: new Budget(budgetCfg),
      }),
    ).rejects.toThrowError(/The anthropic planner model "claude-x" is no longer available\.[\s\S]*squad upgrade/);
  });

  it('nudges model after maxFileReads exhaustion mid-batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-budget-'));
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8');
      const model = queueStreamModel([
        [
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: READ_FILE_TOOL_NAME,
            input: JSON.stringify({ path: 'a.txt' }),
          },
          {
            type: 'tool-call',
            toolCallId: '2',
            toolName: READ_FILE_TOOL_NAME,
            input: JSON.stringify({ path: 'b.txt' }),
          },
          { type: 'finish', finishReason: 'tool-calls', usage: tok(1, 1) },
        ],
        [
          ...textParts('# Final\n'),
          { type: 'finish', finishReason: 'stop', usage: tok(1, 1) },
        ],
      ]);
      const budget = new Budget({ ...budgetCfg, maxFileReads: 1 });
      const result = await runPlanner({
        root,
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget,
      });
      expect(result.budgetExhausted).toBe(true);
      expect(result.planText).toContain('# Final');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns timedOut when budget times out before completing', async () => {
    // Fake only `Date` so `setTimeout` inside the AI SDK stream still runs.
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const budget = new Budget({ ...budgetCfg, maxDurationSeconds: 1 });
    let call = 0;
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        call += 1;
        if (call === 1) {
          vi.setSystemTime(3_500);
          return streamOk([
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: READ_FILE_TOOL_NAME,
              input: JSON.stringify({ path: 'x.txt' }),
            },
            { type: 'finish', finishReason: 'tool-calls', usage: tok(0, 0) },
          ]);
        }
        return streamOk([
          ...textParts('never'),
          { type: 'finish', finishReason: 'stop', usage: tok(0, 0) },
        ]);
      },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-to-'));
    fs.writeFileSync(path.join(root, 'x.txt'), 'ok', 'utf8');
    try {
      const result = await runPlanner({
        root,
        runtime: vercelTestRuntime(model),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget,
      });
      expect(result.timedOut).toBe(true);
      expect(result.finishedNormally).toBe(false);
    } finally {
      vi.useRealTimers();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildScoutedContextSection', () => {
  it('honours readRanges for hinted paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-scoutctx-'));
    try {
      fs.writeFileSync(path.join(root, 'x.ts'), ['aaa', 'bbb', 'ccc', 'ddd'].join('\n'), 'utf8');
      const budget = new Budget(budgetCfg);
      const bus = new PlannerEventBus();
      const md = buildScoutedContextSection(
        root,
        budget,
        ['x.ts'],
        bus,
        'rid',
        [{ path: 'x.ts', offset: 2, limit: 2 }],
      );
      expect(md).toContain('lines 2–3');
      expect(md).toContain('bbb');
      expect(md).toContain('ccc');
      expect(md).not.toContain('aaa');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('truncates oversized files with head read note', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-big-'));
    try {
      const body = 'z'.repeat(33_000);
      fs.writeFileSync(path.join(root, 'big.txt'), body, 'utf8');
      const budget = new Budget(budgetCfg);
      const bus = new PlannerEventBus();
      const md = buildScoutedContextSection(root, budget, ['big.txt'], bus, 'rid');
      expect(md).toContain('truncated:');
      expect(md).toContain('full size');
      expect(md).toContain(`${33_000}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runPlanner scout configuration', () => {
  it('throws when scout enabled with model but scoutSystemPrompt empty', async () => {
    const draftModel = queueStreamModel([[{ type: 'finish', finishReason: 'stop', usage: tok(1, 1) }]]);
    await expect(
      runPlanner({
        root: os.tmpdir(),
        runtime: vercelTestRuntime(draftModel),
        provider: 'anthropic',
        modelId: 'm',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget: new Budget(budgetCfg),
        stages: { scout: { enabled: true, runtime: vercelTestRuntime(draftModel, 'scout'), modelId: 'scout' } },
        scoutSystemPrompt: '   ',
      }),
    ).rejects.toThrow(/scoutSystemPrompt/);
  });

  it('emits stage_complete with errorMessage when scout throws', async () => {
    vi.spyOn(scoutStages, 'runScout').mockRejectedValue(new Error('scout boom'));
    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const draftModel = queueStreamModel([[{ type: 'finish', finishReason: 'stop', usage: tok(1, 1) }]]);
    await runPlanner({
      root: os.tmpdir(),
      runtime: vercelTestRuntime(draftModel),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget: new Budget(budgetCfg),
      stages: { scout: { enabled: true, runtime: vercelTestRuntime(draftModel, 'scout'), modelId: 'scout' } },
      scoutSystemPrompt: 'scout sys',
      events: bus,
    });
    expect(
      events.some(
        (e) =>
          e.kind === 'stage_complete' &&
          e.stage === 'scout' &&
          !e.success &&
          'errorMessage' in e &&
          (e as { errorMessage?: string }).errorMessage?.includes('scout boom'),
      ),
    ).toBe(true);
  });
});
