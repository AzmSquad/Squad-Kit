import type { ProviderName } from './types.js';

export interface ModelNotFoundError {
  provider: ProviderName;
  model: string;
  status: number;
  rawBody: string;
}

/**
 * Detect the "model not found" shape across providers. Returns a `ModelNotFoundError` when
 * the response matches, or `undefined` otherwise.
 *
 * Shapes detected:
 *   Anthropic: 404 with body.error.type === 'not_found_error' OR body text containing "model:"
 *   OpenAI:    404 with body.error.code === 'model_not_found'
 *   Google:    404 with body.error.status === 'NOT_FOUND' containing the model name
 */
export function detectModelNotFound(
  provider: ProviderName,
  model: string,
  status: number,
  rawBody: string,
): ModelNotFoundError | undefined {
  if (status !== 404) return undefined;
  const body = rawBody.toLowerCase();
  const hints = ['not_found_error', 'model_not_found', 'not_found', 'model:'];
  if (!hints.some((h) => body.includes(h))) return undefined;
  return { provider, model, status, rawBody };
}

/**
 * Build the user-facing message. Kept as a separate function so callers can choose whether
 * to embed it in a thrown Error (from the provider adapter) or render via ui.failure.
 */
export function modelNotFoundMessage(err: ModelNotFoundError): string {
  return [
    `The ${err.provider} planner model "${err.model}" is no longer available.`,
    '',
    'Recovery options:',
    `  1. Run \`squad upgrade\` to install a newer squad-kit (or install manually from npm).`,
    `  2. Run \`squad config set planner --provider openai\` (or another \`--provider\`) to switch models via a different provider, then save a key when prompted.`,
    `  3. Run \`squad config set planner\` to set \`planner.modelOverride.${err.provider}\` to a still-valid id (no raw YAML), then \`squad doctor\` to confirm.`,
    '',
    `Raw provider response: ${err.rawBody.slice(0, 200)}`,
  ].join('\n');
}
