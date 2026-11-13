import type { Checklist, ChecklistItem } from '../api/contribution-types';
import type { Lang } from './first-story';

/**
 * The words of a contribution to squad-kit's own code, in the board's two languages: the assistant, the bar on every
 * page, and a story's pull request. Names, repos and numbers come from the engine; an item the board has no words for
 * shows the engine's own line.
 */

const short = (repo?: string) => repo?.split('/').pop() ?? 'squad-kit';
const n1 = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('{n}', String(n)));

export const JOURNEY: Record<Lang, { title: string; sub: string; steps: string[]; closed: string; story: (id: string) => string }> = {
  en: {
    title: 'Contributing to squad-kit',
    sub: 'squad-kit knows. We stay with you until the owner merges it.',
    steps: ['Set up', 'Your idea', 'Built and checked', 'Pull request', "Owner's review", 'Merged'],
    closed: 'Closed by the owner',
    story: (id) => `Following ${id}`,
  },
  ar: {
    title: 'تساهم في squad-kit',
    sub: 'squad-kit عارف. ومعك خطوة بخطوة لين يدمجها المالك.',
    steps: ['التجهيز', 'فكرتك', 'انبنت وانفحصت', 'طلب الدمج', 'مراجعة المالك', 'اندمجت'],
    closed: 'سكّره المالك',
    story: (id) => `نتابع ${id}`,
  },
};

export const ASSIST = {
  en: {
    head: 'You are contributing to squad-kit',
    sub: 'squad-kit sets everything up for you. No git needed: each step has its button.',
    selfTitle: "squad-kit's own code",
    selfLine: 'Your squad knows it, and works only in this folder.',
    read: 'Read the rules',
    hide: 'Hide the rules',
    readFile: 'In your folder:',
    both: 'Do both for me',
    go: 'Write your first idea',
    left: (n: number) => (n === 1 ? 'One step left. squad-kit can do it now.' : n === 2 ? 'Two steps left. squad-kit can do both now.' : `${n} steps left.`),
    signFirst: 'Sign in first, and squad-kit can do the rest.',
    ready: 'Ready: your stories go as pull requests.',
    looking: 'Looking at your copy…',
    notSelf: "This project is not squad-kit's own code, so it has no contribution checklist.",
  },
  ar: {
    head: 'أنت تساهم في squad-kit',
    sub: 'squad-kit يجهّز لك كل شيء. ما تحتاج git: كل خطوة لها زر.',
    selfTitle: 'كود squad-kit نفسه',
    selfLine: 'الفريق يعرف ذلك، ويشتغل بس في هذا المجلد.',
    read: 'اقرأ القواعد',
    hide: 'أخفِ القواعد',
    readFile: 'في مجلدك:',
    both: 'سوّهم عني',
    go: 'اكتب أول فكرة',
    left: (n: number) => (n === 1 ? 'باقي خطوة وحدة. squad-kit يقدر يسويها الآن.' : n === 2 ? 'باقي خطوتين. squad-kit يقدر يسويهم الآن.' : `باقي ${n} خطوات.`),
    signFirst: 'سجّل الدخول أول، وsquad-kit يسوي الباقي.',
    ready: 'جاهز: قصصك تروح كطلبات دمج.',
    looking: 'نطالع نسختك…',
    notSelf: 'هذا المشروع مو كود squad-kit نفسه، فما له قائمة مساهمة.',
  },
};

export const IDEA = {
  en: {
    head: 'Tell the maintainers first',
    sub: 'squad-kit fills in a new issue on the main repo with your idea. You read it there and send it yourself: squad-kit posts nothing.',
    title: 'Your idea in a few words',
    text: 'A few lines about it (optional)',
    fill: 'Fill in the page',
    open: 'Open the new issue page',
    filled: 'The page is ready. Open it, read it, and press Submit there when you are happy with it.',
  },
  ar: {
    head: 'أخبر المشرفين أول',
    sub: 'squad-kit يعبّي لك مهمة جديدة على المستودع الرئيسي بفكرتك. تقرأها هناك وترسلها بنفسك: squad-kit ما ينشر شيء.',
    title: 'فكرتك بكلمات قليلة',
    text: 'كم سطر عنها (اختياري)',
    fill: 'عبّ الصفحة',
    open: 'افتح صفحة المهمة الجديدة',
    filled: 'الصفحة جاهزة. افتحها واقرأها، واضغط Submit هناك إذا عجبتك.',
  },
};

export interface ItemWords {
  title: string;
  line: string;
  button?: string;
}

