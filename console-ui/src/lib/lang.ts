/**
 * Which language a piece of text is in, and which way it runs. squad-kit checks each paragraph and each list item on
 * its own, so one message can hold an Arabic line and an English line. The browser's own guess looks only at the
 * first strong letter, so a message that starts with a ticket number would lay a whole Arabic sentence out left to
 * right.
 */

/** Arabic letters: Arabic, Arabic Supplement, Arabic Extended-A and the presentation forms. */
const AR = '؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿';
const AR_ONE = new RegExp(`[${AR}]`, 'g');
const LATIN_ONE = /[A-Za-z]/g;

export type Lang = 'ar' | 'en' | 'mixed' | 'none';
export type Dir = 'rtl' | 'ltr';

export interface Detected {
  lang: Lang;
  dir: Dir;
  /** The share of Arabic letters, 0 to 1. */
  share: number;
}

/**
 * Counts Arabic letters against English letters. Code, links and numbers are left out: they are written the same
 * way in both. 85% Arabic or more is Arabic, 15% or less is English, anything between is mixed, and the bigger share
 * sets the direction.
 */
export function detect(text: string): Detected {
  const s = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/(https?:\/\/|file:\/\/)\S+/g, ' ');
  const ar = s.match(AR_ONE)?.length ?? 0;
  const la = s.match(LATIN_ONE)?.length ?? 0;
  const total = ar + la;
  if (!total) return { lang: 'none', dir: 'ltr', share: 0 };
  const share = ar / total;
  return { lang: share >= 0.85 ? 'ar' : share <= 0.15 ? 'en' : 'mixed', dir: share >= 0.5 ? 'rtl' : 'ltr', share };
}

/** The type size and line height for a paragraph: Arabic one pixel larger with a taller line. */
export function textClass(d: Detected): 't-ar' | 't-mx' | 't-en' {
  return d.dir === 'rtl' ? 't-ar' : d.lang === 'mixed' ? 't-mx' : 't-en';
}

/** In words for the typing box: "Arabic · right to left". Empty for text with no letters. */
export function langLabel(d: Detected): string {
  const way = d.dir === 'rtl' ? 'right to left' : 'left to right';
  if (d.lang === 'ar') return `Arabic · ${way}`;
  if (d.lang === 'en') return `English · ${way}`;
  if (d.lang === 'mixed') return `Mixed · ${way}`;
  return '';
}

export interface Run {
  text: string;
  /** Set for a run in the other language, which is kept in its own order (bidi isolation). */
  dir?: Dir;
}

/** A number written with the words around it: 30, 10:40, 15%, ٣٠. */
const NUM = '[0-9\\u0660-\\u0669][0-9\\u0660-\\u0669.,:%/+\\-]*';
/** English words, with a number in front or between them: "30 days", "release v0.2.0", "Step 3 of 6". */
const LATIN_RUN = `(?:${NUM}[ \u00A0]+)*[A-Za-z][A-Za-z0-9._\\-/+#@:]*(?:[ \u00A0]+[A-Za-z0-9][A-Za-z0-9._\\-/+#@:]*)*`;
/** Arabic words, with numbers between them: "نحتفظ بالرسائل 30 يوم فقط" stays one phrase. */
const AR_RUN = `[${AR}]+(?:[ \u00A0]+(?:${NUM}[ \u00A0]+)*[${AR}]+)*`;
const RUNS = new RegExp(`(${LATIN_RUN})|(${AR_RUN})`, 'g');

/**
 * Splits a line into runs. An English phrase inside an Arabic paragraph (or Arabic inside English) becomes one run of
 * its own, so its words and punctuation stay in their own order. Everything else stays with the paragraph.
 */
export function runs(text: string, dir: Dir): Run[] {
  const out: Run[] = [];
  let at = 0;
  const push = (t: string, d?: Dir) => {
    if (!t) return;
    const last = out.at(-1);
    if (last && !last.dir && !d) last.text += t;
    else out.push(d ? { text: t, dir: d } : { text: t });
  };
  for (const m of text.matchAll(RUNS)) {
    const i = m.index ?? 0;
    push(text.slice(at, i));
    const latin = Boolean(m[1]);
    push(m[0], latin && dir === 'rtl' ? 'ltr' : !latin && dir === 'ltr' ? 'rtl' : undefined);
    at = i + m[0].length;
  }
  push(text.slice(at));
  return out;
}

/** The way most of the items run: a list or a table follows most of its items. Ties go right to left. */
export function majority(dirs: Dir[]): Dir {
  const rtl = dirs.filter((d) => d === 'rtl').length;
  return dirs.length && rtl * 2 >= dirs.length ? 'rtl' : 'ltr';
}

