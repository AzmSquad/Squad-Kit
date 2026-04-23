import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanner } from '../src/planner/loop.js';
import { Budget } from '../src/planner/budget.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { PlannerProvider, ToolCall, ProviderResponse } from '../src/planner/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockProvider(queue: ProviderResponse[]): PlannerProvider {
  let i = 0;
  return {
    name: 'anthropic',
    async send() {
      const r = queue[i++];
      if (!r) throw new Error('mock provider queue exhausted');
      return r;
    },
  };
}

const budgetCfg = {
  maxFileReads: 25,
  maxContextBytes: 500_000,
  maxDurationSeconds: 120,
};

describe('PlannerRunStats aggregation', () => {
  it('multi-turn run sums usage and cache fields from each turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stats-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
    const tc: ToolCall = { id: 't1', name: READ_FILE_TOOL.name, input: { path: 'a.txt' } };
    const provider = mockProvider([
      { toolCalls: [tc], stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 200 } },
      { text: '# Done', stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 400, cacheCreationTokens: 0 } },
    ]);
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root,
      provider,
      model: 'm',
      apiKey: 'k',
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
    const provider = mockProvider([{ text: 'x', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]);
    const result = await runPlanner({
      root: os.tmpdir(),
      provider,
      model: 'm',
      apiKey: 'k',
      systemPrompt: 's',
      userPrompt: 'u',
      budget: new Budget(budgetCfg),
    });
    expect(result.stats.inputTokens).toBe(0);
    expect(result.stats.cacheHitRatio).toBe(0);
  });
});
