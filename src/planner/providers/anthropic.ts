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

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

type AnthropicSystemTextBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type AnthropicContentBlock = Record<string, unknown>;

type AnthropicMessageWire = {
  role: 'assistant' | 'user';
  content: AnthropicContentBlock[];
};

/**
 * Request JSON sent to the Anthropic messages API. When `turns` is empty, `messages` is
 * omitted so cache-prefix comparisons treat the static header as a literal string prefix
 * of longer requests; `callAnthropic` re-adds `messages: []` for the wire.
 */
export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system: string | AnthropicSystemTextBlock[];
  tools: ReturnType<typeof toAnthropicTool>[];
  messages?: AnthropicMessageWire[];
};

export const anthropicProvider: PlannerProvider = {
  name: 'anthropic',
  async send(req) {
    return callAnthropic(req);
  },
};

export function buildAnthropicBody(req: ProviderRequest): AnthropicRequestBody {
  if (req.cacheEnabled === false) {
    const base: AnthropicRequestBody = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 4096,
      system: req.systemPrompt,
      tools: req.tools.map(toAnthropicTool),
    };
    if (req.turns.length === 0) {
      return base;
    }
    return { ...base, messages: req.turns.map((t) => toAnthropicMessage(t)) };
  }

  const base: AnthropicRequestBody = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 4096,
    system: [
      {
        type: 'text',
        text: req.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: req.tools.map(toAnthropicTool),
  };
  if (req.turns.length === 0) {
    return base;
  }
  return { ...base, messages: toMessagesWithCacheMarkers(req.turns) };
}

export async function callAnthropic(req: ProviderRequest): Promise<ProviderResponse> {
  const built = buildAnthropicBody(req);
  const body: AnthropicRequestBody = { ...built, messages: built.messages ?? [] };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': req.apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: req.abort,
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
      cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function toMessagesWithCacheMarkers(turns: ChatTurn[]): AnthropicMessageWire[] {
  let lastUserWithToolResultIdx = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role === 'user' && hasToolResultBlock(t)) {
      lastUserWithToolResultIdx = i;
      break;
    }
  }

  return turns.map((turn, idx) => {
    const message = toAnthropicMessage(turn);
    if (idx === lastUserWithToolResultIdx) {
      return attachCacheControlToLastToolResult(message);
    }
    return message;
  });
}

function hasToolResultBlock(turn: ChatTurn): boolean {
  return (turn.toolResults?.length ?? 0) > 0;
}

function attachCacheControlToLastToolResult(msg: AnthropicMessageWire): AnthropicMessageWire {
  const content = [...msg.content];
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i] as { type?: string };
    if (block.type === 'tool_result') {
      content[i] = { ...block, cache_control: { type: 'ephemeral' } };
      break;
    }
  }
  return { ...msg, content };
}

function toAnthropicTool(t: ToolSchema) {
  return {
    name: t.name,
    description: t.description,
    input_schema: sortRecordKeys(t.inputSchema) as Record<string, unknown>,
  };
}

function toAnthropicMessage(turn: ChatTurn): AnthropicMessageWire {
  const blocks: AnthropicContentBlock[] = [];
  if (turn.text) blocks.push({ type: 'text', text: turn.text });
  if (turn.toolCalls) {
    for (const tc of turn.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: sortRecordKeys(tc.input) as Record<string, unknown>,
      });
    }
  }
  if (turn.toolResults) {
    for (const tr of turn.toolResults) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: tr.toolCallId,
        content: tr.content,
        is_error: tr.isError ?? false,
      });
    }
  }
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
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
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
