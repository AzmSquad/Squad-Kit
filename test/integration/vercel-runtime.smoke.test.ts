import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/planner/providers/index.js';
import { generateText } from 'ai';

const SHOULD_RUN = !!process.env.SQUAD_INTEGRATION_TEST && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!SHOULD_RUN)('Vercel runtime smoke', () => {
  it('completes a one-shot generation against Anthropic', async () => {
    const { model } = resolveModel('anthropic', 'claude-3-5-haiku-20241022', process.env.ANTHROPIC_API_KEY!);
    const { text, usage } = await generateText({
      model,
      prompt: 'Reply with exactly the word PASS and nothing else.',
      maxOutputTokens: 16,
    });
    expect(text.trim()).toBe('PASS');
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });
});
