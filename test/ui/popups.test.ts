import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chat popups: up to three open side by side, the oldest closing when one more opens, minimised to a bar, fewer on
 * a narrow window and one on a phone. Which ones are open, the lead's conversation and what was seen of each talk stay
 * after a page change or a reload, one set per project. And the decision cards' own rules: what a card asks, whether it
 * is still live, never blind, and the real outcome of a press.
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
const h = React.createElement;

// The root type check does not read the board's own files, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const P = await board('src/lib/popups.ts');
const D = await board('src/lib/decide.ts');
const BA = await board('src/components/decide/BoxAsk.tsx');

const open = (ids: string[], max = 3) => ids.reduce((s, id) => P.openPop(s, id, max), P.EMPTY);
const ids = (s: { open: { id: string; min: boolean }[] }) => s.open.map((p) => (p.min ? `${p.id} (min)` : p.id));

beforeEach(() => dom.window.localStorage.clear());

describe('the popups', () => {
  it('open newest first, up to three; one more closes the oldest', () => {
    expect(ids(open(['lead']))).toEqual(['lead']);
    expect(ids(open(['lead', 'MA-9', 'MA-8']))).toEqual(['MA-8', 'MA-9', 'lead']);
    expect(ids(open(['lead', 'MA-9', 'MA-8', 'MA-10']))).toEqual(['MA-10', 'MA-8', 'MA-9']);
    // Opening one that is open already keeps the others.
    expect(ids(open(['lead', 'MA-9', 'MA-8', 'lead']))).toEqual(['MA-8', 'MA-9', 'lead']);
  });

  it('minimise to a bar, come back on a press, and close', () => {
    let s = P.minimisePop(open(['lead', 'MA-9']), 'MA-9');
    expect(ids(s)).toEqual(['MA-9 (min)', 'lead']);
    expect(P.isOpen(s, 'MA-9')).toBe(false);
    // A head's press brings a minimised one back, and closes an open one.
    s = P.togglePop(s, 'MA-9');
    expect(ids(s)).toEqual(['MA-9', 'lead']);
    s = P.togglePop(s, 'MA-9');
    expect(ids(s)).toEqual(['lead']);
    // Closing the lead's popup ends its conversation there: it opens next time on what needs you.
    s = P.closePop({ ...s, lead: 'c1' }, 'lead');
    expect(s).toMatchObject({ open: [], lead: null });
  });

  it('fit the window: three on a wide one, fewer when narrow, one on a phone', () => {
    expect(P.maxOpen(1440)).toBe(3);
    expect(P.maxOpen(1100)).toBe(2);
    expect(P.maxOpen(820)).toBe(1);
    expect(P.maxOpen(390)).toBe(1);
    expect(P.maxOpen(1440, true)).toBe(1);
    const s = open(['lead', 'MA-9', 'MA-8']);
    expect(P.shownPops(s, 2).map((p: { id: string }) => p.id)).toEqual(['MA-8', 'MA-9']);
    // On a phone, the newest one that is not minimised fills the screen.
    expect(P.shownPops(P.minimisePop(s, 'MA-8'), 1).map((p: { id: string }) => p.id)).toEqual(['MA-9']);
    // On a narrow window, opening one more closes the oldest of the ones that fit.
    expect(ids(open(['lead', 'MA-9'], 1))).toEqual(['MA-9']);
  });

  it('forget what was seen of stories that are gone, and nothing while the board loads', () => {
    const s = { ...P.EMPTY, open: [{ id: 'MA-9', min: false }], seen: { 'MA-9': 3, 'MA-4': 2 }, looked: { 'MA-4': 'proof:1', 'MA-9': 'spec:2' } };
    expect(P.pruneState(s, new Set(['MA-9']))).toEqual({ ...s, seen: { 'MA-9': 3 }, looked: { 'MA-9': 'spec:2' } });
    expect(P.pruneState(s, new Set())).toBe(s);
    expect(P.pruneState(s, new Set(['MA-9', 'MA-4']))).toBe(s);
  });

  it('stay after a reload, one set per project, and what was seen of each talk carries over from the old panel', async () => {
    dom.window.localStorage.setItem('sk.chatdock', JSON.stringify({ tab: 'MA-9', min: false, width: 600, seen: { 'MA-9': 4 } }));
    vi.resetModules();
    const first = await board('src/lib/popups.ts');
    expect(first.popups.get().seen).toEqual({ 'MA-9': 4 });
    first.popups.open('lead');
    first.popups.open('MA-9');
    first.popups.minimise('MA-9');
    first.popups.follow('20261112-abc123');
    first.popups.seen('MA-9', 6);
    expect(JSON.parse(dom.window.localStorage.getItem('sk.popups.mawid'))).toBeTruthy();
    vi.resetModules();
    const again = await board('src/lib/popups.ts');
    expect(again.popups.get()).toEqual({ open: [{ id: 'MA-9', min: true }, { id: 'lead', min: false }], seen: { 'MA-9': 6 }, looked: {}, lead: '20261112-abc123' });
    // A broken or strange stored state never breaks the page.
    expect(again.readState({ open: [{ id: 'lead' }, { nope: 1 }, null, { id: 'A-1' }, { id: 'A-2' }, { id: 'A-3' }], seen: 'x', lead: 7 })).toEqual({ open: [{ id: 'lead', min: false }, { id: 'A-1', min: false }, { id: 'A-2', min: false }], seen: {}, looked: {}, lead: null });
  });
});

