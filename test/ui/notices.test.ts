import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_MS, afterAsking, askPermission, type NotificationLike, type Permission } from '../../console-ui/src/lib/notices.js';

/**
 * Turn on for desktop notices always ends in an answer the person sees: the browser said yes or no, or never
 * answered (a quiet bell in the address bar, an embedded browser), or threw, or the page is not a secure one.
 */

/** A browser's Notification that answers the way a test says. */
function browser(permission: Permission, answer: (cb?: (p: Permission) => void) => Promise<Permission> | undefined): NotificationLike & { asked: number } {
  const n = {
    permission,
    asked: 0,
    requestPermission(cb?: (p: Permission) => void) {
      n.asked += 1;
      return answer(cb);
    },
  };
  return n;
}

afterEach(() => vi.useRealTimers());

describe('asking the browser for desktop notices', () => {
  it('takes the answer from a promise or from a callback', async () => {
    expect(await askPermission(browser('default', async (): Promise<Permission> => 'granted'), { secure: true })).toBe('granted');
    expect(await askPermission(browser('default', (cb) => (cb?.('denied'), undefined)), { secure: true })).toBe('denied');
    expect(await askPermission(browser('default', async (): Promise<Permission> => 'default'), { secure: true })).toBe('default');
  });

  it('does not ask again when the browser decided already', async () => {
    const n = browser('denied', async (): Promise<Permission> => 'granted');
    expect(await askPermission(n, { secure: true })).toBe('denied');
    expect(n.asked).toBe(0);
  });

  it('says the browser has not answered after 8 seconds, when it never does', async () => {
    vi.useFakeTimers();
    const never = browser('default', () => new Promise(() => undefined));
    let got: string | undefined;
    void askPermission(never, { secure: true }).then((a) => (got = a));
    await vi.advanceTimersByTimeAsync(ASK_MS - 1);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBe('timeout');
    expect(ASK_MS).toBe(8000);
  });

  it('ends in an answer when asking throws, answers with nothing, or rejects', async () => {
    vi.useFakeTimers();
    const throws = browser('default', () => {
      throw new Error('not allowed here');
    });
    expect(await askPermission(throws, { secure: true })).toBe('error');
    const rejects = browser('default', () => Promise.reject(new Error('no')));
    expect(await askPermission(rejects, { secure: true })).toBe('error');
    // Nothing back and no callback: the wait ends it.
    const silent = browser('default', () => undefined);
    const p = askPermission(silent, { secure: true });
    await vi.advanceTimersByTimeAsync(ASK_MS);
    expect(await p).toBe('timeout');
  });

  it('never asks from a page that is not secure, or a browser without notices', async () => {
    const n = browser('default', async (): Promise<Permission> => 'granted');
    expect(await askPermission(n, { secure: false })).toBe('insecure');
    expect(n.asked).toBe(0);
    expect(await askPermission(undefined, { secure: true })).toBe('unsupported');
  });
});

describe('what the page says after asking', () => {
  it('on yes: a test notice, and what to check if it did not show', () => {
    expect(afterAsking('granted')).toEqual({ choice: 'on', test: true, bad: false, say: "Desktop notices are on. Didn't see one just now? Your computer may block notices for this browser: check the system's notification settings." });
  });

  it('on no, no answer, or an error: keeps the choice on and says how to allow them, in words for any browser', () => {
    for (const a of ['denied', 'timeout', 'error'] as const) {
      const r = afterAsking(a);
      expect(r).toMatchObject({ choice: 'on', test: false, bad: true });
      expect(r.say).toContain("Allow notifications for this page in your browser's site settings");
      expect(r.say).toContain('On a Mac, also check System Settings › Notifications for your browser.');
      expect(r.say).not.toMatch(/Chrome/);
    }
    expect(afterAsking('timeout').say).toMatch(/^Your browser has not answered\./);
  });

  it('a page that is not secure, or no notices at all: says why and changes nothing', () => {
    expect(afterAsking('insecure')).toMatchObject({ choice: null, bad: true });
    expect(afterAsking('unsupported')).toMatchObject({ choice: null, bad: true });
    expect(afterAsking('default')).toMatchObject({ choice: 'off', bad: false });
  });
});
