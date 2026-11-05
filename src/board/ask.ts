import type { AgentName, Ticket, TimedStep, WaitingKind } from './types.js';
import { WHO, slowAfter } from './clock.js';
import { inAbout, type LiveNow } from './now.js';
import { minutesWords, middle, usualOf, type Usual, type UsualBook } from './usual.js';
import { costWords, totalOf } from './usage.js';

/**
 * "Ask about this ticket": status questions are answered at once from the ticket's live record, in the language of
 * the question, with no AI cost. The matching is plain word lists, so it never guesses: anything it does not know
 * offers a talk with an agent instead, and anything that would change the work offers the two ways a change goes in.
 */

export type AskTopic = 'problem' | 'when' | 'doing' | 'next' | 'cost' | 'change' | 'other';
export type AskLang = 'en' | 'ar';

/** A way on that an answer offers. Each one is a button on the board and a command in the terminal. */
export type AskOffer =
  | { do: 'propose'; label: string; note: string }
  | { do: 'note'; label: string; note: string; to?: AgentName }
  | { do: 'chat'; label: string; to: AgentName }
  | { do: 'stop'; label: string };

export interface AskAnswer {
  lang: AskLang;
  topic: AskTopic;
  /** Answered from the live record at once, with no AI cost. */
  instant: boolean;
  lines: string[];
  offers: AskOffer[];
}

/* ── Which question it is ──────────────────────────────── */

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;

/** Arabic when most of its letters are Arabic. */
export function isArabic(text: string): boolean {
  const ar = text.match(ARABIC)?.length ?? 0;
  const la = text.match(/[A-Za-z]/g)?.length ?? 0;
  return ar > 0 && ar >= la;
}

