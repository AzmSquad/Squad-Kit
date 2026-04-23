import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callAnthropic } from '../src/planner/providers/anthropic.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import {
  anthropicEndTurnResponse,
  anthropicMixedContentResponse,
} from './support/planner-fixtures.js';
import { firstFetchCall } from './support/fetch-test-utils.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must be stubbed in this test'))) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callAnthropic', () => {
  it('POSTs to the Anthropic messages URL with required headers', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify(anthropicEndTurnResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callAnthropic({
      systemPrompt: 'sys',
      model: 'claude-3',
      tools: [],
      turns: [{ role: 'user', text: 'hi' }],
      apiKey: 'sk-ant',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('translates a single user turn into messages with a text block', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify(anthropicEndTurnResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callAnthropic({
      systemPrompt: 'You are a planner.',
      model: 'claude-3',
      tools: [READ_FILE_TOOL],
      turns: [{ role: 'user', text: 'Hello' }],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.system).toBe('You are a planner.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!).toMatchObject({
      name: 'read_file',
      input_schema: READ_FILE_TOOL.inputSchema,
    });
  });

  it('parses text and tool_use blocks and maps stop_reason tool_use', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(anthropicMixedContentResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.text).toBe('Here is the plan.');
    expect(res.toolCalls).toEqual([
      { id: 'toolu_01', name: 'read_file', input: { path: 'src/a.ts' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('maps toolResults turns to tool_result blocks on the user message', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(anthropicEndTurnResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callAnthropic({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [
        {
          role: 'user',
          toolResults: [
            { toolCallId: 't1', content: 'file contents', isError: false },
            { toolCallId: 't2', content: 'oops', isError: true },
          ],
        },
      ],
      apiKey: 'k',
    });

    const { init } = firstFetchCall(fetchMock);
    const body = JSON.parse(init!.body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'file contents', is_error: false },
      { type: 'tool_result', tool_use_id: 't2', content: 'oops', is_error: true },
    ]);
  });

  it('flags 429 as rate_limit with parsed retry-after header and truncated body', async () => {
    const longBody = 'x'.repeat(600);
    const fetchMock = vi.fn(async () => {
      return new Response(longBody, {
        status: 429,
        headers: { 'retry-after': '45' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.errorKind).toBe('rate_limit');
    expect(res.retryAfterSec).toBe(45);
    expect(res.rawError).toMatch(/^anthropic 429: /);
    expect(res.rawError!.length).toBeLessThan(longBody.length);
    expect(res.rawError!.length).toBeLessThanOrEqual('anthropic 429: '.length + 500);
  });

  it('flags 429 as rate_limit even when retry-after header is absent', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', { status: 429 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.errorKind).toBe('rate_limit');
    expect(res.retryAfterSec).toBeUndefined();
  });

  it('non-429/404 errors remain unclassified', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.errorKind).toBeUndefined();
    expect(res.rawError).toMatch(/^anthropic 500: /);
  });

  it('returns friendly rawError on 404 model not found', async () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: claude-bogus' },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callAnthropic({
      systemPrompt: 's',
      model: 'claude-bogus',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.rawError).toContain('Run `squad upgrade`');
    expect(res.rawError).toContain('anthropic');
    expect(res.rawError).toContain('claude-bogus');
  });
});
