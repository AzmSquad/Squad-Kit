import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The buttons on a breakdown's stops. Real React and the real parts in a jsdom page: what each one sends, and what it says first. */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/requirements/BR-1', pretendToBeVisual: true });
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
const { CarryOn, FailedCard } = await import(/* @vite-ignore */ file('src/components/BreakdownRead.tsx'));
const { DecidedEntry } = await import(/* @vite-ignore */ file('src/components/BreakdownTree.tsx'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };
let sent: { url: string; body: any }[];

const view = (more: object) => ({ id: 'BR-1', title: 'BRD', status: 'failed', mine: true, source: { name: 'BRD.pdf', kind: 'pdf' }, questions: [], epics: [], decided: [], leftOut: [], state: { activity: [] }, progress: [], counts: {}, ...more });

async function show(node: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path: '/', component: node, validateSearch: (s: Record<string, unknown>) => s });
  const router = createRouter({ routeTree: top.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
}

const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;
const press = async (name: string) => {
  await act(async () => button(name).click());
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 15)));
};

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') !== 'GET') sent.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return new Response(JSON.stringify({ id: 'BR-1' }), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('a step stopped at its limit', () => {
  const capped = view({ error: 'The Analyst used the 80 turns one step may take on Best, so squad-kit paused it. Its work so far is kept.', state: { activity: [], job: { step: 'read', status: 'failed', capped: true } } });

  it('offers Give it more, not Try again, and says what happened', async () => {
    await show(() => h(FailedCard, { v: capped }));
    expect(page.body.textContent).toContain('The Analyst reached its limit');
    expect(page.body.textContent).toContain('80 turns');
    expect(button('Try again')).toBeUndefined();
    await press('Give it more');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/api\/v1\/requirements\/BR-1\/more$/);
  });

  it('any other stop still has Try again', async () => {
    await show(() => h(FailedCard, { v: view({ error: 'The step stopped on something technical, so squad-kit could not finish it. Press Try again.', state: { activity: [], job: { step: 'read', status: 'failed' } } }) }));
    expect(button('Give it more')).toBeUndefined();
    await press('Try again');
    expect(sent[0]!.url).toMatch(/\/retry$/);
  });
});

describe('a long document', () => {
  it('Read it is what starts the read', async () => {
    await show(() => h(CarryOn, { v: view({ status: 'reading', state: { activity: [], job: { step: 'read', status: 'pending', heldFor: 'long', now: 'This BRD is long' } } }) }));
    await press('Read it');
    expect(sent[0]!.url).toMatch(/\/api\/v1\/requirements\/BR-1\/retry$/);
  });
});

describe('changing a decision', () => {
  const WORDS = 'This decision is not about one part, so the Analyst rewrites the whole breakdown. Stories that started stay as they are. That uses about $1.30 of AI at API prices.';
  const typeIn = async (text: string) => {
    const box = page.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  it('about no one part: it says what happens first, with the rough cost, and only the second press sends', async () => {
    const v = view({ status: 'approved', wholeRedo: WORDS, decided: [{ id: 'd1', text: 'Keep it simple', by: 'analyst', at: '' }] });
    await show(() => h(DecidedEntry, { v, d: v.decided[0] }));
    await press('Change');
    await typeIn('Make it fancy');
    await press('Save change');
    expect(page.body.textContent).toContain(WORDS);
    expect(sent).toEqual([]);
    // Keep it as it is takes it back.
    await press('Keep it as it is');
    expect(page.body.textContent).not.toContain(WORDS);
    await press('Save change');
    await press('Yes, rewrite all of it');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ text: 'Make it fancy', whole: true });
  });

  it('about one part: it goes at once, with no such word', async () => {
    const v = view({ status: 'approved', wholeRedo: WORDS, epics: [{ key: 'E-1', title: 'One', features: [], stories: [{ key: 'S-1', title: 'A', story: 'x', criteria: [], size: 'M', dependsOn: [] }] }], decided: [{ id: 'd1', text: 'Keep it simple', by: 'analyst', at: '', item: 'S-1' }] });
    await show(() => h(DecidedEntry, { v, d: v.decided[0] }));
    await press('Change');
    await typeIn('Make it fancy');
    await press('Save change');
    expect(page.body.textContent).not.toContain(WORDS);
    expect(sent[0]!.body).toEqual({ text: 'Make it fancy' });
  });
});
