import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapToken } from './client';

const TOKEN_KEY = 'squad.console.token';

describe('bootstrapToken', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('reads ?t= from the URL, stores it, and strips the query param', () => {
    const href = 'http://127.0.0.1:5173/dashboard?t=abc123&x=1';
    vi.stubGlobal(
      'location',
      new URL(href) as unknown as Location & string,
    );
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    expect(bootstrapToken()).toBe('abc123');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('abc123');
    expect(replaceState).toHaveBeenCalled();
    const [, , third] = replaceState.mock.calls[0] ?? [];
    expect(String(third)).toContain('http://127.0.0.1:5173/dashboard');
    expect(String(third)).not.toContain('t=');
  });

  it('returns session value when the URL has no token', () => {
    sessionStorage.setItem(TOKEN_KEY, 'stored');
    vi.stubGlobal('location', new URL('http://127.0.0.1:5173/') as unknown as Location & string);
    expect(bootstrapToken()).toBe('stored');
  });
});
