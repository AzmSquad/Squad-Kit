import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A chat's frame follows the board, not the words in it: an Arabic talk keeps the popup's head, its buttons, the
 * sources and the cards where they are, the person's bubbles on the person's side, and turns only each message's words
 * inside their bubble. And a mockup opens in the board's one viewer at the page's top level, never inside the small
 * popup that holds its card. Real React and the real popups in a jsdom page.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
const page = dom.window.document;
dom.window.scrollTo = () => undefined;
const globals = () => {
  vi.stubGlobal('self', dom.window);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
};
globals();

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { popups } = await import(/* @vite-ignore */ file('src/lib/popups.ts'));
const { LeadPopup } = await import(/* @vite-ignore */ file('src/components/popups/LeadPopup.tsx'));
const { StoryPopup } = await import(/* @vite-ignore */ file('src/components/popups/StoryPopup.tsx'));
const { DesignPreview } = await import(/* @vite-ignore */ file('src/components/decide/DesignPreview.tsx'));
const { ChatFiles } = await import(/* @vite-ignore */ file('src/components/ChatFiles.tsx'));
const { Modal } = await import(/* @vite-ignore */ file('src/components/ui.tsx'));
const { TicketDrawer } = await import(/* @vite-ignore */ file('src/pages/TicketDrawer.tsx'));
const { detect } = await import(/* @vite-ignore */ file('src/lib/lang.ts'));
const { act } = React;
const h = React.createElement;

const ARABIC = 'هل التصميم جاهز؟ أريد أن أرى شاشة الحجز قبل الموافقة.';
const at = '2026-11-13T09:00:00.000Z';
const story = {
  id: 'SK-201',
  title: 'Book a visit online',
  ask: 'Patients book a visit online.',
  kind: 'feature',
  source: { type: 'manual' },
  priority: 'normal',
  stage: 'specs',
  status: 'Waits for you',
  waiting: { kind: 'plan', summary: 'The design is ready for you to approve' },
  waitKey: 'plan:1',
  specApproved: { by: 'Momen', at },
  createdAt: at,
  createdBy: 'Momen',
  owner: 'Momen',
  activity: [],
  story: 'As a patient, I want to book a visit online.',
  decision: { title: 'Where the booking lives', why: 'Phones.', options: [{ name: 'One booking page', note: 'Fast', chosen: true }] },
  steps: [{ title: 'Booking page', status: 'todo', minutes: 5 }],
  work: { steps: 1, tests: 1, screens: 1 },
  mockup: '/x/SK-201/mockup.html',
  chat: {
    with: 'architect',
    open: true,
    messages: [
      // A talk that is clearly Arabic, with one short English question in it: the words the old popup turned on.
      { who: 'you', text: 'Pick the doctor too?', at },
      { who: 'architect', text: 'Yes.', at, options: ['Pick for them', 'Let them pick'] },
      { who: 'you', text: ARABIC, at, files: ['/x/SK-201/idea.html'] },
      { who: 'architect', text: 'نعم. الأوقات المتاحة تظهر باللون الأخضر، واسم الطبيب فوق كل وقت، والسعر تحت اسم الطبيب.', at },
    ],
  },
};
const sources = [{ kind: 'story', ref: 'SK-201', label: 'Book a visit online' }, { kind: 'file', ref: 'src/booking.ts:12' }];
const turn = (n: number, text: string, headline: string) => ({
  n,
  ask: { text, at, context: { from: 'board', page: 'Board' } },
  answer: { headline, body: '', evidence: [], sources, cards: [{ id: `c${n}`, level: 1, label: 'Approve the design', command: 'squad approve SK-201', status: 'open', kind: 'decide', story: 'SK-201', wait: 'plan', key: 'plan:1', open: '/board' }], by: 'board' },
  trace: [],
  refused: [],
});
const talk = { id: 'c1', title: 'What waits for me?', startedAt: at, updatedAt: at, context: { from: 'board', page: 'Board' }, turns: [turn(1, 'What waits for me?', 'The design of SK-201 waits for you.'), turn(2, ARABIC, 'نعم، التصميم جاهز وينتظر موافقتك.')] };
const MOCKUP_URL = 'http://127.0.0.1:4809/mockup/SK-201?k=abc';
const answers: Record<string, unknown> = {
  '/api/v1/board': { ready: true, meta: { project: 'Mawid', engine: 'live', user: { name: 'Momen', role: 'PM' }, git: { base: 'main' } }, tickets: [story], archived: [], stats: { released30: 0, bugs30: 0, open: 1 } },
  '/api/v1/lead': { needsYou: [], whatsNew: [], squadNow: [] },
  '/api/v1/lead/conversations/c1': talk,
  '/api/v1/tickets/SK-201': story,
  '/mockup-link': { url: MOCKUP_URL },
};

let root: { render(n: unknown): void; unmount(): void };
const wait = () => act(async () => new Promise((r) => dom.window.setTimeout(r, 15)));
const one = (css: string) => page.querySelector(css) as any;
const all = (css: string) => [...page.querySelectorAll(css)] as any[];
/** The nearest element above that sets a direction, outside the element itself. */
const turnedBy = (el: any) => el.parentElement.closest('[dir="rtl"]');
const click = (el: any) => act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

