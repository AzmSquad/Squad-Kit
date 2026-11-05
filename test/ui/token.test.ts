import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The link's token stays in the browser so a new tab opens the board, and goes when the board says no to it: it runs
 * with a new one now. An old tab never takes away a newer token.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board?t=OLD' });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);

const { UnauthorizedError, api, bootstrapToken, currentToken, send } = await import(/* @vite-ignore */ file('src/api/client.ts'));
const KEY = 'squad.console.token';

function board(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
}

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.history.replaceState({}, '', '/p/mawid/board?t=OLD');
  bootstrapToken();
});

describe('the stored token', () => {
  it('is kept for the whole browser, and leaves the address', () => {
    expect(dom.window.localStorage.getItem(KEY)).toBe('OLD');
    expect(dom.window.location.search).toBe('');
    expect(currentToken()).toBe('OLD');
  });

  it('stays through any other answer', async () => {
    board(500);
    await expect(api('/api/v1/board')).rejects.toThrow();
    expect(dom.window.localStorage.getItem(KEY)).toBe('OLD');
  });

  it('goes when the board says no to it, on a read and on a write', async () => {
    board(401);
    await expect(api('/api/v1/board')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(dom.window.localStorage.getItem(KEY)).toBeNull();
    expect(currentToken()).toBeNull();
    dom.window.history.replaceState({}, '', '/p/mawid/board?t=OLD');
    bootstrapToken();
    await expect(send('/api/v1/tickets', 'POST', {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect(dom.window.localStorage.getItem(KEY)).toBeNull();
  });

  it("an old tab's refusal leaves a newer token alone", async () => {
    board(401);
    // Another tab opened the new link meanwhile: this tab's own call still went out with the old one.
    dom.window.localStorage.setItem(KEY, 'NEW');
    await expect(api('/api/v1/board')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(dom.window.localStorage.getItem(KEY)).toBe('NEW');
  });
});
