import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The words a project manager lands on. Real React and the real pages in a jsdom page, with the board's answers filled
 * in. What is under "For engineers" and the commands beside a button may keep the technical words, so they are left out
 * of what is read here.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/releases', pretendToBeVisual: true });
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
const { ReleasesPage } = await import(/* @vite-ignore */ file('src/pages/Releases.tsx'));
const { DependsCard, DependsLine, BringInButton } = await import(/* @vite-ignore */ file('src/components/Depends.tsx'));
const { Apps } = await import(/* @vite-ignore */ file('src/components/Apps.tsx'));
const { SandboxRows } = await import(/* @vite-ignore */ file('src/components/Sandbox.tsx'));
const { ReleasedDialog } = await import(/* @vite-ignore */ file('src/components/dialogs.tsx'));
const { RunnerSetting, SpeechSettings } = await import(/* @vite-ignore */ file('src/pages/Pages.tsx'));
const { HandOverDialog } = await import(/* @vite-ignore */ file('src/components/HandOver.tsx'));
const { DeleteDialog } = await import(/* @vite-ignore */ file('src/components/DeleteTicket.tsx'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { act } = React;
const h = React.createElement;

let root: { render(n: unknown): void; unmount(): void };

/** What matched, so a failure names the word. */
const expectNoWords = (text: string) => expect(text.match(WORDS)?.[0] ?? null).toBeNull();

const WORDS = /\bremote\b|Push again|\bpipeline\b|\bbranch(es)?\b|\brepos?\b|\bgit\b|\bSandbox\b|latest main|is in main|Session token|\bpushed\b|\bmain\b/i;

const meta = { project: 'App', key: 'AP', engine: 'live', user: { name: 'Momen' }, git: { base: 'main', remote: 'origin' }, commands: {}, map: [], lessons: [] };
const release = { version: 'v1.5.0', status: 'draft', from: 'v1.4.0', tickets: ['AP-1'], notes: '**Hours.** Set opening hours.', addons: { changelog: true, tag: true, pipeline: true, whatsapp: true }, items: [{ id: 'AP-1', title: 'Set hours', gates: null, kind: 'feature' }], targets: [{ repo: '.', branch: 'main', remote: 'origin' }] };
const unsent = { ...release, status: 'released', version: 'v1.4.0', date: new Date().toISOString(), unpushed: [{ repo: '.', remote: 'origin', base: 'main', commit: 'abc', tag: 'v1.4.0', error: 'git push failed: rejected', plain: 'The shared copy of the code did not take the release, so it is only on this computer. An engineer can see why below. Press Send again once that is settled.' }] };

/** The words a person reads on the page now: closed details and command lines left out. */
function shownWords(): string {
  const copy = page.body.cloneNode(true);
  for (const el of copy.querySelectorAll('details, .mono, .term, svg')) el.remove();
  return copy.textContent as string;
}

const answers = (more: Record<string, unknown> = {}) =>
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*\/api\/v1\//, '').split('?')[0]!;
    const known: Record<string, unknown> = { board: { ready: true, meta, tickets: [], stats: { released30: 0, bugs30: 0, open: 0 } }, releases: [release], branches: { here: ['squad/ap-1'], remote: ['squad/ap-2'] }, apps: { apps: [], reading: false }, sandbox: { tools: [{ tool: 'claude', available: true, why: 'its guard' }], registries: [], allowedHosts: [], guard: { on: true, why: 'x', allowRead: [], allowWrite: [] } }, ...more };
    return new Response(JSON.stringify(known[path] ?? {}), { status: 200 });
  });

async function show(node: () => unknown, at = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path: at, component: node, validateSearch: (s: Record<string, unknown>) => s });
  const router = createRouter({ routeTree: top.addChildren([route]), history: createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.body.textContent; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
  await act(async () => new Promise((r) => dom.window.setTimeout(r, 40)));
}

const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim().includes(name)) as any;

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  dom.window.sessionStorage.setItem('squad.console.token', 'a-token');
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('Releases', () => {
  it('a release about to go: no technical words, and the confirm says where it goes in plain words', async () => {
    answers();
    await show(ReleasesPage, '/releases');
    expect(page.body.textContent).toContain('Mark the code as v1.5.0');
    expect(page.body.textContent).toContain('Run your after-release step');
    expectNoWords(shownWords());
    await act(async () => button('Release').click());
    await act(async () => new Promise((r) => dom.window.setTimeout(r, 10)));
    expect(page.body.textContent).toContain("This release goes to your team's shared copy of the code");
    expectNoWords(shownWords());
  });

  it('a release that did not reach the shared copy: Send again, with the same word in what it says', async () => {
    answers({ releases: [unsent] });
    await show(ReleasesPage);
    expect(page.body.textContent).toContain('Not sent yet');
    expect(button('Send again')).toBeTruthy();
    expect(button('Push again')).toBeUndefined();
    expect(shownWords()).toContain('Press Send again');
    expectNoWords(shownWords());
    // Engineers still find the exact words, a click away.
    expect(page.querySelector('details .mono').textContent).toContain('git push failed: rejected');
  });

  it('what is left over from released tickets says so plainly', async () => {
    answers({ releases: [{ ...release, status: 'released', date: new Date().toISOString() }] });
    await show(ReleasesPage);
    await act(async () => new Promise((r) => dom.window.setTimeout(r, 60)));
    expect(page.body.textContent).toContain('Left over from released tickets');
    expectNoWords(shownWords());
  });

  it('the window after a release', async () => {
    answers();
    await show(() => h(ReleasedDialog, { release: { ...unsent, log: [{ ok: true, text: "Sent to your team's shared copy of the code" }] }, demo: false, onClose: () => undefined }));
    expect(page.body.textContent).toContain('v1.4.0 is made, but not sent yet');
    expect(page.body.textContent).toContain('Press Send again');
    expectNoWords(shownWords());
  });
});