/** A component on the board page, as the popups sit over it. */
async function show(component: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const routes = ['/board', '/lead', '/inbox', '/conversations'].map((p) => createRoute({ getParentRoute: () => top, path: p, component: p === '/board' ? component : () => null, validateSearch: (s: Record<string, unknown>) => s }));
  const router = createRouter({ routeTree: top.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/board'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.getElementById('root').textContent; i += 1) await wait();
  for (let i = 0; i < 6; i += 1) await wait();
}

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  vi.stubGlobal('fetch', async (url: string) => {
    const p = String(url).split('?')[0]!;
    const hit = Object.keys(answers).filter((k) => p.endsWith(k)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(hit ? answers[hit] : {}), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("an Arabic talk in the lead's popup", () => {
  it('keeps the frame the board way round, your bubbles on your side, and turns only the words', async () => {
    popups.open('lead');
    popups.follow('c1');
    await show(() => h(LeadPopup, { pop: { id: 'lead', min: false } }));
    const pop = one('section.pop');
    expect(pop.textContent).toContain('نعم، التصميم جاهز');
    // The head, its Close, Minimise and Open full page, the sources and the cards: no direction from the words.
    expect(pop.hasAttribute('dir')).toBe(false);
    expect(turnedBy(one('.pop .ph .tools'))).toBeNull();
    expect(all('.pop .lt-src').length).toBe(2);
    for (const el of all('.pop .lt-src, .pop .decide .df')) expect(turnedBy(el)).toBeNull();
    // Your two questions, one English and one Arabic, both on your side; each runs its own way inside its bubble.
    const yours = all('.pop .lt-you');
    expect(yours.length).toBe(2);
    for (const el of yours) expect(turnedBy(el)).toBeNull();
    expect(yours.map((el) => el.querySelector('p').getAttribute('dir'))).toEqual(['ltr', 'rtl']);
    expect(yours[1].querySelector('p').getAttribute('lang')).toBe('ar');
    // The answer's own words turn, by their language.
    expect(all('.pop .lt-answer h3').map((el) => el.getAttribute('dir'))).toEqual(['ltr', 'rtl']);
  });

  it('turns only the box while you type in Arabic, never the popup', async () => {
    await show(() => h(LeadPopup, { pop: { id: 'lead', min: false } }));
    const box = one('.pop textarea');
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(box, 'السلام عليكم');
      box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    expect(box.getAttribute('dir')).toBe('rtl');
    expect(one('section.pop').hasAttribute('dir')).toBe(false);
  });
});

describe("an Arabic talk in a story's popup", () => {
  it('keeps your messages on your side and the head where it was', async () => {
    // Clearly Arabic: the old popup turned its whole frame on these words.
    expect(detect(story.chat.messages.map((m) => m.text).join(' ')).share).toBeGreaterThan(0.8);
    await show(() => h(StoryPopup, { pop: { id: 'SK-201', min: false }, onOpenDoc: () => {} }));
    expect(one('section.pop').hasAttribute('dir')).toBe(false);
    expect(turnedBy(one('.pop .ph .tools'))).toBeNull();
    const yours = all('.pop .cyou');
    expect(yours.length).toBe(2);
    for (const el of yours) expect(turnedBy(el)).toBeNull();
    // The Arabic message's words run right to left inside its bubble, the English one left to right.
    expect(yours[1].querySelector('.cybub [dir="rtl"]')).toBeTruthy();
    expect(yours[0].querySelector('.cybub [dir="ltr"]')).toBeTruthy();
    // Its design card closes the talk, the board way round too.
    expect(turnedBy(one('.pop .decide'))).toBeNull();
  });

  it("opens the card's mockup over the page while Approve stays on the card, for you to press", async () => {
    await show(() => h(StoryPopup, { pop: { id: 'SK-201', min: false }, onOpenDoc: () => {} }));
    const approve = () => all('.pop .decide button').find((b) => b.textContent.includes('Approve design'));
    expect(approve()).toBeTruthy();
    await click(one('.pop .decide .mockprev-open'));
    await wait();
    const viewer = one('.mockview');
    expect(viewer.closest('.pop')).toBeNull();
    expect([...viewer.querySelectorAll('button')].some((b: any) => /Approve/.test(b.textContent))).toBe(false);
    expect(approve().closest('.mockview')).toBeNull();
  });

  it('leaves your message as it was when you click inside the viewer it opened', async () => {
    await show(() => h(StoryPopup, { pop: { id: 'SK-201', min: false }, onOpenDoc: () => {} }));
    const mine = all('.pop .cyou')[1];
    await click(mine.querySelector('.cfile'));
    await wait();
    const picked = mine.classList.contains('picked');
    // The viewer lies over the page, outside the bubble: a click in it is not a click on the message.
    await click(one('.mockview header'));
    expect(mine.classList.contains('picked')).toBe(picked);
  });
});

describe('the styles', () => {
  it('never move a bubble, a popup or its tail by the direction of the words', () => {
    const dir = file('src/styles');
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css'))) {
      for (const rule of fs.readFileSync(path.join(dir, f), 'utf8').split('}')) {
        const [selector = '', body = ''] = rule.split('{').slice(-2);
        // A chat's bubble or frame, picked by the language or direction of its words: [dir=rtl], .ar, [lang=ar], .t-ar.
        const byWords = /\[dir=['"]?rtl|:dir\(rtl\)|\.ar\b|\[lang=['"]?ar|\.t-(ar|mx)\b/.test(selector) && /\.(cyou|cybub|lt-you|askme|askit|pop|ph)\b/.test(selector);
        const moves = /(^|[\s;{])(align-self|justify-self|justify-content|flex-direction|inset-inline(-start|-end)?|left|right|margin-inline(-start|-end)?|margin-left|margin-right|float|order|border-radius|transform-origin|direction)\s*:/;
        if (byWords && moves.test(body)) bad.push(`${f}: ${selector.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the board's dialog", () => {
  it('opens at the page top level from inside a popup, and Esc and Close still work', async () => {
    const closed: string[] = [];
    await show(() => h('section', { className: 'pop' }, h('div', { className: 'decide' }, h(Modal, { title: 'Propose a change', onClose: () => closed.push('closed') }, h('p', null, 'What should change?')))));
    const veil = one('.modal-veil');
    // In document.body itself: a popup's or a card's transform, overflow or text styles cannot reach it.
    expect(veil.parentElement).toBe(page.body);
    expect(one('.pop').querySelector('.modal-veil, .modal')).toBeNull();
    expect(veil.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Propose a change');
    await act(async () => page.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await click(veil.querySelector('button[aria-label="Close"]'));
    expect(closed).toEqual(['closed', 'closed']);
  });
});

describe('the mockup viewer', () => {
  it('opens over the whole page from a card in a popup, never inside the popup, and gives the focus back', async () => {
    await show(() => h('section', { className: 'pop' }, h(DesignPreview, { t: story })));
    const open = [...page.querySelectorAll('.pop .mockprev button')].find((b: any) => b.textContent.includes('Open the mockup')) as any;
    // As in Safari: the click does not focus the button, and the focus still comes back to it.
    expect(page.activeElement).not.toBe(open);
    await click(open);
    await wait();
    const viewer = one('[role="dialog"]');
    // At the page's top level: a popup's transform or overflow cannot hold it.
    expect(viewer.closest('.pop')).toBeNull();
    expect(viewer.parentElement.parentElement).toBe(page.body);
    expect(viewer.getAttribute('aria-modal')).toBe('true');
    const frame = viewer.querySelector('iframe');
    expect(frame.getAttribute('src')).toBe(MOCKUP_URL);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    // The focus goes in, and Tab past either end comes back round.
    const close = viewer.querySelector('button[aria-label="Close"]');
    expect(page.activeElement).toBe(close);
    const [first, last] = all('.mockview-guard');
    await act(async () => last.focus());
    expect(page.activeElement).toBe(close);
    await act(async () => first.focus());
    expect(page.activeElement).toBe(frame);
    // Esc closes it, and the button that opened it has the focus back.
    await act(async () => page.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(one('[role="dialog"]')).toBeNull();
    expect(page.activeElement).toBe(open);
  });

  it('closes on Esc pressed inside the mockup, told by its own frame only', async () => {
    await show(() => h('section', { className: 'pop' }, h(DesignPreview, { t: story })));
    await click(one('.pop .mockprev-open'));
    await wait();
    const frame = one('.mockview-frame');
    const said = (source: unknown, data: unknown) => act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source })));
    // Another frame, or other words, change nothing.
    await said(dom.window, { squadKit: 'mockup-escape' });
    await said(frame.contentWindow, { squadKit: 'something-else' });
    expect(one('.mockview')).toBeTruthy();
    await said(frame.contentWindow, { squadKit: 'mockup-escape' });
    expect(one('.mockview')).toBeNull();
  });

  it("closes on Esc in a story's drawer and leaves the drawer open", async () => {
    const closed: string[] = [];
    await show(() => h(TicketDrawer, { id: 'SK-201', tab: 'plan', onClose: () => closed.push('drawer') }));
    await click(all('.mockup button').find((b) => b.textContent.includes('Full size')));
    await wait();
    expect(one('body > .mockview-veil')).toBeTruthy();
    await act(async () => page.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(one('.mockview')).toBeNull();
    expect(closed).toEqual([]);
    // With the viewer closed, Esc closes the drawer as before.
    await act(async () => page.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closed).toEqual(['drawer']);
  });

  it('is the same viewer for a mockup sent in a chat', async () => {
    await show(() => h('section', { className: 'pop' }, h(ChatFiles, { ticket: 'SK-201', files: ['/x/SK-201/idea.html'] })));
    await click(one('.pop .cfile'));
    await wait();
    const viewer = one('[role="dialog"]');
    expect(viewer.closest('.pop')).toBeNull();
    expect(viewer.querySelector('.mockview-frame').getAttribute('src')).toBe(MOCKUP_URL);
    await click(viewer.querySelector('button[aria-label="Close"]'));
    expect(one('[role="dialog"]')).toBeNull();
  });
});
