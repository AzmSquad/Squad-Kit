import type {
  ChatTurn,
  PlannerProvider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolSchema,
} from '../types.js';
import {
  detectModelNotFound,
  detectRateLimit,
  modelNotFoundMessage,
} from '../provider-errors.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const anthropicProvider: PlannerProvider = {
  name: 'anthropic',
  async send(req) {
    return callAnthropic(req);
  },
};

export async function callAnthropic(req: ProviderRequest): Promise<ProviderResponse> {
  const body = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 4096,
    system: req.systemPrompt,
    tools: req.tools.map(toAnthropicTool),
    messages: req.turns.map(toAnthropicMessage),
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': req.apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const nf = detectModelNotFound('anthropic', req.model, res.status, text);
    if (nf) {
      return {
        stopReason: 'error',
        rawError: modelNotFoundMessage(nf),
        errorKind: 'model_not_found',
      };
    }
    const rl = detectRateLimit('anthropic', res.status, res.headers, text);
    if (rl) {
      return {
        stopReason: 'error',
        rawError: `anthropic 429: ${text.slice(0, 500)}`,
        errorKind: 'rate_limit',
        retryAfterSec: rl.retryAfterSec,
      };
    }
    return { stopReason: 'error', rawError: `anthropic ${res.status}: ${text.slice(0, 500)}` };
  }

  const json = (await res.json()) as AnthropicResponse;
  const textOut = json.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls: ToolCall[] = json.content
    .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

  return {
    text: textOut || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    stopReason: mapStop(json.stop_reason),
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}

function toAnthropicTool(t: ToolSchema) {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

function toAnthropicMessage(turn: ChatTurn) {
  const blocks: unknown[] = [];
  if (turn.text) blocks.push({ type: 'text', text: turn.text });
  if (turn.toolCalls)
    for (const tc of turn.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  if (turn.toolResults)
    for (const tr of turn.toolResults)
      blocks.push({
        type: 'tool_result',
        tool_use_id: tr.toolCallId,
        content: tr.content,
        is_error: tr.isError ?? false,
      });
  return { role: turn.role === 'assistant' ? 'assistant' : 'user', content: blocks };
}

function mapStop(r: string | undefined): ProviderResponse['stopReason'] {
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

interface AnthropicResponse {
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
