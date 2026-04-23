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

/** Headers look-up that accepts both fetch `Headers` and plain records. */
export type HeadersLike = Headers | Record<string, string | null | undefined>;

export interface RateLimitError {
  provider: ProviderName;
  status: 429;
  /** Seconds until the provider expects us to retry, if it told us. */
  retryAfterSec?: number;
  rawBody: string;
}

/**
 * Detect a 429 rate-limit response. Returns a `RateLimitError` when the status is 429,
 * populating `retryAfterSec` from the `Retry-After` header (seconds or HTTP-date) or from
 * Google's body-level `retryDelay: "30s"` field. Returns `undefined` for any other status.
 */
export function detectRateLimit(
  provider: ProviderName,
  status: number,
  headers: HeadersLike,
  rawBody: string,
): RateLimitError | undefined {
  if (status !== 429) return undefined;
  return {
    provider,
    status: 429,
    retryAfterSec: parseRetryAfter(headers, rawBody),
    rawBody,
  };
}

function parseRetryAfter(headers: HeadersLike, body: string): number | undefined {
  const raw = headerGet(headers, 'retry-after');
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec);
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    }
  }
  const bodyMatch = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/i.exec(body);
  if (bodyMatch) {
    const sec = Number(bodyMatch[1]);
    if (Number.isFinite(sec) && sec >= 0) return sec;
  }
  return undefined;
}

function headerGet(h: HeadersLike, name: string): string | null {
  if (typeof (h as Headers).get === 'function') {
    return (h as Headers).get(name);
  }
  const key = name.toLowerCase();
  const rec = h as Record<string, string | null | undefined>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === key) return rec[k] ?? null;
  }
  return null;
}

export interface RateLimitMessageInput {
  provider: ProviderName;
  retryAfterSec?: number;
  rawBody: string;
  /** True when squad-kit already retried once and got rate-limited again. */
  retryAlreadyAttempted?: boolean;
}

/**
 * User-facing rate-limit message. Composed by the loop when rate-limit retry has been
 * exhausted. Callers in the provider adapters set `errorKind: 'rate_limit'` and let the
 * loop compose this message so the "already retried" sentence reflects reality.
 */
export function rateLimitMessage(err: RateLimitMessageInput): string {
  const waitHint = err.retryAfterSec ?? 60;
  const limitsUrl: Record<ProviderName, string> = {
    anthropic: 'https://console.anthropic.com/settings/limits',
    openai: 'https://platform.openai.com/settings/organization/limits',
    google: 'https://aistudio.google.com/app/plan_information',
  };
  const headline = err.retryAfterSec
    ? `${err.provider} rate limit hit \u2014 provider asked us to wait ${err.retryAfterSec}s before retrying.`
    : `${err.provider} rate limit hit.`;
  const retried = err.retryAlreadyAttempted
    ? 'squad-kit already retried once automatically and was throttled again \u2014 your org is firmly over its per-minute quota.'
    : 'squad-kit aborted before retrying.';
  return [
    headline,
    retried,
    '',
    'Recovery options:',
    `  1. Wait ${waitHint}s and rerun \`squad new-plan --api\`. Per-minute limits reset quickly.`,
    `  2. Switch to a smaller planner model: \`squad config set planner\` (pick a cheaper model id).`,
    `  3. Tighten \`planner.budget\` in \`.squad/config.yaml\` (smaller \`maxContextBytes\` / \`maxFileReads\`) so each request carries fewer tokens.`,
    `  4. Upgrade your ${err.provider} tier: ${limitsUrl[err.provider]}.`,
    '',
    'Full runbook: docs/migrating-from-0.1.md (see \u00a78. If something goes wrong).',
    '',
    `Raw provider response: ${err.rawBody.slice(0, 200)}`,
  ].join('\n');
}
