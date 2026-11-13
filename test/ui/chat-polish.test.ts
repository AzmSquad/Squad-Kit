import { describe, expect, it, vi } from 'vitest';

/**
 * The chat polish of 1.3.19 on the board: every chat scrolls like a modern chat (it opens at the bottom or at its first
 * unread message, your own message goes down, new words follow only at the bottom, a chip counts what came in while you
 * read, and late pictures move nothing); one talk in one place; the question's one small line; the design card's
 * picture of the mockup.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const RQ = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url).pathname)) as { QueryClient: new (o?: object) => unknown; QueryClientProvider: unknown };
const h = React.createElement;

// The root type check does not read the board's own files, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const S = await board('src/lib/stick-to-bottom.ts');
const P = await board('src/lib/popups.ts');
const H = await board('src/lib/here.ts');
const L = await board('src/lib/lead.ts');
const DP = await board('src/components/decide/DesignPreview.tsx');
const LT = await board('src/components/LeadTurn.tsx');

/* ── A chat to scroll, with no browser layout: messages of given heights in a box of a given height ── */

function chat(heights: number[], view = 300, newAt: number | null = null) {
  const items = heights.map((h) => ({ h }));
  let top = 0;
  const total = () => items.reduce((n, x) => n + x.h, 0);
  const at = (i: number) => items.slice(0, i).reduce((n, x) => n + x.h, 0) - top;
  const box = {
    clientHeight: view,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, total() - box.clientHeight));
    },
    get scrollHeight() {
      return total();
    },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => (newAt === null ? null : { getBoundingClientRect: () => ({ top: at(newAt) }) }),
  };
  const content = {
    get children() {
      return items.map((x, i) => ({ getBoundingClientRect: () => ({ top: at(i), bottom: at(i) + x.h }) }));
    },
  };
  const changes: { pinned: boolean; unseen: number }[] = [];
  const s = new S.StickToBottom((x: { pinned: boolean; unseen: number }) => changes.push(x));
  return {
    s,
    box,
    content,
    changes,
    /** Opens the talk: its box and its messages appear. */
    open: () => s.attach(box, content),
    bottom: () => total() - box.clientHeight,
    /** The person scrolls to a place. */
    scroll(to: number) {
      s.touched();
      box.scrollTop = to;
      s.onScroll();
    },
    /** A message grows: its words as they are written, a picture that loaded. */
    grow(i: number, by: number) {
      items[i]!.h += by;
      s.onResize();
    },
    /** A new message comes in. */
    add(h: number) {
      items.push({ h });
      s.onCount(items.length);
      s.onResize();
    },
  };
}

