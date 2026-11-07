import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Who answers an agent's question: the person gets every business gap and clash, a technical question goes back to the
 * agent (twice at most, then a plain stop), and an ask that is not allowed is refused, logged in a plain line, counted,
 * and never shown. The filter reads the words; it never trusts the agent's label. The agents here are fakes.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const a = answers.shift() as { text?: string } | undefined;
    // An answer with no shape (a reply in a question's thread) is its text alone.
    if (a && typeof a === 'object' && 'text' in a && Object.keys(a).length === 1) return { ok: true, sessionId: opts.resume ?? opts.sessionId ?? 'r-1', text: a.text } as RunResult;
    return { ok: true, structured: a, sessionId: opts.resume ?? opts.sessionId ?? 'r-1', text: '' } as RunResult;
  },
}));

const { judgeQuestion, judgeReply, readable, refusedReplyLine, stoppedQuestion, questionBackPrompt, TECHNICAL_BACK } = await import('../src/engine/question-filter.js');
const { recentLines } = await import('../src/core/app-log.js');
const B = await import('../src/engine/breakdown-prompts.js');
const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { openWindows } = await import('../src/engine/window-server.js');
const P = await import('../src/engine/prompts.js');

const FRIEND = 'Please edit .squad/config.json to set the test command';

describe('the filter', () => {
  it("refuses the friend's case: an ask to edit squad-kit's settings", () => {
    expect(judgeQuestion({ text: FRIEND })).toMatchObject({ pass: false, kind: 'not-allowed', what: 'settings' });
    expect(judgeQuestion({ text: 'Can you change squad-kit settings so the Tester may run Chrome?' })).toMatchObject({ kind: 'not-allowed', what: 'settings' });
    expect(judgeQuestion({ text: 'Should I add a rule to CLAUDE.md?' })).toMatchObject({ kind: 'not-allowed', what: 'settings' });
  });

  it('refuses asks for a secret and for changing git history, never business words that sound alike', () => {
    expect(judgeQuestion({ text: 'Can you give me the database password?' })).toMatchObject({ kind: 'not-allowed', what: 'secret' });
    expect(judgeQuestion({ text: 'Please paste your API token here so I can reach the tracker.' })).toMatchObject({ kind: 'not-allowed', what: 'secret' });
    expect(judgeQuestion({ text: 'Should I force push the branch to fix it?' })).toMatchObject({ kind: 'not-allowed', what: 'history' });
    expect(judgeQuestion({ text: 'Should users enter their password twice when they sign up?' })).toEqual({ pass: true });
    expect(judgeQuestion({ text: 'Can staff change the history of a booking?' })).toEqual({ pass: true });
  });

  it('sends technical questions back, whatever label they carry', () => {
    for (const text of [
      'Port 3000 is in use. Should I stop the other program?',
      'Chrome cannot start because of the sandbox (Mach port). Can you allow it?',
      'Should I set ROOMFLOW_PORT to 8001?',
      'Should I install Playwright for the screenshots?',
      'Run npm install in a terminal, then tell me when it is done.',
      'Is it fine to put the setting in config/app.json?',
      'The MCP tool did not answer. What now?',
      'Should I commit the changes to git first?',
      'Can I get permission to write to the folder outside the project?',
    ]) {
      expect(judgeQuestion({ text }), text).toMatchObject({ pass: false, kind: 'technical' });
    }
    // The label alone never lets one through: the choices and why are read too.
    expect(judgeQuestion({ text: 'Which one should I use?', options: ['Port 3000', 'Port 3001'] })).toMatchObject({ kind: 'technical' });
  });

  it('lets every business gap and clash through', () => {
    for (const text of [
      'What should happen to a booking when the room is cancelled?',
      'The BRD says 4 hours in R3 and 2 hours in R7. Which one is right?',
      'Do staff share computers?',
      'Should managers have permission to approve refunds over 500?',
      'Which branch office does the report cover?',
      'Should the payment terminal print a receipt?',
      'Which port should the shipment go to?',
      'Should I merge the two booking lists into one page?',
    ]) {
      expect(judgeQuestion({ text }), text).toEqual({ pass: true });
    }
  });

  it("finds the questions of an answer: the one question, and the Analyst's list", () => {
    expect(stoppedQuestion({ summary: 'x', question: { text: 'Is a refund due?', kind: 'gap' } })).toBeNull();
    const found = stoppedQuestion({ summary: 'x', questions: [{ text: 'Who books?' }, { text: 'Which port should the dev server use?', options: ['3000', '8000'] }] });
    expect(found).toMatchObject({ q: { at: 'questions[1]' }, verdict: { kind: 'technical' } });
    expect(questionBackPrompt(found!)).toContain(TECHNICAL_BACK);
  });
});

