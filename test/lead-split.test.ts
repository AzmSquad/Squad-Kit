import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard } from './support/lead.js';
import { PAYMENT_PARTS, brdLike, businessPaste } from './support/split.js';

/**
 * The Squad lead never makes one giant draft from a text that is more than one story: its draft goes through squad-kit's
 * own count, and becomes a split (Create N stories) or, for a whole document, Send to Requirements. A requirements
 * document pasted to the lead gets that card at once, with no AI. Nothing is made until the person presses. The agent
 * is a fake.
 */

let answers: unknown[] = [];
let runs = 0;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (_opts: RunOptions): Promise<RunResult> => {
    runs += 1;
    return { ok: true, sessionId: 's1', text: '', structured: answers.shift() ?? goodAnswer() };
  },
}));

const { listTickets, readTicket } = await import('../src/board/store.js');
const { readBreakdown } = await import('../src/board/requirements.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { runCard } = await import('../src/engine/lead/cards.js');
const { AS_ONE_ANYWAY } = await import('../src/board/split.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  answers = [];
  runs = 0;
  ({ tmp, bp } = await leadBoard('squad-lead-split-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

const draft = (more: Record<string, unknown> = {}) => ({
  kind: 'draft_story',
  title: 'Meeting rooms for members',
  ask: 'Members book rooms, reception sees guests, managers get reports.',
  storyKind: 'feature',
  doneWhen: [{ text: 'A member books a free room', proof: 'screen' }],
  ...more,
});

async function asked(text: string) {
  const c = await askLead(bp, { text }).done;
  return { id: c.id, turn: c.turns.at(-1)! };
}

describe("the lead's story draft", () => {
  it('a long business text drafted as one story is asked for again, with its parts, and becomes a split card', async () => {
    answers = [goodAnswer({ cards: [draft()] }), goodAnswer({ cards: [draft({ size: 'few', why: 'Four stories in one.', parts: PAYMENT_PARTS })] })];
    const { turn } = await asked(`Make a story from this:\n${businessPaste().slice(0, 3000)}`);
    expect(runs).toBe(2);
    expect(turn.trace.map((s) => s.text).join('\n')).toMatch(/drafts one story from a text that holds several/);
    const [card] = turn.answer!.cards;
    expect(card).toMatchObject({ kind: 'draft_story', label: 'Create 4 stories', split: { size: 'few' } });
  });

  it('nothing is made without the person\'s choice; Create N stories makes them, each waiting for Start, with "depends on"', async () => {
    answers = [goodAnswer({ cards: [draft({ parts: PAYMENT_PARTS.map((p) => ({ ...p, doneWhen: [`${p.title} works`] })), why: 'Four stories in one.' })] })];
    const before = listTickets(bp).length;
    const { id, turn } = await asked('Customers pay by card, get a receipt, ask for refunds, and staff see a report. Make it a story.');
    const card = turn.answer!.cards[0]!;
    expect(listTickets(bp).length).toBe(before);
    await expect(runCard(bp, card.id)).rejects.toThrow(/Choose: create 4 stories, or one story/);
    // A split card has no Send to Requirements button, so neither has its command.
    await expect(runCard(bp, card.id, { choice: 'requirements' })).rejects.toThrow(/This draft is 4 stories: create them, or one story/);
    expect(listTickets(bp).length).toBe(before);
    const done = await runCard(bp, card.id, { choice: 'split' });
    const made = (done.card as { stories: string[] }).stories;
    expect(made).toHaveLength(4);
    expect(done.card.result).toBe(`Created ${made.slice(0, 3).join(', ')} and ${made[3]}. Nothing starts until you press Start.`);
    for (const [i, sid] of made.entries()) {
      const t = readTicket(bp, sid)!;
      expect(t).toMatchObject({ title: PAYMENT_PARTS[i]!.title, waitsToStart: true, lead: id });
      expect(t.dependsOn).toEqual(i === 0 ? undefined : [made[0]]);
      // Each part has its own "done when" lines, not the whole draft's.
      expect(t.brief?.criteria).toEqual([`${PAYMENT_PARTS[i]!.title} works`]);
    }
  });

  it('Create as one story keeps the choice on the story, so its first step asks no more', async () => {
    answers = [goodAnswer({ cards: [draft({ parts: PAYMENT_PARTS })] })];
    const { turn } = await asked('Customers pay by card and get a receipt. Make it a story.');
    const done = await runCard(bp, turn.answer!.cards[0]!.id, { choice: 'one' });
    const t = readTicket(bp, (done.card as { story: string }).story)!;
    expect(t.title).toBe('Meeting rooms for members');
    expect(t.split?.decided?.choice).toBe('keep');
  });

  it('a whole document by squad-kit\'s own count: Send to Requirements, or one story anyway with a short warning', async () => {
    answers = [goodAnswer({ cards: [draft({ size: 'brd', areas: [{ name: 'Booking', stories: 6 }] })] }), goodAnswer({ cards: [draft()] })];
    const doc = brdLike(3, 4);
    const first = await asked(`Turn this into a story:\n${doc}`);
    const card = first.turn.answer!.cards[0]!;
    expect(card).toMatchObject({ label: 'Send to Requirements', split: { size: 'brd', areas: [{ name: 'Booking', stories: 6 }] } });
    await expect(runCard(bp, card.id, { choice: 'split' })).rejects.toThrow(/whole requirements document: send it to Requirements/);
    const sent = await runCard(bp, card.id, { choice: 'requirements' });
    expect(sent.card.result).toMatch(/^Sent to Requirements as BR-\d+\. The Analyst reads it first\.$/);
    // The card keeps its link to the breakdown.
    expect((sent.card as { breakdown?: string }).breakdown).toMatch(/^BR-\d+$/);

    const again = await asked(`And this one, as one story please:\n${doc}`);
    const one = await runCard(bp, again.turn.answer!.cards[0]!.id, { choice: 'one' });
    expect(readTicket(bp, (one.card as { story: string }).story)!.notes?.map((n) => n.text)).toContain(AS_ONE_ANYWAY);
  });
});

describe('a requirements document pasted to the lead', () => {
  it('is answered at once, with no AI, with Send to Requirements; its text goes there on the press', async () => {
    const doc = brdLike(10, 8);
    expect(doc.length).toBeGreaterThan(4000);
    const { turn } = await asked(doc);
    expect(runs).toBe(0);
    expect(turn.answer).toMatchObject({ by: 'check', headline: 'This is a whole requirements document, too big for one story.' });
    const [card] = turn.answer!.cards;
    expect(card).toMatchObject({ kind: 'requirements', level: 2, label: 'Send to Requirements', lang: 'en' });
    expect((card as { found: string[] }).found).toEqual(expect.arrayContaining(['80 requirement numbers']));
    const done = await runCard(bp, card!.id);
    const b = readBreakdown(bp, (done.card as { breakdown: string }).breakdown)!;
    expect(b).toMatchObject({ status: 'reading', source: { kind: 'pasted' } });
  });

  it('a long text that is not a document is still refused, pointing to New ticket and Requirements', () => {
    expect(() => askLead(bp, { text: 'Please make this better. '.repeat(400) })).toThrow(/paste it in New ticket, which suggests a split, or on the Requirements page/);
  });
});
