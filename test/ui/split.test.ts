import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A story too big for one, on the board: the suggestion's words in the person's language, the New ticket dialog's
 * buttons before anything is created, and the card on a story with Split, Keep as one and Change the split. Real React
 * and the real parts in a jsdom page: what each press sends, and that nothing is sent without one.
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
const S = await import(/* @vite-ignore */ file('src/lib/split.ts'));
const D = await import(/* @vite-ignore */ file('src/lib/decide.ts'));
const { DraftSizeButtons, DraftSuggestion } = await import(/* @vite-ignore */ file('src/components/split/DraftSize.tsx'));
const { SplitCard } = await import(/* @vite-ignore */ file('src/components/split/SplitCard.tsx'));
const { SizeHint } = await import(/* @vite-ignore */ file('src/components/split/SizeHint.tsx'));
const { LeadRequirements } = await import(/* @vite-ignore */ file('src/components/split/LeadSplit.tsx'));
const { act } = React;
const h = React.createElement;

const PARTS = [
  { title: 'Pay by card when booking', line: 'The last booking step takes the card and confirms', size: 'M', needs: [] },
  { title: 'Receipt by email and SMS', line: 'Sent right after the payment', size: 'S', needs: [1] },
  { title: 'Ask for a refund', line: 'Up to a day before; staff approve it', size: 'M', needs: [1] },
  { title: 'Payments report for staff', line: 'Every payment by day, with refunds', size: 'S', needs: [1] },
];
const FEW = { size: 'few', why: 'This is 4 stories in one.', parts: PARTS, found: ['4 separate asks'], at: '2026-11-12T10:00:00Z' };
const BRD = { size: 'brd', why: '', parts: [], areas: [{ name: 'Booking', stories: 6 }, { name: 'Payments', stories: 4 }], found: ['a document of 38 pages'], at: '2026-11-12T10:00:00Z' };
const PASTED = 'Customers should pay by card when they book, get a receipt by email and SMS, and be able to ask for their money back up to a day before. Staff need to see all payments in a report.';
const PASTED_AR = 'العميل يدفع بالبطاقة وقت الحجز، ويوصله إيصال بالإيميل والرسائل، ويقدر يطلب فلوسه ترجع لحد قبل الميعاد بيوم. والموظفين محتاجين يشوفوا كل المدفوعات في تقرير.';

const job = (split: object, text = PASTED) => ({ id: 'd1', status: 'done', step: 'write', looked: [], text, files: [], startedAt: '', draft: { title: 'Customers pay online', ask: text, kind: 'feature', priority: 'normal', criteria: [], rules: [], edgeCases: [], gaps: [], split } });
const story = (more: object = {}) => ({ id: 'MA-21', title: 'Customers pay online when they book', ask: PASTED, kind: 'feature', stage: 'tickets', status: 'The Analyst suggests a split', waiting: { kind: 'split', summary: 'The Analyst suggests splitting it into 4 stories' }, waitKey: 'split:abc', activity: [], split: { suggestion: FEW }, ...more });

let root: { render(n: unknown): void; unmount(): void };
let sent: { url: string; body: any }[];
let reply: unknown = {};

