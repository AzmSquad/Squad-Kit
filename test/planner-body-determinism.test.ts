import { describe, it, expect } from 'vitest';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { ChatTurn, ProviderRequest } from '../src/planner/types.js';
import { buildAnthropicBody } from '../src/planner/providers/anthropic.js';
import { buildOpenAIBody } from '../src/planner/providers/openai.js';
import { buildGoogleBody } from '../src/planner/providers/google.js';

const sample: ProviderRequest = {
  systemPrompt: 'sys',
  model: 'm',
  tools: [READ_FILE_TOOL],
  apiKey: 'k',
  maxOutputTokens: 4096,
  turns: [
    { role: 'user', text: 'u' },
    {
      role: 'assistant',
      text: 'a',
      toolCalls: [{ id: 'x', name: READ_FILE_TOOL.name, input: { path: 'z.ts' } }],
    },
    { role: 'user', toolResults: [{ toolCallId: 'x', content: 'ok' }] },
  ] as ChatTurn[],
};

function expectSameOver10<T>(fn: () => T, eq: (a: T, b: T) => boolean): void {
  const first = fn();
  for (let i = 0; i < 10; i += 1) {
    expect(eq(fn(), first)).toBe(true);
  }
}

describe('build*Body determinism', () => {
  it('buildAnthropicBody is stable over 10 calls', () => {
    expectSameOver10(
      () => buildAnthropicBody(sample),
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    );
  });

  it('buildOpenAIBody is stable over 10 calls', () => {
    expectSameOver10(
      () => buildOpenAIBody(sample),
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    );
  });

  it('buildGoogleBody is stable over 10 calls', () => {
    expectSameOver10(
      () => buildGoogleBody(sample),
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    );
  });
});