/** An item of the checklist in words. `null` keeps the engine's own line. */
export function itemWords(i: ChecklistItem, c: Checklist, lang: Lang): ItemWords {
  const host = c.host ?? '';
  const main = c.main ?? '';
  const ar = lang === 'ar';
  const signedIn = c.items.find((x) => x.id === 'sign-in')?.state === 'done';
  switch (i.id) {
    case 'sign-in':
      if (i.state === 'done') return { title: ar ? `مسجّل في ${host}` : `Signed in to ${host}`, line: i.account ? (ar ? `باسم ${i.account}.` : `As ${i.account}.`) : i.line };
      return {
        title: ar ? `سجّل الدخول في ${host}` : `Sign in to ${host}`,
        line: ar ? `سجّل الدخول مرة وحدة بأداة ${host} الرسمية. squad-kit ما يحفظ أي كلمة سر.` : `Sign in once with ${host}'s own tool. squad-kit keeps no password.`,
        button: ar ? `سجّل الدخول بـ ${host}` : `Sign in with ${host}`,
      };
    case 'copy': {
      const title = ar ? `نسختك الخاصة على ${host}` : `Your own copy on ${host}`;
      if (i.state === 'todo')
        return {
          title,
          line: ar ? `هذا المجلد مربوط بـ ${main}، وبس مالكه يقدر يغيّره. squad-kit يسوي لك نسختك (fork) ويرسل شغلك لها.` : `This folder points at ${main}, which only its owner can change. squad-kit makes your own copy (a fork) and sends your work there.`,
          button: ar ? 'سوّ نسختي' : 'Make my copy',
        };
      if (i.state === 'blocked') return { title, line: ar ? `سجّل الدخول في ${host} أول.` : `Sign in to ${host} first.` };
      if (c.copy) return { title, line: ar ? `${c.copy}، نسخة من ${main}. قصصك تروح لـ ${main} كطلبات دمج منها.` : `${c.copy}, a copy of ${main}. Your stories go to ${main} as pull requests from it.` };
      return { title, line: ar ? `تقدر ترسل تغييراتك لـ ${main} مباشرة.` : i.line };
    }
    case 'up-to-date': {
      const title = ar ? `محدّث مع ${short(main)}` : `Up to date with ${short(main)}`;
      const n = i.count ?? 0;
      if (i.state === 'todo')
        return {
          title,
          line: ar ? `في ${n} تغيير جديد على ${short(main)} من بعد نسختك. خذها قبل ما تبدأ.` : `${n1(n, 'One new change', '{n} new changes')} on ${short(main)} since your copy. Bring ${n === 1 ? 'it' : 'them'} in before you start.`,
          button: ar ? 'حدّثها' : 'Bring it up to date',
        };
      if (i.state === 'blocked' && n)
        return { title, line: ar ? `نسختك فيها ${n} تغيير مو موجود في ${main}. squad-kit يخليها زي ما هي، وتقدر تكتب فكرتك. عشان تطابق ${main}، أرسلها كطلب دمج أو اسأل مهندس.` : i.line };
      if (i.state === 'blocked') return { title, line: signedIn ? (ar ? 'سوّ نسختك أول.' : 'Make your own copy first.') : ar ? `سجّل الدخول في ${host} أول.` : `Sign in to ${host} first.` };
      if (i.state === 'done') return { title, line: ar ? `نسختك فيها كل شيء من ${short(main)}.` : `Your copy has everything in ${short(main)}.` };
      return { title, line: i.line };
    }
    case 'rules':
      return {
        title: ar ? 'قواعد squad-kit' : "squad-kit's rules",
        line: ar ? 'ملفات صغيرة، طبقات واضحة، كل زر له أمر، وأقل من 6 ميجا. الفريق يلتزم بها والفحوص تحرسها.' : 'Small files, clear layers, every button with its command, under 6 MB. Your squad follows them and the checks hold them.',
        button: ar ? 'اقرأ القواعد' : 'Read the rules',
      };
    case 'idea':
      return {
        title: ar ? 'فكرة كبيرة؟' : 'A big idea?',
        line: ar ? 'أخبر المشرفين أول، عشان ما يبني اثنين نفس الشيء. squad-kit يكتب الملاحظة من فكرتك، وأنت ترسلها.' : 'Tell the maintainers first, so nobody builds the same thing twice. squad-kit writes the note from your idea; you send it.',
        button: ar ? 'أخبر المشرفين' : 'Tell the maintainers',
      };
    default:
      return { title: i.title, line: i.line };
  }
}

/* ── A story's pull request ─────────────────────────────── */

export interface TrackWords {
  title: string;
  sub?: string;
}

