import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The frame stays English and left to right; what a person or an agent wrote runs its own way, each piece by itself.
 * Real React and the real pages in a jsdom page, with Arabic and English tickets and a breakdown: the direction each
 * piece gets, where a ticket number stays, and that English comes out as before.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/shop/board', pretendToBeVisual: true });
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
const { Modal, NotesView, Place, Written, WrittenLines } = await import(/* @vite-ignore */ file('src/components/ui.tsx'));
const { BoardPage } = await import(/* @vite-ignore */ file('src/pages/Board.tsx'));
const { TicketDrawer } = await import(/* @vite-ignore */ file('src/pages/TicketDrawer.tsx'));
const { BugsPage, InboxPage } = await import(/* @vite-ignore */ file('src/pages/Pages.tsx'));
const { ReleasesPage } = await import(/* @vite-ignore */ file('src/pages/Releases.tsx'));
const { OverviewPage } = await import(/* @vite-ignore */ file('src/pages/Overview.tsx'));
const { ProofPage } = await import(/* @vite-ignore */ file('src/pages/Proof.tsx'));
const { ItemPanel, Tree } = await import(/* @vite-ignore */ file('src/components/BreakdownTree.tsx'));
const { BreakdownMap } = await import(/* @vite-ignore */ file('src/components/BreakdownMap.tsx'));
const { QuestionsView } = await import(/* @vite-ignore */ file('src/components/BreakdownRead.tsx'));
const { NewTicketDialog } = await import(/* @vite-ignore */ file('src/components/dialogs.tsx'));
const { Markdown } = await import(/* @vite-ignore */ file('src/components/Conversation.tsx'));
const { ApiProof } = await import(/* @vite-ignore */ file('src/components/ApiProof.tsx'));
const { CardLine, NowCard, WorkSoFar } = await import(/* @vite-ignore */ file('src/components/LiveNow.tsx'));
const { WhatHappened } = await import(/* @vite-ignore */ file('src/components/WhatHappened.tsx'));
const { BreakdownPlace, DecidedForYou, StopPanel } = await import(/* @vite-ignore */ file('src/components/AutoTicket.tsx'));
const { ChangeCard, ChangeHistory } = await import(/* @vite-ignore */ file('src/components/ChangeCard.tsx'));
const { ProjectWaiting } = await import(/* @vite-ignore */ file('src/components/Waiting.tsx'));
const { act } = React;
const h = React.createElement;

const QUESTION = 'هل يستطيع الموظف إلغاء موعد بعد تأكيده؟';

const ticket = (id: string, title: string, over: object = {}) => ({
  id,
  title,
  ask: title,
  kind: 'feature',
  source: { type: 'manual' },
  priority: 'normal',
  stage: 'tickets',
  status: 'Waits for you',
  waiting: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  createdBy: 'سارة',
  owner: 'سارة',
  activity: [],
  ...over,
});

const arabic = ticket('SK-12', 'صفحة حجز المواعيد للموظفين؟', {
  status: 'ينتظر إجاباتك عن سؤالين',
  waiting: { kind: 'questions', summary: 'المحلل لديه سؤالان عن الحجز' },
  ask: 'نريد صفحة يحجز منها الموظف موعدا.\nPlease keep the English labels.',
  brief: { criteria: ['الموظف يرى المواعيد المتاحة فقط', 'Works on a phone'] },
  notes: [{ text: 'راجع SK-9 قبل البدء', kind: 'note', by: 'سارة', at: '2026-10-04T10:00:00.000Z' }],
  story: 'بصفتي موظفا، أريد تنبيها عند الحجز. راجع SK-9 أولا؟',
  criteria: [{ given: 'موظف في الصفحة', when: 'يضغط زر Confirm', then: 'تظهر رسالة' }],
  questions: [
    {
      id: 'q1',
      from: 'analyst',
      text: QUESTION,
      options: ['نعم، حتى قبل الموعد بساعة', 'لا، المدير فقط'],
      thread: [{ who: 'analyst', text: 'كما في SK-9.', at: '2026-10-04T10:00:00.000Z' }],
    },
  ],
  decision: { title: 'أين نتحقق من الموعد؟', why: 'كما قرر ADR-001 من قبل.', options: [{ name: 'في الخادم فقط', note: 'أبسط وأضمن', chosen: true }] },
  work: { steps: 2, tests: 1, screens: 0 },
  steps: [{ title: 'قراءة صفحة الحجز', status: 'done', minutes: 3 }],
  activity: [{ at: '2026-10-05T10:00:00.000Z', who: 'analyst', text: 'كتب سؤالين عن الحجز في SK-12' }],
  gates: { checks: 'pass', checksText: '1 of 1', review: 'pass', proof: 'pass' },
  proof: [
    { criterion: 'تصله رسالة SMS خلال 5 دقائق', before: 'a.png', after: 'b.png', beforeLabel: 'قبل التغيير', afterLabel: 'بعد التغيير', shows: 'broken', why: 'الرسالة وصلت بعد 9 دقائق', page: '/sms/log' },
  ],
  offScreen: [{ criterion: 'تحفظ الرسالة 30 يوما', why: 'هذا يحدث في الخادم' }],
  alsoChanged: ['عدّل ملف الترجمة ar.json'],
});
const english = ticket('SK-19', 'Export the visitor list to PDF', { status: 'Waits for you', waiting: { kind: 'spec', summary: 'Check the spec: is this what you want?' }, story: 'As a clerk, I want a PDF.', criteria: [{ given: 'a clerk', when: 'they press Export', then: 'a PDF downloads' }] });
const mixed = ticket('SK-13', 'MA-10 لازم يخلص قبل release v0.2.0 الأسبوع الجاي', { waiting: { kind: 'spec', summary: 'راجع المواصفات' } });