/* ── Decision cards ─────────────────────────────────────── */

const story = (more: Record<string, unknown> = {}) => ({
  id: 'MA-17',
  title: 'Need help link on the sign-up page',
  stage: 'review',
  status: 'Proof ready for you',
  waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
  waitKey: 'proof:1a2b3c4d',
  gates: { checks: 'pass', review: 'pass', proof: 'pass' },
  proof: [
    { criterion: 'The link shows under the form', before: 'a.png', after: 'b.png', shows: 'met' },
    { criterion: 'It works in Arabic', before: 'c.png', after: 'd.png', shows: 'met' },
  ],
  activity: [],
  ...more,
});

describe('a decision card', () => {
  it('asks what the story waits on: Looks right on a proof, Approve on a spec, a plan or a design, answers, or Open', () => {
    expect(D.decideKind(story())).toBe('proof');
    expect(D.decideKind(story({ waiting: { kind: 'spec', summary: '' } }))).toBe('spec');
    expect(D.decideKind(story({ waiting: { kind: 'plan', summary: '' } }))).toBe('plan');
    expect(D.decideKind(story({ waiting: { kind: 'plan', summary: '' }, specApproved: { by: 'Momen', at: '' } }))).toBe('design');
    expect(D.decideKind(story({ waiting: { kind: 'questions', summary: '' }, questions: [{ id: 'q1', text: 'How long?', options: ['5 minutes'] }] }))).toBe('questions');
    expect(D.decideKind(story({ waiting: { kind: 'ask', summary: '' }, agentQuestion: { from: 'builder', text: 'Which one?', options: ['A', 'B'], at: '' } }))).toBe('ask');
    expect(D.decideKind(story({ waiting: { kind: 'stuck', summary: 'It needs one decision' } }))).toBe('open');
    // The talk itself is the place, and a proof being saved after Looks right waits for nobody.
    expect(D.decideKind(story({ waiting: { kind: 'chat', summary: '' } }))).toBeNull();
    expect(D.decideKind(story({ now: { merging: true } }))).toBeNull();
    expect(D.yesLabel('proof')).toBe('Looks right');
    expect(D.yesLabel('design')).toBe('Approve design');
  });

  it('is live while the story still waits on what it showed, and says so when it does not', () => {
    expect(D.cardState(story())).toBe('live');
    expect(D.cardState(story(), 'proof:1a2b3c4d')).toBe('live');
    expect(D.cardState(story(), 'proof:00000000')).toBe('changed');
    // Made while its spec waited, and now its proof waits: the spec was decided.
    expect(D.cardState(story(), 'spec:00000000')).toBe('decided');
    expect(D.cardState(story({ waiting: null, waitKey: undefined, stage: 'release' }), 'proof:1a2b3c4d')).toBe('decided');
    expect(D.cardState(undefined, 'proof:1a2b3c4d')).toBe('gone');
  });

  it('is never blind: no Looks right or Approve without the thing to look at', () => {
    expect(D.seeable(story(), 'proof')).toBe(true);
    expect(D.seeable(story({ proof: [] }), 'proof')).toBe(false);
    expect(D.seeable(story({ story: '', criteria: [] }), 'spec')).toBe(false);
    expect(D.seeable(story({ steps: [{ title: 'Add the count' }] }), 'plan')).toBe(true);
    expect(D.proofShots(story()).map((s: { file: string }) => s.file)).toEqual(['b.png', 'd.png']);
  });

  it('says the real outcome of a press, from the story the board sent back', () => {
    expect(D.outcome('proof', 'MA-17', story({ stage: 'release', waiting: null, mergedAt: '2026-11-12' }), 'yes')).toBe('You pressed Looks right. MA-17 is accepted and merged, ready for the next release.');
    expect(D.outcome('proof', 'MA-17', story({ live: true, waiting: null }), 'yes')).toMatch(/^You pressed Looks right. Newer work changed the same code/);
    expect(D.outcome('design', 'MA-8', null, 'yes')).toBe('You approved the design. Building starts now.');
    expect(D.outcome('proof', 'MA-17', null, 'change')).toBe('You sent it back with your note. The Builder works on it now.');
    expect(D.footnote('proof', true)).toBe('The lead brings this card. Only you can press it.');
  });

  it('shows a press only while the story does not wait on something new, in its own talk', () => {
    const spec = { words: 'You approved the spec.', at: '2026-11-12T18:00:00.000Z', kind: 'spec', key: 'spec:1' };
    // Just pressed: the story moves on, the card stays green.
    expect(D.pressShown({ mine: spec, kept: null, latest: null, state: 'decided' })).toBe(spec);
    // The design waits now: the talk shows the design card, not the old green spec.
    expect(D.pressShown({ mine: spec, kept: spec, latest: spec, state: 'live', waitKey: 'plan:2' })).toBeNull();
    // The lead's card was made for the spec: it keeps its press.
    expect(D.pressShown({ mine: spec, kept: null, latest: null, made: 'spec:1', state: 'decided' })).toBe(spec);
    // A talk opened again after the press shows the newest press while nothing new waits.
    expect(D.pressShown({ mine: null, kept: null, latest: spec, state: 'decided' })).toBe(spec);
    expect(D.pressShown({ mine: null, kept: null, latest: spec, made: 'proof:9', state: 'decided' })).toBeNull();
  });

  it('keeps a press made here, by story and wait, so the card stays green after the story moved on', () => {
    D.savePressed(D.pressedKey('MA-17', 'proof:1a2b3c4d'), 'You pressed Looks right. MA-17 is accepted.', 'proof');
    expect(D.readPressed()['MA-17|proof:1a2b3c4d']).toMatchObject({ words: 'You pressed Looks right. MA-17 is accepted.', kind: 'proof' });
    expect(D.pressedLately('MA-17')).toBe(true);
    expect(D.pressedLately('MA-18')).toBe(false);
  });
});

