import { describe, it, expect } from 'vitest';
import { composeSystemPrompt, composeUserPrompt } from '../src/planner/system-prompt.js';

describe('composeSystemPrompt', () => {
  it('substitutes template vars and appends API preamble with repo tree', () => {
    const out = composeSystemPrompt({
      projectRoots: ['src', 'lib'],
      primaryLanguage: 'ts',
      trackerType: 'jira',
      repoMap: 'a.txt\nb.ts',
    });
    expect(out).toContain('src, lib');
    expect(out).toContain('ts');
    expect(out).toContain('jira');
    expect(out).toContain('Direct-API mode notes');
    expect(out).toContain('a.txt');
    expect(out).toContain('b.ts');
    expect(out).toContain('The intake story is provided in the user message');
  });
});

describe('composeUserPrompt', () => {
  it('inlines intake content', () => {
    const body = '## Story\n\nHello.';
    const out = composeUserPrompt({ intakeContent: body });
    expect(out).toContain(body);
    expect(out).toContain('Produce the implementation plan');
  });
});
