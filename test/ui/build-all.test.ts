import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Build all's dialog: pressing Read them first starts the run, opens it, and asks the Backlog again, so the group's row
 * shows its run at once. An item that has a run already answers that run, and the dialog opens it. Real React and the
 * real dialog in a jsdom page.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/backlog', pretendToBeVisual: true });
const page = dom.window.document;
// The router scrolls on a change of page; jsdom has no scrolling.
dom.window.scrollTo = () => undefined;
const globals = () => {
  for (const [k, v] of Object.entries({ self: dom.window, window: dom.window, document: page, navigator: dom.window.navigator, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(k, v);
};
globals();

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { BuildAllDialog } = await import(/* @vite-ignore */ file('src/components/epic/BuildAllDialog.tsx'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { act } = React;
const h = React.createElement;

const PREVIEW = {
  root: { id: '120', ref: 'AB#120', title: 'Booking', type: 'Epic', level: 'epic', url: '' },
  stories: [{ id: '123', ref: 'AB#123', title: 'Search rooms', type: 'User Story', isBug: false, state: 'New', needs: [] }],
  leftOut: [],
  atOnce: 2,
};

let root: { render(n: unknown): void; unmount(): void };
let posted: unknown;

async function show(): Promise<{ client: any; router: any }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const g = { id: '120', ref: 'AB#120', title: 'Booking', type: 'Epic', level: 'epic', state: 'New', tags: [], url: '' };
  const route = createRoute({ getParentRoute: () => top, path: '/', component: () => h(BuildAllDialog, { g, label: 'Azure DevOps', onClose: () => undefined }) });
  const runs = createRoute({ getParentRoute: () => top, path: '/requirements/$id', component: () => h('p', null, 'the run') });
  const router = createRouter({ routeTree: top.addChildren([route, runs]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent?.includes('Search rooms'); i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
  return { client, router };
}

const press = async (name: string) => {
  const b = [...page.querySelectorAll('button')].find((x: any) => x.textContent.trim() === name) as any;
  await act(async () => b.click());
  for (let i = 0; i < 20; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
};

beforeEach(() => {
  globals();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  posted = undefined;
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('Build all', () => {
  for (const [what, answer] of [
    ['a new run', { id: 'BR-4' }],
    ['an item with a run already', { id: 'BR-4', already: 'AB#120 has a run already: BR-4. New stories under it show there with Add to the run.' }],
  ] as const) {
    it(`opens the run and asks the Backlog again: ${what}`, async () => {
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'POST') posted = String(url);
        return new Response(JSON.stringify((init.method ?? 'GET') === 'POST' ? answer : PREVIEW), { status: 200 });
      });
      const { client, router } = await show();
      const asked = vi.spyOn(client, 'invalidateQueries');
      await press('Read them first');
      expect(posted).toMatch(/\/api\/v1\/backlog\/120\/build$/);
      expect(asked.mock.calls.map((c: any[]) => c[0]?.queryKey?.[0])).toContain('backlog');
      expect(router.state.location.pathname).toBe('/requirements/BR-4');
    });
  }
});
