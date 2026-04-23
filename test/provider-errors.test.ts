import { describe, it, expect } from 'vitest';
import { detectModelNotFound, modelNotFoundMessage } from '../src/planner/provider-errors.js';

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
