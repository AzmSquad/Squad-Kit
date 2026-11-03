import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { runPlanner } from '../src/planner/loop.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';
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

function tok(p: number, o: number) {
  return { inputTokens: p, outputTokens: o, totalTokens: p + o };
}

function streamOk(chunks: LanguageModelV2StreamPart[]) {
  return {
    stream: simulateReadableStream({ chunks }),
  };
}

function vercelRt(m: LanguageModelV2, id = 'm') {
  return new VercelRuntime('anthropic', id, m, true);
}

describe('PlannerRunStats aggregation', () => {
  it('aggregates token and cache stats across tool+text turns', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stats-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
    let i = 0;
    // Anthropic reports cache reads on the usage and cache writes in provider metadata.
    const metaCreate = { anthropic: { cacheCreationInputTokens: 200 } };
    const metaRead = { anthropic: { cacheCreationInputTokens: 0 } };
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () => {
        i += 1;
        if (i === 1) {
          return streamOk([
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: READ_FILE_TOOL_NAME,
              input: JSON.stringify({ path: 'a.txt' }),
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { ...tok(100, 10), cachedInputTokens: 0 },
              providerMetadata: metaCreate,
            },
          ]);
        }
        return streamOk([
          ...textParts('# Done'),
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { ...tok(500, 20), cachedInputTokens: 400 },
            providerMetadata: metaRead,
          },
        ]);
      },
    });
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root,
      runtime: vercelRt(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.finishedNormally).toBe(true);
    expect(result.stats.inputTokens).toBe(600);
    expect(result.stats.outputTokens).toBe(30);
    expect(result.stats.cacheCreationTokens).toBe(200);
    expect(result.stats.cacheReadTokens).toBe(400);
    expect(result.stats.turns).toBe(2);
    expect(result.stats.cacheHitRatio).toBeCloseTo(400 / 1000, 5);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cacheHitRatio is 0 when all token totals are zero', async () => {
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'm',
      doStream: async () =>
        streamOk([
          ...textParts('x'),
          { type: 'finish', finishReason: 'stop', usage: tok(0, 0) },
        ]),
    });
    const result = await runPlanner({
      root: os.tmpdir(),
      runtime: vercelRt(model),
      provider: 'anthropic',
      modelId: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      budget: new Budget(budgetCfg),
    });
    expect(result.stats.inputTokens).toBe(0);
    expect(result.stats.cacheHitRatio).toBe(0);
  });
});
