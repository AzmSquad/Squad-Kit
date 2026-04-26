import { describe, it, expect } from 'vitest';
import { maskToken } from '../src/core/mask-token.js';

describe('maskToken', () => {
  it('returns null for empty', () => {
    expect(maskToken()).toBeNull();
    expect(maskToken('')).toBeNull();
  });

  it('short strings show dots and last 2', () => {
    expect(maskToken('12345678')).toBe('••••78');
  });

  it('long strings use prefix, ellipsis, suffix', () => {
    const t = 'sk-anthropic-abcdefghijklmnop';
    expect(maskToken(t)).toBe(`${t.slice(0, 4)}…${t.slice(-4)}`);
  });
});
