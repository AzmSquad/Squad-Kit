import type { LanguageModelUsage } from 'ai';
import type { Usage } from './types.js';

/** Map Agent SDK / Anthropic usage blocks to planner `Usage` (cache fields often null). */
export function usageFromAgentSdkResult(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null | undefined): Usage {
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const out: Usage = {
    inputTokens: inTok ?? 0,
    outputTokens: outTok ?? 0,
  };
  const cc = usage?.cache_creation_input_tokens;
  const cr = usage?.cache_read_input_tokens;
  if (cc != null && cc > 0) out.cacheCreationTokens = cc;
  if (cr != null && cr > 0) out.cacheReadTokens = cr;
  return out;
}

export function usageFromLanguageModelStep(
  usage: LanguageModelUsage,
  providerMetadata: unknown,
): Usage {
  const out: Usage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  const meta = providerMetadata as
    | {
        anthropic?: {
          cacheCreationInputTokens?: number | null;
        };
      }
    | undefined;
  const a = meta?.anthropic;
  if (a) {
    out.cacheCreationTokens = a.cacheCreationInputTokens ?? 0;
    // Anthropic cache reads arrive on the usage itself; cache writes stay in provider metadata.
    out.cacheReadTokens = usage.cachedInputTokens ?? 0;
  }
  return out;
}
