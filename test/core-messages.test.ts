import { describe, it, expect } from 'vitest';
import type { ChatTurn } from '../src/planner/types.js';
import { turnsToCoreMessages } from '../src/planner/core-messages.js';

describe('turnsToCoreMessages tool names', () => {
  it('emits distinct toolName per tool-result entry', () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: 'go' },
      {
        role: 'assistant',
        toolCalls: [
          { id: 'g', name: 'grep', input: {} },
          { id: 'l', name: 'list_dir', input: {} },
          { id: 'r', name: 'read_file', input: {} },
        ],
      },
      {
        role: 'user',
        toolResults: [
          { toolCallId: 'g', name: 'grep', content: 'a', isError: false },
          { toolCallId: 'l', name: 'list_dir', content: 'b', isError: false },
          { toolCallId: 'r', name: 'read_file', content: 'c', isError: true },
        ],
      },
    ];
    const msgs = turnsToCoreMessages('system text', turns, { cacheEnabled: false, provider: 'openai' });
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg?.role).toBe('tool');
    const parts = toolMsg!.content as Array<{ toolName?: string; output?: { type: string } }>;
    expect(parts.map((p) => p.toolName)).toEqual(['grep', 'list_dir', 'read_file']);
    expect(parts.map((p) => p.output?.type)).toEqual(['json', 'json', 'error-json']);
  });
});
