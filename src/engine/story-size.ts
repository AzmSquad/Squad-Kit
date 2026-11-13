import { DocumentError, kindOf, pdfPages, plainText, unzip, wordCount, wordToMarkdown } from '../board/requirements-text.js';

/**
 * How big a pasted or written story is, before any AI reads it: one story, a few stories in one, or a whole
 * requirements document. squad-kit counts it itself (ADR-004): the words, the pages of an attached Word or PDF file,
 * requirement numbers (FR-1, REQ-12, BR-3…), headings and "shall"/"must" lines, separate asks, and how many roles,
 * screens and flows it names. Code, tables and log lines are left out first: a bug with its stack trace is still one
 * story. Only the words and the requirement numbers make it more than one story; the rest only leaves it to the
 * Analyst, who can still say one. Either way it is only a suggestion: nothing is split or sent until the person presses.
 */

/** clear one story; the Analyst judges; clearly a few stories; a whole requirements document. */
export type FixedSize = 'one' | 'middle' | 'few' | 'brd';

/** At most this many words and asks, with no list, no numbers and no document: one story, nothing to judge. */
export const ONE_STORY_WORDS = 60;
export const ONE_STORY_ASKS = 2;
/** From this many words, or requirement numbers, it is never one story. */
export const FEW_STORIES_WORDS = 400;
export const FEW_STORIES_IDS = 3;
/** A whole requirements document: this many words, pages in an attached document, or requirement numbers. */
export const BRD_WORDS = 2500;
export const BRD_PAGES = 8;
export const BRD_REQUIREMENT_IDS = 10;

export interface SizeInput {
  /** What the person asks for: its separate asks are counted here only. */
  text: string;
  /** Their own lists ("done when", rules, edge cases): words and requirement numbers, never asks or headings. */
  lists?: string[];
  /** The files that came with it, as sent (base64) or read: a Word, PDF, Markdown or text file is read; pictures are left out. */
  files?: { name: string; data: string | Buffer }[];
}

export interface SizeCheck {
  size: FixedSize;
  words: number;
  /** The most pages of an attached Word or PDF file. */
  pages?: number;
  requirementIds: number;
  headings: number;
  mustLines: number;
  asks: number;
  /** The roles, screens and flows it names, together. */
  breadth: number;
  /** What it found that counts, in plain words, for the Analyst and the person. */
  found: string[];
}

