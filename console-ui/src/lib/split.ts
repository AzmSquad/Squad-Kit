import type { SplitPart, SplitSuggestion, Ticket } from '../api/types';
import { detect } from './lang';
import { andList } from './lead';

/**
 * A story too big for one: the words of its suggestion card, in the person's language (English or Arabic, as they
 * wrote it), what each size means, and the real outcome of a press. No React here, so each rule is tested on its own.
 */

export type Lang = 'en' | 'ar';

/** The language of what the person wrote: Arabic when it reads right to left. */
export function langOf(text: string): Lang {
  return text.trim() && detect(text).dir === 'rtl' ? 'ar' : 'en';
}

/** Every word the cards say, in one language. */
export interface Words {
  sizes: Record<SplitPart['size'], string>;
  needs(ns: number[]): string;
  who: string;
  title(n: number): string;
  note(id: string, n: number): string;
  yes(n: number): string;
  keep: string;
  change: string;
  yours: string;
  ask: string;
  askLabel(id: string): string;
  send: string;
  cancel: string;
  /** The lead's cards: put aside, nothing done. */
  discard: string;
  notNow: string;
  done(ids: string[]): string;
  kept: string;
  changing: string;
  sent(id: string, br: string): string;
  read(n: number): string;
  create(n: number): string;
  one: string;
  hint: string;
  brd: { read: string; title: string; lead(total: number, parts: number): string; unit(n: number): string; why: string; also: string; send: string; anyway: string; keep: string; hint: string; hintText: string };
  found(xs: string[]): string;
  big: { few: string; brd: string };
}

export const WORDS: Record<Lang, Words> = {
  en: {
    sizes: { S: 'About a day', M: 'A few days', L: 'A week or more' },
    needs: (ns: number[]) => `Needs ${ns.join(' and ')}`,
    who: 'Suggestion for you',
    title: (n: number) => `Split into ${n} stories`,
    note: (id: string, n: number) => `${id} keeps the first one. The other ${n - 1} wait in Tickets, each with its own spec, checks and proof.`,
    yes: (n: number) => `Split into ${n}`,
    keep: 'Keep as one',
    change: 'Change the split',
    yours: 'Nothing changes until you press.',
    ask: 'Tell the Analyst how to split it…',
    askLabel: (id: string) => `Goes to the Analyst on ${id}`,
    send: 'Send',
    cancel: 'Cancel',
    discard: 'Discard',
    notNow: 'Not now',
    done: (ids: string[]) => `Split into ${ids.length}. ${andList(ids.slice(1))} wait in Tickets.`,
    kept: 'You kept it as one story.',
    changing: 'You asked for another split. The Analyst works on it now.',
    sent: (id: string, br: string) => `Sent to Requirements as ${br}. ${id} waits in Tickets: delete it, or start it to build it as one story.`,
    read: (n: number) => `The Analyst read it: this is ${n} stories in one.`,
    create: (n: number) => `Create ${n} stories`,
    one: 'Create as one story',
    hint: 'You check each one before it starts.',
    brd: {
      read: 'The Analyst read it: this is a whole requirements document, not one story.',
      title: 'Too big for one story',
      lead: (total: number, parts: number) => `About ${total} stories in ${parts} parts:`,
      unit: (n: number) => (n === 1 ? 'story' : 'stories'),
      why: 'Requirements breaks it down with you: the Analyst asks its questions first, then you approve the stories part by part, in the right order.',
      also: 'As one story, the squad would try to build all of it at once: slow, costly, and hard to check.',
      send: 'Send to Requirements',
      anyway: 'Make one story anyway',
      keep: 'Keep as one',
      hint: 'Your text and file go with it.',
      hintText: 'Your text goes with it.',
    },
    found: (xs: string[]) => `squad-kit's own count: ${xs.join(', ')}.`,
    big: {
      few: 'This text looks like several stories. This talk changes nothing on the story: paste it in New ticket, and the Analyst suggests a split there.',
      brd: 'This text looks like a whole requirements document. This talk changes nothing on the story: send it to Requirements to break it into stories.',
    },
  },
  ar: {
    sizes: { S: 'حوالي يوم', M: 'كام يوم', L: 'أسبوع أو أكتر' },
    needs: (ns: number[]) => `محتاجة ${ns.join(' و')}`,
    who: 'اقتراح ليك',
    title: (n: number) => `قسّمها لـ ${n} قصص`,
    note: (id: string, n: number) => `${id} تفضل للأولى. ${n === 2 ? 'التانية تستنى' : `الـ ${n - 1} التانيين يستنوا`} في التذاكر، وكل واحدة ليها مواصفات واختبارات وإثبات.`,
    yes: (n: number) => `قسّمها لـ ${n}`,
    keep: 'خليها واحدة',
    change: 'غيّر التقسيم',
    yours: 'مفيش حاجة هتتغير لحد ما تضغط.',
    ask: 'قول للمحلل تقسمها إزاي…',
    askLabel: (id: string) => `هيروح للمحلل على ${id}`,
    send: 'ابعت',
    cancel: 'إلغاء',
    discard: 'سيبها',
    notNow: 'مش دلوقتي',
    done: (ids: string[]) => `اتقسمت لـ ${ids.length}. ${ids.slice(1).join(' و')} مستنيين في التذاكر.`,
    kept: 'خليتها قصة واحدة.',
    changing: 'طلبت تقسيم تاني. المحلل شغال عليه دلوقتي.',
    sent: (id: string, br: string) => `اتبعتت للمتطلبات باسم ${br}. ${id} مستنية في التذاكر: امسحها، أو ابدأها عشان تتبني قصة واحدة.`,
    read: (n: number) => `المحلل قرأها: دي ${n} قصص في قصة واحدة.`,
    create: (n: number) => `اعمل ${n} قصص`,
    one: 'اعملها قصة واحدة',
    hint: 'هتراجع كل واحدة قبل ما تبدأ.',
    brd: {
      read: 'المحلل قرأه: ده مستند متطلبات كامل، مش قصة واحدة.',
      title: 'أكبر من قصة واحدة',
      lead: (total: number, parts: number) => `حوالي ${total} قصة في ${parts} أجزاء:`,
      unit: () => 'قصص',
      why: 'صفحة المتطلبات بتقسّمه معاك: المحلل يسأل أسئلته الأول، وبعدين توافق على القصص جزء جزء، بالترتيب الصح.',
      also: 'لو بقى قصة واحدة، الفريق هيحاول يبني كله مرة واحدة: بطيء ومكلّف وصعب يتراجع.',
      send: 'ابعته للمتطلبات',
      anyway: 'اعمله قصة واحدة برضه',
      keep: 'خليها واحدة',
      hint: 'النص والملف هيروحوا معاه.',
      hintText: 'النص هيروح معاه.',
    },
    found: (xs: string[]) => `عدّ squad-kit: ${xs.join('، ')}.`,
    big: {
      few: 'النص ده شكله كذا قصة. المحادثة دي مش بتغيّر القصة: حطه في تذكرة جديدة، والمحلل هيقترح تقسيمه هناك.',
      brd: 'النص ده شكله مستند متطلبات كامل. المحادثة دي مش بتغيّر القصة: ابعته للمتطلبات عشان يتقسم لقصص.',
    },
  },
};

