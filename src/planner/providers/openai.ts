import type {
  ChatTurn,
  PlannerProvider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolSchema,
} from '../types.js';
import { sortRecordKeys } from '../stable-json.js';
import {
  detectModelNotFound,
  detectRateLimit,
  modelNotFoundMessage,
} from '../provider-errors.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * When `turns` is empty, `messages` is omitted from the object so prefix helpers can treat
 * the static header as a string prefix; `callOpenAI` injects a single system message for the
 * real POST.
 */
export type OpenAIRequestBody = {
  model: string;
  max_completion_tokens: number;
  tools: ReturnType<typeof toOpenAITool>[];
  messages?: unknown[];
};

export const openaiProvider: PlannerProvider = {
  name: 'openai',
  async send(req) {
    return callOpenAI(req);
  },
};

export function buildOpenAIBody(req: ProviderRequest): OpenAIRequestBody {
  const base: OpenAIRequestBody = {
    model: req.model,
    max_completion_tokens: req.maxOutputTokens ?? 4096,
    tools: req.tools.map(toOpenAITool),
  };
  if (req.turns.length === 0) {
    return base;
  }
  const messages: unknown[] = [{ role: 'system', content: req.systemPrompt }];
  for (const turn of req.turns) messages.push(...toOpenAIMessages(turn));
  return { ...base, messages };
}

export async function callOpenAI(req: ProviderRequest): Promise<ProviderResponse> {
  const built = buildOpenAIBody(req);
  const messages: unknown[] =
    built.messages && built.messages.length > 0
      ? (built.messages as unknown[])
      : [{ role: 'system', content: req.systemPrompt }];

  const body = { ...built, messages };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const nf = detectModelNotFound('openai', req.model, res.status, text);
    if (nf) {
      return {
        stopReason: 'error',
        rawError: modelNotFoundMessage(nf),
        errorKind: 'model_not_found',
      };
    }
    const rl = detectRateLimit('openai', res.status, res.headers, text);
    if (rl) {
      return {
        stopReason: 'error',
        rawError: `openai 429: ${text.slice(0, 500)}`,
        errorKind: 'rate_limit',
        retryAfterSec: rl.retryAfterSec,
      };
    }
    return { stopReason: 'error', rawError: `openai ${res.status}: ${text.slice(0, 500)}` };
  }

  const json = (await res.json()) as OpenAIResponse;
  const choice = json.choices?.[0];
  if (!choice) return { stopReason: 'error', rawError: 'openai: empty choices' };

  const textOut = choice.message.content ?? '';
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: safeJson(tc.function.arguments),
  }));

  return {
    text: textOut || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    stopReason: mapStop(choice.finish_reason),
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

function toOpenAITool(t: ToolSchema) {
  return {
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: sortRecordKeys(t.inputSchema) as Record<string, unknown>,
    },
  };
}

function toOpenAIMessages(turn: ChatTurn): unknown[] {
  const out: unknown[] = [];
  if (turn.role === 'assistant') {
    out.push({
      role: 'assistant',
      content: turn.text ?? null,
      tool_calls: turn.toolCalls?.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(sortRecordKeys(tc.input) as Record<string, unknown>),
        },
      })),
    });
  } else {
    if (turn.text) out.push({ role: 'user', content: turn.text });
    if (turn.toolResults) {
      for (const tr of turn.toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content });
      }
    }
  }
  return out;
}

function mapStop(r: string | undefined): ProviderResponse['stopReason'] {
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return 'end_turn';
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return sortRecordKeys(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}
