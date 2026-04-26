import { describe, expect, it } from 'vitest';
import { readPresentedToken, timingSafeEqualHex } from '../src/console/auth.js';

describe('readPresentedToken', () => {
  it('reads Bearer token from Authorization', () => {
    const req = new Request('http://x/api/meta', {
      headers: { authorization: 'Bearer xyz' },
    });
    expect(readPresentedToken(req)).toBe('xyz');
  });

  it('is case-insensitive for bearer prefix', () => {
    const req = new Request('http://x/api/meta', {
      headers: { authorization: 'Bearer  abc' },
    });
    expect(readPresentedToken(req)).toBe('abc');
  });

  it('reads token from ?t= query', () => {
    const req = new Request('http://x/api/meta?t=hello&other=1');
    expect(readPresentedToken(req)).toBe('hello');
  });

  it('returns null when both are missing', () => {
    const req = new Request('http://x/api/meta');
    expect(readPresentedToken(req)).toBeNull();
  });

  it('prefers Authorization over query when both present', () => {
    const req = new Request('http://x/api/meta?t=q', {
      headers: { authorization: 'Bearer from-header' },
    });
    expect(readPresentedToken(req)).toBe('from-header');
  });
});

describe('timingSafeEqualHex', () => {
  it('rejects length mismatch', () => {
    expect(timingSafeEqualHex('aa', 'a')).toBe(false);
  });

  it('rejects equal-length mismatch', () => {
    expect(timingSafeEqualHex('ab', 'ac')).toBe(false);
  });

  it('accepts exact match', () => {
    expect(timingSafeEqualHex('abc', 'abc')).toBe(true);
  });
});
