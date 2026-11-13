import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review on the Changes tab (ADR-007), real React in a jsdom page: each round, each note on its file and line with
 * where it stands, as the pull request shows it. A note in Arabic reads right to left; a file path never does.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/app/board', pretendToBeVisual: true });
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
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { ReviewView } = await import(/* @vite-ignore */ file('src/components/review/ReviewRounds.tsx'));
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

const VIEW = {
  rounds: [
    {
      n: 1,
      at: '2026-11-13T10:02:00.000Z',
      approved: false,
      fix: ['a3f9c21'],
      notes: [
        { n: 1, round: 1, file: 'src/payments/charge.ts', line: 42, text: 'The amount is rounded before tax is added.', state: 'fixed', fixed: { commit: 'a3f9c21', by: 'git' } },
        { n: 2, round: 1, file: 'src/money.ts', text: 'انقل تنسيق المبالغ إلى دالة مشتركة واحدة.', state: 'past', past: { by: 'Momen', reason: 'لاحقاً في MA-30', at: '2026-11-13T10:30:00.000Z' } },
        { n: 3, round: 1, text: 'Add a test for a refund.', state: 'open' },
      ],
    },
    { n: 2, at: '2026-11-13T10:20:00.000Z', approved: true, fix: [], notes: [] },
  ],
  counts: { notes: 3, fixed: 1, past: 1, open: 1 },
  fixes: ['a3f9c21'],
  looksRight: { by: 'Momen', at: '2026-11-13T10:42:00.000Z' },
  posted: { at: '2026-11-13T10:43:00.000Z', ok: false, pr: 7, why: 'Azure DevOps said no to this. An engineer can see why in the log.' },
  old: false,
  canWrite: true,
  canPast: true,
};

async function show(v: object) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(ReviewView, { id: 'MA-21', v })))));
}

describe('the review on the Changes tab', () => {
  it('lists each round, each note on its file and line, and where each stands', async () => {
    await show(VIEW);
    const text = page.querySelector('.rv')!.textContent;
    expect(text).toContain('2 rounds · 3 notes: 1 fixed, 1 you went past, 1 open · Builder changes after review: 1 commit');
    const threads = [...page.querySelectorAll('.rv-thread')] as any[];
    expect(threads.map((t) => t.querySelector('.rv-file .path').textContent)).toEqual(['src/payments/charge.ts:42', 'src/money.ts', 'The whole change']);
    expect(threads.map((t) => t.querySelector('.res').textContent.trim())).toEqual(['Fixed', 'Went past', 'Open']);
    expect(threads[0].querySelector('.rv-fixed').textContent).toBe('Fixed in a3f9c21');
    expect(threads[1].querySelector('.rv-past').textContent).toContain('You went past it: لاحقاً في MA-30');
    expect(page.querySelector('.rv-none')!.textContent).toBe('Round 2: no new notes');
    expect(page.querySelector('.rv-ok')!.textContent).toMatch(/^Momen approved: Looks right, 13 Nov \d\d:\d\d$/);
  });

  it('reads an Arabic note right to left, and keeps the file path left to right', async () => {
    await show(VIEW);
    const arabic = page.querySelectorAll('.rv-thread')[1] as any;
    expect(arabic.querySelector('.body p').getAttribute('dir')).toBe('rtl');
    expect(arabic.querySelector('.rv-file').getAttribute('dir')).toBe('ltr');
    expect((page.querySelectorAll('.rv-thread')[0] as any).querySelector('.body p').getAttribute('dir')).toBe('ltr');
  });

  it('an open note has Go past, which asks why; a refused write has Write it again, each with its command', async () => {
    await show(VIEW);
    const go = [...page.querySelectorAll('button')].find((b: any) => b.textContent.includes('Go past')) as any;
    expect(page.querySelectorAll('.rv-go')).toHaveLength(1);
    await act(async () => go.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(page.querySelector('.rv-why input')!.getAttribute('placeholder')).toBe('Why you go past it. It goes in the pull request too.');
    expect(page.querySelector('.rv-why .term')!.textContent).toContain('squad review MA-21 --past 3 --reason "<why>"');
    expect(page.querySelector('.rv-pr.no')!.textContent).toContain('Not in pull request 7 yet: Azure DevOps said no to this.');
    expect(page.querySelector('.rv-pr.no')!.textContent).toContain('Write it again');
    expect(page.querySelector('.rv-pr.no .term')!.textContent).toContain('squad review MA-21 --write');
  });

  it('an open note whose place a later change touched says so: the Reviewer calls it next round', async () => {
    await show({ ...VIEW, rounds: [{ ...VIEW.rounds[0], notes: [{ n: 5, round: 1, file: 'README.md', text: 'Add the new line.', state: 'open', touched: '021e063' }] }] });
    expect(page.querySelector('.rv-touched')!.textContent).toBe('Changed in 021e063: the Reviewer says in its next round whether it is fixed');
  });

  it('after Looks right there is nothing to go past, and a written review says where it is', async () => {
    await show({ ...VIEW, canPast: false, posted: { at: VIEW.posted.at, ok: true, pr: 7, threads: 3 } });
    expect(page.querySelectorAll('.rv-go')).toHaveLength(0);
    expect(page.querySelector('.rv-pr.ok')!.textContent).toBe(' In pull request 7');
  });
});
