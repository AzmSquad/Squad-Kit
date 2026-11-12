import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard } from './support/lead.js';

/**
 * Decision cards: the lead brings a story that waits on the person into the chat, with the board's own buttons, and
 * only the person presses them. The card is level 1 and changes nothing itself; "approve" stays in the never list; a
 * press from a card is checked again against the mark of what waited, so the board acts only on what the person saw.
 * The agent is a fake.
 */

const calls: RunOptions[] = [];
let agent: (opts: RunOptions) => Promise<Partial<RunResult>> = async () => ({ structured: goodAnswer() });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, sessionId: 's1', text: '', ...(await agent(opts)) };
  },
}));

const { readTicket, updateTicket } = await import('../src/board/store.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { NEVER, neverAsked } = await import('../src/engine/lead/can.js');
const { decideCard, makeCard, runCard, storyCard } = await import('../src/engine/lead/cards.js');
const { readConversation, writeConversation } = await import('../src/engine/lead/store.js');
const { leadRules } = await import('../src/engine/lead/prompt.js');
const { waitKey } = await import('../src/board/wait-key.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  calls.length = 0;
  agent = async () => ({ structured: goodAnswer() });
  ({ tmp, bp } = await leadBoard('squad-lead-decide-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

const ask = async (text: string, more: Record<string, unknown> = {}) => (await askLead(bp, { text, ...more }).done).turns.at(-1)!;

describe('a decision card', () => {
  it('comes for a story that waits on the person: level 1, with the mark of what waited and where it opens', () => {
    const t = readTicket(bp, 'SK-139')!;
    const card = decideCard('c1.1.1', t)!;
    expect(card).toMatchObject({ kind: 'decide', level: 1, story: 'SK-139', wait: 'proof', label: 'Looks right', open: '/tickets/SK-139/proof', command: 'squad show SK-139', status: 'open' });
    expect(card.kind === 'decide' && card.key).toBe(waitKey(t));
    expect(card.allowAlways).toBeUndefined();
    // A story that waits for nothing gets none; asked for one, it gets its Open card instead.
    expect(decideCard('c1.1.2', readTicket(bp, 'SK-145')!)).toBeNull();
    const made = makeCard(bp, { kind: 'decide', story: 'sk-145' }, 'c1.1.3');
    expect('card' in made && made.card.kind).toBe('open_story');
  });

  it('is what the lead brings for each waiting story it talks about, and next to its refusal', async () => {
    agent = async () => ({ structured: goodAnswer({ headline: 'SK-139 is ready for your check.', body: 'Its four pictures show the search box. SK-149 is in the queue.' }) });
    const c = await askLead(bp, { text: 'Is SK-139 ready?' }).done;
    expect(c.turns[0]!.answer!.cards).toEqual([expect.objectContaining({ kind: 'decide', story: 'SK-139', wait: 'proof', level: 1 })]);
    // "Accept it for me", in Arabic, after that answer: squad-kit refuses with no AI, and brings the card of the story
    // the conversation was about, so the person is one press from doing it themselves.
    const before = calls.length;
    const own = await ask('ممتاز، اقبلها لي', { conversation: c.id });
    expect(calls).toHaveLength(before);
    expect(own.answer).toMatchObject({ by: 'refusal', headline: NEVER.approve.refusalAr, cards: [expect.objectContaining({ kind: 'decide', story: 'SK-139' })] });
    // Its words point to the card, which is right under them.
    expect(own.answer!.body).toContain('بطاقتها بالأسفل');
  });

  it('is no card for a story that waits on its own talk: the talk is the place, so it opens there', () => {
    updateTicket(bp, 'SK-145', (x) => (x.waiting = { kind: 'chat', summary: 'The Analyst waits while you talk' }));
    const t = readTicket(bp, 'SK-145')!;
    expect(decideCard('c1.1.1', t)).toBeNull();
    expect(storyCard('c1.1.1', t)).toMatchObject({ kind: 'open_story', story: 'SK-145' });
  });

  it('tells the lead the card is shown under its answer, to point to it and never to a tab on the board', () => {
    const rules = leadRules([], false);
    expect(rules).toContain('shows its card in this chat, right under your answer');
    expect(rules).toContain('never to a tab');
    expect(rules).toContain('keep your refusal and add an\n  open_story card for each story you name');
  });

  it('keeps at most 4 cards', async () => {
    for (const id of ['SK-144', 'SK-145', 'SK-149', 'SK-150']) updateTicket(bp, id, (x) => (x.waiting = { kind: 'spec', summary: 'The spec waits for you' }));
    agent = async () => ({ structured: goodAnswer({ headline: 'Six things wait.', body: 'SK-139, SK-142, SK-144, SK-145, SK-149 and SK-150 wait for you.' }) });
    const t = await ask('What waits for me?');
    expect(t.answer!.cards).toHaveLength(4);
    expect(t.answer!.cards.every((c) => c.kind === 'decide')).toBe(true);
  });

  it('is never pressed from the lead: its run only says where the person decides, and the story stays as it was', async () => {
    agent = async () => ({ structured: goodAnswer({ headline: 'SK-139 waits for you.', body: 'Check its proof.' }) });
    const t = await ask('Is SK-139 ready?');
    const card = t.answer!.cards[0]!;
    const before = JSON.stringify(readTicket(bp, 'SK-139'));
    const r = await runCard(bp, card.id);
    expect(r.card).toMatchObject({ kind: 'decide', status: 'open', result: expect.stringMatching(/^Only you can decide SK-139/) });
    expect(JSON.stringify(readTicket(bp, 'SK-139'))).toBe(before);
    // The lead may hand in no card that approves: those are refused in squad-kit's own words.
    for (const kind of ['approve', 'looks_right', 'accept', 'approve_plan']) expect(makeCard(bp, { kind, story: 'SK-139' }, 'x.1')).toEqual({ refused: 'approve' });
  });
});

describe('"approve" stays a never for the lead', () => {
  it('refuses accepting or approving for the person, in English and Arabic, as before', () => {
    for (const text of ['Approve SK-142', 'Press Looks right on SK-139', 'Great, agreed. Accept SK-139 for me.', 'ممتاز، اقبلها لي', 'اقبلها', 'وافق على الخطة', 'خلاص اقبلها', 'تمام اعتمدها', 'ممكن توافق على الخطة', 'ابيك تعتمد الخطة', 'اريدك ان توافق على الخطة']) {
      expect(neverAsked(text), text).toContain('approve');
    }
    // Agreeing is not asking: the lead answers it.
    expect(neverAsked('ممتاز موافق')).toEqual([]);
    expect(neverAsked('How do I approve a spec?')).toEqual([]);
  });

  it('answers a question that tells what someone did, with a comma in it: no refusal', () => {
    for (const text of ['المدير قرأ المواصفات، اعتمدها امس، فما الخطوة التالية؟', 'فريق الدعم طلب ميزة، اصدر التحديث امس ثم توقف، ليش؟', 'امس، عدل الكود ولم يشتغل', 'توافق الخطة مع المواصفات؟']) {
      expect(neverAsked(text), text).toEqual([]);
    }
  });
});

describe('an answer a restart cut off', () => {
  it('keeps none of its words written so far, and says it did not come', () => {
    const at = '2026-11-12T18:00:00.000Z';
    writeConversation(bp, { id: '20261112-aaaaaa', title: 'x', startedAt: at, updatedAt: at, context: { from: 'board' }, thinking: true, turns: [{ n: 1, ask: { text: 'Is SK-139 ready?', at, context: { from: 'board' } }, trace: [], refused: [], draft: { headline: 'SK-139 is' } }] });
    const c = readConversation(bp, '20261112-aaaaaa')!;
    expect(c.thinking).toBe(false);
    expect(c.turns[0]!.draft).toBeUndefined();
    expect(c.turns[0]!.error).toMatch(/^squad-kit restarted while the lead was answering/);
  });
});

describe('a press from a card', () => {
  const app = () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    return a;
  };
  const post = (a: Hono, url: string, body: unknown) => a.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('runs the board’s own action only on what the card showed', async () => {
    updateTicket(bp, 'SK-145', (x) => (x.waiting = { kind: 'spec', summary: 'The spec waits for you' }));
    const shown = waitKey(readTicket(bp, 'SK-145')!)!;
    const a = app();
    const board = (await (await a.request('/api/v1/board')).json()) as { tickets: { id: string; waitKey?: string }[] };
    expect(board.tickets.find((t) => t.id === 'SK-145')!.waitKey).toBe(shown);
    // The spec changed since the card was made: the press is refused, and the story stays where it is.
    updateTicket(bp, 'SK-145', (x) => (x.story = `${x.story ?? ''} Also on phones.`));
    const late = await post(a, '/api/v1/tickets/SK-145/approve', { expect: shown });
    expect(late.ok).toBe(false);
    expect(((await late.json()) as { error: string }).error).toBe('SK-145 changed since this card was made. Open it to see it as it is now.');
    expect(readTicket(bp, 'SK-145')!.waiting?.kind).toBe('spec');
    // With the mark of what waits now, it is the same press as the board's own button.
    const now = waitKey(readTicket(bp, 'SK-145')!)!;
    expect(now).not.toBe(shown);
    expect((await post(a, '/api/v1/tickets/SK-145/approve', { expect: now })).ok).toBe(true);
    expect(readTicket(bp, 'SK-145')!.specApproved).toBeTruthy();
    // Decided on the board already: the card's press says so.
    const again = await post(a, '/api/v1/tickets/SK-145/approve', { expect: now });
    expect(((await again.json()) as { error: string }).error).toBe('SK-145 no longer waits for you: it was already decided on the board.');
  });

  it('checks Something’s wrong and an answer the same way, and the board’s own buttons as before', async () => {
    updateTicket(bp, 'SK-145', (x) => (x.waiting = { kind: 'plan', summary: 'The plan waits for you' }));
    const a = app();
    expect((await post(a, '/api/v1/tickets/SK-145/change', { text: 'Fewer steps', expect: 'plan:00000000' })).ok).toBe(false);
    expect(readTicket(bp, 'SK-145')!.waiting?.kind).toBe('plan');
    expect((await post(a, '/api/v1/tickets/SK-145/change', { text: 'Fewer steps' })).ok).toBe(true);
    expect(readTicket(bp, 'SK-145')!.changeRequest).toBe('Fewer steps');
    expect((await post(a, '/api/v1/tickets/SK-148/answers', { answers: {}, expect: 'questions:00000000' })).ok).toBe(false);
  });

  it('marks a new proof round as a new wait', () => {
    const t = readTicket(bp, 'SK-139')!;
    const before = waitKey(t);
    expect(waitKey({ ...t, proofRound: (t.proofRound ?? 0) + 1 })).not.toBe(before);
    expect(waitKey({ ...t, waiting: null })).toBeUndefined();
    expect(waitKey(t)).toBe(before);
  });
});