async function show(node: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path: '/', component: node, validateSearch: (s: Record<string, unknown>) => s });
  const reqs = createRoute({ getParentRoute: () => top, path: '/requirements/$id', component: () => h('p', null, 'Requirements page') });
  const router = createRouter({ routeTree: top.addChildren([route, reqs]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
}

const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;
const press = async (name: string) => {
  await act(async () => button(name).click());
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 20)));
};

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  reply = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') !== 'GET') sent.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('the words and rules', () => {
  it('speak the language the person wrote in, with plain sizes', () => {
    expect(S.langOf(PASTED)).toBe('en');
    expect(S.langOf(PASTED_AR)).toBe('ar');
    expect(S.WORDS.en.sizes).toEqual({ S: 'About a day', M: 'A few days', L: 'A week or more' });
    expect(S.partMeta(PARTS[1], S.WORDS.en)).toEqual({ size: 'About a day', needs: 'Needs 1' });
    expect(S.partMeta(PARTS[0], S.WORDS.ar)).toEqual({ size: 'كام يوم', needs: null });
    expect(S.areasTotal(BRD)).toEqual({ total: 10, parts: 2 });
  });

  it('say what really happened, from the story the board sent back', () => {
    const w = S.WORDS.en;
    expect(S.splitOutcome({ id: 'MA-21', split: { decided: { choice: 'split', by: 'Momen', at: '', made: ['MA-21', 'MA-22', 'MA-23', 'MA-24'] } } }, w)).toBe('Split into 4. MA-22, MA-23 and MA-24 wait in Tickets.');
    expect(S.splitOutcome({ id: 'MA-21', split: { decided: { choice: 'keep', by: 'Momen', at: '' } } }, w)).toBe('You kept it as one story.');
    expect(S.splitOutcome({ id: 'MA-21', split: { decided: { choice: 'requirements', by: 'Momen', at: '', breakdown: 'BR-2' } } }, w)).toMatch(/^Sent to Requirements as BR-2\./);
    expect(S.splitOutcome({ id: 'MA-21', split: { change: 'Keep the receipt with the payment' } }, w)).toBe('You asked for another split. The Analyst works on it now.');
    expect(S.WORDS.ar.done(['MA-21', 'MA-22', 'MA-23'])).toBe('اتقسمت لـ 3. MA-22 وMA-23 مستنيين في التذاكر.');
  });

  it('a split is a decision card of its own; the green card stays at the first steps only', () => {
    const t = story();
    expect(D.decideKind(t)).toBe('split');
    expect(D.seeable(t, 'split')).toBe(true);
    const at = new Date().toISOString();
    expect(S.showDecidedSplit({ stage: 'specs', waiting: { kind: 'questions', summary: '' }, split: { decided: { choice: 'split', by: '', at } } })).toBe(true);
    expect(S.showDecidedSplit({ stage: 'implement', waiting: null, split: { decided: { choice: 'split', by: '', at } } })).toBe(false);
    expect(S.draftShows({})).toBe('one');
    expect(S.draftShows({ split: BRD })).toBe('brd');
  });
});

describe('the New ticket dialog, before anything is created', () => {
  const dialog = (j: object, calls: string[]) => () =>
    h('div', null, h(DraftSuggestion, { job: j }), h(DraftSizeButtons, { job: j, onOne: (as: string) => calls.push(`one:${as}`), onCancel: () => calls.push('cancel'), onMade: (t?: { id: string }) => calls.push(`made:${t?.id ?? ''}`) }));

  it('a few stories: the parts, then Create 4 stories makes them in one call', async () => {
    const calls: string[] = [];
    reply = { tickets: [{ id: 'MA-21' }, { id: 'MA-22' }, { id: 'MA-23' }, { id: 'MA-24' }] };
    await show(dialog(job(FEW), calls));
    expect(page.body.textContent).toContain('The Analyst read it: this is 4 stories in one.');
    expect(page.body.textContent).toContain('Pay by card when booking');
    expect(page.body.textContent).toContain('You check each one before it starts.');
    expect(sent).toEqual([]);
    await press('Create 4 stories');
    expect(sent).toEqual([{ url: '/p/mawid/api/v1/tickets/draft/d1/split', body: {} }]);
    expect(calls).toEqual(['made:MA-21']);
  });

  it('Create as one story goes on to the form, and Cancel closes: neither sends anything', async () => {
    const calls: string[] = [];
    await show(dialog(job(FEW), calls));
    await press('Create as one story');
    await press('Cancel');
    expect(calls).toEqual(['one:kept', 'cancel']);
    expect(sent).toEqual([]);
  });

  it('a whole document: Send to Requirements, or one story anyway', async () => {
    const calls: string[] = [];
    reply = { breakdown: { id: 'BR-2', title: 'Mawid BRD v2' } };
    await show(dialog(job(BRD), calls));
    expect(page.body.textContent).toContain('The Analyst read it: this is a whole requirements document, not one story.');
    expect(page.body.textContent).toContain('About 10 stories in 2 parts:');
    await press('Make one story anyway');
    expect(calls).toEqual(['one:brd']);
    await press('Send to Requirements');
    expect(sent).toEqual([{ url: '/p/mawid/api/v1/tickets/draft/d1/requirements', body: {} }]);
  });

  it('in Arabic, right to left, in the words of the design', async () => {
    await show(dialog(job(FEW, PASTED_AR), []));
    expect(page.querySelector('.draftsize').getAttribute('dir')).toBe('rtl');
    expect(page.body.textContent).toContain('المحلل قرأها: دي 4 قصص في قصة واحدة.');
    expect(button('اعمل 4 قصص')).toBeTruthy();
    expect(button('اعملها قصة واحدة')).toBeTruthy();
  });
});

