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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const googleProvider: PlannerProvider = {
  name: 'google',
  async send(req) {
    return callGoogle(req);
  },
};

export async function callGoogle(req: ProviderRequest): Promise<ProviderResponse> {
  const url = `${API_BASE}/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: req.systemPrompt }] },
    contents: req.turns.map(toGoogleContent),
    tools: req.tools.length ? [{ functionDeclarations: req.tools.map(toGoogleTool) }] : undefined,
    generationConfig: { maxOutputTokens: req.maxOutputTokens ?? 4096 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const nf = detectModelNotFound('google', req.model, res.status, text);
    if (nf) {
      return {
        stopReason: 'error',
        rawError: modelNotFoundMessage(nf),
        errorKind: 'model_not_found',
      };
    }
    const rl = detectRateLimit('google', res.status, res.headers, text);
    if (rl) {
      return {
        stopReason: 'error',
        rawError: `google 429: ${text.slice(0, 500)}`,
        errorKind: 'rate_limit',
        retryAfterSec: rl.retryAfterSec,
      };
    }
    return { stopReason: 'error', rawError: `google ${res.status}: ${text.slice(0, 500)}` };
  }

  const json = (await res.json()) as GoogleResponse;
  const cand = json.candidates?.[0];
  if (!cand) return { stopReason: 'error', rawError: 'google: empty candidates' };

  const parts = cand.content?.parts ?? [];
  const textOut = parts
    .filter((p): p is GoogleTextPart => 'text' in p && !!p.text)
    .map((p) => p.text)
    .join('');
  const toolCalls: ToolCall[] = parts
    .filter((p): p is GoogleFunctionCallPart => 'functionCall' in p && !!p.functionCall)
    .map((p, i) => ({
      id: `gcall_${i}_${p.functionCall.name}`,
      name: p.functionCall.name,
      input: p.functionCall.args ?? {},
    }));

  return {
    text: textOut || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    stopReason: mapStop(cand.finishReason),
    usage: {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function toGoogleTool(t: ToolSchema) {
  return { name: t.name, description: t.description, parameters: t.inputSchema };
}

function toGoogleContent(turn: ChatTurn) {
  const role = turn.role === 'assistant' ? 'model' : 'user';
  const parts: unknown[] = [];
  if (turn.text) parts.push({ text: turn.text });
  if (turn.toolCalls)
    for (const tc of turn.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.input } });
  if (turn.toolResults) {
    for (const tr of turn.toolResults) {
      parts.push({
        functionResponse: { name: nameFromToolCallId(tr.toolCallId), response: { content: tr.content } },
      });
    }
  }
  return { role, parts };
}

function nameFromToolCallId(id: string): string {
  const m = id.match(/^gcall_\d+_(.+)$/);
  return m?.[1] ?? 'read_file';
}

function mapStop(r: string | undefined): ProviderResponse['stopReason'] {
  if (r === 'STOP' || r === 'END_OF_TURN' || r === 'FINISH_REASON_STOP') return 'end_turn';
  if (r === 'MAX_TOKENS') return 'max_tokens';
  return 'tool_use';
}

interface GoogleResponse {
  candidates?: Array<{
    content?: { parts?: Array<GoogleTextPart | GoogleFunctionCallPart> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}
interface GoogleTextPart {
  text: string;
}
interface GoogleFunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
}
