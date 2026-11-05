import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the person typed and has not sent stays on this computer. Real React in a jsdom page: the boxes unmount and mount
 * again the way another tab, Esc, a click outside or a reload make them.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
const page = dom.window.document;
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { act } = React;
// The root type check does not read the board's JSX, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const { useDraft, clearDrafts, draftKey, pruneDrafts, readDraft, writeDraft } = await board('src/lib/drafts.ts');
const { Modal } = await board('src/components/ui.tsx');
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };

function Box({ scope = 'SK-1', field = 'note' }: { scope?: string; field?: string }) {
  const [text, setText, clear] = useDraft(scope, field, '');
  return h('div', null, h('input', { value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value) }), h('button', { onClick: clear }, 'sent'));
}

const box = () => page.querySelector('input');
async function type(text: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    set.call(box(), text);
    box().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function show(node: unknown) {
  await act(async () => root.render(node));
}
async function hide() {
  await act(async () => root.render(null));
}

beforeEach(async () => {
  dom.window.localStorage.clear();
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('typed text', () => {
  it('survives the box going away and coming back: another tab, Esc, a click outside', async () => {
    await show(h(Box));
    await type('needs the manager to approve');
    await hide();
    await show(h(Box));
    expect(box().value).toBe('needs the manager to approve');
  });

  it('survives a reload: it is in the browser, under the project, the ticket and the field', async () => {
    await show(h(Box));
    await type('kept');
    expect(readDraft(draftKey('mawid', 'SK-1', 'note'))).toBe('kept');
  });

  it('never shows on another ticket or another field', async () => {
    await show(h(Box));
    await type('for SK-1');
    await show(h(Box, { scope: 'SK-2' }));
    expect(box().value).toBe('');
    await type('for SK-2');
    await show(h(Box, { field: 'other' }));
    expect(box().value).toBe('');
    await show(h(Box));
    expect(box().value).toBe('for SK-1');
    await show(h(Box, { scope: 'SK-2' }));
    expect(box().value).toBe('for SK-2');
  });

  it('goes once it is sent', async () => {
    await show(h(Box));
    await type('sent now');
    await act(async () => page.querySelector('button').click());
    expect(box().value).toBe('');
    await hide();
    await show(h(Box));
    expect(box().value).toBe('');
    expect(readDraft(draftKey('mawid', 'SK-1', 'note'))).toBeUndefined();
  });

  it('is no draft when it is back to what it started as', async () => {
    await show(h(Box));
    await type('x');
    await type('');
    expect(readDraft(draftKey('mawid', 'SK-1', 'note'))).toBeUndefined();
  });

  it('browser storage that refuses keeps it in memory, and nothing throws', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => undefined, key: () => null, length: 0 };
    writeDraft('squad.draft.a.b.c', 'still here', refusing as never);
    expect(readDraft('squad.draft.a.b.c', refusing as never)).toBe('still here');
  });

  it('browser storage that throws on any use is no problem either', () => {
    const broken = { get length() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { throw new Error('denied'); } };
    expect(readDraft('squad.draft.x.y.z', broken as never)).toBeUndefined();
    expect(() => writeDraft('squad.draft.x.y.z', 'v', broken as never)).not.toThrow();
    expect(() => clearDrafts('x', 'y', broken as never)).not.toThrow();
    expect(() => pruneDrafts(broken as never)).not.toThrow();
  });

  it('a draft nobody came back to in a month goes', () => {
    const at = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeDraft('squad.draft.a.b.old', 'old', dom.window.localStorage, at);
    writeDraft('squad.draft.a.b.new', 'new', dom.window.localStorage);
    pruneDrafts(dom.window.localStorage);
    expect(dom.window.localStorage.getItem('squad.draft.a.b.old')).toBeNull();
    expect(readDraft('squad.draft.a.b.new', dom.window.localStorage)).toBe('new');
  });

  it('clearing one ticket leaves the others', async () => {
    writeDraft(draftKey('mawid', 'new-ticket', 'title'), 'a');
    writeDraft(draftKey('mawid', 'new-ticket', 'ask'), 'b');
    writeDraft(draftKey('mawid', 'SK-1', 'note'), 'c');
    clearDrafts('mawid', 'new-ticket');
    expect(readDraft(draftKey('mawid', 'new-ticket', 'title'))).toBeUndefined();
    expect(readDraft(draftKey('mawid', 'SK-1', 'note'))).toBe('c');
  });
});

describe('closing a dialog', () => {
  const esc = async () => act(async () => void dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  const outside = async () => act(async () => void page.querySelector('.modal-veil').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })));

  it('with typed text only: Esc and a click outside close it, and the text is back when it opens again', async () => {
    let closed = 0;
    await show(h(Modal, { title: 'New ticket', onClose: () => (closed += 1) }, h(Box, { scope: 'new-ticket' })));
    await type('a pasted BRD');
    await esc();
    expect(closed).toBe(1);
    await outside();
    expect(closed).toBe(2);
    await hide();
    await show(h(Modal, { title: 'New ticket', onClose: () => undefined }, h(Box, { scope: 'new-ticket' })));
    expect(box().value).toBe('a pasted BRD');
  });

  it('with files attached, which cannot be kept: Esc, the cross and a click outside ask first', async () => {
    let closed = 0;
    await show(h(Modal, { title: 'New ticket', onClose: () => (closed += 1), losing: 'the 2 attached files' }, 'body'));
    await esc();
    expect(closed).toBe(0);
    expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain('the 2 attached files');
    await act(async () => page.querySelector('[role="alertdialog"] .btn.pri').click());
    expect(page.querySelector('[role="alertdialog"]')).toBeNull();
    await outside();
    await act(async () => page.querySelector('[role="alertdialog"] .btn:not(.pri)').click());
    expect(closed).toBe(1);
  });
});