const boardAnswer = {
  ready: true,
  meta: { project: 'منصة حجز المواعيد', engine: 'live', user: { name: 'سارة', role: 'BA' }, git: { base: 'main' } },
  tickets: [arabic, english, mixed, ticket('SK-18', 'التاريخ يظهر بصيغة خاطئة؟', { kind: 'bug', stage: 'bugs', foundIn: 'v1.1.0', status: 'تم التصنيف' })],
  archived: [],
  stats: { released30: 0, bugs30: 0, open: 4 },
};

const story = (key: string, title: string, over: object = {}) => ({ key, title, story: `بصفتي موظفا، أريد ${title}.`, criteria: [{ given: 'موظف', when: 'يضغط زر Save', then: 'يُحفظ؟' }], size: 'M', dependsOn: [], ...over });
const view = {
  id: 'BR-1',
  title: 'وثيقة متطلبات المواعيد',
  status: 'ready',
  mine: true,
  source: { file: 'source/x.md', name: 'متطلبات.md', kind: 'markdown', addedBy: 'سارة', addedAt: '2026-10-03T10:00:00.000Z' },
  questions: [{ id: 'q1', kind: 'gap', text: 'من يستطيع رؤية التقرير الشهري؟', options: ['المدير فقط', 'كل الموظفين'], refs: [{ section: '4.2', page: 18 }], impact: 'يؤثر على S-12' }],
  epics: [
    {
      key: 'E-1',
      title: 'حجز المواعيد',
      goal: 'يحجز الموظف بسرعة',
      features: [{ key: 'F-1', title: 'اختيار الموعد', summary: 'عرض المواعيد', stories: [story('S-1', 'عرض المواعيد'), story('S-2', 'حجز موعد لمراجع SK-12؟', { dependsOn: ['S-1'] }), story('S-3', 'Export the list to PDF')] }],
      stories: [],
    },
  ],
  decided: [{ id: 'd1', text: 'قررنا أن يكون الموعد 15 دقيقة', by: 'analyst', at: '2026-10-04T10:00:00.000Z', item: 'S-1' }],
  leftOut: [],
  state: { activity: [] },
  progress: [],
  counts: { epics: 1, features: 1, stories: 3, merged: 0, building: 0, needsYou: 0 },
  estimate: { stories: 3, parallel: 2 },
  problems: [],
};

const answers: Record<string, unknown> = {
  '/api/v1/board': boardAnswer,
  '/api/v1/tickets/SK-12': arabic,
  '/api/v1/tickets/SK-19': english,
  '/api/v1/releases': [
    { version: 'v1.2.0', status: 'draft', from: 'v1.1.0', tickets: ['SK-12'], items: [{ id: 'SK-12', title: 'صفحة حجز المواعيد للموظفين؟' }], targets: [], addons: {}, notes: '### ميزات جديدة\n- **تصدير المواعيد.** تحميل القائمة عبر SK-22.\n- Date format fixed.\nلمزيد من التفاصيل راجع SK-9 و release v1.1.0.', out: [] },
  ],
  '/api/v1/overview': { project: 'منصة حجز المواعيد', handover: 'approved', summary: 'منصة يحجز فيها الموظفون المواعيد، عبر SMS.', users: 'موظفو الاستقبال', can: ['حجز موعد لمراجع جديد'], since: [], worth: ['لا توجد اختبارات لصفحة الدفع؟'], ideas: [{ title: 'تنبيه قبل الموعد بيوم', why: 'يقل عدد من لا يحضرون.' }], parts: [{ id: 'web', name: 'صفحات الحجز', what: 'ما يراه الموظف', files: [] }], links: [], rules: [{ id: 'ADR-001', title: 'الخادم هو مصدر الحقيقة' }], map: [], command: 'squad overview' },
  '/api/v1/requirements/BR-1': view,
  '/api/v1/app/waiting': { items: [] },
  '/api/v1/tickets/SK-12/happened': {
    seconds: 60,
    steps: [
      { step: 'spec', name: 'Analyst · Spec', summary: 'Wrote the spec.', notes: [], seconds: 60, tab: 'plan', handedIn: { kind: 'spec', story: 'بصفتي موظفا، أريد تنبيها.', criteria: ['تظهر رسالة: اختر غيره؟', 'Works on a phone'] } },
      { step: 'questions', name: 'Analyst · Questions', summary: 'كتب سؤالين عن الحجز في SK-12', notes: [], seconds: 60, handedIn: { kind: 'questions', items: [{ text: QUESTION, answer: 'نعم، حتى قبل الموعد بساعة' }] } },
    ],
  },
  '/proof.json': { part: 'api', method: 'GET', path: '/x', status: 200, sheets: [{ name: 'الرسائل', total: 2, rows: [['القناة', 'الرقم', 'الوقت'], ['SMS', '0551234567', '10:40']] }, { name: 'Messages', total: 2, rows: [['Channel', 'Number'], ['SMS', '0551234567']] }] },
};

