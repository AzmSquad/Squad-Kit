import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';

/** One block of model text as an AI SDK 5 model streams it: start, the text, end. */
export function textParts(delta: string, id = 'text-1'): LanguageModelV2StreamPart[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
  ];
}
