import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard, pressTool, textOf } from './support/lead.js';

/**
 * Buttons, not "tell me": an answer that sends the person to the board comes with its card: a story that waits for
 * the person comes with its decision card (the board's own buttons, only theirs to press), any other with an Open card
 * to the story at its tab, which changes nothing; a refusal of what only the person may do brings the stories it
 * names; and the lead may show a story's own proof pictures, only those the board already keeps. The agent is a fake.
 */

const calls: RunOptions[] = [];
let agent: (opts: RunOptions, n: number) => Promise<Partial<RunResult>> = async () => ({ structured: goodAnswer() });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, sessionId: 's1', text: '', ...(await agent(opts, calls.length)) };
  },
}));

const { readTicket, updateTicket } = await import('../src/board/store.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { NEVER } = await import('../src/engine/lead/can.js');
const { openPlace, runCard } = await import('../src/engine/lead/cards.js');
const { laterOffer } = await import('../src/engine/lead/answer.js');
const { requireConversation } = await import('../src/engine/lead/store.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');
const { placeOf } = await import('../console-ui/src/lib/lead.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  calls.length = 0;
  agent = async () => ({ structured: goodAnswer() });
  ({ tmp, bp } = await leadBoard('squad-lead-open-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

const ask = async (text: string, more: Record<string, unknown> = {}) => (await askLead(bp, { text, ...more }).done).turns.at(-1)!;

describe('an Open card', () => {
  it('opens a story at its tab, on its own: no OK, nothing changes, and it can be opened again', async () => {
    agent = async () => ({
      structured: goodAnswer({
        cards: [
          { kind: 'open_story', story: 'SK-144', tab: 'plan', why: 'Its plan shows the steps.' },
          { kind: 'open_story', story: 'sk-139' },
          { kind: 'open_story', story: 'XX-1' },
        ],
      }),
    });
    const t = await ask('Where is the plan of SK-144?');
    const [plan, proof] = t.answer!.cards;
    expect(t.answer!.cards).toHaveLength(2);
    expect(plan).toMatchObject({ kind: 'open_story', level: 1, story: 'SK-144', tab: 'plan', label: "Open SK-144's plan", open: '/board?ticket=SK-144&tab=plan', command: 'squad show SK-144', why: 'Its plan shows the steps.', status: 'open' });
    // No tab given on a story that waits for the person: its decision card. SK-139 waits for Looks right, on its proof page.
    expect(proof).toMatchObject({ kind: 'decide', story: 'SK-139', wait: 'proof', label: 'Looks right', open: '/tickets/SK-139/proof' });
    expect(t.trace.map((s) => s.text)).toContain('Left out a card: an Open card names no story on this board');
    const before = JSON.stringify(readTicket(bp, 'SK-144'));
    for (let i = 0; i < 2; i++) {
      const r = await runCard(bp, plan!.id);
      expect(r.card).toMatchObject({ status: 'open', result: 'It opens on the board: /board?ticket=SK-144&tab=plan. In the terminal: squad show SK-144' });
    }
    expect(JSON.stringify(readTicket(bp, 'SK-144'))).toBe(before);
    expect(requireConversation(bp, plan!.id.split('.')[0]!).turns[0]!.answer!.cards[0]!.status).toBe('open');
  });

  it("goes where the board's own buttons go", () => {
    const t = readTicket(bp, 'SK-144')!;
    expect(openPlace(t)).toBe('/board?ticket=SK-144');
    expect(openPlace(t, 'spec')).toBe('/board?ticket=SK-144&tab=story');
    expect(openPlace(t, 'proof')).toBe('/board?ticket=SK-144&tab=proof');
    expect(openPlace(t, 'questions')).toBe('/board?ticket=SK-144');
    expect(openPlace(readTicket(bp, 'SK-139')!, 'proof')).toBe('/tickets/SK-139/proof');
    // A stop at the proof: its pictures and its ways out are on the Now tab.
    expect(openPlace(readTicket(bp, 'SK-135')!, 'proof')).toBe('/board?ticket=SK-135');
    updateTicket(bp, 'SK-144', (x) => (x.waiting = { kind: 'plan', summary: 'The plan waits for you' }));
    expect(openPlace(readTicket(bp, 'SK-144')!, 'plan')).toBe('/board?ticket=SK-144');
    // The board reads the same places back.
    expect(placeOf('/board?ticket=SK-144&tab=plan')).toEqual({ to: '/board', ticket: 'SK-144', tab: 'plan' });
    expect(placeOf('/board?ticket=SK-144')).toEqual({ to: '/board', ticket: 'SK-144' });
    expect(placeOf('/tickets/SK-139/proof')).toEqual({ to: '/tickets/$id/proof', id: 'SK-139' });
  });
});

describe('buttons, not "go and press it"', () => {
  it('gives a card for each story the answer sends the person to: its decision card while it waits for them', async () => {
    agent = async () => ({
      structured: goodAnswer({
        headline: 'Accept SK-139 first, then SK-142.',
        body: '1. Open SK-139 and press Looks right.\n2. Open SK-142 and press Looks right.\nSK-149 is still in the queue, and decision ADR-010 stays.',
      }),
    });
    const t = await ask('What order should I accept them in?');
    expect(t.answer!.cards.map((c) => [c.kind, c.label, (c.kind === 'open_story' || c.kind === 'decide') && c.open])).toEqual([
      ['decide', 'Looks right', '/tickets/SK-139/proof'],
      ['decide', 'Looks right', '/tickets/SK-142/proof'],
    ]);
  });

  it('opens a story a sentence sends the person to even when it waits for nothing, in Arabic too', async () => {
    agent = async () => ({ structured: goodAnswer({ headline: 'الخطة جاهزة.', body: 'افتح SK-145 وراجع الخطة.' }) });
    const t = await ask('أين خطة SK-145؟');
    expect(t.answer!.cards).toEqual([expect.objectContaining({ kind: 'open_story', story: 'SK-145', tab: 'plan', open: '/board?ticket=SK-145&tab=plan' })]);
  });

  it('adds none for a story it only mentions, none for one a card is already for, and keeps at most 4 cards', async () => {
    agent = async () => ({ structured: goodAnswer({ headline: 'SK-149 adds Arabic names to the PDF exports.', body: 'It is in the queue.' }) });
    expect((await ask('What is SK-149 about?')).answer!.cards).toEqual([]);
    agent = async () => ({
      structured: goodAnswer({
        headline: 'Four things wait for you.',
        body: 'Open SK-139, SK-142, SK-144 and SK-148. Press Looks right on SK-155.',
        cards: [
          { kind: 'open_story', story: 'SK-139' },
          { kind: 'open_story', story: 'SK-142' },
          { kind: 'board_action', action: 'try_again', story: 'SK-144' },
        ],
      }),
    });
    const t = await ask('What needs me?');
    expect(t.answer!.cards.map((c) => `${c.kind} ${c.label}`)).toEqual(['decide Looks right', 'decide Looks right', 'board_action Try again', 'decide Answer']);
  });

  it('turns an action that does not fit now into the story\'s own card: no pictures again on a proof that waits for Looks right', async () => {
    agent = async () => ({
      structured: goodAnswer({
        cards: [
          { kind: 'board_action', action: 'pictures_again', story: 'SK-139', why: 'It has no picture of the search box.' },
          { kind: 'board_action', action: 'try_again', story: 'SK-139' },
        ],
      }),
    });
    const t = await ask('Can the Tester take SK-139 pictures again?');
    expect(t.answer!.cards).toEqual([expect.objectContaining({ kind: 'decide', story: 'SK-139', label: 'Looks right', why: 'It has no picture of the search box.' })]);
    expect(t.trace.map((s) => s.text)).toEqual(expect.arrayContaining(['Left out a card: SK-139 does not wait for new pictures', 'Left out a card: SK-139 has no Try again now']));
    expect(readTicket(bp, 'SK-139')!.waiting?.kind).toBe('proof');
  });

  it('keeps its refusal of what only the person may do, and brings the stories it names', async () => {
    agent = async () => ({
      structured: goodAnswer({
        headline: "I can't press Looks right for you.",
        body: 'Only you can accept SK-139 and SK-142. Open each one, check the pictures, then decide.',
      }),
    });
    const t = await ask('ممتاز موافق');
    expect(t.answer!.headline).toBe("I can't press Looks right for you.");
    expect(t.answer!.cards.map((c) => `${c.kind} ${c.kind === 'decide' ? c.story : ''}`)).toEqual(['decide SK-139', 'decide SK-142']);
    // squad-kit's own refusal, with no AI, brings them too.
    const own = await ask('Approve SK-142');
    expect(own.answer).toMatchObject({ by: 'refusal', headline: NEVER.approve.refusal, cards: [{ kind: 'decide', story: 'SK-142', open: '/tickets/SK-142/proof' }] });
  });
});

describe('"tell me and I\'ll"', () => {
  it('is asked for again, once, with its card; the lead acts only through this answer', async () => {
    agent = async (_o, n) => ({
      structured:
        n === 1
          ? goodAnswer({ headline: 'SK-142 has no picture of the highlight.', body: "If you want pictures for SK-142 before you accept, tell me and I'll request them." })
          : goodAnswer({ headline: 'SK-142 has no picture of the highlight.', body: "Open its proof and press Something's wrong with a note.", cards: [{ kind: 'open_story', story: 'SK-142', tab: 'proof' }] }),
    });
    const t = await ask('Is SK-142 ready?');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('the body offers to do something for SK-142 later');
    expect(t.trace.map((s) => s.text)).toContainEqual(expect.stringMatching(/^The answer was not complete \(the body offers to do something for SK-142 later/));
    expect(t.answer!.cards.map((c) => `${c.kind} ${c.label}`)).toEqual(['decide Looks right']);
  });

  it('keeps the words and its cards when it still offers it, and the story\'s card comes anyway', async () => {
    agent = async () => ({ structured: goodAnswer({ headline: 'SK-142 is almost there.', body: 'لو تريد صورًا لـ SK-142 قبل القبول، قل لي وسأطلبها.', cards: [{ kind: 'engineer_report' }] }) });
    const t = await ask('هل SK-142 جاهزة؟');
    expect(calls).toHaveLength(2);
    expect(t.answer!.body).toContain('قل لي');
    expect(t.answer!.cards.map((c) => c.kind)).toEqual(['engineer_report', 'decide']);
  });

  it('is only an offer about a story with no card for it', () => {
    const a = (body: string, cards: Record<string, unknown>[] = []) => laterOffer({ headline: 'x.', body, cards });
    expect(a("Tell me what should change, and I'll draft that story for you to create.")).toBeNull();
    expect(a("Let me know if SK-142 needs anything else.")).toBeNull();
    expect(a("Tell me and I'll take the SK-142 pictures again.")).toMatch(/SK-142/);
    expect(a("Tell me and I'll take the SK-142 pictures again.", [{ kind: 'open_story', story: 'SK-142' }])).toBeNull();
    expect(a('اخبرني وسأطلب صور SK-142.')).toMatch(/SK-142/);
  });
});

describe("a story's own proof pictures", () => {
  it('show as evidence with the story they are from, only the ones the board keeps on a story', async () => {
    fs.writeFileSync(path.join(bp.proofDir, 'not-a-proof.png'), 'x');
    agent = async (opts) => {
      const story = textOf(await pressTool(opts, 'read_story', { id: 'SK-139' }));
      expect(story).toContain('[files: sk139-before.png, sk139-after.png]');
      expect(story).toContain('Cards for SK-139 now: open_story (tab proof); no board action fits it now.');
      return {
        structured: goodAnswer({
          evidence: [
            { file: 'sk139-after.png', caption: 'The search box above the case list', story: 'SK-139' },
            { file: '../sk148-light.png', caption: 'Typing 1446 lists the cases of that year' },
            { file: 'not-a-proof.png', caption: 'Not on any story' },
            { file: 'missing.png', caption: 'Not kept anywhere', story: 'SK-139' },
            { file: '.env', caption: 'No' },
          ],
        }),
      };
    };
    const t = await ask("Show me SK-139's proof");
    expect(t.answer!.evidence).toEqual([
      { file: 'sk139-after.png', caption: 'The search box above the case list', url: '/api/v1/proof/sk139-after.png', story: 'SK-139' },
      { file: 'sk148-light.png', caption: 'Typing 1446 lists the cases of that year', url: '/api/v1/proof/sk148-light.png', story: expect.stringMatching(/^SK-\d+$/) },
    ]);
  });

  it('tells the lead it may show them, and how to give the Open card', async () => {
    await ask('Who uses this app?');
    const rules = calls[0]!.appendSystemPrompt!;
    expect(rules).toContain("a story's own proof\n  pictures when you talk about them");
    expect(rules).toContain('each with a caption. At most\n  4: squad-kit shows no more.');
    expect(rules).toContain('open_story: opens a story on the board');
    expect(rules).toContain('Buttons, not "tell me"');
    expect(rules).toContain('keep your refusal and add an\n  open_story card for each story you name');
  });
});