describe("the card on a story, in the Analyst's talk", () => {
  it('Split into 4 is the board\'s own call, sent with the mark of what the card showed', async () => {
    reply = story({ waiting: null, split: { suggestion: FEW, decided: { choice: 'split', by: 'Momen', at: '', made: ['MA-21', 'MA-22', 'MA-23', 'MA-24'] } } });
    await show(() => h(SplitCard, { t: story() }));
    expect(page.body.textContent).toContain('MA-21 keeps the first one. The other 3 wait in Tickets');
    expect(page.body.textContent).toContain('Nothing changes until you press.');
    expect(sent).toEqual([]);
    await press('Split into 4');
    expect(sent).toEqual([{ url: '/p/mawid/api/v1/tickets/MA-21/split', body: { choice: 'split', expect: 'split:abc' } }]);
    expect(page.body.textContent).toContain('Split into 4. MA-22, MA-23 and MA-24 wait in Tickets.');
  });

  it('Keep as one, and Change the split with a note', async () => {
    await show(() => h(SplitCard, { t: story() }));
    await press('Keep as one');
    expect(sent.at(-1)!.body).toEqual({ choice: 'keep', expect: 'split:abc' });
    await act(async () => root.unmount());
    root = createRoot(page.getElementById('root'));
    await show(() => h(SplitCard, { t: story() }));
    await press('Change the split');
    const box = page.querySelector('.df.ask input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(box, 'Keep the receipt with the payment');
      box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await press('Send');
    expect(sent.at(-1)!.body).toEqual({ choice: 'change', note: 'Keep the receipt with the payment', expect: 'split:abc' });
  });

  it('decided, it stays green with the new ids from the record', async () => {
    await show(() => h(SplitCard, { t: story({ waiting: { kind: 'questions', summary: '' }, stage: 'specs', split: { suggestion: FEW, decided: { choice: 'split', by: 'Momen', at: '', made: ['MA-21', 'MA-22', 'MA-23', 'MA-24'] } } }) }));
    expect([...page.querySelectorAll('.num.sid')].map((n: any) => n.textContent)).toEqual(['MA-21', 'MA-22', 'MA-23', 'MA-24']);
    expect(page.querySelector('.decide.decided')).toBeTruthy();
    expect(button('Split into 4')).toBeUndefined();
  });

  it('an Arabic story gets the Arabic card, right to left', async () => {
    await show(() => h(SplitCard, { t: story({ ask: PASTED_AR, title: 'الدفع أونلاين وقت الحجز' }) }));
    expect(page.querySelector('.decide.splitcard').getAttribute('dir')).toBe('rtl');
    expect(button('قسّمها لـ 4')).toBeTruthy();
    expect(button('خليها واحدة')).toBeTruthy();
    expect(page.body.textContent).toContain('مفيش حاجة هتتغير لحد ما تضغط.');
  });
});

describe('a whole document in a talk, and pasted to the lead', () => {
  const doc = { who: 'you', text: 'Here is the whole RoomFlow document.', at: '2026-11-13T10:00:00Z', big: 'brd' };

  it('the hint sends it once; after that it links to the breakdown the board kept', async () => {
    await show(() => h(SizeHint, { story: 'MA-21', m: doc }));
    await press('Send to Requirements');
    expect(sent).toEqual([{ url: '/p/mawid/api/v1/tickets/MA-21/chat/requirements', body: { at: doc.at } }]);
    await act(async () => root.unmount());
    root = createRoot(page.getElementById('root'));
    await show(() => h(SizeHint, { story: 'MA-21', m: { ...doc, breakdown: 'BR-4' } }));
    expect(button('Send to Requirements')).toBeUndefined();
    expect([...page.querySelectorAll('a')].map((a: any) => a.textContent)).toContain('BR-4');
  });

  it("the lead's card speaks the document's language", async () => {
    await show(() => h(LeadRequirements, { card: { id: 'c1.1.1', kind: 'requirements', level: 2, label: 'Send to Requirements', command: 'squad lead run c1.1.1', status: 'open', found: [], lang: 'ar' } }));
    expect(page.querySelector('.decide.splitcard').getAttribute('dir')).toBe('rtl');
    expect(button('ابعته للمتطلبات')).toBeTruthy();
    expect(button('مش دلوقتي')).toBeTruthy();
  });
});
