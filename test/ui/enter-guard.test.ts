import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Enter does what the button does, and a button that waits for its answer cannot be pressed again. Real React and the
 * real dialogs in a jsdom page, with the answer held back: a second Enter while it waits sends nothing.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
const page = dom.window.document;
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { PullDialog } = await import(/* @vite-ignore */ file('src/components/dialogs.tsx'));
const { AddPartDialog } = await import(/* @vite-ignore */ file('src/components/BreakdownDialogs.tsx'));
const { MessageAgent } = await import(/* @vite-ignore */ file('src/components/Conversation.tsx'));
const { HandOverDialog } = await import(/* @vite-ignore */ file('src/components/HandOver.tsx'));
const { FolderBrowser } = await import(/* @vite-ignore */ file('src/components/FolderBrowser.tsx'));
const { Notes } = await import(/* @vite-ignore */ file('src/pages/TicketDrawer.tsx'));
const { CarryOn } = await import(/* @vite-ignore */ file('src/components/BreakdownRead.tsx'));
const { BrokenTickets, NoBoard } = await import(/* @vite-ignore */ file('src/pages/Board.tsx'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };
/** Every call that changes something, while the answer is held back. */
let sent: { url: string; body: unknown }[];
let answer: () => void;

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  answer = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      await new Promise<void>((done) => (answer = done));
    }
    return new Response(JSON.stringify({ ready: false, id: 'AP-1', key: 'E-9', tickets: [], path: '/made' }), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  answer();
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

async function show(node: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, node))));
}

async function type(box: any, text: string) {
  const proto = box.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, text);
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

async function press(box: any, more: object = {}) {
  await act(async () => {
    box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...more }));
  });
  // The answer is held back, so what the page shows now is what it shows while it waits.
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
}

/** Enter, then Enter again and again while the answer is on its way: one call. */
async function onlyOnce(box: any, more: object = {}) {
  await press(box, more);
  expect(sent).toHaveLength(1);
  await press(box, more);
  await press(box, more);
  expect(sent).toHaveLength(1);
}

const ticket = { id: 'AP-1', title: 'A ticket', stage: 'implement', status: '', notes: [], activity: [], source: { type: 'manual' } };
const noop = () => undefined;

describe('Enter while the answer is on its way', () => {
  it('Pull sends once, so it never makes two tickets', async () => {
    await show(h(PullDialog, { onClose: noop, onCreated: noop }));
    const box = page.getElementById('pull-ref');
    await type(box, 'AB#123');
    await onlyOnce(box);
    expect(sent[0]!.body).toEqual({ ref: 'AB#123' });
  });

  it('Pull with no number sends nothing, as its button does', async () => {
    await show(h(PullDialog, { onClose: noop, onCreated: noop }));
    await press(page.getElementById('pull-ref'));
    expect(sent).toHaveLength(0);
  });

  it('Add a part sends once, so it never makes two stories', async () => {
    const v = { id: 'BR-1', mine: true, status: 'ready', epics: [{ key: 'E-1', title: 'Booking', features: [{ key: 'F-1', title: 'Search', stories: [] }], stories: [] }], state: { activity: [] }, progress: [], decided: [], questions: [] };
    await show(h(AddPartDialog, { v, level: 'story', under: 'F-1', onClose: noop, onAdded: noop }));
    const box = page.getElementById('rq-title');
    await type(box, 'Hold a slot');
    await onlyOnce(box);
    expect(sent[0]!.body).toMatchObject({ title: 'Hold a slot', under: 'F-1', level: 'story' });
  });

  it('a message to an agent sends once', async () => {
    await show(h(MessageAgent, { t: ticket, to: 'builder' }));
    const box = page.querySelector('.msgagent input');
    await type(box, 'Use the new table');
    await onlyOnce(box);
  });

  it('a note sends once, with the keys that send it', async () => {
    await show(h(Notes, { t: ticket }));
    const box = page.querySelector('.addnote textarea');
    await type(box, 'At most 3 a day');
    await onlyOnce(box, { metaKey: true });
  });

  it('a hand over sends once', async () => {
    await show(h(HandOverDialog, { t: ticket, onClose: noop }));
    const box = page.getElementById('handover-to');
    await type(box, 'Sara');
    await onlyOnce(box);
  });

  it('a new folder is made once', async () => {
    const listing = { data: { path: '/work', parent: '/', places: [], folders: [] }, isError: false, isLoading: false };
    await show(h(FolderBrowser, { at: '/work', go: noop, listing, onError: noop }));
    const button = [...page.querySelectorAll('button')].find((b: any) => /New folder here/.test(b.textContent));
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    const box = page.querySelector('input[placeholder="Name of the new folder"]');
    await type(box, 'cases');
    await onlyOnce(box);
  });
});

describe('what the board says on its own', () => {
  it('a ticket that cannot be read: its name and what happened, with the file one click away', async () => {
    const problem = 'AP-7 could not be read: its file is damaged, so it is not on the board. Nothing is lost. An engineer can look at it.';
    await show(h(BrokenTickets, { list: [{ id: 'AP-7', problem, file: '.squad/tickets/AP-7/ticket.md', detail: 'bad indentation' }] }));
    expect(page.querySelector('[role="alert"] p').textContent).toBe(problem);
    expect(page.querySelector('details summary').textContent).toBe('For an engineer');
    expect(page.querySelector('details pre').textContent).toContain('.squad/tickets/AP-7/ticket.md');
  });

  it('settings that cannot be read are not "no board yet" and the sample board', async () => {
    await show(h(NoBoard, { settings: "This project's settings file could not be read." }));
    expect(page.body.textContent).toContain("This project's settings file could not be read.");
    expect(page.body.textContent).not.toContain('No board yet');
    expect(page.body.textContent).not.toContain('squad demo');
    await show(h(NoBoard, {}));
    expect(page.body.textContent).toContain('No board yet');
  });

  it('Carry on shows only while the Analyst waits at the budget, and is the same call as the terminal', async () => {
    const v = (job: object | undefined, mine = true) => ({ id: 'BR-1', mine, state: { activity: [], ...(job ? { job } : {}) } });
    await show(h(CarryOn, { v: v({ step: 'read', status: 'pending' }) }));
    expect(page.querySelector('button')).toBeNull();
    await show(h(CarryOn, { v: v({ step: 'read', status: 'pending', heldFor: 'budget' }, false) }));
    expect(page.querySelector('button')).toBeNull();
    await show(h(CarryOn, { v: v({ step: 'read', status: 'pending', heldFor: 'budget' }) }));
    const button = page.querySelector('button');
    expect(button.textContent).toContain('Carry on');
    expect(button.getAttribute('title')).toBe('squad requirements retry BR-1');
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/api\/v1\/requirements\/BR-1\/retry$/);
  });
});
