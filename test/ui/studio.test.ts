import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Studio (AB-127): its place in the sidebar, its page at /p/<project>/studio, and its two tabs. The last tab is kept
 * in the browser tab's own memory, one per project: it lasts through a reload and ends when the tab closes. The page
 * calls nothing on the board server, so opening it creates nothing in the project. Real React in a jsdom page.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const URL_AT = 'http://127.0.0.1:4809/p/mawid/studio';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: URL_AT, pretendToBeVisual: true });
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
// The root type check does not read the board's own files, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const S = await board('src/lib/studio.ts');
const { StudioPage } = await board('src/pages/Studio.tsx');
const h = React.createElement;

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let root: { render(n: unknown): void; unmount(): void } | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;

async function open(project: string) {
  await close();
  root = createRoot(page.getElementById('root'));
  await act(async () => root!.render(h(StudioPage, { project })));
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
const tabs = () => [...page.querySelectorAll('[role="tab"]')] as { textContent: string; getAttribute(n: string): string | null; dispatchEvent(e: unknown): void }[];
const openTab = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
async function click(label: string) {
  const tab = tabs().find((t) => t.textContent === label)!;
  await act(async () => tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}

/** A fresh browser tab: the same computer, a new tab's own memory. */
function newBrowserTab() {
  const fresh = new JSDOM('<!doctype html>', { url: URL_AT });
  vi.stubGlobal('sessionStorage', fresh.window.sessionStorage);
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  fetchSpy = vi.fn(() => Promise.reject(new Error('The Studio must not call the board server')));
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(close);

describe('the Studio in the sidebar', () => {
  const nav = () => {
    const shell = read('console-ui/src/components/Shell.tsx');
    const list = /const NAV = \[([\s\S]*?)\n\];/.exec(shell)![1]!;
    return [...list.matchAll(/\{ to: '([^']+)', label: '([^']+)', icon: (\w+)([^}]*)\}/g)].map((m) => ({ to: m[1], label: m[2], icon: m[3], rest: m[4] }));
  };

  it('shows Studio with the palette icon right after Architecture, with no switch and no counter', () => {
    const items = nav();
    const at = items.findIndex((n) => n.label === 'Architecture');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(items[at + 1]).toEqual({ to: '/studio', label: 'Studio', icon: 'Palette', rest: ' ' });
    expect(read('console-ui/src/components/Shell.tsx')).toMatch(/import \{[^}]*\bPalette\b[^}]*\} from 'lucide-react'/);
  });

  it('opens at /p/<project>/studio, with the tab not in the address', () => {
    const router = read('console-ui/src/router.tsx');
    expect(router).toContain("const studio = createRoute({ getParentRoute: () => rootRoute, path: '/studio', component: StudioPage });");
    expect(router).toMatch(/rootRoute\.addChildren\(\[[^\]]*\barchitecture, studio\b/);
    // Every board page sits under /p/<project>: the router's base.
    expect(router).toContain("basepath: PROJECT_BASE || '/'");
  });
});

describe('the Studio page', () => {
  it('opens on Sketches the first time, with its title, its line and the two tabs', async () => {
    await open('mawid');
    expect(page.querySelector('h1').textContent).toBe('Studio');
    expect(page.querySelector('.top .note').textContent).toBe('Your sketches and design systems for this project.');
    expect(tabs().map((t) => t.textContent)).toEqual(['Sketches', 'Design systems']);
    expect(openTab()).toBe('Sketches');
  });

  it('shows only a short "Nothing here yet" on each tab', async () => {
    await open('mawid');
    for (const label of ['Sketches', 'Design systems']) {
      await click(label);
      expect(openTab()).toBe(label);
      const panel = page.querySelector('[role="tabpanel"]');
      expect(panel.textContent).toBe('Nothing here yet.');
      expect(panel.children).toHaveLength(1);
    }
  });

  it('remembers the last tab per project, also after a reload', async () => {
    await open('mawid');
    await click('Design systems');
    await open('shop');
    expect(openTab()).toBe('Sketches');
    await click('Design systems');
    await click('Sketches');

    // A reload: the page mounts again in the same browser tab.
    await open('mawid');
    expect(openTab()).toBe('Design systems');
    await open('shop');
    expect(openTab()).toBe('Sketches');
    expect(S.readStudioTab('mawid')).toBe('systems');
    expect(S.readStudioTab('shop')).toBe('sketches');
  });

  it('opens every project on Sketches again in a new browser tab', async () => {
    await open('mawid');
    await click('Design systems');
    await close();
    newBrowserTab();
    await open('mawid');
    expect(openTab()).toBe('Sketches');
    // Nothing lasts past the tab: the computer's lasting storage holds no Studio choice.
    expect(Object.keys(dom.window.localStorage)).toEqual([]);
  });

  it('falls back to Sketches when the saved value is unknown or unreadable', async () => {
    dom.window.sessionStorage.setItem(S.studioTabKey('mawid'), 'colors');
    await open('mawid');
    expect(openTab()).toBe('Sketches');

    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage is off');
      },
      setItem: () => {
        throw new Error('storage is off');
      },
    });
    expect(S.readStudioTab('mawid')).toBe('sketches');
    expect(() => S.saveStudioTab('mawid', 'systems')).not.toThrow();
    await open('mawid');
    expect(openTab()).toBe('Sketches');
    await click('Design systems');
    expect(openTab()).toBe('Design systems');
  });

  it('makes no call to the board server, so opening it and switching tabs creates nothing', async () => {
    const xhr = vi.spyOn(dom.window.XMLHttpRequest.prototype, 'open');
    await open('mawid');
    await click('Design systems');
    await click('Sketches');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    // Nor any of the board's data helpers that could reach it.
    for (const file of ['console-ui/src/pages/Studio.tsx', 'console-ui/src/lib/studio.ts'])
      expect(read(file)).not.toMatch(/lib\/data|useAct|apiFetch|fetch\(|useQuery|useMutation/);
    expect([...read('console-ui/src/pages/Studio.tsx').matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['react', '../api/client', '../lib/studio']);
  });
});
