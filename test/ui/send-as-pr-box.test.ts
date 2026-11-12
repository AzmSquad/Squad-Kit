import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Send it as a pull request" box on a merged story of squad-kit's own code. Real React in a jsdom page. The push is
 * the step itself: it shows with commands turned off too, and a folder with spaces is quoted, so it runs as copied.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/squad-kit/board', pretendToBeVisual: true });
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
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { SendAsPr } = await import(/* @vite-ignore */ file('src/components/SendAsPr.tsx'));
const { Cmd } = await import(/* @vite-ignore */ file('src/components/ui.tsx'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };

beforeEach(() => {
  globals();
  page.body.innerHTML = '<div id="root"></div>';
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.localStorage.clear();
});

const box = {
  branch: 'squad/sk-1',
  remote: 'origin',
  push: 'git push origin squad/sk-1',
  dir: '/Users/sara/My Projects/squad-kit',
  page: 'https://github.com/AzmSquad/squad-kit/compare/main...sara:squad/sk-1?expand=1&title=Show+the+version',
  host: 'GitHub',
  into: 'AzmSquad/squad-kit',
};

describe('Send it as a pull request', () => {
  it('quotes a folder with spaces, and shows the push with commands turned off', async () => {
    dom.window.localStorage.setItem('sk.commands', 'off');
    await act(async () => root.render(h(PrefsProvider, null, h('div', null, h(SendAsPr, { s: box }), h(Cmd, { text: 'squad watch SK-1' })))));
    // The board's terminal twin of a button stays hidden; the push, which is the step itself, does not.
    const terms = [...page.querySelectorAll('.term')];
    expect(terms).toHaveLength(1);
    expect(terms[0].closest('.sendas')).not.toBeNull();
    const copy = page.querySelector('.sendas .term button') as any;
    expect(copy.getAttribute('aria-label')).toBe('Copy cd "/Users/sara/My Projects/squad-kit" && git push origin squad/sk-1');
    const link = page.querySelector('.sendas a') as any;
    expect(link.textContent).toBe('Open the pull request page ');
    expect(link.getAttribute('href')).toBe(box.page);
    expect(page.querySelector('.sendas')!.textContent).toContain('open the pull request to AzmSquad/squad-kit on GitHub');
  });
});