/** Arabic written several ways reads as one: no vowel marks or stretching, one alef, ha for ta marbuta, ya for alef maqsura. */
export function plainArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const EN_POLITE = /^(please\s+)?((can|could|would) you\s+)?(please\s+)?(tell me|let me know|show me|do you know|i want to know|i'd like to know)\s+/;
const EN_DO = /^(make|change|add|remove|delete|use|put|rename|move|show|hide|replace|set|turn|fix|update|switch|include|drop|give|let|don't|dont|do not|never|always|write|create)\b/;
const EN_ASK = /\b(i want|i'd like|i would like|we need|we want|it should|they should|can you|could you|would you|please)\b/;
const EN: [Exclude<AskTopic, 'change' | 'other'>, RegExp][] = [
  ['cost', /\b(cost|costs|costing|spend|spent|spending|price|money|bill|budget|tokens?|dollars?)\b|\$|how much (has|did|does|is|will)\b/],
  ['problem', /\b(problems?|issues?|wrong|stuck|broken|errors?|fail|failed|failing|ok|okay|fine|alright|all right|slow|hang|hanging|hung|blocked|trouble|not working|(so|too) long|taking (so )?long)\b/],
  ['when', /\b(when|how long|eta|ready|finish|finished|done|time left|soon|how much longer|how many minutes|take)\b/],
  ['next', /\b(next|after this|after that|then what|what comes|coming up)\b/],
  ['doing', /\b(doing|working|status|progress|where is|where's|happening|happened|up to|right now|how('s| is) it going|what (did|has) (it|he|she|they))\b/],
];

const AR_POLITE = /^(لو سمحت|من فضلك|رجاء)?\s*(ممكن\s+)?(تقول لي|تقولي|قل لي|قول لي|قلي|خبرني|اخبرني|ابي اعرف|ابغي اعرف|ابغا اعرف|اريد ان اعرف|اريد اعرف|ودي اعرف)\s+/;
const AR_DO = /^(خل|خلي|خليه|غير|اضف|ضيف|زود|احذف|شيل|امسح|حط|ضع|اجعل|بدل|عدل|سو|سوي|اكتب|ابي|ابغي|ابغا|اريد|نبي|نبغي|لازم|يجب|ممكن|استخدم|اعرض|اخف)(\s|$)/;
const AR: [Exclude<AskTopic, 'change' | 'other'>, RegExp][] = [
  ['cost', /(تكلف|كلف|تكاليف|سعر|فلوس|مصاريف|مصروف|صرف|دفع|توكن|دولار)/],
  ['when', /(متي|امتي|ايمتي|كم باقي|كم يحتاج|كم ياخذ|كم وقت|كم دقيقه|يخلص|تخلص|خلص|ينتهي|تنتهي|انتهي|جاهز|يجهز|تجهز)/],
  ['problem', /(مشكل|عالق|معلق|واقف|متوقف|خطا|غلط|تمام|سليم|بطي|متاخر|طول|طولت|عطل|خربان|في شي|فيه شي)/],
  ['next', /(التالي|التاليه|الجاي|الجايه|القادم|القادمه|بعدين|بعد كذا|بعد ذلك|بعدها|وش بعد|ايش بعد|شو بعد)/],
  ['doing', /(يسوي|تسوي|يعمل|تعمل|يشتغل|تشتغل|يفعل|تفعل|الحاله|وين وصل|فين وصل|وصل لوين|وش يصير|ايش يصير|شو عم|الحين|حاليا)/],
];

/** What a question asks, from plain word lists in English and Arabic. */
export function askTopic(text: string): { topic: AskTopic; lang: AskLang } {
  if (isArabic(text)) {
    const s = plainArabic(text).replace(/[؟?!.،,]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = s.replace(AR_POLITE, '');
    if (q !== s) return { topic: AR.find(([, re]) => re.test(q))?.[0] ?? 'other', lang: 'ar' };
    if (AR_DO.test(q)) return { topic: 'change', lang: 'ar' };
    return { topic: AR.find(([, re]) => re.test(q))?.[0] ?? 'other', lang: 'ar' };
  }
  const s = text.toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const q = s.replace(EN_POLITE, '');
  if (q === s && EN_DO.test(q)) return { topic: 'change', lang: 'en' };
  const found = EN.find(([, re]) => re.test(q))?.[0];
  if (found) return { topic: found, lang: 'en' };
  return { topic: q === s && EN_ASK.test(q) ? 'change' : 'other', lang: 'en' };
}

/* ── Arabic words ──────────────────────────────────────── */

const WHO_AR: Record<AgentName | 'squad', string> = {
  analyst: 'المحلل',
  architect: 'المعماري',
  builder: 'المطوّر',
  reviewer: 'المراجع',
  tester: 'المختبِر',
  squad: 'squad-kit',
};

/** What the person does next, as a noun phrase: "after approving the spec". */
const YOUR_PART_AR: Record<WaitingKind, string> = {
  questions: 'الإجابة على الأسئلة',
  spec: 'الموافقة على المواصفات',
  plan: 'الموافقة على التصميم',
  proof: 'مراجعة الصور والموافقة عليها',
  stuck: 'اختيار طريقة للمتابعة',
  release: 'إصدار النسخة',
  ask: 'الإجابة على السؤال',
  yours: 'إعادة التذكرة إلى الفريق',
  chat: 'إنهاء المحادثة',
  change: 'البت في تحديث التصميم',
  depends: 'اختيار طريقة البناء',
};

/** The English "what it needs you for" of the live record, in Arabic. */
const NEED_AR: Record<string, string> = {
  'answer its questions, or approve the spec': 'الإجابة على أسئلته أو الموافقة على المواصفات',
  'approve the spec': 'الموافقة على المواصفات',
  'approve the design': 'الموافقة على التصميم',
  'check the proof': 'مراجعة الصور والموافقة عليها',
};

/** "دقيقة واحدة", "دقيقتين", "4 دقائق", "14 دقيقة". */
export function arMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m === 1) return 'دقيقة واحدة';
  if (m === 2) return 'دقيقتين';
  return m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
}

/** "خلال 6 دقائق تقريبًا". */
export function arIn(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m <= 1 ? 'خلال دقيقة تقريبًا' : `خلال ${arMinutes(seconds)} تقريبًا`;
}

/** "من 2 إلى 6 دقائق", "حوالي دقيقة", "أقل من دقيقة". */
function arRange(u: Pick<Usual, 'low' | 'high'>): string {
  if (u.high < 60) return 'أقل من دقيقة';
  const low = Math.max(1, Math.round(u.low / 60));
  const high = Math.max(low, Math.round(u.high / 60));
  if (low === high) return `حوالي ${arMinutes(low * 60)}`;
  return `من ${low} إلى ${high} ${high <= 10 ? 'دقائق' : 'دقيقة'}`;
}

const VERB_AR: [RegExp, string][] = [
  [/^editing /, 'يعدّل '],
  [/^reading /, 'يقرأ '],
  [/^writing /, 'يكتب '],
  [/^running /, 'يشغّل '],
  [/^searching for /, 'يبحث عن '],
  [/^looking for /, 'يبحث عن '],
  [/^looking up /, 'يبحث في '],
  [/^listing /, 'يستعرض '],
];

function doingAr(doing: string): string {
  for (const [re, ar] of VERB_AR) if (re.test(doing)) return doing.replace(re, ar);
  return doing;
}

const SENTENCE_AR: Record<TimedStep, string> = {
  questions: 'المحلل يقرأ التذكرة ليعرف ما يحتاج أن يسألك عنه.',
  spec: 'المحلل يكتب المواصفات: القصة وشروط الإنجاز.',
  design: 'المعماري يختار طريقة البناء ويكتب التصميم.',
  build: 'المطوّر يكتب الكود.',
  fix: 'المطوّر يصلح ما وجدته الفحوصات أو المراجع.',
  checks: 'squad-kit يشغّل فحوصات المشروع بنفسه، فلا يقيّم الفريق عمله بنفسه.',
  review: 'المراجع، وهو وكيل جديد، يقرأ التغييرات.',
  proof: 'المختبِر يفتح التطبيق ويلتقط صورة لكل شرط إنجاز.',
};

function screens(t: Ticket): boolean {
  return (t.work?.screens ?? 0) > 0;
}

/** Builds by itself: the work is accepted and merged with no one pressing Looks right. */
const MERGES_AR = 'يقبل الفريق العمل ويدمجه تلقائيًا.';

function thenAr(t: Ticket, now: LiveNow): string {
  const shots = screens(t) ? '، ثم يلتقط المختبِر صورة لكل شرط إنجاز' : '';
  const ready = t.track === 'auto' ? MERGES_AR : 'الإثبات جاهز لتراجعه.';
  const p = now.part;
  switch (now.step) {
    case 'questions':
      return 'سيسألك المحلل عما يحتاج معرفته، أو يكتب المواصفات مباشرة.';
    case 'spec':
      return 'تقرأ المواصفات وتوافق عليها، ثم يكتب المعماري التصميم.';
    case 'design':
      return t.track === 'express'
        ? 'المسار السريع: تُعتمد الخطة تلقائيًا، ثم يبدأ المطوّر وتليه الفحوصات والمراجعة.'
        : t.track === 'auto'
          ? 'مسار «Builds by itself»: تُعتمد الخطة تلقائيًا، ثم يبدأ المطوّر وتليه الفحوصات والمراجعة.'
          : 'تقرأ التصميم وتوافق عليه، ثم يبدأ المطوّر.';
    case 'build':
      return p && p.n < p.of ? `يكمل المطوّر الخطوة ${p.n + 1} من ${p.of}، ثم تعمل الفحوصات تلقائيًا ويقرأ مراجع جديد العمل${shots}.` : `تعمل الفحوصات تلقائيًا ويقرأ مراجع جديد العمل${shots}.`;
    case 'fix':
      return `تعمل الفحوصات مرة أخرى تلقائيًا، ثم يقرأ المراجع العمل${shots}.`;
    case 'checks':
      return `يقرأ المراجع، وهو وكيل جديد، التغييرات${shots}.`;
    case 'review':
      return screens(t) ? 'يلتقط المختبِر صورة لكل شرط إنجاز.' : ready;
    default:
      return ready;
  }
}

/* ── When a note is read ───────────────────────────────── */

function noteLeft(now: LiveNow): number {
  return now.usual ? Math.max(60, middle(now.usual) - (now.seconds ?? 0)) : 60;
}

/** When a note sent now is read, in Arabic. The English sentence is on the live record. */
export function noteWhenAr(t: Ticket, now: LiveNow): string {
  const none = 'لا يعمل أي وكيل الآن، فلن يقرأها أحد بعد.';
  switch (now.state) {
    case 'working':
      if (now.role === 'squad') return `squad-kit يشغّل الفحوصات الآن. يقرؤها الوكيل التالي عند بدء خطوته، ${arIn(noteLeft(now))}.`;
      return `يقرؤها ${WHO_AR[now.role ?? 'builder']} عند بدء خطوته التالية، ${arIn(noteLeft(now))}.`;
    case 'you':
      return `${none} سيقرؤها الفريق عندما يتابع العمل، بعد ${t.waiting ? YOUR_PART_AR[t.waiting.kind] : YOUR_PART_AR.yours}.`;
    case 'queued':
      return `${none} التذكرة التالية في الدور: سيقرؤها الفريق عند توفر مكان وبدء خطوتها.`;
    case 'stopping':
      return 'الفريق يتوقف الآن، وسيقرؤها عند متابعة العمل.';
    case 'ready':
    case 'done':
      return 'العمل مقبول، فلا يعمل عليه أي وكيل بعد الآن. تبقى الملاحظة في التذكرة للسجل.';
    default:
      return `${none} سيقرؤها الفريق عند بدء العمل على التذكرة.`;
  }
}

/* ── The answers ───────────────────────────────────────── */

/** A change can go through the spec once there is an approved spec to change, or the work is accepted. */
function canPropose(t: Ticket): boolean {
  return t.stage === 'release' || t.stage === 'done' || Boolean(t.specApproved) || ['implement', 'test', 'review'].includes(t.stage);
}

/** The agent a talk or a note goes to: the one working now, else the Analyst. */
function agentOf(now: LiveNow): AgentName {
  return now.role && now.role !== 'squad' ? now.role : 'analyst';
}

function slowNow(now: LiveNow, book: UsualBook, t: Ticket): boolean {
  if (now.slow) return true;
  if (!now.step || !now.role || now.seconds === undefined) return false;
  return now.seconds >= slowAfter(usualOf(book, now.role, now.step, t.track));
}

function costLine(t: Ticket, lang: AskLang): string {
  const total = totalOf(t.usage);
  if (!total.runs) return lang === 'ar' ? 'لم يُحسب شيء بعد: لم يعمل أي وكيل على هذه التذكرة.' : 'Nothing is counted yet: no agent has run on this ticket.';
  if (total.costUsd === undefined) {
    return lang === 'ar' ? `لم تذكر أداة الذكاء الاصطناعي تكلفة هذه التشغيلات (${total.runs}).` : `The AI tool did not report a cost for these ${total.runs} runs.`;
  }
  if (lang === 'ar') {
    const amount = total.costUsd < 0.005 ? 'أقل من 0.01 دولار' : `${total.costUsd.toFixed(2)} دولار`;
    return `التكلفة حتى الآن ${amount} بأسعار API، في ${total.runs} ${total.runs <= 10 ? 'مرات تشغيل' : 'مرة تشغيل'}.`;
  }
  return `So far it has cost ${costWords(total)} at API prices, over ${total.runs} ${total.runs === 1 ? 'run' : 'runs'}.`;
}

function problemLines(t: Ticket, now: LiveNow, book: UsualBook, lang: AskLang): string[] {
  const ar = lang === 'ar';
  const secs = now.seconds;
  if (now.state === 'working') {
    const who = ar ? WHO_AR[now.role ?? 'builder'] : `The ${now.who}`;
    if (now.slow?.kind === 'stuck') {
      const quiet = now.slow.text;
      return ar
        ? [`قد يكون العمل عالقًا. ${quiet.startsWith('No progress') ? 'لا تقدّم منذ فترة.' : ''}`.trim(), 'البطاقة أعلاه تعرض ما فحصه squad-kit وطرق المتابعة.']
        : [`It may be stuck. ${quiet}`, 'The card above says what squad-kit checked, with the ways out.'];
    }
    if (slowNow(now, book, t)) {
      if (!now.slow && !ar) return [`It is slower than usual, but still working. ${now.role === 'squad' ? 'squad-kit' : who} has been on this step for ${minutesWords(secs ?? 0)}. It usually takes ${rangeEn(now.usual!)}.`, 'You can give it more time, stop and try again, or stop it.'];
      return ar
        ? [`العمل أبطأ من المعتاد، لكنه مستمر. ${who} على هذه الخطوة منذ ${arMinutes(secs ?? 0)}، وتستغرق عادة ${arRange(now.usual!)}.`, 'يمكنك من البطاقة أعلاه منحه 10 دقائق إضافية، أو إيقافه والمحاولة من جديد، أو إيقافه.']
        : [`It is slower than usual, but still working. ${now.slow?.text ?? ''}`.trim(), 'You can give it 10 more minutes, stop and try again, or stop it from the card above.'];
    }
    const p = now.part;
    const u = now.usual!;
    const checks = now.role === 'squad';
    const first = ar
      ? checks
        ? `لا توجد مشكلة. squad-kit يشغّل الفحوصات${secs !== undefined ? ` منذ ${arMinutes(secs)}` : ' الآن'}. تستغرق عادة ${arRange(u)}.`
        : `لا توجد مشكلة. ${who}${p ? ` في الخطوة ${p.n} من ${p.of} و` : ' '}يعمل${secs !== undefined ? ` منذ ${arMinutes(secs)}` : ' الآن'}. هذه الخطوة تستغرق عادة ${arRange(u)}.`
      : checks
        ? `No problem. squad-kit is running the checks${secs !== undefined ? `, for ${minutesWords(secs)} so far` : ''}. They usually take ${rangeEn(u)}.`
        : secs === undefined
          ? `No problem. ${who} is working${p ? ` on step ${p.n} of ${p.of}` : ''}. This step usually takes ${rangeEn(u)}.`
          : `No problem. ${who}${p ? ` is on step ${p.n} of ${p.of} and has worked for` : ' has worked on this step for'} ${minutesWords(secs)}. This step usually takes ${rangeEn(u)}.`;
    const tries = (t.tries ?? 0) > 0 ? (ar ? 'فشلت الفحوصات مرة على الطريق، والمطوّر يصلحها.' : `The checks failed ${t.tries === 1 ? 'once' : `${t.tries} times`} on the way; the Builder fixes what they found.`) : '';
    const then = ar ? `بعدها: ${thenAr(t, now)} ستظهر في «Waiting for you» عندما تحتاجك.` : `Next: ${lowerFirst(now.then ?? '')} I will put it in Waiting for you when it needs you.`;
    return [first, tries, then].filter(Boolean);
  }
  if (now.state === 'you') {
    if (t.waiting?.kind === 'stuck') return ar ? ['نعم: توقف الفريق ويحتاج قرارك.', t.stuck?.question ?? ''].filter(Boolean) : ['Yes: the squad stopped and needs your decision.', t.stuck?.question ?? ''].filter(Boolean);
    return ar ? [`لا توجد مشكلة. التذكرة تنتظر منك ${t.waiting ? YOUR_PART_AR[t.waiting.kind] : YOUR_PART_AR.yours}.`] : [`No problem. ${now.sentence}`];
  }
  return ar ? [stateAr(t, now, 'لا توجد مشكلة. ')] : [`No problem. ${now.sentence}`];
}

/** The live sentence for the calm states, in Arabic. */
function stateAr(t: Ticket, now: LiveNow, lead = ''): string {
  switch (now.state) {
    case 'queued':
      return `${lead}التذكرة التالية في الدور، وتبدأ عند توفر مكان.`;
    case 'stopping':
      return 'العمل يتوقف كما طلبت. كل ما أُنجز محفوظ.';
    case 'ready':
      return `${lead}العمل مقبول ويصدر مع ${t.release ?? 'النسخة القادمة'}.`;
    case 'done':
      return `${lead}صدرت${t.release ? ` في ${t.release}` : ''}.`;
    case 'you':
      return `${lead}التذكرة تنتظر منك ${t.waiting ? YOUR_PART_AR[t.waiting.kind] : YOUR_PART_AR.yours}.`;
    default:
      return `${lead}لا يجري أي عمل عليها الآن.`;
  }
}

function rangeEn(u: Pick<Usual, 'low' | 'high'>): string {
  if (u.high < 60) return 'under a minute';
  const low = Math.max(1, Math.round(u.low / 60));
  const high = Math.max(low, Math.round(u.high / 60));
  return low === high ? `about ${low} minute${low === 1 ? '' : 's'}` : `${low} to ${high} minutes`;
}

function lowerFirst(s: string): string {
  // A ticket name or an abbreviation keeps its capitals: "SK-152 needs SK-146", "PDF".
  return /^[A-Z][A-Z0-9]+\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function whenLines(t: Ticket, now: LiveNow, book: UsualBook, lang: AskLang): string[] {
  const ar = lang === 'ar';
  if (now.state === 'working' && now.readyIn) {
    if (slowNow(now, book, t)) {
      const who = ar ? WHO_AR[now.role ?? 'builder'] : now.role === 'squad' ? 'squad-kit' : `The ${now.who}`;
      return ar
        ? [`العمل أبطأ من المعتاد، لذلك يصعب التقدير. ${who} على هذه الخطوة منذ ${arMinutes(now.seconds ?? 0)}.`]
        : [`It is taking longer than usual, so it is hard to say. ${now.slow?.text ?? `${who} has been on this step for ${minutesWords(now.seconds ?? 0)}.`}`];
    }
    const what = now.readyIn.what;
    if (t.track === 'auto') return ar ? [`غالبًا ${arIn(now.readyIn.seconds)}. بعدها ${MERGES_AR}`] : [`Probably ${inAbout(now.readyIn.seconds)}. Then it is accepted and merged by itself.`];
    return ar ? [`غالبًا ${arIn(now.readyIn.seconds)}. بعدها سنطلب منك ${NEED_AR[what] ?? what}.`] : [`Probably ${inAbout(now.readyIn.seconds)}. Then you will be asked to ${what}.`];
  }
  if (now.state === 'you') return ar ? [`التذكرة بانتظارك الآن: تحتاج ${t.waiting ? YOUR_PART_AR[t.waiting.kind] : YOUR_PART_AR.yours}.`] : [`It is waiting for you now: ${lowerFirst(t.waiting?.summary ?? 'give it back when you are done')}.`];
  if (now.state === 'queued') return ar ? ['لم تبدأ خطوتها بعد: هي التالية في الدور، وتبدأ عند توفر مكان.'] : ['It is next in line, so its step has not started yet. It starts when a slot is free.'];
  if (now.state === 'ready') return ar ? [`جاهزة: العمل مقبول ويصدر مع ${t.release ?? 'النسخة القادمة'}.`] : [`It is ready: accepted, and it goes out with ${t.release ?? 'the next release'}.`];
  if (now.state === 'done') return ar ? [`صدرت${t.release ? ` في ${t.release}` : ''}.`] : [now.sentence];
  if (now.state === 'idle') return ar ? ['لم يبدأ العمل عليها بعد.'] : ['Work on it has not started yet.'];
  return ar ? [stateAr(t, now)] : [now.sentence];
}

function doingLines(t: Ticket, now: LiveNow, lang: AskLang): string[] {
  if (lang === 'en') return [now.sentence, ...(now.state === 'working' && now.doing ? [`Right now it is ${now.doing}.`] : [])];
  if (now.state !== 'working') return [stateAr(t, now)];
  const who = WHO_AR[now.role ?? 'builder'];
  const title = now.part ? t.steps?.[now.part.n - 1]?.title : undefined;
  const first = now.part && title ? `${who} في الخطوة ${now.part.n} من ${now.part.of}: ${title}.` : SENTENCE_AR[now.step ?? 'build'];
  return [first, ...(now.doing ? [`الآن ${doingAr(now.doing)}.`] : [])];
}

function nextLines(t: Ticket, now: LiveNow, lang: AskLang): string[] {
  const ar = lang === 'ar';
  if (now.state === 'working' && now.readyIn) {
    if (!ar) return [now.next ?? ''];
    if (t.track === 'auto') return [thenAr(t, now), `يُقبل العمل ويُدمج تلقائيًا ${arIn(now.readyIn.seconds)}. لا شيء مطلوب منك الآن.`];
    return [thenAr(t, now), `بعدها سنطلب منك ${NEED_AR[now.readyIn.what] ?? now.readyIn.what} ${arIn(now.readyIn.seconds)}. لا شيء مطلوب منك الآن.`];
  }
  if (now.state === 'you') return ar ? [`يتابع الفريق بعد ${t.waiting ? YOUR_PART_AR[t.waiting.kind] : YOUR_PART_AR.yours}.`] : [now.next ?? now.sentence];
  return ar ? [stateAr(t, now)] : [now.next ?? now.sentence];
}

/** Answers one question about a ticket from its live record. No AI runs, so it costs nothing. */
export function answerAsk(t: Ticket, now: LiveNow, book: UsualBook, question: string): AskAnswer {
  const { topic, lang } = askTopic(question);
  const ar = lang === 'ar';
  const who = agentOf(now);
  const to = now.state === 'working' && now.role && now.role !== 'squad' ? now.role : undefined;
  const noteLabel = ar ? `أرسلها ملاحظة إلى ${to ? WHO_AR[to] : 'الفريق'}` : `Send it as a note to the ${to ? WHO[to] : 'squad'}`;
  const note: AskOffer = { do: 'note', label: noteLabel, note: ar ? noteWhenAr(t, now) : now.noteWhen, ...(to ? { to } : {}) };
  const chat: AskOffer = { do: 'chat', label: ar ? `اسأل ${WHO_AR[who]}` : `Ask the ${WHO[who]}`, to: who };
  const stop: AskOffer = { do: 'stop', label: ar ? 'أوقف العمل' : 'Stop the work' };
  const answer = (lines: string[], offers: AskOffer[] = [], instant = true): AskAnswer => ({ lang, topic, instant, lines: lines.filter(Boolean), offers });
  switch (topic) {
    case 'problem':
      return answer(problemLines(t, now, book, lang), now.state === 'working' && !now.slow ? [stop] : []);
    case 'when':
      return answer(whenLines(t, now, book, lang));
    case 'doing':
      return answer(doingLines(t, now, lang));
    case 'next':
      return answer(nextLines(t, now, lang));
    case 'cost':
      return answer([costLine(t, lang)]);
    case 'change': {
      if (t.stage === 'release' || t.stage === 'done') {
        const line = ar ? `${t.id} مقبولة، لذلك يصبح أي تغيير تذكرة جديدة مرتبطة بها أو بلاغ خطأ.` : `${t.id} is accepted, so a change becomes a new linked ticket or a bug report.`;
        return answer([line], [{ do: 'propose', label: ar ? 'اطلب تغييرًا' : 'Ask for a change', note: ar ? 'تختار: تذكرة جديدة مرتبطة أو بلاغ خطأ.' : 'You choose: a new linked ticket or a bug report.' }], false);
      }
      if (!canPropose(t)) {
        const line = ar
          ? 'المواصفات لم تُعتمد بعد، فما زال الفريق يستطيع أخذ ذلك في الحسبان. أرسلها ملاحظة، أو ناقشها مع المحلل.'
          : 'The spec is not approved yet, so the squad can still take this in. Send it as a note, or talk it through with the Analyst.';
        return answer([line], [note, { do: 'chat', label: ar ? 'ناقشها مع المحلل' : 'Talk it through with the Analyst', to: 'analyst' }], false);
      }
      const propose: AskOffer = {
        do: 'propose',
        label: ar ? 'اقترح تعديلًا' : 'Propose a change',
        note: ar ? 'تُحدَّث المواصفات وتوافق عليها، ثم يعيد المطوّر ما تغيّر فقط.' : 'The spec is updated, you approve it, and the Builder redoes only what changed.',
      };
      return answer([ar ? 'هذا يغيّر ما وافقت عليه في المواصفات. كيف تريد أن يصل إلى الفريق؟' : 'That changes what you approved in the spec. How should it reach the squad?'], [propose, note], false);
    }
    default:
      return answer(
        [
          ar
            ? 'أستطيع الإجابة فورًا عن أسئلة الحالة: هل توجد مشكلة، متى يجهز، ماذا يعمل الآن، ما الخطوة التالية، وكم كلّف. لأي سؤال آخر اسأل أحد الوكلاء.'
            : 'I answer status questions at once: is there a problem, when will it be ready, what is it doing, what is next, and what it has cost. For anything else, ask an agent.',
        ],
        [chat],
        false,
      );
  }
}
