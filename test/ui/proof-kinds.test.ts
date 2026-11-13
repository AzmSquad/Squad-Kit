import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The proof kinds on the board: the chip on each "done when" of the spec with its reason, the menu that changes it
 * before the approval (other kinds off on a line squad-kit locked, with why), read only after it; one block per line on
 * the Proof tab, laid out by its kind; and the line's kind with a short form of its proof on a chat card. Real React and
 * the real parts in a jsdom page: what each press sends.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
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
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const K = await import(/* @vite-ignore */ file('src/lib/proof-kinds.ts'));
const { KindPick } = await import(/* @vite-ignore */ file('src/components/proof/KindPick.tsx'));
const { KindBlocks } = await import(/* @vite-ignore */ file('src/components/proof/KindBlocks.tsx'));
const { Body } = await import(/* @vite-ignore */ file('src/components/decide/Body.tsx'));
const { act } = React;
const h = React.createElement;

const SEES = 'About what someone sees, so it needs a picture';
const criteria = [
  { given: 'I confirm a booking', when: 'I pay by card', then: 'I see Paid and my receipt number', proof: { kind: 'screen', why: SEES, locked: true } },
  { given: 'the payment goes through', when: 'it is saved', then: 'the booking is saved as paid', proof: { kind: 'data', why: 'Nothing new on a screen: the bookings table shows it.' } },
  { given: 'a card', when: 'it is used', then: 'card numbers are never saved', proof: { kind: 'none', why: 'Nothing to show.' } },
];
const spec = (more: object = {}) => ({ id: 'MA-21', title: 'Pay by card when booking', ask: 'Customers pay by card.', kind: 'feature', stage: 'specs', status: 'Spec ready for you', waiting: { kind: 'spec', summary: 'The spec is ready' }, activity: [], criteria, ...more });

let root: { render(n: unknown): void; unmount(): void };
let sent: { url: string; body: any }[];
let files: Record<string, unknown>;

