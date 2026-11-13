import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in code window on the Connections page. Real React in a jsdom page, with the board's answers made up. The
 * window takes the focus; a click beside it never stops a sign-in the person is approving; Esc stops it, even before
 * the code arrives; and a sign-in the board lost (`none`, after squad-kit restarted) is said, with Try again, never an
 * endless wait.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/squad-kit/connections', pretendToBeVisual: true });
const page = dom.window.document;
const globals = () => {
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
const { SignInCode } = await import(/* @vite-ignore */ file('src/components/connect/SignInCode.tsx'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };
let calls: string[];
let closed: number;
/** What GET /sign-in answers while the window follows the sign-in. */
let now: Record<string, unknown>;
/** Holds the answer to the start until the test lets it go. */
let started: ((r: Record<string, unknown>) => void) | null;

const wait = (ms = 10) => act(async () => new Promise((r) => dom.window.setTimeout(r, ms)));
const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;

async function open(hold = false) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const route = `${init.method ?? 'GET'} ${new URL(String(url), 'http://127.0.0.1:4809').pathname}`;
    calls.push(route);
    if (route.endsWith('/sign-in') && init.method === 'POST') {
      const body = hold ? await new Promise<Record<string, unknown>>((done) => (started = done)) : { state: 'waiting', code: 'AB12-CD34', url: 'https://github.com/login/device' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (route.endsWith('/cancel')) return new Response(JSON.stringify({ state: 'cancelled' }), { status: 200 });
    return new Response(JSON.stringify(now), { status: 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(SignInCode, { name: 'github', label: 'GitHub', onClose: () => (closed += 1) })))));
  await wait();
}

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  dom.window.localStorage.setItem('squad-kit-first-start-lang', 'en');
  page.body.innerHTML = '<div id="root"></div>';
  root = createRoot(page.getElementById('root'));
  calls = [];
  closed = 0;
  now = { state: 'waiting', code: 'AB12-CD34', url: 'https://github.com/login/device' };
  started = null;
});

afterEach(async () => {
  started?.({ state: 'waiting', code: 'AB12-CD34' });
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('the sign-in code window', () => {
  it('takes the focus, shows the code, and a click beside it stops nothing', async () => {
    await open();
    expect(page.activeElement?.getAttribute('role')).toBe('dialog');
    expect(page.querySelector('.gh-bigcode span')?.textContent).toBe('AB12-CD34');
    await act(async () => page.querySelector('.modal-veil')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })));
    expect(calls.filter((c) => c.endsWith('/cancel'))).toEqual([]);
    expect(closed).toBe(0);
  });

  it('Esc stops the sign-in, even before its code arrives', async () => {
    await open(true);
    expect(page.querySelector('.gh-wait')?.textContent).toContain("Asking GitHub's tool for a code");
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(calls).toContain('POST /p/squad-kit/api/v1/connections/github/sign-in/cancel');
    expect(closed).toBe(1);
    // The start answers late: its sign-in is stopped too.
    await act(async () => started!({ state: 'waiting', code: 'AB12-CD34' }));
    started = null;
    await wait();
    expect(calls.filter((c) => c.endsWith('/cancel'))).toHaveLength(2);
  });

  it('a sign-in the board lost (none) is said, with Try again, never an endless wait', async () => {
    now = { state: 'none' };
    await open();
    await wait(1700);
    expect(page.querySelector('.gh-bad')?.textContent).toBe('The sign-in stopped before it finished. Try again.');
    expect(page.querySelector('.gh-spin')).toBeNull();
    now = { state: 'waiting', code: 'AB12-CD34' };
    await act(async () => button('Try again').click());
    await wait();
    expect(calls.filter((c) => c === 'POST /p/squad-kit/api/v1/connections/github/sign-in')).toHaveLength(2);
    expect(page.querySelector('.gh-bigcode span')?.textContent).toBe('AB12-CD34');
  });
});
