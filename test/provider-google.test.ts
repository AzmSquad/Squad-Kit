import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callGoogle } from '../src/planner/providers/google.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import { googleFunctionCallResponse } from './support/planner-fixtures.js';
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

describe('callGoogle', () => {
  it('POSTs to generateContent with model and key in the URL', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 's',
      model: 'gemini-pro',
      tools: [],
      turns: [],
      apiKey: 'AIza_secret',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url } = firstFetchCall(fetchMock);
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=AIza_secret',
    );
  });

  it('encodes model names that need escaping in the path', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 's',
      model: 'models/foo bar',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    const { url } = firstFetchCall(fetchMock);
    expect(url).toContain(encodeURIComponent('models/foo bar'));
  });

  it('sets system_instruction.parts[0].text from the system prompt', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 'You are helpful.',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.system_instruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
  });

  it('uses role model for assistant turns', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [{ role: 'assistant', text: 'I am the model.' }],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.contents).toEqual([{ role: 'model', parts: [{ text: 'I am the model.' }] }]);
  });

  it('places tool schemas under tools[0].functionDeclarations', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 's',
      model: 'm',
      tools: [READ_FILE_TOOL],
      turns: [],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.tools).toHaveLength(1);
    const decl0 = body.tools[0]!.functionDeclarations[0]!;
    expect(decl0).toMatchObject({
      name: 'read_file',
      parameters: READ_FILE_TOOL.inputSchema,
    });
  });

  it('omits tools when the tool list is empty', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGoogle({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    const body = JSON.parse(firstFetchCall(fetchMock).init!.body as string);
    expect(body.tools).toBeUndefined();
  });

  it('parses functionCall parts into toolCalls with gcall_* ids', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(googleFunctionCallResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGoogle({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.toolCalls).toEqual([
      { id: 'gcall_0_read_file', name: 'read_file', input: { path: 'c.ts' } },
    ]);
    expect(res.stopReason).toBe('end_turn');
  });

  it('returns error stopReason and rawError on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('quota', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGoogle({
      systemPrompt: 's',
      model: 'm',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.rawError).toMatch(/^google 403: quota$/);
  });

  it('returns friendly rawError on 404 NOT_FOUND for model', async () => {
    const body = JSON.stringify({
      error: {
        code: 404,
        message: 'models/gemini-bogus is not found for API version',
        status: 'NOT_FOUND',
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGoogle({
      systemPrompt: 's',
      model: 'gemini-bogus',
      tools: [],
      turns: [],
      apiKey: 'k',
    });

    expect(res.stopReason).toBe('error');
    expect(res.rawError).toContain('Run `squad upgrade`');
    expect(res.rawError).toContain('google');
    expect(res.rawError).toContain('gemini-bogus');
  });
});
