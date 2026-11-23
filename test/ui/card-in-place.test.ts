import { describe, expect, it, vi } from 'vitest';

/** The question card stays where it came in the talk (#32). Real React in a jsdom page. */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { useCardPlace } = await import(/* @vite-ignore */ new URL('../../console-ui/src/components/chat/CardInPlace.tsx', import.meta.url).pathname);
const h = React.createElement;

let at = -1;
function Talk({ id, waits, count }: { id: string; waits: boolean; count: number }) {
  at = useCardPlace(id, waits, count);
  return null;
}

describe('the question card in the talk (#32)', () => {
  it('stays after the messages that came before it, while new ones land below it', async () => {
    const root = createRoot(dom.window.document.getElementById('root'));
    await React.act(() => root.render(h(Talk, { id: 'MA-1', waits: true, count: 3 })));
    expect(at).toBe(3);
    await React.act(() => root.render(h(Talk, { id: 'MA-1', waits: true, count: 5 })));
    expect(at).toBe(3);
    // Answered: the card goes, and a new one later comes in at the end of the talk then.
    await React.act(() => root.render(h(Talk, { id: 'MA-1', waits: false, count: 6 })));
    expect(at).toBe(6);
    await React.act(() => root.render(h(Talk, { id: 'MA-1', waits: true, count: 7 })));
    expect(at).toBe(7);
    await React.act(() => root.unmount());
  });
});
