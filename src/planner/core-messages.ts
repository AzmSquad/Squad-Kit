import type { ModelMessage } from 'ai';
import type { ChatTurn, ProviderName } from './types.js';
import { SCOUTED_USER_MESSAGE_CACHE_SENTINEL } from './system-prompt.js';

export function turnsToCoreMessages(
  systemPrompt: string,
  turns: ChatTurn[],
  opts: { cacheEnabled: boolean; provider: ProviderName },
): ModelMessage[] {
  const { cacheEnabled, provider } = opts;
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
      ...(cacheEnabled && provider === 'anthropic'
        ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
        : {}),
    },
  ];

  let lastToolMessageIndex = -1;

  for (const t of turns) {
    if (t.role === 'user') {
      if (t.text !== undefined && t.text.length > 0) {
        const userMsg: ModelMessage = { role: 'user', content: t.text };
        if (
          cacheEnabled &&
          provider === 'anthropic' &&
          t.text.startsWith(SCOUTED_USER_MESSAGE_CACHE_SENTINEL)
        ) {
          userMsg.providerOptions = {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          };
        }
        messages.push(userMsg);
      }
      if (t.toolResults?.length) {
        const msg: ModelMessage = {
          role: 'tool',
          content: t.toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            // A JSON output keeps the wire format the planner has always sent: providers JSON-encode the
            // text, and an error result still reaches the model flagged as an error.
            output: tr.isError
              ? { type: 'error-json' as const, value: tr.content }
              : { type: 'json' as const, value: tr.content },
          })),
        };
        lastToolMessageIndex = messages.push(msg) - 1;
      }
    } else {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
      > = [];
      if (t.text) parts.push({ type: 'text', text: t.text });
      for (const tc of t.toolCalls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.name,
          input: tc.input,
        });
      }
      if (parts.length === 0) continue;
      if (parts.length === 1 && parts[0]!.type === 'text') {
        messages.push({ role: 'assistant', content: parts[0]!.text });
      } else {
        messages.push({ role: 'assistant', content: parts });
      }
    }
  }

  if (cacheEnabled && provider === 'anthropic' && lastToolMessageIndex >= 0) {
    const target = messages[lastToolMessageIndex]!;
    if (target.role === 'tool') {
      target.providerOptions = {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      };
    }
  }

  return messages;
}
