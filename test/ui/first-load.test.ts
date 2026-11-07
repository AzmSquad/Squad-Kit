import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A page whose first load did not get through says so, with the way on. Real React and the real pages in a jsdom page,
 * with the app answering 401 or 404, or not at all. An all-clear, "No board yet" or "Add your first project" would be false.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/board', pretendToBeVisual: true });
const page = dom.window.document;
const globals = () => {
  vi.stubGlobal('self', dom.window);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
};
globals();

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { loadTrouble } = await import(/* @vite-ignore */ file('src/lib/load-trouble.ts'));
const { NO_ANSWER, UnauthorizedError } = await import(/* @vite-ignore */ file('src/api/client.ts'));
const { BoardPage } = await import(/* @vite-ignore */ file('src/pages/Board.tsx'));
const { InboxPage } = await import(/* @vite-ignore */ file('src/pages/Pages.tsx'));
const { HomePage } = await import(/* @vite-ignore */ file('src/pages/Home.tsx'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };

/** The real page at its own address, so its links and search work. */
async function show(path: string, Page: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path, component: Page, validateSearch: (s: Record<string, unknown>) => s });
  const router = createRouter({ routeTree: top.addChildren([route]), history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 40)));
}

const answering = (status: number) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'x' }), { status, statusText: status === 404 ? 'Not Found' : 'Server Error' }));
const silent = () => vi.stubGlobal('fetch', async () => {
  throw new TypeError('Failed to fetch');
});

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  dom.window.sessionStorage.clear();
  dom.window.sessionStorage.setItem('squad.console.token', 'a-token');
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

const FALSE_WORDS = /Nothing needs you right now|No board yet|squad demo|Start a new project|Add a project you already have/;

describe('the first load did not get through', () => {
  it.each([
    ['Board, a removed project', '/board', () => BoardPage, 404, /the board could not load: this project is not open/i],
    ['Board, app down', '/board', () => BoardPage, 0, /did not answer, so the board could not load/],
    ['Waiting for you, a removed project', '/inbox', () => InboxPage, 404, /what waits for you could not load/i],
    ['Waiting for you, app down', '/inbox', () => InboxPage, 0, /did not answer, so what waits for you could not load/],
    ['Waiting for you, a server error', '/inbox', () => InboxPage, 500, /what waits for you could not load\. Nothing is lost/i],
    ['Home, app down', '/', () => HomePage, 0, /did not answer, so your projects could not load/],
    ['Home, a server error', '/', () => HomePage, 500, /your projects could not load\. Nothing is lost/i],
  ])('%s: it says so, with Try again, and no false words', async (_name, path, Page, status, words) => {
    if (status) answering(status as number);
    else silent();
    await show(path as string, (Page as () => unknown)());
    const text = page.body.textContent as string;
    expect(text).toMatch(words as RegExp);
    expect(text).not.toMatch(FALSE_WORDS);
    expect([...page.querySelectorAll('button')].some((b: any) => b.textContent === 'Try again')).toBe(true);
  });

  it('an expired link says so in its own words on a page, and the ways on are there', async () => {
    dom.window.localStorage.clear();
    dom.window.sessionStorage.clear();
    answering(401);
    await show('/board', BoardPage);
    expect(page.body.textContent).toContain("This page's link is out of date");
    expect(page.body.textContent).not.toMatch(FALSE_WORDS);
  });

  it('Try again reads again, and the page comes back', async () => {
    let up = false;
    vi.stubGlobal('fetch', async () => {
      if (!up) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ready: false }), { status: 200 });
    });
    await show('/board', BoardPage);
    const again = [...page.querySelectorAll('button')].find((b: any) => b.textContent === 'Try again') as any;
    up = true;
    await act(async () => again.click());
    await act(async () => new Promise((r) => dom.window.setTimeout(r, 40)));
    expect(page.body.textContent).toContain('No board yet');
    expect(page.body.textContent).not.toContain('could not load');
  });

  it('a board that is really not set up does not send a project manager to a terminal first', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ready: false }), { status: 200 }));
    await show('/board', BoardPage);
    expect(page.body.textContent).toContain('This project has not been set up yet');
    expect(page.querySelector('a.btn').textContent).toBe('Go to Home');
  });

  it('the words for each kind of trouble', () => {
    expect(loadTrouble(new UnauthorizedError(), 'the board').text).toContain('out of date');
    expect(loadTrouble(new Error(NO_ANSWER), 'the board')).toEqual({ text: 'squad-kit did not answer, so the board could not load. Check that it still runs in its terminal, then press Try again.', home: false });
    expect(loadTrouble(new Error('404 Not Found: x'), 'the board').home).toBe(true);
    expect(loadTrouble(new Error('500 Server Error: ENOSPC'), 'the board').text).not.toContain('ENOSPC');
  });
});