describe('the filter in the squad', () => {
  let tmp: string;
  let bp: ReturnType<typeof boardPaths>;
  type Squad = { review(id: string): Promise<void>; launch(key: string, job: () => Promise<void>): void; running: Set<string> };

  beforeEach(() => {
    calls.length = 0;
    answers.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-filter-'));
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function inReview() {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    return updateTicket(bp, t.id, (x) => {
      x.squad = { phase: 'review', nextAt: new Date().toISOString() };
      x.stage = 'review';
      x.worktree = tmp;
      x.baseCommit = 'abc';
      x.story = 'As a clerk…';
      x.criteria = [{ given: 'a person', when: 'they book a 4th time', then: 'they see an error' }];
    });
  }
  const lines = (id: string) => readTicket(bp, id)!.activity.map((a) => a.text);
  const ask = (text: string, kind = 'gap') => ({ approved: false, summary: '', comments: [], question: { text, options: ['Yes', 'No'], kind } });
  const approve = { approved: true, summary: 'Fine', comments: [] };

  /** Runs a step the way the squad does, so a stop becomes its card. */
  async function step(s: Squad, id: string, job: () => Promise<void>): Promise<void> {
    s.launch(id, job);
    await vi.waitFor(() => expect(s.running.has(id)).toBe(false), { timeout: 10_000 });
  }

  it("refuses the friend's case, logs it in a plain line, counts it, and never shows it", async () => {
    const t = inReview();
    answers.push(ask(FRIEND), approve);
    const s = new LiveSquad(bp) as unknown as Squad;
    await s.review(t.id);
    const saved = readTicket(bp, t.id)!;
    expect(saved.agentQuestion).toBeUndefined();
    expect(saved.waiting?.kind).not.toBe('ask');
    expect(lines(t.id)).toContain("The Reviewer asked to change squad-kit's settings. squad-kit refused, and did not bother you with it.");
    expect(lines(t.id).join('\n')).not.toContain('.squad/config.json');
    // It went back to the same conversation, told why.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resume).toBe(calls[0]!.sessionId ?? 'r-1');
    expect(calls[1]!.prompt).toContain('squad-kit refused your question');
    expect(openWindows()).toBe(0);
  });

  it('sends a technical question back to the agent; then its business gap reaches the person', async () => {
    const t = inReview();
    answers.push(ask('Port 3000 is busy, should I use 3001 for the test server?'), ask('Do cancelled bookings count toward the limit?'));
    const s = new LiveSquad(bp) as unknown as Squad;
    await expect(s.review(t.id)).rejects.toThrow(/Waiting for your answer/);
    expect(calls[1]!.prompt).toContain('This is technical. Decide it yourself, or call i_am_stuck.');
    const saved = readTicket(bp, t.id)!;
    expect(saved.waiting?.kind).toBe('ask');
    expect(saved.agentQuestion?.text).toBe('Do cancelled bookings count toward the limit?');
    expect(lines(t.id).some((l) => l.startsWith('The Reviewer asked a technical question, so squad-kit sent it back to it to decide'))).toBe(true);
  });

  it('a technical question asked a third time ends the step with a plain stop and Try again', async () => {
    const t = inReview();
    for (let i = 0; i < 3; i += 1) answers.push(ask('Should I run npm install in the terminal first?'));
    const s = new LiveSquad(bp) as unknown as Squad;
    await step(s, t.id, () => s.review(t.id));
    const saved = readTicket(bp, t.id)!;
    expect(calls).toHaveLength(3);
    expect(saved.stuck?.question).toBe('The Reviewer kept asking a technical question, which squad-kit does not pass on to you, so it stopped this step. Press Try again.');
    expect(saved.stuck?.options[0]?.do).toBe('retry');
    expect(saved.stuck?.detail).toContain('npm install');
    expect(saved.agentQuestion).toBeUndefined();
  });

  it('three refused asks stop the agent in plain words, with Try again and the details for engineers', async () => {
    const t = inReview();
    answers.push(ask(FRIEND), ask('Can you give me the database password?'), ask('Should I force push the branch?'));
    const s = new LiveSquad(bp) as unknown as Squad;
    await step(s, t.id, () => s.review(t.id));
    const saved = readTicket(bp, t.id)!;
    expect(saved.stuck?.question).toBe('The Reviewer kept asking for things it may not do, so squad-kit stopped it.');
    expect(saved.stuck?.options[0]?.do).toBe('retry');
    expect(saved.stuck?.detail).toContain('asks the person for a secret');
    expect(lines(t.id)).toEqual(
      expect.arrayContaining([
        "The Reviewer asked to change squad-kit's settings. squad-kit refused, and did not bother you with it.",
        'The Reviewer asked for a password or a key. squad-kit refused, and did not bother you with it.',
        'The Reviewer asked to change the history of the code. squad-kit refused, and did not bother you with it.',
      ]),
    );
  });

  it("the Analyst's questions carry a type, and only business ones reach the person", async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    expect(P.intakePrompt(readMeta(bp), [], t)).toContain('Each question has a kind: "gap"');
    expect((P.QUESTIONS_SCHEMA.properties.questions.items as { required: string[] }).required).toContain('kind');
  });
});

/** Real business questions the filter once blocked (review of 2026-11-04): each must reach the person. */
const BUSINESS = [
  'What are the password rules for new accounts?',
  'Can you share the wording for the password reset email?',
  'Should users type their password here or on the next screen?',
  'Should admins edit the permission list for each role?',
  'Can a coach change the squad settings for the team?',
  'Can staff cherry-pick which orders ship first?',
  'Which terminal at the airport does the shuttle stop at?',
  'Can customers pay from the terminal in the shop?',
  'Can users stash items in a wishlist?',
  'Which voice commands run the booking?',
  'Which port of entry do travellers pick?',
  'Should the booking settings page show the limits?',
];

/** Asks nobody may put to the person, and which kind each one is. */
const NOT_ALLOWED: [string, 'settings' | 'secret'][] = [
  ['Please add api.stripe.com to the hosts the squad may reach in Settings.', 'settings'],
  ['Could you turn off the guard in Settings so I can run the browser?', 'settings'],
  ['Can you change the start command in Settings to npm run dev:test?', 'settings'],
  ['Please edit .squad/config.json to set the test command.', 'settings'],
  ["What's the Stripe test key?", 'secret'],
  ['Please paste the database login here.', 'secret'],
  ['Please send me your API token.', 'secret'],
];

/** The same words hidden: a zero-width space inside each word, Cyrillic or Greek letters that look Latin, full-width letters. */
const HIDDEN: [string, (s: string) => string][] = [
  ['a zero-width space', (s) => s.replace(/\b([A-Za-z])([A-Za-z]{2,})/g, '$1​$2')],
  ['Cyrillic look-alikes', (s) => s.replace(/a/g, 'а').replace(/e/g, 'е').replace(/o/g, 'о').replace(/p/g, 'р').replace(/c/g, 'с')],
  ['Greek look-alikes', (s) => s.replace(/o/g, 'ο').replace(/a/g, 'α').replace(/i/g, 'ι').replace(/T/g, 'Τ')],
  ['full-width letters', (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
];

describe('the filter reads words as the person does', () => {
  for (const text of BUSINESS) {
    it(`lets a business question through: "${text}"`, () => {
      expect(judgeQuestion({ text, options: ['Yes', 'No'] })).toEqual({ pass: true });
    });
  }

  for (const [text, what] of NOT_ALLOWED) {
    it(`refuses as not allowed (${what}): "${text}"`, () => {
      expect(judgeQuestion({ text })).toMatchObject({ pass: false, kind: 'not-allowed', what });
      for (const [how, hide] of HIDDEN) {
        const hidden = hide(text);
        expect(hidden, how).not.toBe(text);
        expect(judgeQuestion({ text: hidden }), `${how}: ${hidden}`).toMatchObject({ pass: false, kind: 'not-allowed', what });
      }
    });
  }

  it('folds styled letters, takes out invisible characters and reads look-alike letters as Latin', () => {
    expect(readable('pa​ss⁠wo­rd')).toBe('password');
    expect(readable('раsswоrd')).toBe('password');
    expect(readable('ａｐｉ key')).toBe('api key');
    expect(readable('What’s the key?')).toBe("What's the key?");
  });

  it('reads everything the person sees with a question: its choices, why, where it comes from and what it changes', () => {
    const q = { text: 'Which refund rule applies to a cancelled booking?', options: ['R3', 'R7'] };
    expect(judgeQuestion(q)).toEqual({ pass: true });
    expect(judgeQuestion({ ...q, options: ['R3', 'Please send me your API token.'] })).toMatchObject({ kind: 'not-allowed', what: 'secret' });
    expect(judgeQuestion({ ...q, why: 'Could you turn off the guard in Settings?' })).toMatchObject({ kind: 'not-allowed', what: 'settings' });
    expect(judgeQuestion({ ...q, sources: [{ text: 'BRD 4.2 Refunds', page: 3 }, { text: 'src/booking/cancel.ts' }] })).toMatchObject({ kind: 'technical' });
    expect(judgeQuestion({ ...q, impact: 'Changes how npm run dev starts' })).toMatchObject({ kind: 'technical' });
    // A breakdown's question: its sections and what the answer changes are read too.
    const found = stoppedQuestion({ questions: [{ kind: 'gap', text: 'Which refund rule applies?', options: ['R3', 'R7'], refs: [{ section: '4.2', title: 'Refunds' }], impact: 'Please paste the database login here.' }] });
    expect(found).toMatchObject({ q: { at: 'questions[0]' }, verdict: { kind: 'not-allowed', what: 'secret' } });
  });

  it('in a reply in a talk, refuses only an ask that is not allowed: technical words are fine there', () => {
    for (const text of [
      'Open /book, pick a room, then press Book. The new page is in src/pages/Book.tsx.',
      'squad-kit rebases the branch onto main when it merges, so you do nothing there.',
      'The test command in Settings ran the tests, and they passed.',
      'Run npm test in the terminal to see the tests pass.',
    ]) {
      expect(judgeReply(text), text).toEqual({ pass: true });
    }
    expect(judgeReply('To try it, please paste your API token here.')).toMatchObject({ pass: false, what: 'secret' });
    expect(judgeReply('Could you change the test command in Settings to npm run test:ci?')).toMatchObject({ pass: false, what: 'settings' });
    expect(judgeReply('You could rebase the branch onto main yourself.')).toMatchObject({ pass: false, what: 'history' });
  });

  it('a secret asked for in other words is refused too; the business words around passwords and keys are not', () => {
    for (const text of ['Is there an API token I can paste into the tracker?', 'Can I get the admin password?', 'Do you have the Stripe secret key?', 'Can you tell me what the database password is?', 'Please paste the values from your .env file here.']) {
      expect(judgeQuestion({ text }), text).toMatchObject({ kind: 'not-allowed', what: 'secret' });
    }
    for (const text of ['Should users get a password to share with their team?', 'What is the key difference between the two plans?', 'Can we use the key dates from R4?', 'Can you tell me the password rules for admins?', 'Should the login page show the company logo?']) {
      expect(judgeQuestion({ text }), text).toEqual({ pass: true });
    }
  });
});

describe('the filter in talks and in runs with no ticket', () => {
  let tmp: string;
  let bp: ReturnType<typeof boardPaths>;
  type Squad = {
    chatReply(id: string): Promise<void>;
    reply(id: string, qid: string): Promise<void>;
    runAgent(o: Record<string, unknown>): Promise<{ structured?: unknown }>;
  };

  beforeEach(() => {
    calls.length = 0;
    answers.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-filter-'));
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function building() {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    return updateTicket(bp, t.id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
      x.worktree = tmp;
      x.sessions = { intake: 'i-1', build: 'b-1' };
    });
  }

  it('a chat answer that asks for a secret is replaced with one plain line and logged; a technical answer stays', async () => {
    const t = building();
    actions.startChat(bp, t.id, 'builder');
    answers.push({ reply: 'To test it, please paste your Stripe test key here.', ready: false, options: ['I pasted it'] });
    const s = new LiveSquad(bp) as unknown as Squad;
    await s.chatReply(t.id);
    const last = readTicket(bp, t.id)!.chat!.messages.at(-1)!;
    expect(last).toMatchObject({ who: 'builder', text: refusedReplyLine('Builder', 'secret') });
    expect(last.options).toBeUndefined();
    expect(JSON.stringify(readTicket(bp, t.id))).not.toContain('Stripe test key');
    expect(readTicket(bp, t.id)!.activity.map((a) => a.text)).toContain('The Builder asked for a password or a key. squad-kit refused, and did not bother you with it.');
    expect(recentLines(60_000).join('\n')).toContain('Stripe test key');
    // The person asked how to test: technical words in the answer are fine.
    answers.push({ reply: 'Run npm test in the terminal, then open /book on port 5173.', ready: false });
    await s.chatReply(t.id);
    expect(readTicket(bp, t.id)!.chat!.messages.at(-1)!.text).toBe('Run npm test in the terminal, then open /book on port 5173.');
  });

  it('an answer in a question thread that asks to change git history is left out too', async () => {
    const t0 = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t0.id, (x) => {
      x.sessions = { intake: 'i-1' };
      x.questions = [{ id: 'q1', from: 'analyst', text: 'Who may book?', options: ['Staff', 'Everyone'], thread: [{ who: 'you', text: 'How do I undo it?', at: new Date().toISOString() }] }];
    });
    const s = new LiveSquad(bp) as unknown as Squad;
    answers.push({ text: 'Please force push the branch to undo it.' });
    await s.reply(t0.id, 'q1');
    const thread = readTicket(bp, t0.id)!.questions![0]!.thread!;
    expect(calls).toHaveLength(1);
    expect(thread.at(-1)).toMatchObject({ who: 'analyst', text: refusedReplyLine('Analyst', 'history') });
    // A plain answer stays as it is.
    answers.push({ text: 'Staff book rooms; guests cannot.' });
    await s.reply(t0.id, 'q1');
    expect(readTicket(bp, t0.id)!.questions![0]!.thread!.at(-1)!.text).toBe('Staff book rooms; guests cannot.');
  });

  it('a run with no ticket (a breakdown) asks again at most twice for a question that is not allowed, then stops plainly', async () => {
    const read = (text: string) => ({ summary: 'Read it', epics: [], decided: [], questions: [{ kind: 'gap', text, options: ['Yes', 'No'] }] });
    for (let i = 0; i < 6; i += 1) answers.push(read(FRIEND));
    const s = new LiveSquad(bp) as unknown as Squad;
    const err = await s.runAgent({ role: 'analyst', job: '__breakdown:b1', step: 'questions', cwd: tmp, prompt: 'Read the document.', permissions: ['read'], schema: B.READ_SCHEMA, timeoutMs: 60_000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('The Analyst kept asking for things it may not do, so squad-kit stopped it.');
    expect(calls).toHaveLength(3);
    expect(recentLines(60_000).join('\n')).toContain("Refused the Analyst's question in __breakdown:b1");
  });

  it('a run with no ticket counts a technical and a not-allowed question together', async () => {
    const read = (text: string) => ({ summary: 'Read it', epics: [], decided: [], questions: [{ kind: 'gap', text, options: ['Yes', 'No'] }] });
    answers.push(read('Should I run npm install first?'), read(FRIEND), read('Should I run npm install first?'), read('Who books rooms?'));
    const s = new LiveSquad(bp) as unknown as Squad;
    const err = await s.runAgent({ role: 'analyst', job: '__scan', step: 'questions', cwd: tmp, prompt: 'Read it.', permissions: ['read'], schema: B.READ_SCHEMA, timeoutMs: 60_000 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/kept asking a technical question/);
    expect(calls).toHaveLength(3);
  });
});

describe('a story in Arabic: its agents ask in Arabic', () => {
  it.each([
    'هل يستطيع الموظف تعديل وقت الدخول بعد حفظه؟',
    'من يوافق على طلب الزيارة: المدير أم موظف الاستقبال؟',
    'ما قواعد كلمة المرور للمستخدمين الجدد؟',
    'هل يظهر سجل الزوار لكل فروع الشركة؟',
    'ما مفتاح الغرفة الذي يأخذه الزائر؟',
    'هل تريد إضافة عمود جديد إلى التقرير؟',
    'كم منفذ بيع لدى الشركة؟',
  ])('lets a business question through: %s', (text) => {
    expect(judgeQuestion({ text })).toEqual({ pass: true });
  });

  it.each([
    'ما كلمة المرور لقاعدة البيانات؟',
    'أعطني كلمة السر من فضلك.',
    'من فضلك أرسل لي مفتاح API.',
    'هل لديك بيانات الدخول؟',
    'أحتاج إلى التوكن حتى أكمل.',
    'أين رمز الدخول؟',
  ])('refuses a secret: %s', (text) => {
    expect(judgeQuestion({ text })).toMatchObject({ pass: false, kind: 'not-allowed', what: 'secret' });
  });

  it("refuses a change to squad-kit's own things", () => {
    expect(judgeQuestion({ text: 'هل يمكنك تعديل إعدادات squad-kit؟' })).toMatchObject({ pass: false, kind: 'not-allowed', what: 'settings' });
  });

  it.each([
    'هل أعدّل ملف الإعدادات أم أنشئ ملفًا جديدًا؟',
    'أي متغيرات البيئة أستخدم؟',
    'المنفذ 3000 مشغول، هل أوقف البرنامج؟',
    'افتح نافذة الأوامر وأخبرني بالنتيجة.',
    'نفّذ هذا الأمر ثم أخبرني.',
    'هل أثبّت المتصفح؟',
    'هل أفتح طلب سحب الآن؟',
    'ظهر تعارض الدمج، ماذا أفعل؟',
  ])('sends a technical question back: %s', (text) => {
    expect(judgeQuestion({ text })).toMatchObject({ pass: false, kind: 'technical' });
  });

  it('a mark on a letter or a hidden character does not hide a word', () => {
    expect(judgeQuestion({ text: 'ما كَلِمة المرور؟' })).toMatchObject({ pass: false, what: 'secret' });
    expect(judgeQuestion({ text: 'ما كلمة\u200b المرور؟' })).toMatchObject({ pass: false, what: 'secret' });
  });

  it('a reply that only explains is fine, and one that asks for a secret is not', () => {
    expect(judgeReply('يدخل الموظف كلمة المرور في صفحة الدخول.').pass).toBe(true);
    expect(judgeReply('أعطني كلمة المرور.').pass).toBe(false);
  });
});