describe('scrolling, like a modern chat', () => {
  it('opens at the newest message', () => {
    const c = chat([200, 200, 200, 200]);
    c.open();
    expect(c.box.scrollTop).toBe(c.bottom());
    expect(c.s.pinned).toBe(true);
  });

  it('opens at the first unread message, under its "New" line, and keeps it there while pictures load', () => {
    const c = chat([200, 200, 200, 200, 200], 300, 2);
    c.open();
    expect(c.box.scrollTop).toBe(400 - 12);
    expect(c.s.pinned).toBe(false);
    c.grow(0, 150);
    expect(c.box.scrollTop).toBe(550 - 12);
  });

  it('opens at the bottom again when a popup comes back from its bar', () => {
    const c = chat([200, 200, 200, 200]);
    c.open();
    c.scroll(100);
    expect(c.s.pinned).toBe(false);
    // Minimised: the talk goes. Brought back: a new box, placed again.
    c.s.attach(null, null);
    c.add(150);
    c.open();
    expect(c.box.scrollTop).toBe(c.bottom());
    expect(c.s.pinned).toBe(true);
  });

  it('follows new words only while you are at the bottom, or near it', () => {
    const c = chat([200, 200, 200]);
    c.open();
    c.s.onCount(3);
    c.grow(2, 120);
    expect(c.box.scrollTop).toBe(c.bottom());
    c.scroll(c.bottom() - 40);
    expect(c.s.pinned).toBe(true);
    c.add(80);
    c.grow(3, 60);
    expect(c.box.scrollTop).toBe(c.bottom());
    expect(c.s.unseen).toBe(0);
  });

  it('stays put while you read further up, with a chip that counts what came in', () => {
    const c = chat([200, 200, 200, 200]);
    c.open();
    c.s.onCount(4);
    c.scroll(150);
    c.add(100);
    c.grow(4, 40);
    c.add(100);
    expect(c.box.scrollTop).toBe(150);
    expect(c.s).toMatchObject({ pinned: false, unseen: 2 });
    expect(c.changes.at(-1)).toEqual({ pinned: false, unseen: 2 });
    // The chip takes you down, and goes.
    c.s.toBottom();
    expect(c.box.scrollTop).toBe(c.bottom());
    expect(c.s).toMatchObject({ pinned: true, unseen: 0 });
  });

  it('takes your own message to the bottom, from anywhere', () => {
    const c = chat([200, 200, 200, 200]);
    c.open();
    c.scroll(0);
    c.s.toBottom();
    c.add(60);
    expect(c.box.scrollTop).toBe(c.bottom());
    expect(c.s.unseen).toBe(0);
  });

  it('never moves what you read when a picture above it loads late', () => {
    const c = chat([200, 200, 200, 200, 200]);
    c.open();
    c.scroll(450);
    // The message at the top of the view starts at 400; the first one grows by 300 above it.
    c.grow(0, 300);
    expect(c.box.scrollTop).toBe(750);
    c.grow(1, -100);
    expect(c.box.scrollTop).toBe(650);
  });

  it('keeps the bottom when the box changes size: the composer grows, the window, another popup', () => {
    const c = chat([200, 200, 200, 200]);
    c.open();
    c.s.touched();
    c.box.clientHeight = 200;
    c.s.onResize();
    expect(c.box.scrollTop).toBe(c.bottom());
    c.box.clientHeight = 420;
    c.s.onResize();
    expect(c.box.scrollTop).toBe(c.bottom());
  });
});

describe('one talk in one place', () => {
  const state = { open: [{ id: 'lead', min: false }, { id: 'MA-10', min: false }, { id: 'MA-9', min: true }], seen: { 'MA-10': 4 }, looked: {}, lead: 'c1' };

  it("hides only the talks the page shows, and gives them back as they were", () => {
    const here = new Set(['MA-10']);
    expect(P.notShownHere(state, here).open.map((p: { id: string }) => p.id)).toEqual(['lead', 'MA-9']);
    expect(P.notShownHere(state, here).seen).toEqual({ 'MA-10': 4 });
    expect(P.notShownHere(state, new Set())).toBe(state);
    // The page shows the lead's talk: the lead's popup hides, the others stay.
    expect(P.notShownHere(state, new Set(['lead'])).open.map((p: { id: string }) => p.id)).toEqual(['MA-10', 'MA-9']);
  });

  it("lets a page say it shows a talk while it is there, and brings its own box into view from the head", async () => {
    const focus = vi.fn();
    function Page({ id }: { id: string | null }) {
      H.useShowsTalk(id, focus);
      return null;
    }
    const root = createRoot(dom.window.document.getElementById('root'));
    await React.act(async () => root.render(h(Page, { id: 'MA-10' })));
    expect(H.shownHere.has('MA-10')).toBe(true);
    H.shownHere.focus('MA-10');
    expect(focus).toHaveBeenCalledTimes(1);
    // Another talk picked: the first one's popup comes back.
    await React.act(async () => root.render(h(Page, { id: 'MA-23' })));
    expect(H.shownHere.has('MA-10')).toBe(false);
    expect(H.shownHere.has('MA-23')).toBe(true);
    await React.act(async () => root.unmount());
    expect(H.shownHere.has('MA-23')).toBe(false);
  });

  it("puts the cursor in the page's own box", () => {
    const page = dom.window.document;
    const wrap = page.createElement('div');
    wrap.innerHTML = '<div class="cthread"></div><textarea></textarea>';
    page.body.appendChild(wrap);
    wrap.scrollIntoView = () => {};
    const box = wrap.querySelector('textarea');
    box.scrollIntoView = () => {};
    H.focusBoxIn(wrap);
    expect(page.activeElement).toBe(box);
    wrap.remove();
  });
});

