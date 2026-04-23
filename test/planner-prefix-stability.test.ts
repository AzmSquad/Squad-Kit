import { describe, it, expect } from 'vitest';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { ChatTurn, ProviderRequest } from '../src/planner/types.js';
import { prefixOf } from '../src/planner/providers/prefix.js';

const baseReq: Omit<ProviderRequest, 'turns'> = {
  systemPrompt: 'system line',
  model: 'planner-model',
  tools: [READ_FILE_TOOL],
  apiKey: 'k',
  maxOutputTokens: 4096,
};

const t1: ChatTurn = { role: 'user', text: 'first user' };
const t2: ChatTurn = {
  role: 'assistant',
  text: 'assistant',
  toolCalls: [{ id: 'c1', name: READ_FILE_TOOL.name, input: { path: 'a.ts' } }],
};

describe('prefixOf', () => {
  it('anthropic: prefix grows as a literal string prefix when a turn is appended', () => {
    const one: ProviderRequest = { ...baseReq, turns: [t1] };
    const two: ProviderRequest = { ...baseReq, turns: [t1, t2] };
    const p1 = prefixOf('anthropic', one);
    const p2 = prefixOf('anthropic', two);
    expect(p2.startsWith(p1)).toBe(true);
    expect(p2.slice(0, p1.length)).toBe(p1);
  });

  it('openai: prefix grows as a literal string prefix when a turn is appended', () => {
    const one: ProviderRequest = { ...baseReq, turns: [t1] };
    const two: ProviderRequest = { ...baseReq, turns: [t1, t2] };
    const p1 = prefixOf('openai', one);
    const p2 = prefixOf('openai', two);
    expect(p2.startsWith(p1)).toBe(true);
    expect(p2.slice(0, p1.length)).toBe(p1);
  });

  it('google: prefix grows as a literal string prefix when a turn is appended', () => {
    const one: ProviderRequest = { ...baseReq, turns: [t1] };
    const two: ProviderRequest = { ...baseReq, turns: [t1, t2] };
    const p1 = prefixOf('google', one);
    const p2 = prefixOf('google', two);
    expect(p2.startsWith(p1)).toBe(true);
    expect(p2.slice(0, p1.length)).toBe(p1);
  });
});
