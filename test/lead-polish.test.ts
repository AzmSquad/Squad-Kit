import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard } from './support/lead.js';

/**
 * The chat polish of 1.3.19, the engine's side: a greeting answered at once from the board's own numbers with no AI
 * run, one count of what needs the person everywhere (news is not counted), check-ins that never say "0 pictures",
 * buttons that name their action, the lead knowing a story's mockup, and answers that say each story once, on its card.
 */

const calls: RunOptions[] = [];
let agent: () => Promise<Partial<RunResult>> = async () => ({ structured: goodAnswer() });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, sessionId: 's1', text: '', usage: { costUsd: 0.05 }, ...(await agent()) };
  },
}));

const { listTickets, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { isArabic } = await import('../src/board/ask.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { ACTIONS } = await import('../src/engine/lead/can.js');
const { actionCard } = await import('../src/engine/lead/cards.js');
const { needsYou, whatsNew, checkIn } = await import('../src/engine/lead/needs-you.js');
const { liveNow } = await import('../src/board/now.js');
const { readUsual } = await import('../src/board/usual.js');
const { morningBrief } = await import('../src/engine/lead/brief.js');
const { boardText, notesText } = await import('../src/engine/lead/records.js');
const { storyText } = await import('../src/engine/lead/story.js');
const { proofWords } = await import('../src/engine/lead/proof-words.js');
const { boardNumbers, smallTalkOf } = await import('../src/engine/lead/small-talk.js');
const { sameStoryCard, trimCarded } = await import('../src/engine/lead/tidy.js');
const { pressNeeded, waitingCount } = await import('../src/engine/lead/waiting.js');
const { breakdownWaits } = await import('../src/board/requirements.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');
const client = await import('../console-ui/src/lib/waiting.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  calls.length = 0;
  agent = async () => ({ structured: goodAnswer() });
  ({ tmp, bp } = await leadBoard('squad-lead-polish-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

/** A released story whose plan a later decision changed: news, not something to press. */
function releasedWithNews(id = 'SK-138'): void {
  updateTicket(bp, id, (t) => {
    t.stage = 'done';
    t.release = 'v0.2.0';
    t.outdated = [{ adr: 'ADR-011', why: 'The link preview is written into the code.', change: 'Use the address the owner is on.', at: '2026-11-01T10:00:00.000Z' }];
  });
}

describe('a greeting', () => {
  it('is told apart from a question, in English and Arabic', () => {
    expect(smallTalkOf('Hello')).toBe('hello');
    expect(smallTalkOf('hi there!')).toBe('hello');
    expect(smallTalkOf('Good morning, lead')).toBe('hello');
    expect(smallTalkOf('Hey, how are you?')).toBe('hello');
    expect(smallTalkOf('Thanks!')).toBe('thanks');
    expect(smallTalkOf('ok thank you, bye')).toBe('bye');
    expect(smallTalkOf('مرحبا')).toBe('hello');
    expect(smallTalkOf('السلام عليكم ورحمة الله')).toBe('hello');
    expect(smallTalkOf('صباح الخير يا ليد')).toBe('hello');
    expect(smallTalkOf('شكرا جزيلا')).toBe('thanks');
    for (const q of ['Hello, why is MA-9 slow?', 'hi, show me the design', 'ok', 'What needs me?', 'مرحبا، ليه MA-9 واقفة؟']) expect(smallTalkOf(q), q).toBeNull();
  });

  it('is answered at once from the board, with no AI run and no cost', async () => {
    const c = (await askLead(bp, { text: 'Hello', context: { from: 'board', page: 'Board' } }).done).turns.at(-1)!;
    const b = boardNumbers(bp);
    expect(calls).toHaveLength(0);
    expect(c).toMatchObject({ seconds: 0, costUsd: 0, answer: { by: 'board', headline: `Hello! Here is ${readMeta(bp).project} right now.`, cards: [] } });
    expect(c.trace).toEqual([]);
    expect(c.answer!.body).toContain(`${b.open} stories are open`);
    expect(c.answer!.body).toContain(`${waitingCount(bp)} things need you.`);
    expect(c.answer!.body).toContain(b.working ? `${b.working} agent${b.working === 1 ? ' is' : 's are'} working.` : 'No one is working right now.');
    // Counted as the board counts: open is not merged yet, as the side menu says.
    const all = listTickets(bp).filter((t) => !t.archived);
    expect(b.open).toBe(all.filter((t) => t.stage !== 'done' && !t.mergedAt).length);
    expect(b.accepted + b.released + b.open).toBe(all.length);
  });

  it('answers in Arabic when greeted in Arabic, and a thank you briefly', async () => {
    const ar = (await askLead(bp, { text: 'صباح الخير' }).done).turns.at(-1)!.answer!;
    expect(ar.headline).toBe(`أهلًا! هذا وضع ${readMeta(bp).project} الآن.`);
    expect(isArabic(ar.body)).toBe(true);
    expect(ar.body).toContain(`ما ينتظرك الآن: ${waitingCount(bp)}.`);
    const thanks = (await askLead(bp, { text: 'thanks!' }).done).turns.at(-1)!.answer!;
    expect(thanks).toMatchObject({ headline: "You're welcome.", body: `${waitingCount(bp)} things still need you.` });
    expect(calls).toHaveLength(0);
  });

  it('leaves real questions to the lead, which reads the board numbers before an old first read', async () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', at: '2026-01-01T00:00:00.000Z', summary: 'A new project that has not started yet.' } });
    updateTicket(bp, 'SK-143', (t) => (t.mergedAt = '2026-02-01T00:00:00.000Z'));
    const notes = notesText(bp);
    expect(notes.startsWith("The board now, squad-kit's own count and newer than anything below:")).toBe(true);
    expect(notes).toMatch(/The project in short, from squad-kit's first read on 2026-01-01; \d+ stories were merged since, so it is older than the code: A new project/);
    await askLead(bp, { text: 'Hello, which story added the search box?' }).done;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("The board now, squad-kit's own count");
  });
});

describe('what needs you, counted once', () => {
  it('leaves news out of the count and puts it in What is new', () => {
    releasedWithNews();
    expect(needsYou(bp).map((n) => n.story)).not.toContain('SK-138');
    expect(pressNeeded(bp).map((t) => t.id)).not.toContain('SK-138');
    expect(whatsNew(bp)).toEqual([{ id: 'new.SK-138', story: 'SK-138', title: readTicket(bp, 'SK-138')!.title, words: 'SK-138 is released in v0.2.0. ADR-011 came after its plan.', open: '/board?ticket=SK-138' }]);
  });

  it('is one number for the board, the lead, its answers and the brief', () => {
    releasedWithNews();
    const n = waitingCount(bp);
    // The board lists open stories only; its count is the same rule (console-ui/src/lib/waiting.ts).
    const listed = listTickets(bp).filter((t) => t.stage !== 'done' && !t.archived);
    expect(client.waitingCount(listed as never, breakdownWaits(bp).length)).toBe(n);
    expect(needsYou(bp).filter((x) => x.kind !== 'slow')).toHaveLength(n - breakdownWaits(bp).length);
    expect(morningBrief(bp).waiting).toBe(n);
    expect(boardText(bp)).toContain(`Things that need the person now: ${n}, the board's own count`);
    expect(boardText(bp)).toContain('News, not counted as needing the person: SK-138 (ADR-011 came after its plan).');
    expect(notesText(bp)).toContain(`${n} things need the person`);
  });
});

describe('a check-in with no pictures', () => {
  it('says how the story was proved, never "0 pictures"', () => {
    const line = (kind?: 'screen' | 'api' | 'data' | 'test' | 'none') => ({ given: '', when: '', then: 'x', ...(kind ? { proof: { kind } } : {}) });
    expect(proofWords({ criteria: [line('test')] }, 0)).toBe('proved by a test');
    expect(proofWords({ criteria: [line('test'), line('test'), line('api')] }, 0)).toBe('proved by 2 tests and an API answer');
    expect(proofWords({ criteria: [line('data')] }, 0)).toBe('proved by a check of the saved data');
    expect(proofWords({ criteria: [line(), line('none')] }, 0)).toBe('no pictures for this story');
    expect(proofWords({ criteria: [line('screen'), line('test')] }, 3)).toBe('3 pictures and a test');
    expect(proofWords({}, 1)).toBe('1 picture');
    // The kind is filled in by the proof kinds (board/proof-kind.ts) on each "done when".
    const t = { ...readTicket(bp, 'SK-142')!, proof: [], criteria: [{ given: 'a', when: 'b', then: 'c', proof: { kind: 'test' as const } }] };
    const words = checkIn(t, liveNow(t, readUsual(bp))).words;
    expect(words).toBe('SK-142 is ready for your check: proved by a test, not checked: the project has no tests, Reviewer approved.');
    expect(needsYou(bp).map((x) => x.words).join(' ')).not.toContain('0 pictures');
  });
});

describe('buttons name the action', () => {
  it('never say a bare "Allow once"', () => {
    expect(ACTIONS.pictures_again.label).toBe('Take the pictures again');
    for (const a of Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]) expect(actionCard('c1', a, { story: 'SK-155' }).label).not.toMatch(/^Allow/);
    expect(needsYou(bp).find((x) => x.story === 'SK-155')!.cards[0]).toMatchObject({ label: 'Take the pictures again', allowAlways: true });
  });
});

describe('the design', () => {
  it("is in the lead's read of the story, so it brings the design card", () => {
    expect(storyText(bp, { ...readTicket(bp, 'SK-139')!, mockup: 'mockup.html' })).toContain("The Architect's mockup of the screen: mockup.html, in the story's folder. The board shows it as a picture on the story's design card");
    expect(storyText(bp, readTicket(bp, 'SK-142')!)).not.toContain('mockup');
  });
});

describe('an answer that brings cards', () => {
  it('says each story once, on its card, and never brings the same card twice', async () => {
    agent = async () => ({
      structured: goodAnswer({
        headline: '2 stories wait for you.',
        body: '1. SK-139 is ready for your check: 4 pictures.\n2. SK-148 has 4 questions from the Analyst.\n3. SK-152 waits for SK-146.\n\nUse the cards below.',
        cards: [{ kind: 'decide', story: 'SK-139' }, { kind: 'decide', story: 'SK-139' }, { kind: 'decide', story: 'SK-148' }],
      }),
    });
    const a = (await askLead(bp, { text: 'What waits for me?' }).done).turns.at(-1)!.answer!;
    // SK-152's card comes from squad-kit, for the waiting story the words name.
    expect(a.cards.filter((c) => c.kind === 'decide').map((c) => (c as { story: string }).story)).toEqual(['SK-139', 'SK-148', 'SK-152']);
    expect(a.body).toBe('Use the cards below.');
  });

  it('keeps the lines no card shows, numbered again', () => {
    const decide = (story: string) => ({ id: story, kind: 'decide', level: 1, story, wait: 'proof', key: 'k', open: '/', label: 'Looks right', command: '', status: 'open' }) as const;
    expect(trimCarded('1. MA-8 the design.\n2. MA-10 a talk.\n3. MA-11 stopped.\n\nPress below.', [decide('MA-8'), decide('MA-11')])).toBe('1. MA-10 a talk.\n\nPress below.');
    expect(trimCarded('MA-8 waits for you.', [decide('MA-8')])).toBe('MA-8 waits for you.');
    expect(trimCarded('- MA-10 needs MA-8 first.', [decide('MA-8')])).toBe('- MA-10 needs MA-8 first.');
    expect(sameStoryCard([decide('MA-8')], decide('MA-8'))).toBe(true);
    expect(sameStoryCard([decide('MA-8')], decide('MA-9'))).toBe(false);
  });
});
