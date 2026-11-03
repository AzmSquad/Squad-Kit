import { describe, it, expect } from 'vitest';
import { usageFromLanguageModelStep } from '../src/planner/usage-map.js';
import type { LanguageModelUsage } from 'ai';

describe('usageFromLanguageModelStep (Anthropic cache fields)', () => {
  it('maps cache writes from provider metadata and cache reads from the usage', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 800,
    };
    const meta = {
      anthropic: {
        cacheCreationInputTokens: 2000,
      },
    };
    expect(usageFromLanguageModelStep(usage, meta)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 2000,
      cacheReadTokens: 800,
    });
  });

  it('treats missing cache fields as zero', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
    expect(usageFromLanguageModelStep(usage, undefined)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
