import { describe, it, expect } from 'vitest';
import { resolveModel } from '../src/planner/providers/index.js';

describe('resolveModel', () => {
  it('returns a LanguageModelV2 with the requested provider and model id', () => {
    const { provider, modelId, model } = resolveModel('anthropic', 'claude-opus-4-7', 'sk-test');
    expect(provider).toBe('anthropic');
    expect(modelId).toBe('claude-opus-4-7');
    expect(model.modelId).toBe('claude-opus-4-7');
    expect(model.provider).toBe('anthropic.messages');
  });

  it('keeps OpenAI on the Chat Completions API', () => {
    expect(resolveModel('openai', 'gpt-5', 'sk-test').model.provider).toBe('openai.chat');
  });
});
