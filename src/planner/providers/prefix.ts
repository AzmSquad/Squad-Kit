import { buildAnthropicBody } from './anthropic.js';
import { buildOpenAIBody } from './openai.js';
import { buildGoogleBody } from './google.js';
import type { ProviderName, ProviderRequest } from '../types.js';

/**
 * Return a string suitable for comparing cacheable request prefixes across turns: the full
 * JSON for the provider body after removing the last chat turn, with the terminal `}` stripped
 * so a shorter request's prefix is a literal substring prefix of a longer one when new fields
 * are appended (e.g. `messages` / `contents`) in deterministic `build*Body` order.
 */
export function prefixOf(provider: ProviderName, req: ProviderRequest): string {
  const trimmed: ProviderRequest = { ...req, turns: req.turns.slice(0, -1) };
  const s = (() => {
    switch (provider) {
      case 'anthropic':
        return JSON.stringify(buildAnthropicBody(trimmed));
      case 'openai':
        return JSON.stringify(buildOpenAIBody(trimmed));
      case 'google':
        return JSON.stringify(buildGoogleBody(trimmed));
    }
  })();
  return s.length > 0 ? s.slice(0, -1) : s;
}