describe("your question's line", () => {
  it('is one dim line under the bubble: the time and where, in full on hover', async () => {
    const at = new Date(2026, 10, 13, 6, 3).toISOString();
    const c = { id: 'c1', title: 'Hello', startedAt: at, updatedAt: at, context: { from: 'board', page: 'Board' }, turns: [] as unknown[] };
    const turn = { n: 1, ask: { text: 'What is pending on me?', at, context: { from: 'board', page: 'Board' } }, trace: [], refused: [], answer: { headline: 'Six stories wait for you.', body: '', evidence: [], sources: [], cards: [], by: 'board' }, seconds: 0, costUsd: 0 };
    c.turns.push(turn);
    const root = createRoot(dom.window.document.getElementById('root'));
    const qc = new RQ.QueryClient();
    await React.act(async () => root.render(h(RQ.QueryClientProvider, { client: qc }, h(LT.LeadTurnView, { c, turn, last: true, onAgain: () => {} }))));
    const page = dom.window.document;
    const line = page.querySelector('.lt-you .lt-when');
    expect(line.textContent).toBe('06:03·Board');
    expect(line.getAttribute('title')).toBe('Asked on the Board page');
    // No pill, no "You" row above it.
    expect(page.querySelector('.lt-you .lt-ctx')).toBeNull();
    expect(page.querySelector('.lt-meta')).toBeNull();
    await React.act(async () => root.unmount());
  });

  it('shows only the time when it was asked on the lead page itself', () => {
    expect(L.askedPlace({ from: 'board', page: 'Squad lead' })).toBe('Squad lead');
  });
});

describe('the design card', () => {
  it("shows the Architect's mockup as a picture that cannot be clicked into, and opens the full one", async () => {
    dom.window.localStorage.setItem('squad.console.token', 'test-token');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ url: 'http://127.0.0.1:4809/mockups/abc/mockup.html' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const root = createRoot(dom.window.document.getElementById('root'));
    const qc = new RQ.QueryClient();
    const show = async (t: unknown) => React.act(async () => root.render(h(RQ.QueryClientProvider, { client: qc }, h(DP.DesignPreview, { t }))));
    await show({ id: 'MA-8', title: 'Customer picks a service', mockup: 'mockup.html' });
    await React.act(async () => new Promise((r) => setTimeout(r, 20)));
    const page = dom.window.document;
    const frame = page.querySelector('.mockprev .mockprev-frame');
    expect(asked[0]).toBe('/p/mawid/api/v1/tickets/MA-8/mockup-link?path=mockup.html');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:4809/mockups/abc/mockup.html');
    // Sealed and out of reach: its own scripts only, no focus, no clicks inside it.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const open = [...page.querySelectorAll('.mockprev button')].find((b: { textContent: string }) => b.textContent.includes('Open the mockup'));
    expect(open).toBeTruthy();
    await React.act(async () => open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    // The full one is the board's one viewer, at the page's top level (test/ui/chat-frame.test.ts has the rest).
    expect(page.querySelector('body > .mockview-veil .mockview-frame').getAttribute('src')).toBe('http://127.0.0.1:4809/mockups/abc/mockup.html');
    await React.act(async () => page.querySelector('.mockview button[aria-label="Close"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(page.querySelector('.mockview')).toBeNull();
    // A design with no mockup shows no picture.
    await show({ id: 'MA-9', title: 'Another', mockup: undefined });
    expect(page.querySelector('.mockprev')).toBeNull();
    await React.act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});
