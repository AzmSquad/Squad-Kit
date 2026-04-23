import { describe, it, expect } from 'vitest';
import { readBundledPrompt } from '../src/utils/fs.js';

describe('readBundledPrompt', () => {
  it('returns intake.md with expected heading', () => {
    const s = readBundledPrompt('intake.md');
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain('# Story intake');
  });

  it('returns non-empty generate-plan.md', () => {
    const s = readBundledPrompt('generate-plan.md');
    expect(s.length).toBeGreaterThan(0);
  });

  it('returns non-empty story-skeleton.md', () => {
    const s = readBundledPrompt('story-skeleton.md');
    expect(s.length).toBeGreaterThan(0);
  });

  it('rejects unknown prompt names at compile time', () => {
    expect(() => {
      // @ts-expect-error invalid prompt name
      readBundledPrompt('unknown.md');
    }).toThrow();
  });
});
