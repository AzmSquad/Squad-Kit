import { describe, it, expect } from 'vitest';
import { providerFor, anthropicProvider, openaiProvider, googleProvider } from '../src/planner/providers/index.js';

describe('providerFor', () => {
  it('returns the matching provider instance for each name', () => {
    expect(providerFor('anthropic')).toBe(anthropicProvider);
    expect(providerFor('openai')).toBe(openaiProvider);
    expect(providerFor('google')).toBe(googleProvider);
  });
});
