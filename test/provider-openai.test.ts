import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callOpenAI } from '../src/planner/providers/openai.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import { openaiLengthResponse, openaiToolCallsResponse } from './support/planner-fixtures.js';
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

describe('callOpenAI', () => {
  it('POSTs to chat completions with Bearer authorization', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      systemPrompt: 'sys',
      model: 'gpt-4',
      tools: [],
      turns: [],
      apiKey: 'sk-openai',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-openai');
    expect(headers['content-type']).toBe('application/json');
  });

  it('places the system prompt in messages[0]', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      systemPrompt: 'System only.',
      model: 'm',
      tools: [READ_FILE_TOOL],
      turns: [{ role: 'user', text: 'u' }],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'System only.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'u' });
  });

  it('serialises assistant tool_calls with JSON-stringified arguments', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: null }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [
        {
          role: 'assistant',
          text: 'Calling tool',
          toolCalls: [{ id: 'call_abc', name: 'read_file', input: { path: 'x.ts' } }],
        },
      ],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    const assistant = body.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('Calling tool');
    expect(assistant.tool_calls).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"x.ts"}' },
      },
    ]);
  });

  it('maps finish_reason tool_calls to stopReason tool_use', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(openaiToolCallsResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callOpenAI({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'b.ts' } }]);
    expect(res.text).toBeUndefined();
  });

  it('maps finish_reason length to max_tokens', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(openaiLengthResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callOpenAI({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('max_tokens');
    expect(res.text).toBe('partial');
  });

  it('emits role tool messages for user toolResults', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [
        {
          role: 'user',
          text: 'read this',
          toolResults: [{ toolCallId: 'call_1', content: '{"ok":true}' }],
        },
      ],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'read this' },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ]);
  });

  it('returns error stopReason and rawError on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callOpenAI({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.rawError).toMatch(/^openai 503: bad$/);
  });

  it('returns friendly rawError on 404 model_not_found', async () => {
    const body = JSON.stringify({
      error: { code: 'model_not_found', message: 'The model `gpt-bogus` does not exist' },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callOpenAI({
      systemPrompt: 's',
      model: 'gpt-bogus',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.rawError).toContain('Run `squad upgrade`');
    expect(res.rawError).toContain('openai');
    expect(res.rawError).toContain('gpt-bogus');
  });
});
