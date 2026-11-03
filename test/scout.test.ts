import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateObject: (...args: Parameters<typeof actual.generateObject>) =>
      mockGenerateObject(...args) as ReturnType<typeof actual.generateObject>,
  };
});

import { APICallError } from 'ai';
import { runScout } from '../src/planner/stages/scout.js';
import { Budget } from '../src/planner/budget.js';
import { PlannerEventBus } from '../src/planner/events.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';

const mockModel = {} as import('@ai-sdk/provider').LanguageModelV2;

beforeEach(() => {
  mockGenerateObject.mockReset();
});

function okPayload(): {
  object: { selectedFiles: string[]; reasoning: string; suggestedReadStrategy: 'read_full' };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  warnings: [];
  finishReason: string;
  rawResponse: Record<string, never>;
  providerMetadata: Record<string, never>;
} {
  return {
    object: {
      selectedFiles: ['a.ts'],
      reasoning: 'because',
      suggestedReadStrategy: 'read_full',
    },
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    warnings: [],
    finishReason: 'stop',
    rawResponse: {},
    providerMetadata: {},
  };
}

describe('runScout', () => {
  it('calls generateObject with maxTokens override', async () => {
    mockGenerateObject.mockResolvedValue(okPayload());
    const budget = new Budget({ maxFileReads: 10, maxContextBytes: 10000, maxDurationSeconds: 60 });
    const bus = new PlannerEventBus();
    const runtime = new VercelRuntime('anthropic', 'm', mockModel, true);
    await runScout({
      runtime,
      systemPrompt: 's',
      userPrompt: 'u',
      budget,
      bus,
      runId: 'test',
      maxTokens: 4096,
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 4096 }));
  });

  it('defaults maxTokens to 2048 when omitted', async () => {
    mockGenerateObject.mockResolvedValue(okPayload());
    const budget = new Budget({ maxFileReads: 10, maxContextBytes: 10000, maxDurationSeconds: 60 });
    const bus = new PlannerEventBus();
    const runtime = new VercelRuntime('anthropic', 'm', mockModel, true);
    await runScout({
      runtime,
      systemPrompt: 's',
      userPrompt: 'u',
      budget,
      bus,
      runId: 'test',
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 2048 }));
  });

  it('retries once on 429 within 90s retry-after cap', async () => {
    vi.useFakeTimers();
    mockGenerateObject
      .mockRejectedValueOnce(
        new APICallError({
          message: '429',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '2' },
          responseBody: '{}',
        }),
      )
      .mockResolvedValueOnce(okPayload());
    const budget = new Budget({ maxFileReads: 10, maxContextBytes: 10000, maxDurationSeconds: 60 });
    const bus = new PlannerEventBus();
    const runtime = new VercelRuntime('anthropic', 'm', mockModel, true);
    const p = runScout({
      runtime,
      systemPrompt: 's',
      userPrompt: 'u',
      budget,
      bus,
      runId: 'test',
    });
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(mockGenerateObject).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry when retry-after exceeds 90s', async () => {
    mockGenerateObject.mockRejectedValue(
      new APICallError({
        message: '429',
        url: 'https://example.invalid',
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { 'retry-after': '200' },
        responseBody: '{}',
      }),
    );
    const budget = new Budget({ maxFileReads: 10, maxContextBytes: 10000, maxDurationSeconds: 60 });
    const bus = new PlannerEventBus();
    const runtime = new VercelRuntime('anthropic', 'm', mockModel, true);
    await expect(
      runScout({
        runtime,
        systemPrompt: 's',
        userPrompt: 'u',
        budget,
        bus,
        runId: 'test',
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});
