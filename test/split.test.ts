import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { PAYMENTS, PAYMENTS_AR, PAYMENT_PARTS, brdLike, businessPaste } from './support/split.js';

/**
 * A story too big for one: the Analyst's suggestion waits on the story, and only the person's press changes anything.
 * Split makes the parts with "depends on", Keep as one goes on with the questions, Change the split asks the Analyst
 * again, and Send to Requirements makes a breakdown. The New ticket dialog's draft goes the same way. The Analyst is a fake.
 */

let answers: unknown[] = [];
const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, sessionId: opts.resume ?? opts.sessionId ?? 's1', text: '', structured: answers.shift() } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, writeMeta, updateTicket } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { chatToRequirements, decideSplit, createSized, AS_ONE_ANYWAY } = await import('../src/board/split.js');
const { waitKey } = await import('../src/board/wait-key.js');
const { listBreakdowns, readBreakdown } = await import('../src/board/requirements.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { currentDraft, draftTicket, startDraft, draftJob } = await import('../src/engine/draft.js');
const { mountSplitApi } = await import('../src/console/api/split.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Squad = { intake(id: string): Promise<void>; splitAgain(id: string): Promise<void> };
const squad = () => new LiveSquad(bp) as unknown as Squad;

const questionsAnswer = (split?: object) => ({
  summary: 'Customers pay online when they book.',
  questions: [{ from: 'analyst', kind: 'gap', text: 'Which cards should customers pay with?', options: ['Mada and Visa', 'Visa and Mastercard'] }],
  ...(split ? { split } : {}),
});
const fourParts = { size: 'few', why: 'This is 4 stories in one. Each part can be built, checked and shown on its own.', parts: PAYMENT_PARTS.map((p) => ({ ...p, doneWhen: [`${p.title} works`] })) };

beforeEach(() => {
  answers = [];
  calls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-split-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A story the person wrote, at its first step. */
function story(title: string, ask: string, more: Partial<Parameters<typeof actions.createTicket>[1]> = {}) {
  const t = actions.createTicket(bp, { title, ask, ...more });
  updateTicket(bp, t.id, (x) => (x.squad = null));
  return t.id;
}

describe('the first step of a story', () => {
  it('a clear one-story ticket asks the Analyst nothing about its size', async () => {
    const id = story('Show hearing time in local time', "Show the hearing time in each person's local time.");
    answers = [questionsAnswer()];
    await squad().intake(id);
    expect(calls[0]!.prompt).not.toContain('judge the size');
    expect(JSON.stringify(calls[0]!.schema ?? {})).not.toContain('"split"');
    expect(readTicket(bp, id)!.waiting?.kind).toBe('questions');
  });

  it('a story with several asks: the Analyst judges it, and its split waits for the person. Nothing is created', async () => {
    const before = listTickets(bp).length;
    const id = story('Customers pay online when they book', PAYMENTS);
    answers = [questionsAnswer(fourParts)];
    await squad().intake(id);
    expect(calls[0]!.prompt).toContain('judge the size');
    expect(calls[0]!.prompt).toContain('4 separate asks');
    const t = readTicket(bp, id)!;
    expect(t.waiting).toEqual({ kind: 'split', summary: 'The Analyst suggests splitting it into 4 stories' });
    expect(t.status).toBe('The Analyst suggests a split');
    expect(t.split?.suggestion?.parts.map((p) => p.title)).toEqual(PAYMENT_PARTS.map((p) => p.title));
    expect(t.split?.questions?.map((q) => q.text)).toEqual(['Which cards should customers pay with?']);
    expect(t.questions ?? []).toEqual([]);
    expect(t.squad ?? null).toBeNull();
    expect(waitKey(t)).toMatch(/^split:/);
    // Nothing exists but the story itself until the person presses.
    expect(listTickets(bp).length).toBe(before + 1);
  });

  it('a long business text can never be one story: "one" is not even a choice for the Analyst', async () => {
    const id = story('Meeting rooms', businessPaste());
    answers = [questionsAnswer(fourParts)];
    await squad().intake(id);
    const schema = JSON.stringify(calls[0]!.schema);
    expect(schema).toContain('"enum":["few","brd"]');
    expect(readTicket(bp, id)!.waiting?.kind).toBe('split');
  });
});

describe('the person decides', () => {
  async function waiting(ask = PAYMENTS, criteria?: string[]) {
    const id = story('Customers pay online when they book', ask, criteria ? { criteria } : {});
    answers = [questionsAnswer(fourParts)];
    await squad().intake(id);
    return readTicket(bp, id)!;
  }

  it('Split: the story keeps the first part, the others wait in Tickets with "depends on", and the Analyst reads part 1 again', async () => {
    const t = await waiting(PAYMENTS, ['A customer pays by card', 'Staff see a payments report']);
    const after = decideSplit(bp, t.id, { choice: 'split', expect: waitKey(t)! });
    const made = after.split!.decided!.made!;
    expect(made).toHaveLength(4);
    expect(made[0]).toBe(t.id);
    expect(after).toMatchObject({ title: 'Pay by card when booking', waiting: null, live: true, status: 'Analyst is reading the ticket' });
    expect(after.squad?.phase).toBe('analyst-read');
    expect(after.split?.was).toEqual({ title: 'Customers pay online when they book', ask: PAYMENTS });
    expect(after.ask).toContain('One part of "Customers pay online when they book"');
    for (const [i, id] of made.slice(1).entries()) {
      const p = readTicket(bp, id)!;
      expect(p.title).toBe(PAYMENT_PARTS[i + 1]!.title);
      expect(p.dependsOn).toEqual([t.id]);
      expect(p).toMatchObject({ waitsToStart: true, live: false, status: `Waits for ${t.id}`, split: { from: t.id } });
      expect(p.squad ?? null).toBeNull();
      expect(p.ask).toContain(PAYMENTS);
    }
    // The person's own "done when" lines given to no part go to none: part 1 has only its own, and the whole text each
    // part reads keeps them.
    expect(after.brief?.criteria).toEqual(['Pay by card when booking works']);
    expect(after.ask).toContain('Done when:\n- A customer pays by card\n- Staff see a payments report');
    // Its first step asks nothing more about the size.
    calls.length = 0;
    answers = [questionsAnswer()];
    updateTicket(bp, t.id, (x) => (x.squad = null));
    await squad().intake(t.id);
    expect(calls[0]!.prompt).not.toContain('judge the size');
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('questions');
  });

  it('a line the Analyst gives a part goes to that part; a part keeps "Write new tests" off', async () => {
    const id = story('Customers pay online when they book', PAYMENTS, { criteria: ['A customer pays by card', 'Staff see a payments report'], noNewTests: true });
    answers = [questionsAnswer({ ...fourParts, parts: [{ ...PAYMENT_PARTS[0], criteria: [1] }, PAYMENT_PARTS[1], PAYMENT_PARTS[2], { ...PAYMENT_PARTS[3], criteria: [2] }] })];
    await squad().intake(id);
    const after = decideSplit(bp, id, { choice: 'split' });
    const made = after.split!.decided!.made!;
    expect(after.brief?.criteria).toEqual(['A customer pays by card']);
    expect(readTicket(bp, made[3]!)!.brief?.criteria).toEqual(['Staff see a payments report']);
    expect(readTicket(bp, made[1]!)!.brief?.criteria ?? []).toEqual([]);
    expect(made.slice(1).every((x) => readTicket(bp, x)!.noNewTests)).toBe(true);
  });

  it('only the choices the card has a button for: no Requirements on a split, no Split or Change on a whole document', async () => {
    const t = await waiting();
    expect(() => decideSplit(bp, t.id, { choice: 'requirements' })).toThrow(/split it, keep it as one, or change the split/);
    const id = story('RoomFlow release 2', brdLike());
    answers = [{ summary: 'A whole document.', questions: [], split: { size: 'brd', why: 'Too big.', areas: [] } }];
    await squad().intake(id);
    expect(() => decideSplit(bp, id, { choice: 'change', note: 'Two parts' })).toThrow(/send it to Requirements, or keep it as one story/);
  });

  it('a press sent again after a failure part-way makes nothing twice', async () => {
    const t = await waiting();
    const s = t.split!.suggestion!;
    // The first press made two of the parts, then stopped.
    for (const [i, p] of s.parts.slice(1, 3).entries()) actions.createTicket(bp, { title: p.title, ask: p.line, key: `${t.id}:${s.at}:${i + 2}`, waitsToStart: true });
    const before = listTickets(bp).length;
    const made = decideSplit(bp, t.id, { choice: 'split' }).split!.decided!.made!;
    expect(listTickets(bp).length).toBe(before + 1);
    expect(new Set(made).size).toBe(4);
  });

  it('a story pulled from a tracker is never offered a split: part 1 would resolve its whole work item', async () => {
    const id = story('Meeting rooms', businessPaste(), { source: { type: 'azure', ref: 'AB#41', id: '41' } });
    answers = [questionsAnswer()];
    await squad().intake(id);
    expect(calls[0]!.prompt).not.toContain('judge the size');
    expect(readTicket(bp, id)!.waiting?.kind).toBe('questions');
  });

  it('Keep as one: the questions asked beside the suggestion wait now', async () => {
    const t = await waiting();
    const n = listTickets(bp).length;
    const after = decideSplit(bp, t.id, { choice: 'keep' });
    expect(after.waiting?.kind).toBe('questions');
    expect(after.questions?.map((q) => q.text)).toEqual(['Which cards should customers pay with?']);
    expect(after.split?.decided?.choice).toBe('keep');
    expect(after.title).toBe('Customers pay online when they book');
    expect(listTickets(bp).length).toBe(n);
  });

  it('Change the split: the Analyst writes it again from the note, in the same conversation', async () => {
    const t = await waiting();
    expect(() => decideSplit(bp, t.id, { choice: 'change', note: ' ' })).toThrow(/how to split it/);
    const asked = decideSplit(bp, t.id, { choice: 'change', note: 'Keep the receipt inside the payment story' });
    expect(asked).toMatchObject({ waiting: null, status: 'The Analyst is changing the split', split: { change: 'Keep the receipt inside the payment story' } });
    expect(asked.squad?.phase).toBe('split-change');
    answers = [{ split: { size: 'few', why: 'Three stories.', parts: [PAYMENT_PARTS[0], PAYMENT_PARTS[2], PAYMENT_PARTS[3]] } }];
    calls.length = 0;
    await squad().splitAgain(t.id);
    expect(calls[0]!.resume).toBe(t.sessions!.intake);
    expect(calls[0]!.prompt).toContain('Keep the receipt inside the payment story');
    const again = readTicket(bp, t.id)!;
    expect(again.waiting?.kind).toBe('split');
    expect(again.split?.suggestion?.parts).toHaveLength(3);
    expect(again.split?.change).toBeUndefined();
    // The questions are still kept for Keep as one.
    expect(again.split?.questions).toHaveLength(1);
  });

  it('a card shown before a change is refused: the press is on what the person saw', async () => {
    const t = await waiting();
    const old = waitKey(t)!;
    updateTicket(bp, t.id, (x) => (x.split!.suggestion = { ...x.split!.suggestion!, parts: x.split!.suggestion!.parts.slice(0, 2), at: 'later' }));
    expect(() => decideSplit(bp, t.id, { choice: 'split', expect: old })).toThrow(/changed since this card was made/);
    expect(() => decideSplit(bp, actions.createTicket(bp, { title: 'Other' }).id, { choice: 'split' })).toThrow(/has no split waiting/);
  });

  it('Send to Requirements: a breakdown from its text, and the story stops and waits in Tickets', async () => {
    const id = story('RoomFlow release 2', brdLike());
    answers = [{ summary: 'A whole document.', questions: [], split: { size: 'brd', why: 'A whole requirements document.', areas: [{ name: 'Booking', stories: 6 }, { name: 'Reports', stories: 4 }] } }];
    await squad().intake(id);
    const t = readTicket(bp, id)!;
    expect(t.waiting?.summary).toBe('Too big for one story: the Analyst suggests Requirements');
    expect(() => decideSplit(bp, id, { choice: 'split' })).toThrow(/whole requirements document/);
    const before = listBreakdowns(bp).length;
    const after = decideSplit(bp, id, { choice: 'requirements' });
    expect(listBreakdowns(bp)).toHaveLength(before + 1);
    const b = readBreakdown(bp, after.split!.decided!.breakdown!);
    expect(b).toMatchObject({ title: 'RoomFlow release 2', status: 'reading', source: { kind: 'pasted' } });
    expect(after).toMatchObject({ waiting: null, waitsToStart: true, status: `Sent to Requirements as ${b!.id}`, split: { decided: { choice: 'requirements', breakdown: b!.id } } });
  });

  it('Keep as one over a whole document: the Analyst reads it again as one story, with a short warning', async () => {
    const id = story('RoomFlow release 2', brdLike());
    answers = [{ summary: 'A whole document.', questions: [], split: { size: 'brd', why: 'Too big.', areas: [] } }];
    await squad().intake(id);
    const after = decideSplit(bp, id, { choice: 'keep' });
    expect(after.squad?.phase).toBe('analyst-read');
    expect(after.notes?.map((n) => n.text)).toEqual([AS_ONE_ANYWAY]);
  });
});

describe('a new story from pasted text', () => {
  it('the draft carries the suggestion, and nothing is created by it', async () => {
    const before = listTickets(bp).length;
    answers = [{ title: 'Customers pay online', ask: PAYMENTS, kind: 'feature', track: 'full', priority: 'normal', criteria: ['A customer pays by card'], rules: [], edgeCases: [], gaps: [], split: fourParts }];
    const d = await draftTicket(bp, { text: PAYMENTS });
    expect(d.split?.parts).toHaveLength(4);
    expect(calls[0]!.prompt).toContain('fill in the ticket fields for the whole text');
    expect(listTickets(bp).length).toBe(before);
  });

  it('Create N stories, Send to Requirements and Create as one story, each one call', async () => {
    const app = new Hono();
    mountSplitApi(app, { paths: buildPaths(tmp) });
    const post = (url: string, body: object = {}) => app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const draft = async (text: string, split: object) => {
      answers = [{ title: 'Customers pay online', ask: text, kind: 'feature', track: 'full', priority: 'normal', criteria: [], rules: ['Refunds up to a day before'], edgeCases: [], gaps: [], split }];
      const job = startDraft(bp, { text });
      await vi.waitFor(() => expect(draftJob(bp, job.id).status).toBe('done'));
      return job.id;
    };

    const id = await draft(PAYMENTS, fourParts);
    const r = await post(`/api/v1/tickets/draft/${id}/split`);
    expect(r.status).toBe(200);
    const { tickets } = (await r.json()) as { tickets: { id: string; title: string; dependsOn?: string[]; waitsToStart?: boolean; squad?: unknown; brief?: { rules: string[]; criteria: string[] } }[] };
    expect(tickets.map((t) => t.title)).toEqual(PAYMENT_PARTS.map((p) => p.title));
    // The first starts at once, as any new story; the others wait, each needing the first.
    expect(readTicket(bp, tickets[0]!.id)!.squad?.phase).toBe('analyst-read');
    expect(tickets.slice(1).every((t) => t.waitsToStart && t.dependsOn?.[0] === tickets[0]!.id)).toBe(true);
    expect(tickets.every((t) => t.brief?.rules[0] === 'Refunds up to a day before')).toBe(true);
    // Each part has its own "done when" lines, never the whole text's.
    expect(tickets.map((t) => t.brief?.criteria)).toEqual(PAYMENT_PARTS.map((p) => [`${p.title} works`]));
    // The draft is used: it no longer waits under New ticket, and the same press gets the same stories.
    expect(currentDraft(bp)).toBeNull();
    const again = (await (await post(`/api/v1/tickets/draft/${id}/split`)).json()) as { tickets: { id: string }[] };
    expect(again.tickets.map((t) => t.id)).toEqual(tickets.map((t) => t.id));

    const doc = await draft(brdLike(), { size: 'brd', why: 'A whole document.', areas: [{ name: 'Booking', stories: 6 }] });
    const sent = (await (await post(`/api/v1/tickets/draft/${doc}/requirements`)).json()) as { breakdown: { id: string } };
    expect(readBreakdown(bp, sent.breakdown.id)?.title).toBe('Customers pay online');
    const twice = (await (await post(`/api/v1/tickets/draft/${doc}/requirements`)).json()) as { breakdown: { id: string } };
    expect(twice.breakdown.id).toBe(sent.breakdown.id);

    // As one story anyway: the ticket keeps the size choice, so its first step asks no more, with a short warning.
    const one = createSized(bp, { title: 'RoomFlow release 2', ask: brdLike() }, 'brd');
    expect(one.split?.decided?.choice).toBe('keep');
    expect(one.notes?.map((n) => n.text)).toEqual([AS_ONE_ANYWAY]);
    const checked = createSized(bp, { title: 'Customers pay online', ask: PAYMENTS }, 'checked');
    expect(checked.split?.checked).toBeTruthy();
  });

  it('the story route takes only the four choices', async () => {
    const app = new Hono();
    mountSplitApi(app, { paths: buildPaths(tmp) });
    const t = actions.createTicket(bp, { title: 'One' });
    const r = await app.request(`/api/v1/tickets/${t.id}/split`, { method: 'POST', body: JSON.stringify({ choice: 'yes' }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('Choose split, keep, change or requirements.');
  });
});

describe('a new story from a voice note, or a bug', () => {
  it('a note nobody could write out is never clearly one story: the Analyst judges it', async () => {
    answers = [{ title: 'Pay by card', ask: 'x', kind: 'feature', track: 'full', priority: 'normal', criteria: [], rules: [], edgeCases: [], gaps: [], split: { size: 'one', why: 'One story.' } }];
    await draftTicket(bp, { text: '', files: [{ name: 'manager.m4a', data: Buffer.from('not really audio').toString('base64') }] });
    expect(calls[0]!.prompt).toContain('judge the size');
  });

  it('a bug report stays one story, whatever its size', async () => {
    answers = [{ title: 'Blank page', ask: 'x', kind: 'bug', track: 'full', priority: 'high', criteria: [], rules: [], edgeCases: [], gaps: [], split: fourParts }];
    const d = await draftTicket(bp, { text: businessPaste() });
    expect(d.kind).toBe('bug');
    expect(d.split).toBeUndefined();
    expect(JSON.stringify(calls[0]!.schema)).toContain('"enum":["one","few","brd"]');
  });
});

describe('a big text in a talk beside the work', () => {
  it('a whole document goes to Requirements once, from the hint under it; the message keeps the link', () => {
    const t = actions.createTicket(bp, { title: 'Payments' });
    updateTicket(bp, t.id, (x) => (x.chat = { with: 'analyst', open: true, beside: true, messages: [], before: { waiting: null } }));
    actions.sendChat(bp, t.id, brdLike());
    const m = readTicket(bp, t.id)!.chat!.messages.at(-1)!;
    expect(m.big).toBe('brd');
    const first = chatToRequirements(bp, t.id, m.at);
    expect(readTicket(bp, t.id)!.chat!.messages.at(-1)!.breakdown).toBe(first.breakdown.id);
    expect(chatToRequirements(bp, t.id, m.at).breakdown.id).toBe(first.breakdown.id);
    expect(() => chatToRequirements(bp, actions.createTicket(bp, { title: 'Other' }).id)).toThrow(/no whole document in its talk/);
  });

  it('gets a hint under it, with no AI: several stories, or a whole document', () => {
    const t = actions.createTicket(bp, { title: 'Payments' });
    updateTicket(bp, t.id, (x) => (x.chat = { with: 'analyst', open: true, beside: true, messages: [], before: { waiting: null } }));
    actions.sendChat(bp, t.id, businessPaste());
    expect(readTicket(bp, t.id)!.chat!.messages.at(-1)!.big).toBe('few');
    updateTicket(bp, t.id, (x) => (x.chat!.thinking = false));
    actions.sendChat(bp, t.id, PAYMENTS_AR);
    expect(readTicket(bp, t.id)!.chat!.messages.at(-1)!.big).toBeUndefined();
  });
});