describe('a ticket that needs another', () => {
  const ticket = { id: 'AP-2', title: 'Second', stage: 'implement', status: '', dependsOn: ['AP-1'], activity: [], source: { type: 'manual' }, waiting: { kind: 'depends', summary: 'x' } };
  const one = { id: 'AP-1', title: 'First', stage: 'implement', status: '', branch: 'squad/ap-1', worktree: '/copy', activity: [], source: { type: 'manual' } };

  it('the card says work, not a branch', async () => {
    answers({ board: { ready: true, meta, tickets: [one, ticket], stats: {} } });
    await show(() => h(DependsCard, { t: ticket }));
    expect(page.body.textContent).toContain("Build on AP-1's work");
    expect(page.body.textContent).toContain('is not in the code yet');
    expectNoWords(shownWords());
  });

  it('Bring in the newest work names no branch, before or after it is pressed', async () => {
    answers({ board: { ready: true, meta, tickets: [ticket], stats: {} } });
    const t = { ...ticket, waiting: null };
    await show(() => h(BringInButton, { t }));
    expect(button('Bring in the newest work')).toBeTruthy();
    expectNoWords(shownWords());
    await act(async () => root.render(null));
    await show(() => h(BringInButton, { t: { ...t, baseWanted: { by: 'Momen', at: '' } } }));
    expect(page.body.textContent).toContain('The newest work comes in after this step');
  });

  it('the line on a ticket that chose', async () => {
    answers({ board: { ready: true, meta, tickets: [ticket], stats: {} } });
    const t = { ...ticket, dependency: { on: ['AP-1'], way: 'anyway', by: 'Momen', at: '' } };
    await show(() => h(DependsLine, { t }));
    expectNoWords(shownWords());
  });
});

describe('Your apps and the guard', () => {
  it('a new version is in the newest version, not in main', async () => {
    answers({ apps: { apps: [{ name: 'Web', state: 'stopped', url: 'http://x', canStart: true, fresh: { id: 'VD-5', title: 'Fresh', base: 'main' } }], fresh: { id: 'VD-5', title: 'Fresh', base: 'main' }, reading: false } });
    await show(Apps);
    if (page.body.textContent.includes('VD-5')) expect(page.body.textContent).toContain('VD-5 is in the newest version');
    expectNoWords(shownWords());
  });

  it('the guard has no technical name', async () => {
    answers();
    await show(SandboxRows);
    expect(page.body.textContent).toContain('The guard for the Builder and Tester');
    expect(page.body.textContent).not.toContain('Sandbox');
  });
});

describe('Settings, Hand over and Delete', () => {
  const ticket = { id: 'AP-3', title: 'Third', stage: 'implement', status: '', branch: 'squad/ap-3', worktree: '/copy', owner: 'Momen', activity: [], source: { type: 'manual' } };

  it('Settings has no protocol name, and says what is true for this computer about video', async () => {
    answers({ speech: { hasKey: false, video: false } });
    await show(() => h('div', null, h(RunnerSetting), h(SpeechSettings)));
    const text = page.body.textContent as string;
    expect(text).not.toContain('Agent Client Protocol');
    expect(text).not.toContain('ACP');
    expect(text).toContain('The usual way');
    expect(text).toContain('Video notes need a Mac');
    expect(text).not.toContain('every voice and video note');
  });

  it('a Mac says every voice and video note', async () => {
    answers({ speech: { hasKey: false, video: true } });
    await show(SpeechSettings);
    expect(page.body.textContent).toContain('every voice and video note');
  });

  it('Hand over says what happens with no technical words', async () => {
    answers();
    await show(() => h(HandOverDialog, { t: ticket, onClose: () => undefined }));
    expect(page.body.textContent).toContain("sends them to your team's shared copy of the code");
    expectNoWords(shownWords());
  });

  it('Delete offers its work in the shared copy, not a branch on a remote', async () => {
    answers({ 'tickets/AP-3/delete': { id: 'AP-3', title: 'Third', summary: 'It goes.', removes: [], stays: [], warnings: [], remote: false, base: 'main', pushed: { branch: 'squad/ap-3', remote: 'origin', why: 'Nobody else needs it.' } } });
    await show(() => h(DeleteDialog, { t: ticket, onClose: () => undefined, onDeleted: () => undefined }));
    expect(page.body.textContent).toContain("Also delete its work in your team's shared copy of the code");
    expectNoWords(shownWords());
  });
});

describe('a file that cannot be read, on its own page', () => {
  it('Releases names it, and the rest of the page stays', async () => {
    const problem = 'Release v1.3.0 could not be read: its file is damaged, so it is not shown here. Nothing is lost. An engineer can look at it.';
    answers({ board: { ready: true, meta, tickets: [], stats: {}, brokenRecords: [{ kind: 'release', id: 'v1.3.0', problem, file: '.squad/releases/v1.3.0.md', detail: 'It has no version.' }, { kind: 'decision', id: 'AP-1.1', problem: 'Other', file: 'x', detail: 'y' }] } });
    await show(ReleasesPage);
    expect(page.body.textContent).toContain(problem);
    expect(page.body.textContent).not.toContain('Other');
    expect(page.body.textContent).toContain('Release v1.5.0');
  });
});

