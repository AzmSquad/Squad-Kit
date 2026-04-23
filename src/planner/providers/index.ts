import type { PlannerProvider, ProviderName } from '../types.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { googleProvider } from './google.js';

export function providerFor(name: ProviderName): PlannerProvider {
  switch (name) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'google':
      return googleProvider;
  }
}

export { anthropicProvider, openaiProvider, googleProvider };
