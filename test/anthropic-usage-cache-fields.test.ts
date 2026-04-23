import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callAnthropic } from '../src/planner/providers/anthropic.js';
import type { ProviderRequest } from '../src/planner/types.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must be stubbed in this test'))) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const req: ProviderRequest = {
  systemPrompt: 's',
  model: 'm',
  tools: [],
  turns: [],
  apiKey: 'k',
};

describe('callAnthropic usage cache fields', () => {
  it('maps cache_creation_input_tokens and cache_read_input_tokens', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 800,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic(req);
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 2000,
      cacheReadTokens: 800,
    });
  });

  it('treats missing cache fields as zero', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic(req);
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