/* ── "Something's wrong" in the chat's own box ─────────────── */

describe("the chat's box", () => {
  const ask = (label: string) => ({ label, placeholder: 'Tell the Builder what is wrong…', send: () => {} });
  const a = ask('Goes back to the Builder on MA-17');
  const b = ask('Goes back to the Analyst on MA-9');
  function Card({ id, it }: { id: string; it: unknown }) {
    const box = BA.useCardBox();
    return h('button', { id, onClick: () => box?.ask(it) }, id);
  }
  function Talk({ n, cards }: { n: number; cards: [string, unknown][] }) {
    const { box, door } = BA.useBoxAsk();
    return h(BA.ChatBox.Provider, { value: door }, h('p', { id: 'box' }, box ? box.label : 'none'), h('i', null, n), ...cards.map(([id, it]) => h(Card, { key: id, id, it })));
  }
  const page = dom.window.document;
  const box = () => page.getElementById('box').textContent;
  const press = async (id: string) => React.act(async () => page.getElementById(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

  it('keeps asking for the note when the talk draws again, and a card lets go only of its own ask', async () => {
    const root = createRoot(page.getElementById('root'));
    const show = async (n: number, cards: [string, unknown][]) => React.act(async () => root.render(h(Talk, { n, cards })));
    await show(0, [['wrong', a], ['other', b]]);
    expect(box()).toBe('none');
    await press('wrong');
    expect(box()).toBe(a.label);
    // The talk draws again (a poll, a new message): the box still asks, so the note goes to the board.
    await show(1, [['wrong', a], ['other', b]]);
    await show(2, [['wrong', a], ['other', b]]);
    expect(box()).toBe(a.label);
    // Another card going away leaves this ask alone; this card going away takes it back.
    await show(3, [['wrong', a]]);
    expect(box()).toBe(a.label);
    await show(4, []);
    expect(box()).toBe('none');
    await React.act(async () => root.unmount());
  });
});
