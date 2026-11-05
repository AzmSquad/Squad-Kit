import { describe, expect, it, vi } from 'vitest';

/** A page that breaks while drawing itself: never a white page and an unstyled "Something went wrong", always ways on. */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { Boundary } = await import(/* @vite-ignore */ file('src/components/Crash.tsx'));
const h = React.createElement;

function Broken(): unknown {
  throw new Error('a ticket with no steps');
}

describe('the net around a page', () => {
  it('shows what happened and the ways on, with the exact error for engineers', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = createRoot(dom.window.document.getElementById('root'));
    await React.act(async () => root.render(h(Boundary, null, h(Broken))));
    const text = dom.window.document.body.textContent as string;
    expect(text).toContain('This page ran into a problem');
    expect(text).toContain('Your work is safe');
    expect(text).toContain('Try again');
    expect(text).toContain('Go to the board');
    expect(text).toContain('Report a problem');
    expect(dom.window.document.querySelector('details pre').textContent).toContain('a ticket with no steps');
    expect(dom.window.document.querySelector('a.btn').getAttribute('href')).toBe('/p/mawid/board');
    await React.act(async () => root.unmount());
    said.mockRestore();
  });

  it('the report window breaking takes nothing else down', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = createRoot(dom.window.document.getElementById('root'));
    await React.act(async () => root.render(h('div', null, h('p', null, 'the page'), h(Boundary, { fallback: null }, h(Broken)))));
    expect(dom.window.document.body.textContent).toContain('the page');
    await React.act(async () => root.unmount());
    said.mockRestore();
  });
});
