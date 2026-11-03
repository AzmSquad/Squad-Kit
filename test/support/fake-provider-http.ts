/**
 * A stand-in for the Anthropic, OpenAI and Google HTTP APIs, so planner tests can see exactly what the
 * real provider adapters send. Install it with `vi.stubGlobal('fetch', fake.fetch)`; no network is used.
 */
import type { ProviderName } from '../../src/planner/types.js';

export interface FakeToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One streamed model turn: some text, then tool calls (or a plain stop). */
export interface FakeTurn {
  text?: string;
  calls?: FakeToolCall[];
}

export interface RecordedRequest {
  url: string;
  body: Record<string, any>;
}

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const text = events
    .map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function anthropicTurn(turn: FakeTurn, model: string): Response {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 30 },
        },
      },
    },
  ];
  let index = 0;
  if (turn.text) {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: turn.text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    index += 1;
  }
  for (const c of turn.calls ?? []) {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    index += 1;
  }
  const stopReason = turn.calls?.length ? 'tool_use' : 'end_turn';
  events.push(
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return sse(events);
}

function openaiTurn(turn: FakeTurn, model: string): Response {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model };
  const events: Array<{ data: unknown }> = [];
  if (turn.text) events.push({ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] } });
  (turn.calls ?? []).forEach((c, i) =>
    events.push({
      data: {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }] }, finish_reason: null }],
      },
    }),
  );
  events.push(
    { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.calls?.length ? 'tool_calls' : 'stop' }] } },
    { data: { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } },
    { data: '[DONE]' },
  );
  return sse(events);
}

function googleTurn(turn: FakeTurn): Response {
  const parts: unknown[] = [];
  if (turn.text) parts.push({ text: turn.text });
  for (const c of turn.calls ?? []) parts.push({ functionCall: { name: c.name, args: c.input } });
  return sse([
    {
      data: {
        candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
      },
    },
  ]);
}

/** The scout's one-shot structured answer, shaped the way each provider returns JSON. */
function structuredAnswer(provider: ProviderName, body: Record<string, any>, object: unknown): Response {
  if (provider === 'anthropic') {
    const forced = body.tool_choice?.name as string | undefined;
    return json({
      id: 'msg_s', type: 'message', role: 'assistant', model: body.model, stop_sequence: null,
      content: forced ? [{ type: 'tool_use', id: 'toolu_s', name: forced, input: object }] : [{ type: 'text', text: JSON.stringify(object) }],
      stop_reason: forced ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  }
  if (provider === 'openai') {
    return json({
      id: 'chatcmpl-s', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(object) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  }
  return json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(object) }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  });
}

/**
 * Streamed requests are answered from `turns` in order; one-shot requests (the scout) get `scoutObject`.
 */
export function fakeProviderHttp(provider: ProviderName, opts: { turns: FakeTurn[]; scoutObject?: unknown }) {
  const requests: RecordedRequest[] = [];
  let next = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, any>;
    requests.push({ url, body });
    const streaming = provider === 'google' ? url.includes(':streamGenerateContent') : body.stream === true;
    if (!streaming) return structuredAnswer(provider, body, opts.scoutObject);
    const turn = opts.turns[next++];
    if (!turn) throw new Error(`fake ${provider}: no more turns`);
    if (provider === 'anthropic') return anthropicTurn(turn, String(body.model));
    if (provider === 'openai') return openaiTurn(turn, String(body.model));
    return googleTurn(turn);
  };
  return { fetch, requests };
}