async function show(node: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path: '/', component: node });
  const router = createRouter({ routeTree: top.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 30)));
}
const buttons = () => [...page.querySelectorAll('button')] as any[];
const click = async (el: any) => {
  await act(async () => el.click());
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 20)));
};
const lines = (t: object) => () => h('ol', { className: 'ac' }, criteria.map((_, i) => h('li', { key: i }, h('span', null, criteria[i]!.then), h(KindPick, { t, i }))));

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  files = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') !== 'GET') sent.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const name = String(url).split('?')[0]!.split('/').pop()!;
    return new Response(JSON.stringify(files[name] ?? {}), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('the chips in the spec', () => {
  it('show each kind with its reason, and the locked line its rule', async () => {
    await show(lines(spec()));
    const text = page.body.textContent;
    expect(text).toContain('Screen');
    expect(text).toContain('Data');
    expect(text).toContain('Not on a screen');
    expect(text).toContain(SEES);
    expect(text).toContain('Nothing new on a screen: the bookings table shows it.');
    expect(page.querySelectorAll('.pkind.k-data').length).toBe(1);
  });

  it('the menu changes a kind with one call, and shows its terminal command', async () => {
    await show(lines(spec()));
    await click(buttons().find((b) => b.getAttribute('aria-label')?.includes('"done when" 2')));
    expect(page.body.textContent).toContain('How should line 2 be proved?');
    expect(page.body.textContent).toContain('Rows before and after, read only');
    expect(page.body.textContent).toContain('You see this proof when the story is ready to check.');
    expect(page.querySelector('.kindmenu .opt.on')?.textContent).toContain('Data');
    await click(buttons().find((b) => b.getAttribute('role') === 'menuitemradio' && b.textContent.includes('Test')));
    expect(sent).toEqual([{ url: '/p/mawid/api/v1/tickets/MA-21/prove', body: { line: 2, kind: 'test' } }]);
  });

  it('on a locked line the other kinds are off, with the lock note', async () => {
    await show(lines(spec()));
    await click(buttons().find((b) => b.getAttribute('aria-label')?.includes('"done when" 1')));
    const opts = buttons().filter((b) => b.getAttribute('role') === 'menuitemradio');
    expect(opts.filter((b) => b.disabled).map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Data'), expect.stringContaining('API call'), expect.stringContaining('Test'), expect.stringContaining('Not on a screen')]));
    expect(opts.find((b) => b.textContent.includes('Screen'))!.disabled).toBe(false);
    expect(page.body.textContent).toContain(K.LOCK_NOTE);
  });

  it('Not on a screen asks for a reason first', async () => {
    await show(lines(spec()));
    await click(buttons().find((b) => b.getAttribute('aria-label')?.includes('"done when" 2')));
    await click(buttons().find((b) => b.getAttribute('role') === 'menuitemradio' && b.textContent.includes('Not on a screen')));
    expect(sent).toEqual([]);
    const input = page.querySelector('.kindwhyask input');
    expect(input).toBeTruthy();
    expect(buttons().find((b) => b.textContent === 'Save').disabled).toBe(true);
  });

  it('read only once the spec is approved, and nothing at all on an old spec', async () => {
    await show(lines(spec({ specApproved: { by: 'Momen', at: '' }, waiting: { kind: 'plan', summary: '' } })));
    expect(page.querySelectorAll('.pkind').length).toBe(3);
    expect(buttons().filter((b) => b.className === 'kindbtn')).toHaveLength(0);
    expect(K.kindsOpen(spec({ live: true }))).toBe(false);
    expect(K.hasKinds({ criteria: criteria.map(({ proof: _p, ...c }) => c) })).toBe(false);
  });
});

describe('the Proof tab and the chat card', () => {
  const proof = [
    { criterion: 'I see Paid and my receipt number', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', kind: 'screen', shows: 'met' },
    { criterion: 'The booking is saved as paid', before: 'ma-21-after-rows-1.rows.json', after: 'ma-21-after-rows-1.rows.json', beforeLabel: 'New screen', afterLabel: 'After', kind: 'data', shows: 'met' },
    { criterion: 'A booking not paid in 15 minutes is freed', before: 'ma-21-test-3.test.json', after: 'ma-21-test-3.test.json', beforeLabel: 'Test', afterLabel: 'Test', kind: 'test', shows: 'met', test: { name: 'frees an unpaid slot', file: 'tests/booking.test.ts', steps: ['Makes a booking at 10:00 and does not pay', 'Moves the clock to 10:16'], before: 'failed', after: 'passed', seconds: 0.4 } },
    { criterion: 'Card numbers are never saved', before: 'ma-21-none-4.none.json', after: 'ma-21-none-4.none.json', beforeLabel: 'Not on a screen', afterLabel: 'Not on a screen', kind: 'none', shows: 'met', checked: 'The Reviewer checked the code and the tables: only the last 4 digits are kept.', note: 'Nothing to show.' },
  ];
  const rows = { table: 'bookings', columns: ['id', 'status', 'paid_at'], key: 'id', before: { rows: [{ id: '1042', status: 'waiting', paid_at: '–' }] }, after: { rows: [{ id: '1042', status: 'paid', paid_at: '10:31:07' }, { id: '1043', status: 'waiting', paid_at: '–' }] }, changes: { changed: [{ key: '1042', columns: ['status', 'paid_at'] }], added: ['1043'], removed: [] } };

  it('one block per line, by its kind: pictures, rows with the changed cells, the test before and after, the check', async () => {
    files['ma-21-after-rows-1.rows.json'] = rows;
    await show(() => h(KindBlocks, { t: { ...spec({ stage: 'review', waiting: { kind: 'proof', summary: '' } }), proof } }));
    const text = page.body.textContent;
    expect(page.querySelectorAll('.kindgrid .pf').length).toBe(4);
    expect(text).toContain('1 row changed, 1 row added');
    expect([...page.querySelectorAll('td.ch')].map((x: any) => x.textContent)).toEqual(['paid', '10:31:07']);
    expect(page.querySelector('tr.new')?.textContent).toContain('1043');
    expect(text).toContain('Moves the clock to 10:16');
    expect(text).toContain('It failed before the change');
    expect(text).toContain('and passes now');
    expect(text).toContain('only the last 4 digits are kept');
    expect(page.querySelectorAll('.kindgrid img').length).toBe(2);
  });

  it("the chat card shows each line's kind and a short form of its proof", async () => {
    await show(() => h(Body, { t: { ...spec({ waiting: { kind: 'proof', summary: '' } }), proof }, kind: 'proof' }));
    const text = page.body.textContent;
    expect(text).toContain('Failed before the change, passes now · 0.4 s');
    expect(text).toContain('Rows before and after');
    expect(text).toContain('Reviewer: The Reviewer checked the code and the tables: only the last 4 digits are kept.');
    expect(page.querySelectorAll('.shortproof .pkind').length).toBe(4);
    // Only real pictures in the card's strip.
    expect(page.querySelectorAll('.shots img').length).toBe(1);
  });

  it('the spec card has each line with its kind', async () => {
    await show(() => h(Body, { t: spec(), kind: 'spec' }));
    expect([...page.querySelectorAll('.pkind')].map((x: any) => x.textContent)).toEqual(['Screen', 'Data', 'Not on a screen']);
  });
});