export const PR = {
  en: {
    head: 'Pull request',
    open: (host: string) => `Open on ${host}`,
    note: 'squad-kit never merges into the main repo. Only its owner can.',
    step: {
      'looks-right': (): TrackWords => ({ title: 'Looks right', sub: 'You checked the proof' }),
      pushed: (copy?: string, branch?: string): TrackWords => ({ title: 'Pushed to your fork', sub: [copy, branch && `branch ${branch}`].filter(Boolean).join(', ') }),
      opened: (into?: string): TrackWords => ({ title: `Pull request opened into ${into ?? 'the main repo'}`, sub: 'With the proof for each line and the review' }),
      review: 'The owner reviews it',
      merged: 'Merged by the owner',
    },
    reviewSub: { waiting: 'Waiting for the owner. Nothing to do now.', notes: 'The owner asked for changes.', fixing: "The Builder is fixing the owner's notes.", closed: 'Closed by the owner without merging.', merged: '' },
    closedTitle: 'Closed by the owner',
    notesHead: 'The owner asked for changes',
    notesTag: 'Changes for you',
    line: (n: number) => `line ${n}`,
    fix: 'Fix these',
    reply: (host: string) => `Reply on ${host}`,
    ask: 'Ask the lead',
    askText: (id: string, notes: string) => `The owner left these notes on the pull request of ${id}. What do they ask for, and should the Builder fix them?\n\n${notes}`,
    fixNote: 'The Builder fixes them, squad-kit pushes again and answers each comment.',
    leave: (host: string) => `I answered them on ${host}`,
    leaveNote: 'squad-kit marks them answered and waits for the owner again.',
    fixedHead: 'Fixed and sent',
    fixedTag: 'Done',
    fixedIn: 'Fixed in',
    pushed: 'Pushed: the pull request is updated, and each comment has its answer.',
    pushedSome: 'Pushed: the pull request is updated. squad-kit answers the rest of the comments at its next look.',
    mergedHead: 'Merged by the owner',
    mergedSub: (into: string, id: number, day: string, time: string) => `${into} #${id}, on ${day} at ${time}. You are now one of its contributors.`,
    syncLater: 'Before your next story, squad-kit brings your fork up to date.',
    check: 'Check again',
    looked: (at: string) => `squad-kit looks by itself every 3 minutes. Last look at ${at}.`,
    notLooked: 'squad-kit looks by itself every 3 minutes.',
  },
  ar: {
    head: 'طلب الدمج',
    open: (host: string) => `افتح على ${host}`,
    note: 'squad-kit ما يدمج أبداً في المستودع الرئيسي. بس مالكه يقدر.',
    step: {
      'looks-right': (): TrackWords => ({ title: 'تمام', sub: 'راجعت الإثبات' }),
      pushed: (copy?: string, branch?: string): TrackWords => ({ title: 'انرفع إلى نسختك', sub: [copy, branch && `فرع ${branch}`].filter(Boolean).join('، ') }),
      opened: (into?: string): TrackWords => ({ title: `انفتح طلب دمج إلى ${into ?? 'المستودع الرئيسي'}`, sub: 'مع إثبات كل سطر والمراجعة' }),
      review: 'المالك يراجعه',
      merged: 'دمجه المالك',
    },
    reviewSub: { waiting: 'بانتظار المالك. ما عليك شيء الآن.', notes: 'المالك طلب تعديلات.', fixing: 'المنفّذ يصلّح ملاحظات المالك.', closed: 'سكّره المالك بدون دمج.', merged: '' },
    closedTitle: 'سكّره المالك',
    notesHead: 'المالك طلب تعديلات',
    notesTag: 'تعديلات لك',
    line: (n: number) => `السطر ${n}`,
    fix: 'صلّحها',
    reply: (host: string) => `رد على ${host}`,
    ask: 'اسأل القائد',
    askText: (id: string, notes: string) => `المالك ترك هذه الملاحظات على طلب دمج ${id}. وش يطلب، وهل يصلّحها المنفّذ؟\n\n${notes}`,
    fixNote: 'المنفّذ يصلّحها، وsquad-kit يرفع مرة ثانية ويرد على كل تعليق.',
    leave: (host: string) => `رديت عليها على ${host}`,
    leaveNote: 'squad-kit يعتبرها مردود عليها وينتظر المالك من جديد.',
    fixedHead: 'اتصلحت وانرسلت',
    fixedTag: 'تم',
    fixedIn: 'اتصلحت في',
    pushed: 'انرفع: طلب الدمج تحدّث، وكل تعليق عليه رد.',
    pushedSome: 'انرفع: طلب الدمج تحدّث. squad-kit يرد على باقي التعليقات في نظرته الجاية.',
    mergedHead: 'دمجه المالك',
    mergedSub: (into: string, id: number, day: string, time: string) => `${into} #${id}، في ${day} الساعة ${time}. صرت من المساهمين فيه.`,
    syncLater: 'قبل قصتك الجاية، squad-kit يحدّث نسختك.',
    check: 'افحص مرة ثانية',
    looked: (at: string) => `squad-kit يطالع لحاله كل 3 دقايق. آخر مرة الساعة ${at}.`,
    notLooked: 'squad-kit يطالع لحاله كل 3 دقايق.',
  },
};
