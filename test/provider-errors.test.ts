import { describe, it, expect } from 'vitest';
import {
  detectModelNotFound,
  detectRateLimit,
  modelNotFoundMessage,
  rateLimitMessage,
} from '../src/planner/provider-errors.js';

describe('detectModelNotFound', () => {
  it('returns ModelNotFoundError for Anthropic 404 with not_found_error body', () => {
    const raw = JSON.stringify({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: claude-bogus' },
    });
    const nf = detectModelNotFound('anthropic', 'claude-bogus', 404, raw);
    expect(nf).toEqual({
      provider: 'anthropic',
      model: 'claude-bogus',
      status: 404,
      rawBody: raw,
    });
  });

  it('returns undefined for a non-404 status', () => {
    const raw = JSON.stringify({ error: { type: 'not_found_error' } });
    expect(detectModelNotFound('anthropic', 'm', 500, raw)).toBeUndefined();
  });

  it('returns undefined for a 404 without the expected hints', () => {
    expect(detectModelNotFound('anthropic', 'm', 404, '{"error":"nope"}')).toBeUndefined();
  });

  it('matches OpenAI model_not_found body', () => {
    const raw = JSON.stringify({
      error: { message: 'The model `x` does not exist', code: 'model_not_found' },
    });
    const nf = detectModelNotFound('openai', 'gpt-bogus', 404, raw);
    expect(nf?.provider).toBe('openai');
    expect(nf?.model).toBe('gpt-bogus');
  });

  it('matches Google NOT_FOUND body', () => {
    const raw = JSON.stringify({
      error: { code: 404, message: 'models/gemini-bogus is not found', status: 'NOT_FOUND' },
    });
    const nf = detectModelNotFound('google', 'gemini-bogus', 404, raw);
    expect(nf?.provider).toBe('google');
    expect(nf?.model).toBe('gemini-bogus');
  });
});

describe('modelNotFoundMessage', () => {
  it('includes recovery paths and provider/model names', () => {
    const msg = modelNotFoundMessage({
      provider: 'anthropic',
      model: 'claude-x',
      status: 404,
      rawBody: '{}',
    });
    expect(msg).toContain('anthropic');
    expect(msg).toContain('claude-x');
    expect(msg).toContain('Run `squad upgrade`');
    expect(msg).toContain('squad config set planner');
    expect(msg).toContain('planner.modelOverride.anthropic');
    expect(msg).toContain('squad doctor');
  });
});

describe('detectRateLimit', () => {
  it('returns undefined for non-429 statuses', () => {
    expect(detectRateLimit('anthropic', 500, new Headers(), 'x')).toBeUndefined();
    expect(detectRateLimit('anthropic', 200, new Headers(), 'x')).toBeUndefined();
  });

  it('parses a numeric retry-after header', () => {
    const headers = new Headers({ 'retry-after': '45' });
    const rl = detectRateLimit('anthropic', 429, headers, '{}');
    expect(rl).toBeDefined();
    expect(rl?.retryAfterSec).toBe(45);
    expect(rl?.provider).toBe('anthropic');
    expect(rl?.status).toBe(429);
  });

  it('parses an HTTP-date retry-after header relative to now', () => {
    const target = new Date(Date.now() + 20_000).toUTCString();
    const headers = new Headers({ 'Retry-After': target });
    const rl = detectRateLimit('openai', 429, headers, '{}');
    expect(rl?.retryAfterSec).toBeGreaterThanOrEqual(19);
    expect(rl?.retryAfterSec).toBeLessThanOrEqual(21);
  });

  it("parses Google's body-level retryDelay when the header is absent", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
      },
    });
    const rl = detectRateLimit('google', 429, new Headers(), body);
    expect(rl?.retryAfterSec).toBe(30);
  });

  it('returns a rate-limit result with no retryAfterSec when provider gave no hint', () => {
    const rl = detectRateLimit('anthropic', 429, new Headers(), '{}');
    expect(rl).toBeDefined();
    expect(rl?.retryAfterSec).toBeUndefined();
  });

  it('accepts plain-record headers as well as fetch Headers', () => {
    const rl = detectRateLimit('anthropic', 429, { 'retry-after': '12' }, '{}');
    expect(rl?.retryAfterSec).toBe(12);
  });
});

describe('rateLimitMessage', () => {
  it('mentions wait time, all four recovery options, and the provider-specific limits URL', () => {
    const msg = rateLimitMessage({
      provider: 'anthropic',
      retryAfterSec: 45,
      rawBody: '{"error":{"type":"rate_limit_error"}}',
      retryAlreadyAttempted: true,
    });
    expect(msg).toContain('anthropic rate limit hit');
    expect(msg).toContain('45s');
    expect(msg).toContain('already retried once');
    expect(msg).toContain('squad config set planner');
    expect(msg).toContain('planner.budget');
    expect(msg).toContain('console.anthropic.com/settings/limits');
    expect(msg).toContain('migrating-from-0.1');
    expect(msg).not.toContain('verify models and credentials');
  });

  it('falls back to a 60s hint when the provider gave no retry-after', () => {
    const msg = rateLimitMessage({
      provider: 'openai',
      retryAfterSec: undefined,
      rawBody: '',
      retryAlreadyAttempted: false,
    });
    expect(msg).toContain('openai rate limit hit.');
    expect(msg).toContain('Wait 60s');
    expect(msg).toContain('aborted before retrying');
    expect(msg).toContain('platform.openai.com');
  });

  it('includes the google limits URL for google-provider errors', () => {
    const msg = rateLimitMessage({
      provider: 'google',
      rawBody: '',
    });
    expect(msg).toContain('aistudio.google.com');
  });

  it('explains the retry-skipped case when provider asks beyond our cap', () => {
    const msg = rateLimitMessage({
      provider: 'anthropic',
      retryAfterSec: 132,
      rawBody: 'anthropic 429: quota',
      retrySkippedReason: 'retry_after_too_long',
      maxRetrySec: 90,
    });
    expect(msg).toContain('did not auto-retry');
    expect(msg).toContain('132s wait is longer than our 90s cap');
    expect(msg).not.toContain('already retried');
    expect(msg).not.toContain('aborted before retrying');
  });

  it('uses the 90s default cap when maxRetrySec is not provided for a skipped retry', () => {
    const msg = rateLimitMessage({
      provider: 'anthropic',
      retryAfterSec: 200,
      rawBody: '',
      retrySkippedReason: 'retry_after_too_long',
    });
    expect(msg).toContain('longer than our 90s cap');
  });
});
