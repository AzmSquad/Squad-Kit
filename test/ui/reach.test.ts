import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentReach, expectRestart, noteAlive, noteAnswer, noteNoAnswer, resetReach } from '../../console-ui/src/lib/reach.js';

/** The app stopped: the page must say so instead of looking alive. One missed call is not enough. */

beforeEach(() => resetReach());

describe('whether the app still answers', () => {
  it('one missed call is not enough, two are', () => {
    noteNoAnswer();
    expect(currentReach()).toBe('up');
    noteNoAnswer();
    expect(currentReach()).toBe('down');
  });

  it('two missed calls with an answer between them are not enough', () => {
    noteNoAnswer();
    noteAnswer(200);
    noteNoAnswer();
    expect(currentReach()).toBe('up');
  });

  it('any answer ends it', () => {
    noteNoAnswer();
    noteNoAnswer();
    noteAlive();
    expect(currentReach()).toBe('up');
    noteNoAnswer();
    noteNoAnswer();
    noteAnswer(200);
    expect(currentReach()).toBe('up');
  });

  it('an old link is its own state, and a look at the app does not hide it', () => {
    noteAnswer(401);
    expect(currentReach()).toBe('link-old');
    noteAlive();
    expect(currentReach()).toBe('link-old');
  });

  it('says nothing during a restart the person asked for, and speaks up when it never came back', () => {
    expectRestart(true);
    noteNoAnswer();
    noteNoAnswer();
    expect(currentReach()).toBe('up');
    expectRestart(false);
    expect(currentReach()).toBe('down');
  });
});

describe('the link', () => {
  // The root type check has no browser types, so the client is found at run time.
  const client = () => import(/* @vite-ignore */ `${new URL('../../console-ui/src/api/client.ts', import.meta.url).pathname}`);

  const page = (store: Map<string, string>, href: string) => {
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    vi.stubGlobal('localStorage', s);
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined });
    return { location: { href, pathname: new URL(href).pathname }, history: { replaceState: () => undefined } };
  };

  it('a new tab or a bookmark opens with what the first link left', async () => {
    const browser = new Map<string, string>();
    vi.stubGlobal('window', page(browser, 'http://127.0.0.1:4809/?t=abc123'));
    vi.resetModules();
    const first = await client();
    expect(first.bootstrapToken()).toBe('abc123');

    vi.stubGlobal('window', page(browser, 'http://127.0.0.1:4809/p/mawid/board'));
    vi.resetModules();
    const second = await client();
    expect(second.bootstrapToken()).toBe('abc123');
    vi.unstubAllGlobals();
  });

  it('a browser that refuses storage still works in the tab the link opened', async () => {
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    vi.stubGlobal('localStorage', denied);
    vi.stubGlobal('sessionStorage', denied);
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:4809/?t=abc', pathname: '/' }, history: { replaceState: () => undefined } });
    vi.resetModules();
    const c = await client();
    expect(c.bootstrapToken()).toBe('abc');
    expect(c.currentToken()).toBe('abc');
    vi.unstubAllGlobals();
  });

  it('with no link at all there is no token, and the page says how to get one', async () => {
    vi.stubGlobal('window', page(new Map(), 'http://127.0.0.1:4809/'));
    vi.resetModules();
    const c = await client();
    expect(c.bootstrapToken()).toBeNull();
    vi.unstubAllGlobals();
  });
});
