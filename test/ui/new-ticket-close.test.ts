import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Create cannot be called back once it is on its way. Real React and the real dialog in a jsdom page, with the answer
 * held back: closing says what really happens, the person hears when it lands, and the draft does not stay behind to
 * make a second ticket. The same key goes with every send of one Create.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/board', pretendToBeVisual: true });
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

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void>; useState<T>(x: T): [T, (x: T) => void] };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { NewTicketDialog } = await import(/* @vite-ignore */ file('src/components/dialogs.tsx'));
const { NO_ANSWER } = await import(/* @vite-ignore */ file('src/api/client.ts'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };
let sent: { key: string }[];
let answers: ((r: Response | Error) => void)[];
let setOpen: (x: boolean) => void;
let created: unknown[];

const wait = () => act(async () => new Promise((r) => dom.window.setTimeout(r, 10)));
const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;

function Host() {
  const [open, set] = React.useState(true);
  setOpen = set;
  return open ? h(NewTicketDialog, { onClose: () => set(false), onCreated: (t: unknown) => created.push(t) }) : null;
}

async function typeTitle(text: string) {
  const box = page.querySelector('input[placeholder], input') as any;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  answers = [];
  created = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ draft: null }), { status: 200 });
    if (String(url).endsWith('/api/v1/tickets')) sent.push(JSON.parse(init.body as string));
    const r = await new Promise<Response | Error>((done) => answers.push(done));
    if (r instanceof Error) throw r;
    return r;
  });
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(Host)))));
  await wait();
});

afterEach(async () => {
  for (const a of answers) a(new Response('{}'));
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('New ticket while Create runs', () => {
  it('Cancel becomes Close, and says the ticket still comes; when it lands the person hears, and no draft stays', async () => {
    await typeTitle('Add a coupon');
    await act(async () => button('Create ticket').click());
    await wait();
    expect(sent).toHaveLength(1);
    expect(button('Cancel')).toBeUndefined();
    await act(async () => button('Close').click());
    expect(page.body.textContent).toContain('Your ticket is still being made. Closing this does not stop it');
    expect(page.querySelector('[role=dialog]')).toBeNull();
    // Now it lands, with the window gone.
    await act(async () => answers[0]!(new Response(JSON.stringify({ id: 'AP-7', title: 'Add a coupon' }), { status: 200 })));
    await wait();
    expect(page.body.textContent).toContain('AP-7 is on the board.');
    expect(created).toEqual([]);
    expect(Object.keys(dom.window.localStorage).filter((k) => k.includes('new-ticket') || k.includes('create-key'))).toEqual([]);
  });

  it('Esc says the same', async () => {
    await typeTitle('Add a coupon');
    await act(async () => button('Create ticket').click());
    await wait();
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(page.body.textContent).toContain('Closing this does not stop it');
  });

  it('a normal Create opens the ticket with no extra toast', async () => {
    await typeTitle('Add a coupon');
    await act(async () => button('Create ticket').click());
    await wait();
    await act(async () => answers[0]!(new Response(JSON.stringify({ id: 'AP-7', title: 'Add a coupon' }), { status: 200 })));
    await wait();
    expect(created).toHaveLength(1);
    expect(page.body.textContent).not.toContain('is on the board');
  });

  it('a lost reply: Try again sends the same key, and closing and coming back keeps it', async () => {
    await typeTitle('Add a coupon');
    await act(async () => button('Create ticket').click());
    await wait();
    await act(async () => answers[0]!(new TypeError('Failed to fetch')));
    await wait();
    expect(page.body.textContent).toContain(NO_ANSWER);
    expect(NO_ANSWER).not.toContain('nothing changed');
    await act(async () => button('Try again').click());
    await wait();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[0]!.key).toBeTruthy();
    await act(async () => answers[1]!(new TypeError('Failed to fetch')));
    await wait();
    // Closed and opened again: the same key, so it never makes a second ticket.
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    await wait();
    await act(async () => button('Create ticket').click());
    await wait();
    expect(sent[2]!.key).toBe(sent[0]!.key);
  });
});
