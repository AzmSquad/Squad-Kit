import { describe, it, expect } from 'vitest';
import { liveNow } from '../src/board/now.js';
import { answerAsk, arIn, arMinutes, askTopic, isArabic, plainArabic, type AskAnswer } from '../src/board/ask.js';
import type { Step, Ticket } from '../src/board/types.js';

/**
 * Ask about a ticket (phase 6): status questions are answered at once from the live record, in the language of the
 * question, with no AI cost. Anything it cannot answer offers an agent instead, never a guess; anything that would
 * change the work offers Propose a change or a note the agent reads at its next step.
 */

const AT = Date.parse('2026-11-03T10:45:00Z');
const ago = (s: number) => new Date(AT - s * 1000).toISOString();

function ticket(over: Partial<Ticket> = {}): Ticket {
  return { id: 'RO-7', title: 'Show room capacity', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: '', waiting: null, createdAt: ago(540), createdBy: 'Sara', activity: [], ...over };
}

const steps: Step[] = ['Read the booking page', 'Get each room size', 'Show how many fit', 'Warn when full', 'Same in the API', 'Tests'].map((title, i) => ({
  title,
  status: i < 2 ? 'done' : i === 2 ? 'doing' : 'todo',
}));

const building = (over: Partial<Ticket> = {}) =>
  ticket({
    live: true,
    squad: { phase: 'build', nextAt: ago(-3600) },
    status: 'Editing src/pages/booking.tsx',
    steps,
    work: { steps: 6, tests: 4, screens: 2 },
    specApproved: { by: 'Sara', at: ago(400) },
    clock: { who: 'builder', step: 'build', part: 3, since: ago(240), doing: 'Editing src/pages/booking.tsx', doingAt: ago(4), limit: 60 },
    usage: [{ role: 'builder', step: 'build', level: 'strongest', model: 'Opus', runs: 3, costUsd: 1.234 }],
    ...over,
  });

function ask(t: Ticket, q: string): AskAnswer {
  return answerAsk(t, liveNow(t, {}, AT), {}, q);
}

describe('which question it is', () => {
  it('knows the status questions in English', () => {
    const cases: [string, string][] = [
      ['is there a problem?', 'problem'],
      ['Is it stuck?', 'problem'],
      ['why is it taking so long', 'problem'],
      ['when will it be ready?', 'when'],
      ['How long will it take?', 'when'],
      ['please tell me when it will be done', 'when'],
      ['what is it doing?', 'doing'],
      ['status', 'doing'],
      ["what's next?", 'next'],
      ['how much has it cost?', 'cost'],
      ['can you tell me the cost', 'cost'],
    ];
    for (const [q, topic] of cases) expect(askTopic(q), q).toEqual({ topic, lang: 'en' });
  });

  it('knows the status questions in Arabic, written any of the usual ways', () => {
    const cases: [string, string][] = [
      ['هل في مشكلة؟', 'problem'],
      ['هل هو عالق؟', 'problem'],
      ['متى يخلص؟', 'when'],
      ['متى يجهز', 'when'],
      ['ابي اعرف متى يخلص', 'when'],
      ['وش يسوي الحين؟', 'doing'],
      ['ما الحالة؟', 'doing'],
      ['ايش الخطوة الجاية؟', 'next'],
      ['كم كلّف؟', 'cost'],
    ];
    for (const [q, topic] of cases) expect(askTopic(q), q).toEqual({ topic, lang: 'ar' });
    expect(plainArabic('أَخْضَرٌ إلى المرحلة')).toBe('اخضر الي المرحله');
  });

  it('knows a request that would change the work, in both languages', () => {
    expect(askTopic('make the capacity number green').topic).toBe('change');
    expect(askTopic('Can you add a search box').topic).toBe('change');
    expect(askTopic('خلي رقم السعة أخضر')).toEqual({ topic: 'change', lang: 'ar' });
    expect(askTopic('أضف زر بحث')).toEqual({ topic: 'change', lang: 'ar' });
  });

  it('never guesses at anything else', () => {
    expect(askTopic('who wrote the login page?').topic).toBe('other');
    expect(askTopic('مين كتب صفحة الدخول؟')).toEqual({ topic: 'other', lang: 'ar' });
  });

  it('reads the language from the letters, so a ticket number does not change it', () => {
    expect(isArabic('RO-7 متى يخلص؟')).toBe(true);
    expect(isArabic('is RO-7 ready?')).toBe(false);
  });
});

