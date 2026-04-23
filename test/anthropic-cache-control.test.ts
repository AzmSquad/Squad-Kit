import { describe, it, expect } from 'vitest';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { ChatTurn, ProviderRequest } from '../src/planner/types.js';
import { buildAnthropicBody } from '../src/planner/providers/anthropic.js';

const base: Omit<ProviderRequest, 'turns'> = {
  systemPrompt: 'sys',
  model: 'm',
  tools: [READ_FILE_TOOL],
  apiKey: 'k',
};

describe('buildAnthropicBody cache_control', () => {
  it('with cacheEnabled true (or undefined) emits structured system with ephemeral cache_control', () => {
    const req: ProviderRequest = {
      ...base,
      turns: [{ role: 'user', text: 'hi' }],
    };
    const a = buildAnthropicBody(req);
    const b = buildAnthropicBody({ ...req, cacheEnabled: true });
    expect(a.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(b.system).toEqual(a.system);
    expect('tools' in a && Array.isArray(a.tools)).toBe(true);
    for (const t of a.tools) {
      expect(JSON.stringify(t)).not.toMatch(/cache_control/);
    }
  });

  it('does not put cache_control on tools entries', () => {
    const body = buildAnthropicBody({ ...base, turns: [] });
    expect(body.tools.length).toBeGreaterThan(0);
    for (const tool of body.tools) {
      expect(JSON.stringify(tool)).not.toMatch(/cache_control/);
    }
  });

  it('marks only the last tool_result on the most recent user message with tool results', () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: READ_FILE_TOOL.name, input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        toolResults: [{ toolCallId: 'c1', content: 'out1' }],
      },
      {
        role: 'assistant',
        toolCalls: [{ id: 'c2', name: READ_FILE_TOOL.name, input: { path: 'b.ts' } }],
      },
      {
        role: 'user',
        toolResults: [
          { toolCallId: 'c2', content: 'out2a' },
          { toolCallId: 'c2b', content: 'out2b' },
        ],
      },
    ];
    const body = buildAnthropicBody({ ...base, turns });
    const msg0 = body.messages![0]!;
    const msg2 = body.messages![2]!;
    const msg4 = body.messages![4]!;
    const last0 = msg0.content.filter((b) => (b as { type: string }).type === 'tool_result');
    const last2 = msg2.content.filter((b) => (b as { type: string }).type === 'tool_result');
    const last4 = msg4.content.filter((b) => (b as { type: string }).type === 'tool_result');
    expect(last0.length).toBe(0);
    expect(last2).toHaveLength(1);
    expect((last2[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect(last4).toHaveLength(2);
    expect((last4[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((last4[1] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('when the last turn is assistant, cache_control stays on the latest user message that had tool results', () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'thinking',
        toolCalls: [{ id: 'c1', name: READ_FILE_TOOL.name, input: { path: 'a.ts' } }],
      },
      { role: 'user', toolResults: [{ toolCallId: 'c1', content: 'data' }] },
      { role: 'assistant', text: 'plan done' },
    ];
    const body = buildAnthropicBody({ ...base, turns });
    const lastUserIdx = 2;
    const umsg = body.messages![lastUserIdx]!;
    const tr = umsg.content.filter((b) => (b as { type: string }).type === 'tool_result');
    expect(tr).toHaveLength(1);
    expect((tr[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
    const asst = body.messages![3]!;
    expect(asst.content.some((b) => (b as { type: string }).type === 'tool_result')).toBe(false);
  });

  it('with cacheEnabled false uses string system and no cache_control anywhere', () => {
    const req: ProviderRequest = {
      ...base,
      cacheEnabled: false,
      turns: [
        { role: 'user', text: 'q' },
        { role: 'user', toolResults: [{ toolCallId: 'x', content: 'y' }] },
      ],
    };
    const body = buildAnthropicBody(req);
    expect(body.system).toBe('sys');
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/cache_control/);
  });

  it('with zero turns: structured system only, no errors', () => {
    const body = buildAnthropicBody({ ...base, turns: [] });
    expect(body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toBeUndefined();
  });
});
