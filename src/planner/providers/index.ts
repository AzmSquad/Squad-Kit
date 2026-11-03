import type { LanguageModelV2 } from '@ai-sdk/provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderName } from '../types.js';

export interface ResolvedModel {
  provider: ProviderName;
  model: LanguageModelV2;
  /** Model id used in plan headers and telemetry (same string passed in). */
  modelId: string;
}

/**
 * Fixed API addresses. The providers now also read `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, which other
 * tools on the machine may set (often without `/v1`); the planner has always called the public APIs.
 */
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1';
const OPENAI_API_URL = 'https://api.openai.com/v1';

export function resolveModel(provider: ProviderName, modelId: string, apiKey: string): ResolvedModel {
  switch (provider) {
    case 'anthropic':
      return { provider, model: createAnthropic({ apiKey, baseURL: ANTHROPIC_API_URL })(modelId), modelId };
    case 'openai':
      // `.chat()` keeps the Chat Completions API the planner has always used (the default is now Responses).
      return { provider, model: createOpenAI({ apiKey, baseURL: OPENAI_API_URL }).chat(modelId), modelId };
    case 'google':
      return { provider, model: createGoogleGenerativeAI({ apiKey })(modelId), modelId };
  }
}