/** The language of a story's card: its title and ask as the person wrote them, or as they were before the split. */
export function storyLang(t: Pick<Ticket, 'title' | 'ask' | 'split'>): Lang {
  const was = t.split?.was;
  return langOf(was ? `${was.title} ${was.ask}` : `${t.title} ${t.ask}`);
}

/** The total and the parts of a whole requirements document, for "About 25 stories in 6 parts". */
export function areasTotal(s: SplitSuggestion): { total: number; parts: number } {
  const areas = s.areas ?? [];
  return { total: areas.reduce((n, a) => n + a.stories, 0), parts: areas.length };
}

/** A part's small labels: its size in words, and what it needs. */
export function partMeta(p: SplitPart, w: Words): { size: string; needs: string | null } {
  return { size: w.sizes[p.size], needs: p.needs.length ? w.needs(p.needs) : null };
}

/** What a press really did, from the story the board sent back. */
export function splitOutcome(t: Pick<Ticket, 'id' | 'split'>, w: Words): string | null {
  const d = t.split?.decided;
  if (t.split?.change && !d) return w.changing;
  if (!d) return null;
  if (d.choice === 'split') return w.done(d.made ?? []);
  if (d.choice === 'requirements') return w.sent(t.id, d.breakdown ?? '');
  return w.kept;
}

/** A decided split stays in the story's talk, green, while the story is still at its first steps. */
export function showDecidedSplit(t: Pick<Ticket, 'split' | 'waiting' | 'stage'>, now = Date.now()): boolean {
  const at = t.split?.decided?.at;
  return Boolean(at && t.waiting?.kind !== 'split' && (t.stage === 'tickets' || t.stage === 'specs') && now - Date.parse(at) < 6 * 3_600_000);
}

/** What the New ticket dialog shows once the Analyst is done: the form as usual, a split, or a whole document. */
export function draftShows(d: { split?: SplitSuggestion } | undefined): 'one' | 'few' | 'brd' {
  return d?.split?.size ?? 'one';
}