describe('the answers in English', () => {
  it('answers "is there a problem?" from the live record, at once', () => {
    const a = ask(building(), 'is there a problem?');
    expect(a).toMatchObject({ lang: 'en', topic: 'problem', instant: true });
    expect(a.lines[0]).toBe('No problem. The Builder is on step 3 of 6 and has worked for 4 minutes. This step usually takes 2 to 4 minutes.');
    expect(a.lines[1]).toMatch(/^Next: the Builder goes on with step 4 of 6\..* I will put it in Waiting for you when it needs you\.$/);
    expect(a.offers.map((o) => o.do)).toEqual(['stop']);
  });

  it('says when it is slow or stopped, instead of "no problem"', () => {
    const slow = building({ clock: { who: 'builder', step: 'build', part: 3, since: ago(900) } });
    slow.quiet = { since: ago(900), kind: 'long', detail: 'The Builder has been on this step for 15 minutes. It usually takes 2 to 4 minutes.' };
    expect(ask(slow, 'is there a problem?').lines[0]).toBe('It is slower than usual, but still working. The Builder has been on this step for 15 minutes. It usually takes 2 to 4 minutes.');
    const stopped = ticket({ waiting: { kind: 'stuck', summary: 'The squad stopped and needs you' }, stuck: { question: 'The checks still fail after 3 tries.', options: [] } });
    expect(ask(stopped, 'is there a problem?').lines).toEqual(['Yes: the squad stopped and needs your decision.', 'The checks still fail after 3 tries.']);
  });

  it('answers when, what, next and cost', () => {
    expect(ask(building(), 'when will it be ready?').lines).toEqual(['Probably in about 16 minutes. Then you will be asked to check the proof.']);
    expect(ask(building(), 'what is it doing?').lines).toEqual(['The Builder is on step 3 of 6: show how many fit.', 'Right now it is editing booking.tsx.']);
    expect(ask(building(), "what's next?").lines[0]).toMatch(/^The Builder goes on with step 4 of 6\./);
    expect(ask(building(), 'how much has it cost?').lines).toEqual(['So far it has cost $1.23 at API prices, over 3 runs.']);
    expect(ask(ticket(), 'how much has it cost?').lines).toEqual(['Nothing is counted yet: no agent has run on this ticket.']);
    const waiting = ticket({ stage: 'review', waiting: { kind: 'proof', summary: 'The proof is ready for you to check' } });
    expect(ask(waiting, 'when will it be ready?').lines).toEqual(['It is waiting for you now: the proof is ready for you to check.']);
  });

  it('offers the two ways a change goes in, and says when the note is read', () => {
    const a = ask(building(), 'make the capacity number green');
    expect(a.instant).toBe(false);
    expect(a.lines).toEqual(['That changes what you approved in the spec. How should it reach the squad?']);
    expect(a.offers).toEqual([
      { do: 'propose', label: 'Propose a change', note: 'The spec is updated, you approve it, and the Builder redoes only what changed.' },
      { do: 'note', label: 'Send it as a note to the Builder', note: 'The Builder reads it when its next step starts, in about a minute.', to: 'builder' },
    ]);
  });

  it('says a note waits when no agent runs, and when it will be read', () => {
    const waiting = ticket({ stage: 'specs', specApproved: undefined, waiting: { kind: 'plan', summary: 'The design is ready' } });
    const note = ask(waiting, 'make it green').offers.find((o) => o.do === 'note')!;
    expect(note).toMatchObject({ label: 'Send it as a note to the squad', note: 'No agent is running now, so nobody reads it yet. The squad reads it when it carries on, after you approve the design.' });
    expect(note).not.toHaveProperty('to');
  });

  it('says the checks are squad-kit\'s own, not an agent\'s', () => {
    const t = ticket({ stage: 'test', live: true, squad: { phase: 'test', nextAt: ago(-60) }, status: 'Running test: npm test', clock: { who: 'squad', step: 'checks', since: ago(70) } });
    expect(ask(t, 'is there a problem?').lines[0]).toBe('No problem. squad-kit is running the checks, for 1 minute so far. They usually take 1 to 3 minutes.');
    expect(ask(t, 'هل في مشكلة؟').lines[0]).toBe('لا توجد مشكلة. squad-kit يشغّل الفحوصات منذ دقيقة واحدة. تستغرق عادة من 1 إلى 3 دقائق.');
    expect(ask(t, 'make it faster').offers.find((o) => o.do === 'note')).toMatchObject({ label: 'Send it as a note to the squad' });
  });

  it('offers a talk with an agent for anything it cannot answer', () => {
    const a = ask(building(), 'who wrote the login page?');
    expect(a.topic).toBe('other');
    expect(a.offers).toEqual([{ do: 'chat', label: 'Ask the Builder', to: 'builder' }]);
  });
});

