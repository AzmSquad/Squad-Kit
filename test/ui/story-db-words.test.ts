import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Harness → Safety, "Your own database": a project manager reads one plain sentence, and every technical word (the
 * database's kind, its address, the setting, the template's size) is under "For engineers". Real React in a jsdom page.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/clinic/harness', pretendToBeVisual: true });
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
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { DatabaseBlock, DatabaseSettings } = await import(/* @vite-ignore */ file('src/components/Database.tsx'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };

const view = {
  database: { kind: 'postgres', kindName: 'Postgres', repo: '.', name: 'clinic_dev', where: 'the db service in docker-compose.yml, on port 5433', setting: { env: 'DATABASE_URL', file: '.env' }, address: 'postgresql://clinic:***@localhost:5433/clinic_dev', secret: true, from: ['prisma/schema.prisma'], confirmed: { by: 'Momen', at: new Date().toISOString() } },
  template: { sourceName: 'clinic_dev', madeAt: new Date().toISOString(), bytes: 3 * 1024 * 1024, hidePersonal: false, tables: [{ name: 'patients', kept: 'sampled', rows: 1000 }], hidden: [], notes: [] },
  stories: [{ story: 'CL-4', name: 'clinic_dev_cl_4', at: new Date().toISOString() }],
  notes: [],
  missing: [],
  words: 'Each story gets its own copy of the database, made from a small template. Your own database is never changed.',
};

const TECHNICAL = /postgres|DATABASE_URL|\.env|localhost|clinic_dev|\bMB\b|\bKB\b|server|setting|sample/i;

/** The words on the page now, with what is under "For engineers" and the commands left out. */
function shownWords(): string {
  const copy = page.body.cloneNode(true);
  for (const el of copy.querySelectorAll('details, .mono, .term, svg')) el.remove();
  return copy.textContent as string;
}

async function show(node: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(node)))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 40)));
}

beforeEach(() => {
  globals();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  dom.window.sessionStorage.setItem('squad.console.token', 'a-token');
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(view), { status: 200 }));
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('your own database', () => {
  it('a PM reads one plain sentence; the details are for engineers', async () => {
    await show(DatabaseBlock);
    const words = shownWords();
    expect(words).toContain('Each story gets its own copy of the database');
    expect(words.match(TECHNICAL)?.[0] ?? null).toBeNull();
    // Engineers find it all a click away: what was learned, the template, the switch, the story databases.
    const details = page.querySelector('details').textContent as string;
    expect(details).toContain('Confirmed by Momen');
    expect(details).toContain('3.0 MB');
    expect(details).toContain('Make it again');
    expect(details).toContain('Hide personal data');
    expect(details).toContain('CL-4');
    expect(details).not.toContain('clinic-pass');
  });

  it('Settings shows the same for engineers, with Make it again and the switch', async () => {
    await show(DatabaseSettings);
    const text = page.body.textContent as string;
    expect(text).toContain("Each story's own database");
    expect(text).toContain('For engineers.');
    expect([...page.querySelectorAll('button')].map((b: any) => b.textContent.trim())).toEqual(expect.arrayContaining(['Make it again', 'Off', 'Find it again', 'Correct it']));
  });
});
