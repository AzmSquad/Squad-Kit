import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCallOptions } from 'ai';
import { grepToolFactory } from '../src/planner/tools/grep.js';
import { listDirToolFactory } from '../src/planner/tools/list-dir.js';
import { Budget } from '../src/planner/budget.js';
import { PlannerEventBus } from '../src/planner/events.js';

/** What the planner tools return (AI SDK 5 also allows a streamed result, which they never use). */
type ToolOutput = { content: string; isError: boolean };

const budgetCfg = {
  maxFileReads: 25,
  maxContextBytes: 500_000,
  maxDurationSeconds: 120,
};

describe('grep tool', () => {
  it('finds literal substring', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-grep-'));
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n', 'utf8');
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'nope\n', 'utf8');
      const budget = new Budget(budgetCfg);
      const bus = new PlannerEventBus();
      const tool = grepToolFactory(root, budget, { runId: 'r', turn: 1, bus });
      if (!tool.execute) throw new Error('expected execute');
      const out = (await tool.execute(
        { pattern: 'hello', regex: false, caseInsensitive: false },
        { toolCallId: 't1', messages: [], abortSignal: undefined } as ToolCallOptions,
      )) as ToolOutput;
      expect(out.content).toContain('a.txt:1:');
      expect(out.content).toContain('hello world');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('list_dir tool', () => {
  it('lists one level with dirs first', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ld-'));
    try {
      fs.mkdirSync(path.join(root, 'zdir'), { recursive: true });
      fs.writeFileSync(path.join(root, 'z.txt'), 'x', 'utf8');
      fs.writeFileSync(path.join(root, 'a.txt'), 'y', 'utf8');
      const budget = new Budget(budgetCfg);
      const bus = new PlannerEventBus();
      const tool = listDirToolFactory(root, budget, { runId: 'r', turn: 1, bus });
      if (!tool.execute) throw new Error('expected execute');
      const out = (await tool.execute(
        { path: '.' },
        { toolCallId: 't1', messages: [], abortSignal: undefined } as ToolCallOptions,
      )) as ToolOutput;
      expect(out.content).toContain('zdir/');
      expect(out.content).toContain('a.txt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