let root: { render(n: unknown): void; unmount(): void };

/** The real pages under the routes they ask for. */
async function show(component: () => unknown, at = '/board', path = '/board') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const paths = [...new Set([path, '/', '/board', '/tickets/$id/proof', '/architecture', '/releases', '/settings', '/inbox', '/conversations', '/requirements', '/requirements/$id', '/overview'])];
  const routes = paths.map((p) => createRoute({ getParentRoute: () => top, path: p, component: p === path ? component : () => null, validateSearch: (s: Record<string, unknown>) => s }));
  const router = createRouter({ routeTree: top.addChildren(routes), history: createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  for (let i = 0; i < 40 && !page.getElementById('root').textContent; i += 1) await wait();
  await wait();
}

const wait = () => act(async () => new Promise((r) => dom.window.setTimeout(r, 15)));
const one = (css: string) => page.querySelector(css) as any;
const all = (css: string) => [...page.querySelectorAll(css)] as any[];
const withText = (css: string, text: string) => all(css).find((el) => el.textContent.includes(text));
const tab = async (name: string) => {
  await act(async () => all('.tabs button').find((b) => b.textContent.startsWith(name)).click());
  await wait();
};
/** Types the way a person does: the box hears it as React would. */
const type = async (el: any, text: string) => {
  const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).split('?')[0]!;
    const hit = Object.keys(answers)
      .filter((k) => path.endsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(hit ? answers[hit] : {}), { status: 200 });
  });
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('one piece of text', () => {
  it('Arabic runs right to left and keeps a ticket number in its place', async () => {
    await show(() => h(Written, { as: 'h4', text: 'راجع SK-12 قبل البدء؟' }));
    const el = one('h4');
    expect(el.getAttribute('dir')).toBe('rtl');
    expect(el.getAttribute('lang')).toBe('ar');
    expect(el.querySelector('bdi').getAttribute('dir')).toBe('ltr');
    expect(el.querySelector('bdi').textContent).toBe('SK-12');
    // Nothing added or moved: the words read the same.
    expect(el.textContent).toBe('راجع SK-12 قبل البدء؟');
  });

  it('English comes out as it went in, with nothing wrapped', async () => {
    await show(() => h(Written, { as: 'h4', text: 'Export the visitor list to PDF, SK-12 first' }));
    const el = one('h4');
    expect(el.getAttribute('dir')).toBe('ltr');
    expect(el.querySelector('bdi')).toBeNull();
    expect(el.innerHTML).toBe('Export the visitor list to PDF, SK-12 first');
  });

  it('mixed text goes by what most of it is, as the chat does, and isolates the rest', async () => {
    await show(() => h('div', null, h(Written, { as: 'p', text: 'MA-10 لازم يخلص قبل release v0.2.0 الأسبوع الجاي.' }), h(Written, { as: 'p', text: 'Please put the Arabic label «تم إرسال الرمز» on the button, under the code field.' })));
    const [a, b] = all('p');
    expect(a.getAttribute('dir')).toBe('rtl');
    expect(a.querySelectorAll('bdi[dir="ltr"]').length).toBe(2);
    expect(b.getAttribute('dir')).toBe('ltr');
    expect(b.querySelector('bdi[dir="rtl"]').textContent).toBe('تم إرسال الرمز');
  });

  it('a lead in front does not count, keeps its order on Arabic, and stays plain on English', async () => {
    await show(() => h('div', null, h(Written, { as: 'p', lead: 'SK-12345', text: 'طلب جديد' }), h(Written, { as: 'p', lead: 'SK-12345', text: 'A new request' })));
    const [a, b] = all('p');
    expect(a.getAttribute('dir')).toBe('rtl');
    expect(a.querySelector('bdi[dir="ltr"]').textContent).toBe('SK-12345');
    expect(b.getAttribute('dir')).toBe('ltr');
    expect(b.querySelector('bdi')).toBeNull();
  });

  it('text with line breaks runs its own way on each line', async () => {
    await show(() => h(WrittenLines, { as: 'p', text: 'نريد صفحة للحجز.\n\nPlease keep the labels.\n' }));
    const lines = all('p > [dir]');
    expect(lines.map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(all('p > br')).toHaveLength(1);
  });

  it('a path of names keeps the frame order, each name in its own way', async () => {
    await show(() => h('div', { id: 'place' }, h(Place, { path: 'حجز المواعيد › Reminders' })));
    expect(all('#place > [dir]').map((n) => [n.textContent, n.getAttribute('dir')])).toEqual([['حجز المواعيد', 'rtl'], ['Reminders', 'ltr']]);
    expect(one('#place').textContent).toBe('حجز المواعيد › Reminders');
  });

  it('a path with no Arabic stays plain text', async () => {
    await show(() => h('div', { id: 'place' }, h(Place, { path: 'Payments › Invoices › S-14' })));
    expect(one('#place').innerHTML).toBe('Payments › Invoices › S-14');
  });

  it('a window titled with a name in Arabic follows the name, its frame does not', async () => {
    await show(() => h(Modal, { title: 'متطلبات المواعيد', onClose() {} }, 'Body'));
    expect(one('.modal h3').getAttribute('dir')).toBe('rtl');
    expect(one('.modal').getAttribute('dir')).toBeNull();
  });
});

describe('the board', () => {
  it('each card title and line runs its own way, and the page stays left to right', async () => {
    await show(() => h(BoardPage));
    expect(withText('.card h4', 'صفحة حجز').getAttribute('dir')).toBe('rtl');
    expect(withText('.card h4', 'Export').getAttribute('dir')).toBe('ltr');
    const swapped = withText('.card h4', 'MA-10');
    expect(swapped.getAttribute('dir')).toBe('rtl');
    expect(swapped.querySelector('bdi').textContent).toBe('MA-10');
    expect(withText('.card .st [dir]', 'ينتظر').getAttribute('dir')).toBe('rtl');
    expect(withText('.card .st [dir]', 'Waits').getAttribute('dir')).toBe('ltr');
    // The frame: lanes and ticket numbers carry no direction of their own.
    expect(one('.board').getAttribute('dir')).toBeNull();
    expect(one('.card .id').getAttribute('dir')).toBeNull();
    expect(one('.lh b').textContent).toBe('Tickets');
  });

  it('the search box follows what is typed, and its hint stays as it is', async () => {
    await show(() => h(BoardPage));
    const box = one('input[aria-label="Search tickets"]');
    expect(box.getAttribute('dir')).toBe('auto');
    await type(box, 'حجز');
    expect(box.getAttribute('dir')).toBe('rtl');
    expect(all('.card h4').every((c) => c.textContent.includes('حجز'))).toBe(true);
  });
});

describe('a ticket', () => {
  const drawer = (id: string) => show(() => h(TicketDrawer, { id, onClose() {} }));

  it('the title, the question, its thread and its options run their own way', async () => {
    await drawer('SK-12');
    expect(one('.drawer .dh h2').getAttribute('dir')).toBe('rtl');
    const q = one('.q h4');
    expect(q.getAttribute('dir')).toBe('rtl');
    expect(q.textContent).toBe(`1. ${QUESTION}`);
    expect(one('.q .thread').getAttribute('dir')).toBe('rtl');
    // The full stop after a ticket number stays on the sentence's side.
    expect(one('.q .thread .msg [dir]').querySelector('bdi').textContent).toBe('SK-9');
    expect(one('.q .choices').getAttribute('dir')).toBe('rtl');
    const choices = all('.q .choice');
    expect(choices.map((c) => c.getAttribute('dir'))).toEqual(['rtl', 'rtl', 'ltr']);
    // The frame around them stays as it is.
    expect(one('.tabs').getAttribute('dir')).toBeNull();
    expect(one('.drawer').getAttribute('dir')).toBeNull();
    expect(withText('.dh .sub b', 'سارة').getAttribute('dir')).toBe('rtl');
  });

  it('a typed answer follows what is typed', async () => {
    await drawer('SK-12');
    await act(async () => all('.q .choice').at(-1).click());
    const box = one('.q .choice input');
    expect(box.getAttribute('dir')).toBe('auto');
    await type(box, 'SK-12 قبل الموعد بيوم');
    expect(box.getAttribute('dir')).toBe('rtl');
    await type(box, 'One hour before');
    expect(box.getAttribute('dir')).toBe('ltr');
  });

  it('the ask, the lists and the notes on Story: each line and each item by itself', async () => {
    await drawer('SK-12');
    await tab('Story');
    expect(all('p.story > .wline').map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(all('ul.brief li').map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    const note = one('ul.ticketnotes li');
    expect(note.getAttribute('dir')).toBe('rtl');
    expect(note.querySelector('.grow bdi').textContent).toBe('SK-9');
    // The frame's own bits in a row that turned stay left to right, so "3 Oct" cannot swap.
    expect(note.querySelector('.note').getAttribute('dir')).toBe('ltr');
  });

  it('the plan: story, done when, decision and steps', async () => {
    await drawer('SK-12');
    await tab('Plan');
    expect(one('p.story').getAttribute('dir')).toBe('rtl');
    const c = one('ol.ac li');
    expect(c.getAttribute('dir')).toBe('rtl');
    expect(c.querySelector('em').textContent).toBe('Given');
    expect(withText('ol.ac li bdi', 'Confirm').getAttribute('dir')).toBe('ltr');
    expect(one('.decision h3').getAttribute('dir')).toBe('rtl');
    expect(one('.opt2').getAttribute('dir')).toBe('rtl');
    expect(withText('.why [dir]', 'Why').querySelector('bdi b').textContent).toBe('Why');
    const step = one('ul.steps li');
    expect(step.getAttribute('dir')).toBe('rtl');
    // "3 min" must not turn into "min 3".
    expect(step.querySelector('.time').getAttribute('dir')).toBe('ltr');
  });

  it('activity lines keep who did it in front and the words in their own order', async () => {
    await drawer('SK-12');
    await tab('Activity');
    const line = one('.feed .fe > [dir]');
    expect(line.getAttribute('dir')).toBe('rtl');
    expect(line.querySelector('bdi b').textContent).toBe('Analyst');
    expect(withText('.feed .fe > [dir] bdi', 'SK-12')).toBeTruthy();
    expect(one('.feed .fe').getAttribute('dir')).toBeNull();
  });

  it('proof rows: the "done when", the verdict reason and the labels', async () => {
    await drawer('SK-12');
    await tab('Proof');
    const row = one('.critrow h5');
    expect(row.getAttribute('dir')).toBe('rtl');
    expect(row.querySelector('bdi').textContent).toBe('SMS');
    expect(one('.critrow .verdictnote').getAttribute('dir')).toBe('rtl');
    expect(one('.proofmini small').getAttribute('dir')).toBe('rtl');
    expect(one('.offscreen li b').getAttribute('dir')).toBe('rtl');
    expect(one('.alsochanged').getAttribute('dir')).toBe('rtl');
  });

  it('an English ticket stays plain: left to right, with nothing wrapped', async () => {
    await drawer('SK-19');
    expect(one('.drawer .dh h2').getAttribute('dir')).toBe('ltr');
    expect(one('p.story').getAttribute('dir')).toBe('ltr');
    expect(one('p.story').innerHTML).toBe('As a clerk, I want a PDF.');
    expect(one('ol.ac li').getAttribute('dir')).toBe('ltr');
    expect(one('ol.ac').querySelector('bdi')).toBeNull();
  });
});

describe('the other pages', () => {
  it('Waiting for you', async () => {
    await show(() => h(InboxPage), '/inbox', '/inbox');
    expect(withText('.wcard h3', 'صفحة حجز').getAttribute('dir')).toBe('rtl');
    expect(withText('.wcard p', 'المحلل').getAttribute('dir')).toBe('rtl');
    expect(withText('.wcard h3', 'Export').getAttribute('dir')).toBe('ltr');
    expect(withText('.wcard p', 'Check the spec').getAttribute('dir')).toBe('ltr');
  });

  it('Bugs: the cell follows the words, the table header does not', async () => {
    await show(() => h(BugsPage), '/bugs', '/bugs');
    const cells = all('table.table tbody td');
    expect(cells[1].getAttribute('dir')).toBe('rtl');
    expect(cells[4].getAttribute('dir')).toBe('rtl');
    expect(cells[0].getAttribute('dir')).toBeNull();
    expect(one('table.table').getAttribute('dir')).toBeNull();
  });

  it('Releases: each line of the notes, with its bullet on the side it starts from', async () => {
    await show(() => h(ReleasesPage), '/releases', '/releases');
    expect(withText('.trow b', 'صفحة حجز').getAttribute('dir')).toBe('rtl');
    expect(one('.notes h4').getAttribute('dir')).toBe('rtl');
    const lines = all('.notes p');
    expect(lines.map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr', 'rtl']);
    expect(lines[0].textContent.startsWith('• ')).toBe(true);
    expect(lines[0].querySelector('strong').textContent).toBe('تصدير المواعيد.');
    expect(lines[2].querySelectorAll('bdi').length).toBe(2);
  });

  it('Overview', async () => {
    await show(() => h(OverviewPage), '/overview', '/overview');
    expect(one('.top h1').getAttribute('dir')).toBe('rtl');
    expect(one('.ob-lead').getAttribute('dir')).toBe('rtl');
    expect(one('.ob-list li').getAttribute('dir')).toBe('rtl');
    expect(withText('.ob-list li', 'لا توجد').getAttribute('dir')).toBe('rtl');
    expect(one('.ob-node b').getAttribute('dir')).toBe('rtl');
    expect(one('.ob-ideas li > span').getAttribute('dir')).toBe('rtl');
    expect(withText('.ob-c h3', 'What it is').getAttribute('dir')).toBeNull();
  });

  it('The proof page: a page address stays left to right inside a row that turned', async () => {
    await show(() => h(ProofPage), '/tickets/SK-12/proof', '/tickets/$id/proof');
    const row = one('.crit');
    expect(row.getAttribute('dir')).toBe('rtl');
    expect(row.querySelector('.critpage-s').getAttribute('dir')).toBe('ltr');
    expect(one('.stage h3').getAttribute('dir')).toBe('rtl');
  });
});

describe('a ticket at work and at a stop', () => {
  const working = { ...arabic, now: { state: 'working', role: 'builder', line: 'Builder · الخطوة 2 من 3: إضافة الفحص', time: '2 min', bar: [], sentence: 'المنفذ يضيف فحص الموعد في SK-12.', detail: 'Step 2 of 3', next: 'يراجع المراجع العمل بعد SK-12.' } };

  it('the live line on the card keeps who works in front', async () => {
    await show(() => h('div', { className: 'card' }, h(CardLine, { t: working })));
    const line = one('.nl1 > [dir]');
    expect(line.getAttribute('dir')).toBe('rtl');
    expect(line.querySelector('bdi b').textContent).toBe('Builder');
  });

  it('the Now card: its sentence and what comes next, the frame words in their order', async () => {
    await show(() => h(NowCard, { t: working }));
    expect(one('.nowsay').getAttribute('dir')).toBe('rtl');
    expect(one('.nowsay bdi').textContent).toBe('SK-12');
    expect(one('.nownext').getAttribute('dir')).toBe('rtl');
    expect(one('.nownext bdi b').textContent).toBe('What comes next:');
    expect(one('.nowhead').getAttribute('dir')).toBeNull();
  });

  it('the work so far', async () => {
    await show(() => h(WorkSoFar, { t: arabic }));
    expect(one('.feed .fe > [dir]').getAttribute('dir')).toBe('rtl');
    expect(one('.feed .fe').getAttribute('dir')).toBeNull();
  });

  it('What happened: summaries, what was handed in, and lists with their own margins', async () => {
    await show(() => h(WhatHappened, { t: arabic, onLog() {} }));
    await wait();
    expect(withText('.hstory', 'بصفتي').getAttribute('dir')).toBe('rtl');
    expect(all('.hlist li').slice(0, 2).map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(withText('.hsum', 'SK-12').querySelector('bdi').textContent).toBe('SK-12');
    expect(one('.hans').getAttribute('dir')).toBe('rtl');
    expect(one('.hans bdi').textContent).toBe('You:');
  });

  it('the stop card: the question, its sources, its options and the small choices', async () => {
    const stopped = {
      ...arabic,
      track: 'auto',
      breakdown: { id: 'BR-1', item: 'S-2' },
      waiting: { kind: 'ask', summary: 'جزء ناقص' },
      agentQuestion: { from: 'builder', kind: 'gap', at: '2026-10-07T10:00:00.000Z', text: 'الوثيقة لا تذكر المدة: كم يوما؟', options: ['سبعة أيام (suggested)', 'ثلاثون يوما'], why: 'تؤثر على SMS في SK-12.', sources: [{ text: 'BRD 4.2، صفحة 18', section: '4.2', page: 18 }, { text: 'SK-12 صفحة الحجز', ticket: 'SK-12' }] },
      decided: [{ id: 'd1', text: 'قررنا إعادة المبلغ إلى البطاقة', by: 'builder', at: '2026-10-06T10:00:00.000Z' }, { id: 'd2', text: 'الرسالة بالعربية', by: 'answer', at: '2026-10-06T10:00:00.000Z', changed: { text: 'الرسالة بلغتين', at: '2026-10-07T10:00:00.000Z' } }],
    };
    await show(() => h('div', null, h(BreakdownPlace, { t: stopped }), h(StopPanel, { t: stopped })));
    await wait();
    expect(one('.stuckq').getAttribute('dir')).toBe('rtl');
    expect(all('.opt2').map((o) => o.getAttribute('dir'))).toEqual(['rtl', 'rtl', null]);
    expect(one('.stopwhy').getAttribute('dir')).toBe('rtl');
    expect(all('.stopsrc [lang]').map((x) => x.getAttribute('dir'))).toEqual(['rtl', 'rtl']);
    expect(all('ul.decided li > [dir]').map((x) => x.getAttribute('dir'))).toEqual(['rtl', 'rtl', 'rtl']);
    // "From BR-1 › حجز المواعيد › اختيار الموعد › S-2": the frame's order, each name by itself.
    const place = one('.brdplace');
    expect(place.getAttribute('dir')).toBeNull();
    expect(all('.brdplace > span[dir]').map((x) => x.textContent)).toEqual(['حجز المواعيد', 'اختيار الموعد', 'S-2']);
    expect(place.textContent).toBe('From BR-1 › حجز المواعيد › اختيار الموعد › S-2');
  });

  it('a change: old and new wording side by side, each by itself', async () => {
    const changing = {
      ...arabic,
      waiting: { kind: 'change', summary: 'تغيير ينتظرك' },
      changes: [{ id: 'c1', status: 'proposed', by: 'سارة', at: '2026-10-08T10:00:00.000Z', ask: 'ستون يوما', summary: 'زيادة مدة الاحتفاظ إلى 60 يوما', size: 'small', why: 'طلب المدير ذلك بعد SK-9', parts: [{ part: 'story', before: 'نحتفظ بالرسائل 30 يوما', after: 'We keep them for 60 days' }, { part: 'criterion', before: '', after: 'تحذف بعد 60 يوما' }] }],
    };
    await show(() => h('div', null, h(ChangeCard, { t: changing }), h(ChangeHistory, { t: changing })));
    expect(one('.changebody > p').getAttribute('dir')).toBe('rtl');
    expect(all('.chrow .chold').map((c) => c.getAttribute('dir'))).toEqual(['rtl', null]);
    expect(all('.chrow .chnew').map((c) => c.getAttribute('dir'))).toEqual(['ltr', 'rtl']);
    const row = one('ul.ticketnotes li');
    expect(row.getAttribute('dir')).toBe('rtl');
    expect(row.querySelector('.grow bdi').textContent).toBe('c1');
  });

  it('the Waiting for you banner: each line by itself, in a bar that stays where it is', async () => {
    await show(() => h(ProjectWaiting));
    await wait();
    expect(all('.ybar .yline').map((l) => l.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(one('.ybar').getAttribute('dir')).toBeNull();
    expect(one('.ybar .yid').getAttribute('dir')).toBeNull();
  });
});

describe('a breakdown', () => {
  const tree = () => show(() => h(Tree, { v: view, mode: 'plan', open: new Set(['E-1', 'F-1']), onToggle() {}, onSelect() {}, onDecide() {} }));

  it('the tree: names and goals by themselves, the row itself left to right', async () => {
    await tree();
    expect(withText('.rq-row.epic .rq-t', 'حجز').getAttribute('dir')).toBe('rtl');
    expect(withText('.rq-row.epic .rq-goal', 'يحجز').getAttribute('dir')).toBe('rtl');
    expect(one('.rq-row.feature .rq-t').getAttribute('dir')).toBe('rtl');
    const s2 = withText('.rq-row.story .rq-t', 'SK-12');
    expect(s2.getAttribute('dir')).toBe('rtl');
    expect(s2.querySelector('bdi').textContent).toBe('SK-12');
    expect(withText('.rq-row.story .rq-t', 'Export').getAttribute('dir')).toBe('ltr');
    expect(one('.rq-row').getAttribute('dir')).toBeNull();
    expect(one('.rq-lv').textContent).toBe('Epic');
  });

  it('the map: a key stays with its label, and boxes follow their names', async () => {
    await show(() => h(BreakdownMap, { v: view, onSelect() {}, onDecide() {} }));
    expect(one('.rq-box .n').getAttribute('dir')).toBe('rtl');
    const chip = withText('.rq-chip .rq-chipt', 'SK-12');
    expect(chip.getAttribute('dir')).toBe('rtl');
    expect(chip.querySelector('bdi em').textContent).toBe('S-2');
    const english = withText('.rq-chip .rq-chipt', 'Export');
    expect(english.getAttribute('dir')).toBe('ltr');
    expect(english.querySelector('em').textContent).toBe('S-3');
    expect(english.querySelector('bdi')).toBeNull();
    expect(one('.rq-mapcanvas').getAttribute('dir')).toBeNull();
  });

  it('a story panel: the path, the fields as they are typed, the checks and the needs', async () => {
    await show(() => h(ItemPanel, { v: view, k: 'S-2', onClose() {}, onSelect() {}, onAsk() {}, onOpenRef() {}, onOpenTicket() {}, onAdd() {} }));
    expect(all('.rq-place [dir]').map((p) => p.getAttribute('dir'))).toEqual(['rtl', 'rtl']);
    const title = one('#rq-st');
    expect(title.tagName).toBe('INPUT');
    expect(title.getAttribute('dir')).toBe('rtl');
    expect(one('#rq-ss').getAttribute('dir')).toBe('rtl');
    expect(all('.rq-gwtrow textarea').map((t) => t.getAttribute('dir'))).toEqual(['rtl', 'rtl', 'rtl']);
    expect(one('.rq-needname [dir]').getAttribute('dir')).toBe('rtl');
    await type(title, 'A new name for the story');
    expect(title.getAttribute('dir')).toBe('ltr');
    await type(title, '');
    expect(title.getAttribute('dir')).toBe('auto');
  });

  it('a story panel that cannot be edited shows the same words the same way', async () => {
    await show(() => h(ItemPanel, { v: { ...view, mine: false }, k: 'S-2', onClose() {}, onSelect() {}, onAsk() {}, onOpenRef() {}, onOpenTicket() {}, onAdd() {} }));
    expect(one('#rq-st').tagName).toBe('DIV');
    expect(one('#rq-st').getAttribute('dir')).toBe('rtl');
    expect(one('#rq-ss').getAttribute('dir')).toBe('rtl');
    expect(one('.rq-gwtrow [dir]').getAttribute('dir')).toBe('rtl');
  });

  it("the Analyst's questions on a BRD, and their options", async () => {
    await show(() => h(QuestionsView, { v: { ...view, status: 'questions', epics: [] }, onOpenRef() {} }));
    expect(one('.rq-qt').getAttribute('dir')).toBe('rtl');
    expect(all('.rq-opt').map((o) => o.getAttribute('dir'))).toEqual(['rtl', 'rtl', null]);
    expect(withText('.rq-qsrc [dir]', 'S-12').querySelector('bdi').textContent).toBe('S-12');
  });
});

describe('typing and reading', () => {
  it('a new ticket: boxes follow what is typed, by the same count as the chat', async () => {
    await show(() => h(NewTicketDialog, { onClose() {}, onCreated() {} }));
    const title = one('#nt-title');
    expect(title.getAttribute('dir')).toBe('auto');
    // The browser's own guess stops at the first letter, the S of SK-12.
    await type(title, 'SK-12 طلب حجز موعد جديد؟');
    expect(title.getAttribute('dir')).toBe('rtl');
    await type(title, 'A new booking request');
    expect(title.getAttribute('dir')).toBe('ltr');
    const ask = one('#nt-ask');
    await type(ask, 'نريد صفحة جديدة للحجز');
    expect(ask.getAttribute('dir')).toBe('rtl');
    // A command box stays what it is.
    expect(one('.modal .term').getAttribute('dir')).toBe('ltr');
  });

  it('Markdown an agent wrote: bullets on the side they start from, code left to right, a table first column on the right', async () => {
    await show(() => h(Markdown, { text: 'تصف هذه الوثيقة `npm test` الحجز.\n\n- يدخل اسم المراجع\n- يضغط زر Save\n\n| الحقل | الوصف |\n|---|---|\n| الاسم | اسم المراجع |\n\nAn English line.\n' }));
    const [ar, en] = all('.md p');
    expect(ar.getAttribute('dir')).toBe('rtl');
    expect(ar.querySelector('code').getAttribute('dir')).toBe('ltr');
    expect(en.getAttribute('dir')).toBe('ltr');
    expect(one('.md ul').getAttribute('dir')).toBe('rtl');
    expect(one('.md li').getAttribute('dir')).toBe('rtl');
    expect(one('.md table').getAttribute('dir')).toBe('rtl');
  });

  it('a sheet in the proof: its first column on the side most cells read from', async () => {
    answers['/api/v1/proof/x.json'] = answers['/proof.json'];
    await show(() => h(ApiProof, { file: 'x.json' }));
    await wait();
    const [ar, en] = all('.apiproof-table table');
    expect(ar.getAttribute('dir')).toBe('rtl');
    expect(en.getAttribute('dir')).toBe('ltr');
    expect(ar.querySelector('th').getAttribute('dir')).toBe('rtl');
    expect(withText('.apiproof-sheet b', 'الرسائل').getAttribute('dir')).toBe('rtl');
  });

  it('release notes as they were: an English note is unchanged', async () => {
    await show(() => h(NotesView, { notes: '### New\n- **Export.** Download it.\nSee SK-9.' }));
    expect(one('.notes h4').getAttribute('dir')).toBe('ltr');
    expect(all('.notes p').map((p) => p.getAttribute('dir'))).toEqual(['ltr', 'ltr']);
    expect(one('.notes').querySelector('bdi')).toBeNull();
    expect(one('.notes').textContent).toBe('New• Export. Download it.See SK-9.');
  });
});