/** FR-1, NFR-2, REQ-12, BR-3, UC-4, US-5 and their sub-numbers (FR-1.2). "US 1" with a space is a word and a number. */
const REQUIREMENT_ID = /\b(?:FR|NFR|REQ|BR|UR|SR|UC|US)[-_]?\d{1,4}(?:\.\d{1,3})*\b/gi;
/** A Markdown heading, or a section title with a dotted number: "3.4 Holding a slot". "1. Book a room" is a list item. */
const HEADING = /^(?:#{1,6}\s+\S|\d{1,2}\.\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[^\s.].{0,70}$)/;
/** A table row, a log line or a line of a stack trace: pasted output, not words a person wrote. */
const NOT_PROSE = [
  /^\s*\|/,
  /\|.*\|/,
  /\t.*\t/,
  /^\s+at\s+\S+/,
  /^\s*File ".*", line \d+/,
  /^\s*Traceback\b/,
  /^\s*\.\.\. \d+ more\b/,
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^\s*\[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/,
  /^\s*(?:[\w$]+\.)*\w*(?:Error|Exception)\b.*:/,
];
const MUST = /\b(?:shall|must|is required to|are required to)\b|(?:^|\s)(?:يجب|ينبغي|يلزم|يتعين|لازم|لابد|لا بد)(?:\s|$)/i;
const BULLET = /^\s*(?:[-*•▪◦]|\d{1,2}[.)])\s+/;
/** Words that start a clause that is not an ask of its own: "so that…", "when…", "because…". */
const NOT_AN_ASK = /^(?:and\s+|then\s+)?(?:as\s+an?|so|so that|because|when|whenever|if|unless|while|which|that|who|where|but|or|for example|e\.g\.|i\.e\.|like)\b|^(?:و\s*)?(?:عشان|علشان|لأن|لان|لما|عندما|لو|إذا|اذا|اللي|الذي|التي|بس|زي|مثل|مثلا|يعني)(?:\s|$)/i;

const ROLES = /\b(?:customers?|clients?|users?|admins?|administrators?|staff|employees?|managers?|owners?|clerks?|agents?|supervisors?|doctors?|patients?|students?|teachers?|guests?|vendors?|suppliers?|drivers?|cashiers?|operators?|approvers?|members?|visitors?|partners?)\b|(?:العميل|العملاء|عميل|المستخدم|المستخدمين|الموظف|الموظفين|موظف|المدير|المشرف|الإدارة|المالك|الطالب|المريض|الطبيب|السائق|المورد|الزائر|الضيف)/gi;
const SCREENS = /\b(?:pages?|screens?|forms?|reports?|dashboards?|lists?|menus?|tabs?|popups?|emails?|sms|notifications?|receipts?|invoices?|calendars?|settings)\b|(?:صفحة|الصفحة|شاشة|الشاشة|تقرير|التقرير|نموذج|لوحة|قائمة|إشعار|الإشعار|إيصال|فاتورة|رسالة|الرسائل|الإيميل)/gi;
const FLOWS = /\b(?:approves?|rejects?|cancels?|refunds?|pays?|payments?|books?|bookings?|registers?|sign(?:s)? (?:in|up)|log(?:s)? in|uploads?|exports?|imports?|search(?:es)?|assigns?|notif(?:y|ies)|schedules?|renews?|reschedules?|confirms?|checks? out|transfers?|reminds?|reminders?)\b|(?:يدفع|الدفع|يحجز|الحجز|يلغي|الإلغاء|يسترجع|الاسترجاع|يوافق|الموافقة|يرفض|يسجل|التسجيل|يرفع|يصدر|يبحث|البحث|تذكير|التذكير)/gi;

function distinct(text: string, re: RegExp): number {
  return new Set((text.match(re) ?? []).map((m) => m.toLowerCase().replace(/[-_ ]/g, ''))).size;
}

/** A Word file's pages as Word saved them (docProps/app.xml), else about 450 words a page. */
function wordPages(buf: Buffer, words: number): number {
  try {
    const app = unzip(buf, (n) => n === 'docProps/app.xml').get('docProps/app.xml')?.toString('utf8');
    const saved = Number(/<Pages>(\d+)<\/Pages>/.exec(app ?? '')?.[1]);
    if (saved > 0) return saved;
  } catch {
    // The text was read already; the guess below is enough.
  }
  return Math.max(1, Math.ceil(words / 450));
}

/** The text of the files a person attached, and the most pages of one of them. A file that cannot be read adds nothing. */
function filesText(files: SizeInput['files']): { text: string; pages: number } {
  let text = '';
  let pages = 0;
  for (const f of files ?? []) {
    const kind = kindOf(f.name);
    if (!kind) continue;
    const buf = typeof f.data === 'string' ? Buffer.from(f.data, 'base64') : f.data;
    try {
      if (kind === 'pdf') pages = Math.max(pages, pdfPages(buf));
      else if (kind === 'docx') {
        const md = wordToMarkdown(buf).markdown;
        text += `\n\n${md}`;
        pages = Math.max(pages, wordPages(buf, wordCount(md)));
      } else text += `\n\n${plainText(buf)}`;
    } catch (err) {
      // A broken or locked document is said where it is read for real (Requirements); here it only adds nothing.
      if (!(err instanceof DocumentError)) throw err;
    }
  }
  return { text, pages };
}

/** The text without code blocks, table rows, log lines and stack traces. */
export function proseOf(text: string): string {
  return text
    .replace(/(^|\n)\s*(```|~~~)[\s\S]*?(\n\s*\2[^\n]*|$)/g, '\n')
    .split('\n')
    .filter((l) => !NOT_PROSE.some((re) => re.test(l)))
    .join('\n');
}

/** The separate asks: list items, and the clauses of each sentence that ask for something of their own. */
export function countAsks(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (BULLET.test(line)) {
      if (wordCount(line.replace(BULLET, '')) >= 2) n += 1;
      continue;
    }
    for (const sentence of line.split(/[.!?؟;؛]+(?:\s|$)/)) {
      for (const clause of sentence.split(/,|،|\s+and then\s+/)) {
        const c = clause.trim();
        if (wordCount(c) >= 3 && !NOT_AN_ASK.test(c)) n += 1;
      }
    }
  }
  return n;
}

function many(n: number, one: string, more = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`;
}

/** squad-kit's own look at the size, no AI. */
export function checkSize(input: SizeInput): SizeCheck {
  const docs = filesText(input.files);
  const asked = proseOf(`${input.text ?? ''}${docs.text}`);
  const all = `${asked}\n${proseOf((input.lists ?? []).join('\n'))}`;
  const words = wordCount(all);
  const requirementIds = distinct(all, REQUIREMENT_ID);
  const headings = asked.split('\n').filter((l) => HEADING.test(l.trim()) && wordCount(l) <= 12).length;
  const mustLines = all.split(/[.!?؟\n]+/).filter((s) => MUST.test(s)).length;
  const asks = countAsks(asked);
  const roles = distinct(all, ROLES);
  const screens = distinct(all, SCREENS);
  const flows = distinct(all, FLOWS);
  const breadth = roles + screens + flows;
  const pages = docs.pages || undefined;

  const brd =
    (pages ?? 0) >= BRD_PAGES ||
    words >= BRD_WORDS ||
    requirementIds >= BRD_REQUIREMENT_IDS ||
    (words >= 1000 && (headings >= 6 || mustLines >= 12 || requirementIds >= 5));
  // Asks, headings, pages and breadth alone leave it to the Analyst, who can still say one story.
  const few = words >= FEW_STORIES_WORDS || requirementIds >= FEW_STORIES_IDS;
  const one = words <= ONE_STORY_WORDS && asks <= ONE_STORY_ASKS && !requirementIds && !headings && !pages;
  const size: FixedSize = brd ? 'brd' : few ? 'few' : one ? 'one' : 'middle';

  const found: string[] = [];
  if (words >= 150 || size === 'brd') found.push(`about ${many(Math.round(words / 50) * 50 || words, 'word')}`);
  if (pages) found.push(`a document of ${many(pages, 'page')}`);
  if (requirementIds) found.push(many(requirementIds, 'requirement number'));
  if (headings >= 3) found.push(many(headings, 'heading'));
  if (mustLines >= 6) found.push(many(mustLines, '"must" line'));
  if (asks >= 3) found.push(many(asks, 'separate ask'));
  if (breadth >= 12) found.push(`${many(roles, 'role')}, ${many(screens, 'screen')} and ${many(flows, 'flow')}`);
  return { size, words, ...(pages ? { pages } : {}), requirementIds, headings, mustLines, asks, breadth, found };
}