/** The source cut after `words` words, keeping the spaces and line breaks between them. */
export function firstWords(text: string, words: number): string {
  if (words <= 0) return '';
  let n = 0;
  for (const m of text.matchAll(/\S+/g)) {
    n += 1;
    if (n === words) return text.slice(0, (m.index ?? 0) + m[0].length);
  }
  return text;
}

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/* ── The same rules on a Markdown tree (hast), as a rehype plugin ───────────── */

export interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dt', 'dd', 'figcaption']);
/** Left as they are: code keeps its own order, always left to right. */
const SKIP = new Set(['code', 'pre', 'svg', 'math']);

function textOf(n: HNode, nested = false): string {
  if (n.type === 'text') return n.value ?? '';
  if (n.tagName && SKIP.has(n.tagName)) return ' ';
  // A list item's own words, not the words of a list inside it.
  if (nested && n.tagName && (n.tagName === 'ul' || n.tagName === 'ol')) return ' ';
  return (n.children ?? []).map((c) => textOf(c, true)).join('');
}

function addClass(n: HNode, cls: string): void {
  const p = (n.properties ??= {});
  const now = Array.isArray(p.className) ? (p.className as string[]) : typeof p.className === 'string' ? [p.className] : [];
  p.className = [...now, cls];
}

function el(tagName: string, properties: Record<string, unknown>, children: HNode[]): HNode {
  return { type: 'element', tagName, properties, children };
}

/** Text nodes split into runs, the other language wrapped in <bdi>; while writing, each word in a span that fades in. */
function isolate(n: HNode, dir: Dir, words: boolean): void {
  if (!n.children || (n.tagName && SKIP.has(n.tagName))) return;
  const next: HNode[] = [];
  for (const c of n.children) {
    if (c.type !== 'text') {
      if (c.type === 'element' && !(c.tagName && BLOCKS.has(c.tagName))) isolate(c, dir, words);
      next.push(c);
      continue;
    }
    for (const r of runs(c.value ?? '', dir)) {
      const kids = words ? splitWords(r.text) : [{ type: 'text', value: r.text }];
      if (r.dir) next.push(el('bdi', { dir: r.dir }, kids));
      else next.push(...kids);
    }
  }
  n.children = next;
}

function splitWords(text: string): HNode[] {
  return text.split(/(\s+)/).filter(Boolean).map((w) => (/^\s+$/.test(w) ? { type: 'text', value: w } : el('span', { className: ['fx'] }, [{ type: 'text', value: w }])));
}

export interface LangOptions {
  /** The answer is still being written: words fade in. */
  stream?: boolean;
  /** Show the writing cursor after the last word. */
  caret?: boolean;
}

/** Sets the language, direction and type size of every paragraph, list item, heading and table cell. */
export function langTree(tree: HNode, opts: LangOptions = {}): HNode {
  let lastBlock: HNode | null = null;
  const walk = (n: HNode) => {
    if (n.type === 'element' && n.tagName && SKIP.has(n.tagName)) {
      if (n.tagName === 'code') (n.properties ??= {}).dir = 'ltr';
      if (n.tagName === 'pre') lastBlock = n;
      return;
    }
    if (n.type === 'element' && n.tagName && BLOCKS.has(n.tagName)) {
      const d = detect(textOf(n));
      if (d.lang !== 'none') {
        const p = (n.properties ??= {});
        p.dir = d.dir;
        p.lang = d.dir === 'rtl' ? 'ar' : 'en';
        addClass(n, textClass(d));
      }
      isolate(n, d.dir, Boolean(opts.stream));
      lastBlock = n;
    }
    for (const c of n.children ?? []) walk(c);
    // A list follows most of its items; a table puts its first column on the side most of its cells read from.
    if (n.type === 'element' && (n.tagName === 'ul' || n.tagName === 'ol' || n.tagName === 'table')) {
      const cells: Dir[] = [];
      const collect = (x: HNode) => {
        for (const c of x.children ?? []) {
          if (c.type !== 'element') continue;
          const own = c.tagName === 'li' || c.tagName === 'td' || c.tagName === 'th';
          if (own && c.properties?.dir) cells.push(c.properties.dir as Dir);
          if (!own || n.tagName === 'table') collect(c);
        }
      };
      collect(n);
      if (cells.length) (n.properties ??= {}).dir = majority(cells);
    }
  };
  walk(tree);
  if (opts.caret && lastBlock && (lastBlock as HNode).tagName !== 'pre') {
    ((lastBlock as HNode).children ??= []).push(el('span', { className: ['caret'], ariaHidden: 'true' }, []));
  }
  return tree;
}

/** For react-markdown: `rehypePlugins={[[rehypeLang, { stream }]]}`. */
export function rehypeLang(opts: LangOptions = {}) {
  return (tree: HNode) => {
    langTree(tree, opts);
  };
}
