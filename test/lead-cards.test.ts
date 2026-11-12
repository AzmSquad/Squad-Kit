import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard } from './support/lead.js';

/**
 * The lead's cards: each runs an existing board action through the same function as the board's button, only when
 * pressed, or by itself under "Always allow" for the four low-risk ones. The agent is a fake.
 */

let cards: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (_opts: RunOptions): Promise<RunResult> => ({ ok: true, sessionId: 's1', text: '', structured: goodAnswer({ cards }) }),
}));

const { createTicket } = await import('../src/board/actions.js');
const { readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { ENGINEERS_ONLY } = await import('../src/engine/lead/can.js');
const { runCard } = await import('../src/engine/lead/cards.js');
const { needsYou } = await import('../src/engine/lead/needs-you.js');
const { leadRules, requireConversation, saveLeadRules } = await import('../src/engine/lead/store.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  cards = [];
  ({ tmp, bp } = await leadBoard('squad-lead-cards-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

/** An answer with these cards, and the conversation it is in. */
async function offered(...list: unknown[]) {
  cards = list;
  const c = await askLead(bp, { text: 'What should we do next?' }).done;
  return { id: c.id, cards: c.turns.at(-1)!.answer!.cards, turn: c.turns.at(-1)! };
}

describe('Create story', () => {
  it('uses the ticket creation, keeps how each "done when" is proved, links the conversation, and starts nothing', async () => {
    const { id, cards: [card] } = await offered({
      kind: 'draft_story',
      title: 'Customers cancel their own booking',
      ask: 'A customer can cancel an upcoming booking from My bookings, up to 2 hours before it starts.',
      storyKind: 'feature',
      doneWhen: [
        { text: 'I see Cancel on each upcoming booking in My bookings', proof: 'screen' },
        { text: 'A cancelled booking frees its time for others', proof: 'data' },
        { text: 'The business owner gets an email about it', proof: 'api' },
      ],
      warnings: ['This changes decision ADR-010, "only owners cancel".'],
    });
    expect(card).toMatchObject({ kind: 'draft_story', level: 2, label: 'Create story', status: 'open', command: `squad lead run ${card!.id}` });
    const done = await runCard(bp, card!.id);
    expect(done.card).toMatchObject({ status: 'done', story: expect.stringMatching(/^SK-\d+$/) });
    const t = readTicket(bp, (done.card as { story: string }).story)!;
    expect(t).toMatchObject({ title: 'Customers cancel their own booking', kind: 'feature', waitsToStart: true, live: false, lead: id });
    expect(t.squad ?? null).toBeNull();
    expect(t.brief).toMatchObject({ criteria: ['I see Cancel on each upcoming booking in My bookings', 'A cancelled booking frees its time for others', 'The business owner gets an email about it'], proofs: ['screen', 'data', 'api'] });
    expect(t.notes?.map((n) => n.text)).toEqual(['This changes decision ADR-010, "only owners cancel".']);
    expect(t.activity.map((a) => a.text)).toContain('Made it from a conversation with the Squad lead. Nothing starts until you press Start');
    expect(requireConversation(bp, id).story).toBe(t.id);
    await expect(runCard(bp, card!.id)).rejects.toThrow('This card was already used.');
  });

  it('takes the person\'s edits before Create', async () => {
    const { cards: [card] } = await offered({ kind: 'draft_story', title: 'Cancel', ask: 'Cancel a booking', doneWhen: [{ text: 'A', proof: 'screen' }] });
    const done = await runCard(bp, card!.id, { edits: { title: 'Customers cancel bookings', doneWhen: [{ text: 'Cancel shows', proof: 'test' }] } });
    const t = readTicket(bp, (done.card as { story: string }).story)!;
    expect(t.title).toBe('Customers cancel bookings');
    expect(t.brief).toMatchObject({ criteria: ['Cancel shows'], proofs: ['test'] });
  });
});

describe('board actions', () => {
  it('give more time, take the pictures again, start and stop a story, each through the board\'s own function', async () => {
    const waiting = createTicket(bp, { title: 'Waits to start', waitsToStart: true });
    const { cards: list } = await offered(
      { kind: 'board_action', action: 'more_time', story: 'SK-145', minutes: 15 },
      { kind: 'board_action', action: 'pictures_again', story: 'SK-135' },
      { kind: 'board_action', action: 'start_story', story: waiting.id },
      { kind: 'board_action', action: 'stop_story', story: 'SK-146' },
    );
    expect(list.map((c) => c.label)).toEqual(['Give it 15 more minutes', 'Take them again', 'Start', 'Stop']);
    for (const c of list) await runCard(bp, c.id);
    expect(readTicket(bp, 'SK-145')!.quietSnoozedUntil).toBeDefined();
    expect(readTicket(bp, 'SK-145')!.activity.at(-1)!.text).toBe('Gave it 15 more minutes');
    expect(readTicket(bp, 'SK-135')!.waiting).toBeNull();
    expect(readTicket(bp, waiting.id)).toMatchObject({ live: true });
    expect(readTicket(bp, waiting.id)!.waitsToStart).toBeUndefined();
    expect(readTicket(bp, 'SK-146')!.stopRequested).toBe(true);
  });

  it('leaves out an action that does not fit where the story stands, opening the story instead, and one with no story', async () => {
    const { cards: list, turn } = await offered({ kind: 'board_action', action: 'start_story', story: 'SK-145' }, { kind: 'board_action', action: 'more_time' });
    expect(list).toEqual([expect.objectContaining({ kind: 'open_story', story: 'SK-145', label: 'Open SK-145', level: 1 })]);
    expect(turn.trace.map((s) => s.text)).toEqual(expect.arrayContaining(['Left out a card: SK-145 does not wait to be started', 'Left out a card: give it more time names no story on this board']));
  });

  it('a card that fails keeps its card open with why', async () => {
    const { cards: [card] } = await offered({ kind: 'board_action', action: 'get_tool', tool: 'nothing-like-this' });
    await expect(runCard(bp, card!.id)).rejects.toThrow('squad-kit knows no tool called "nothing-like-this"');
    const kept = requireConversation(bp, card!.id.split('.')[0]!).turns[0]!.answer!.cards[0]!;
    expect(kept).toMatchObject({ status: 'open', result: expect.stringContaining('knows no tool') });
  });
});

describe('Send', () => {
  it("answers the agent's question on a story, with the person's own words when they changed it", async () => {
    updateTicket(bp, 'SK-153', (t) => {
      t.live = false;
      t.waiting = { kind: 'ask', summary: 'The Builder asks which date format' };
      t.agentQuestion = { from: 'builder', text: 'Which date format?', options: ['day/month/year', 'month/day/year'], at: new Date().toISOString() };
    });
    const { cards: [card] } = await offered({ kind: 'send_answer', story: 'SK-153', text: 'day/month/year' });
    expect(card).toMatchObject({ label: 'Send', level: 2 });
    await runCard(bp, card!.id, { edits: { text: 'DD/MM/YYYY, like on the court letters' } });
    expect(readTicket(bp, 'SK-153')!.agentQuestion!.answer).toBe('DD/MM/YYYY, like on the court letters');
    expect(readTicket(bp, 'SK-153')!.waiting).toBeNull();
  });
});

describe('Save', () => {
  it('saves a setting through Settings\' own function; a technical one only for an engineer', async () => {
    const pm = await offered({ kind: 'settings_change', setting: 'quality', value: 'thrifty' }, { kind: 'settings_change', setting: 'commands.start', value: 'npm run dev' });
    expect(pm.cards.map((c) => c.kind === 'settings_change' && c.setting)).toEqual(['quality']);
    expect(pm.turn.trace.map((s) => s.text)).toContain('Left out a card: a technical setting, which only an engineer changes');
    await runCard(bp, pm.cards[0]!.id);
    expect(readMeta(bp).quality).toBe('thrifty');

    writeMeta(bp, { ...readMeta(bp), user: { name: 'Momen', role: 'Software engineer' } });
    const eng = await offered({ kind: 'settings_change', setting: 'commands.start', value: 'npm run dev' });
    expect(eng.cards[0]).toMatchObject({ technical: true, label: 'Save' });
    // Pressed by someone who is not an engineer: refused at the press too.
    writeMeta(bp, { ...readMeta(bp), user: { name: 'Sara', role: 'Project manager' } });
    await expect(runCard(bp, eng.cards[0]!.id)).rejects.toThrow(ENGINEERS_ONLY);
    writeMeta(bp, { ...readMeta(bp), user: { name: 'Momen', role: 'Software engineer' } });
    await runCard(bp, eng.cards[0]!.id);
    expect(readMeta(bp).commands?.start).toBe('npm run dev');
  });
});

describe('Always allow', () => {
  it('is only for the low-risk actions, and Not now puts a card aside', async () => {
    const waiting = createTicket(bp, { title: 'Waits to start', waitsToStart: true });
    const { cards: list } = await offered({ kind: 'board_action', action: 'start_story', story: waiting.id }, { kind: 'board_action', action: 'more_time', story: 'SK-145' }, { kind: 'board_action', action: 'morning_brief' });
    expect(list.map((c) => Boolean(c.allowAlways))).toEqual([false, true, true]);
    await expect(runCard(bp, list[0]!.id, { always: true })).rejects.toThrow('"Always allow" is only for giving more time, taking the pictures again, starting the app and the morning brief. This one asks you each time.');
    expect(leadRules(bp).always).toEqual([]);
    await runCard(bp, list[1]!.id, { always: true });
    expect(leadRules(bp).always).toEqual(['more_time']);
    await runCard(bp, list[2]!.id);
    expect(leadRules(bp)).toEqual({ always: ['more_time'], brief: true });
    // Not now.
    const again = await offered({ kind: 'board_action', action: 'start_story', story: waiting.id });
    expect((await runCard(bp, again.cards[0]!.id, { dismiss: true })).card.status).toBe('dismissed');
    await expect(runCard(bp, again.cards[0]!.id)).rejects.toThrow('This card was put aside.');
    expect(readTicket(bp, waiting.id)!.waitsToStart).toBe(true);
  });

  it('keeps the never list fixed and refuses anything else under Always allow', () => {
    expect(() => saveLeadRules(bp, { never: [] })).toThrow('The list of what the lead never does cannot change.');
    expect(() => saveLeadRules(bp, { always: ['start_story'] })).toThrow('"Always allow" is only for low-risk actions (more_time, pictures_again, start_app, morning_brief), so "start_story" always asks you first.');
    expect(saveLeadRules(bp, { always: ['start_app', 'more_time'], brief: true })).toEqual({ always: ['more_time', 'start_app'], brief: true });
    expect(readMeta(bp).lead).toEqual({ always: ['more_time', 'start_app'], brief: true });
  });

  it('a card on the "Needs you" rail runs the same way', async () => {
    updateTicket(bp, 'SK-145', (t) => (t.quiet = { since: new Date().toISOString(), kind: 'long', detail: 'Still working' }));
    const item = needsYou(bp).find((x) => x.story === 'SK-145')!;
    expect(item.cards[0]!.id).toBe('now.SK-145.more_time');
    await runCard(bp, 'now.SK-145.more_time', { find: (x) => needsYou(bp).flatMap((n) => n.cards).find((c) => c.id === x) });
    expect(readTicket(bp, 'SK-145')!.quietSnoozedUntil).toBeDefined();
    await expect(runCard(bp, 'now.SK-145.more_time', { find: () => undefined })).rejects.toThrow('That card is gone: the story moved on.');
    await expect(runCard(bp, '20261111-abcdef.1.1')).rejects.toThrow('There is no conversation');
  });
});