describe('the answers in Arabic', () => {
  it('answers in Arabic when asked in Arabic', () => {
    const a = ask(building(), 'هل في مشكلة؟');
    expect(a).toMatchObject({ lang: 'ar', topic: 'problem', instant: true });
    expect(a.lines[0]).toBe('لا توجد مشكلة. المطوّر في الخطوة 3 من 6 ويعمل منذ 4 دقائق. هذه الخطوة تستغرق عادة من 2 إلى 4 دقائق.');
    expect(a.offers).toEqual([{ do: 'stop', label: 'أوقف العمل' }]);
  });

  it('answers when, what, next and cost in Arabic', () => {
    expect(ask(building(), 'متى يخلص؟').lines).toEqual(['غالبًا خلال 16 دقيقة تقريبًا. بعدها سنطلب منك مراجعة الصور والموافقة عليها.']);
    expect(ask(building(), 'وش يسوي الحين؟').lines).toEqual(['المطوّر في الخطوة 3 من 6: Show how many fit.', 'الآن يعدّل booking.tsx.']);
    expect(ask(building(), 'ايش الخطوة الجاية؟').lines[0]).toMatch(/^يكمل المطوّر الخطوة 4 من 6/);
    expect(ask(building(), 'كم كلف؟').lines).toEqual(['التكلفة حتى الآن 1.23 دولار بأسعار API، في 3 مرات تشغيل.']);
  });

  it('offers the two ways a change goes in, in Arabic', () => {
    const a = ask(building(), 'خلي رقم السعة أخضر');
    expect(a.lines).toEqual(['هذا يغيّر ما وافقت عليه في المواصفات. كيف تريد أن يصل إلى الفريق؟']);
    expect(a.offers.map((o) => o.label)).toEqual(['اقترح تعديلًا', 'أرسلها ملاحظة إلى المطوّر']);
    expect(a.offers[1]).toMatchObject({ note: 'يقرؤها المطوّر عند بدء خطوته التالية، خلال دقيقة تقريبًا.' });
  });

  it('says in Arabic that a note waits when no agent runs', () => {
    const waiting = ticket({ stage: 'review', waiting: { kind: 'proof', summary: 'The proof is ready' } });
    const note = ask(waiting, 'غير لون الزر').offers.find((o) => o.do === 'note')!;
    expect(note).toMatchObject({ note: 'لا يعمل أي وكيل الآن، فلن يقرأها أحد بعد. سيقرؤها الفريق عندما يتابع العمل، بعد مراجعة الصور والموافقة عليها.' });
  });

  it('offers an agent in Arabic for anything else', () => {
    const a = ask(building(), 'مين كتب صفحة الدخول؟');
    expect(a.offers).toEqual([{ do: 'chat', label: 'اسأل المطوّر', to: 'builder' }]);
  });

  it('counts minutes the Arabic way', () => {
    expect(arMinutes(60)).toBe('دقيقة واحدة');
    expect(arMinutes(120)).toBe('دقيقتين');
    expect(arMinutes(240)).toBe('4 دقائق');
    expect(arMinutes(900)).toBe('15 دقيقة');
    expect(arIn(30)).toBe('خلال دقيقة تقريبًا');
    expect(arIn(360)).toBe('خلال 6 دقائق تقريبًا');
  });
});
