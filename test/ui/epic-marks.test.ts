import { describe, expect, it, vi } from 'vitest';

/**
 * Where a row on the Requirements list comes from. A run from the tracker names the tracker that made it, from the run
 * itself: the project's tracker may have changed since, and the row needs no call to the server. Real React, rendered
 * to text.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
// The board's parts read the page when they load: a jsdom page stands in for it.
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/requirements', pretendToBeVisual: true });
for (const [k, v] of Object.entries({ self: dom.window, window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement })) vi.stubGlobal(k, v);
const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown };
const { renderToStaticMarkup } = (await import(/* @vite-ignore */ file('node_modules/react-dom/server.node.js'))) as { renderToStaticMarkup(n: unknown): string };
const { RowSource } = await import(/* @vite-ignore */ file('src/components/epic/RunMarks.tsx'));

const row = (source: object) => ({ id: 'BR-4', title: 'Booking', status: 'approved', source, counts: {}, building: false, createdAt: '', owner: 'Momen' });
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe("a row's source on the Requirements list", () => {
  it("a run says the tracker it came from, by the run's own label", () => {
    const html = renderToStaticMarkup(React.createElement(RowSource, { r: row({ name: '#120 Booking', kind: 'tracker', tracker: { module: 'github', id: 'octo/shop#120', ref: '#120', url: '', type: 'Epic', label: 'GitHub' } }) }));
    expect(text(html).trim()).toBe('From GitHub · #120 Booking');
    expect(html).toContain('class="tracker-mark"');
  });

  it('a document says its name', () => {
    expect(text(renderToStaticMarkup(React.createElement(RowSource, { r: row({ name: 'RoomFlow BRD.pdf', kind: 'pdf' }) })))).toContain('RoomFlow BRD.pdf');
  });
});
