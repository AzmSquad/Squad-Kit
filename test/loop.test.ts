import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanner } from '../src/planner/loop.js';
import { Budget } from '../src/planner/budget.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { PlannerProvider, ProviderResponse, ToolCall } from '../src/planner/types.js';

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

describe('runPlanner', () => {
  it('returns planText and finishedNormally when assistant ends with end_turn and no tool calls', async () => {
    const provider = mockProvider([
      { text: '# My plan\n', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      provider,
      model: 'm',
      apiKey: 'k',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.planText).toBe('# My plan\n');
    expect(result.finishedNormally).toBe(true);
    expect(result.budgetExhausted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('handles read_file tool call then end_turn on next turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-'));
    try {
      fs.writeFileSync(path.join(root, 'hello.txt'), 'world', 'utf8');
      const tc: ToolCall = { id: 't1', name: READ_FILE_TOOL.name, input: { path: 'hello.txt' } };
      const provider = mockProvider([
        { text: 'Reading…', toolCalls: [tc], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
        { text: '# Done\n', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
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
      expect(result.planText).toContain('Reading…');
      expect(result.planText).toContain('# Done');
      expect(result.finishedNormally).toBe(true);
      expect(budget.snapshot().reads).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns finishedNormally false on max_tokens with no tool calls', async () => {
    const provider = mockProvider([
      { text: 'partial only', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 8 } },
    ]);
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      provider,
      model: 'm',
      apiKey: 'k',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.planText).toBe('partial only');
    expect(result.finishedNormally).toBe(false);
  });

  it('throws on stopReason error with rawError in message', async () => {
    const provider = mockProvider([{ stopReason: 'error', rawError: 'provider exploded' }]);
    const budget = new Budget(budgetCfg);
    await expect(
      runPlanner({
        root: os.tmpdir(),
        provider,
        model: 'm',
        apiKey: 'k',
        systemPrompt: 'sys',
        userPrompt: 'user',
        budget,
      }),
    ).rejects.toThrow(/provider exploded/);
  });

  it('returns tool_result isError for unknown tool name', async () => {
    const bodies: string[] = [];
    const provider: PlannerProvider = {
      name: 'anthropic',
      async send(req) {
        bodies.push(JSON.stringify(req.turns));
        if (bodies.length === 1) {
          return {
            toolCalls: [{ id: 'x', name: 'nope', input: {} }],
            stopReason: 'tool_use',
          };
        }
        return { text: 'after', stopReason: 'end_turn' };
      },
    };
    const budget = new Budget(budgetCfg);
    const result = await runPlanner({
      root: os.tmpdir(),
      provider,
      model: 'm',
      apiKey: 'k',
      systemPrompt: 'sys',
      userPrompt: 'user',
      budget,
    });
    expect(result.planText).toBe('after');
    expect(bodies[1]).toContain('unknown tool');
    expect(bodies[1]).toContain('"isError":true');
  });

  it('nudges model after maxFileReads exhaustion mid-batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-budget-'));
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8');
      const provider = mockProvider([
        {
          toolCalls: [
            { id: '1', name: READ_FILE_TOOL.name, input: { path: 'a.txt' } },
            { id: '2', name: READ_FILE_TOOL.name, input: { path: 'b.txt' } },
          ],
          stopReason: 'tool_use',
        },
        { text: '# Final\n', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const budget = new Budget({ ...budgetCfg, maxFileReads: 1 });
      const result = await runPlanner({
        root,
        provider,
        model: 'm',
        apiKey: 'k',
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
    vi.useFakeTimers({ now: 1_000 });
    const budget = new Budget({ ...budgetCfg, maxDurationSeconds: 1 });
    const tc: ToolCall = { id: 't1', name: READ_FILE_TOOL.name, input: { path: 'x.txt' } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loop-to-'));
    fs.writeFileSync(path.join(root, 'x.txt'), 'ok', 'utf8');
    try {
      let n = 0;
      const provider: PlannerProvider = {
        name: 'anthropic',
        async send() {
          n += 1;
          if (n === 1) {
            vi.setSystemTime(3_500);
            return { toolCalls: [tc], stopReason: 'tool_use' };
          }
          return { text: 'never', stopReason: 'end_turn' };
        },
      };
      const result = await runPlanner({
        root,
        provider,
        model: 'm',
        apiKey: 'k',
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
