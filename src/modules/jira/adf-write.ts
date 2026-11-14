import type { AdfNode } from './adf-read.js';

/**
 * squad-kit writes Markdown for every tracker; Jira takes ADF. This turns the part of Markdown squad-kit writes into
 * it: paragraphs (a single line break stays one), headings, bullet and numbered lists (nested by indent), code blocks,
 * quotes, bold, italic, inline code and links.
 */

type Mark = NonNullable<AdfNode['marks']>[number];

const INLINE: { re: RegExp; mark: (m: RegExpExecArray) => Mark; inner: (m: RegExpExecArray) => string; plain?: boolean }[] = [
  { re: /`([^`]+)`/, mark: () => ({ type: 'code' }), inner: (m) => m[1]!, plain: true },
  { re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/, mark: (m) => ({ type: 'link', attrs: { href: m[2]! } }), inner: (m) => m[1]! },
  { re: /\*\*(.+?)\*\*/, mark: () => ({ type: 'strong' }), inner: (m) => m[1]! },
  { re: /(?<![\w*])\*(?![\s*])([^*]+?)\*(?![\w*])/, mark: () => ({ type: 'em' }), inner: (m) => m[1]! },
  { re: /(?<![\w_])_(?![\s_])([^_]+?)_(?![\w_])/, mark: () => ({ type: 'em' }), inner: (m) => m[1]! },
];

function text(t: string, marks: Mark[]): AdfNode[] {
  return t ? [{ type: 'text', text: t, ...(marks.length ? { marks } : {}) }] : [];
}

/** One line of Markdown as ADF text nodes, the earliest mark first, its inside read again for marks within. */
function inlineOf(line: string, marks: Mark[] = []): AdfNode[] {
  let best: { at: number; m: RegExpExecArray; rule: (typeof INLINE)[number] } | null = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(line);
    if (m && (!best || m.index < best.at)) best = { at: m.index, m, rule };
  }
  if (!best) return text(line, marks);
  const { at, m, rule } = best;
  const inside = [...marks, rule.mark(m)];
  return [
    ...text(line.slice(0, at), marks),
    ...(rule.plain ? text(rule.inner(m), inside) : inlineOf(rule.inner(m), inside)),
    ...inlineOf(line.slice(at + m[0].length), marks),
  ];
}

/** Lines as one paragraph's content: each line break stays a line break. */
function lines(parts: string[]): AdfNode[] {
  return parts.flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inlineOf(l.trim())]);
}

interface ListLine {
  indent: number;
  ordered: boolean;
  num: number;
  text: string[];
}

const LIST = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/;

/** List lines as nested lists: a line indented more than the one above goes inside it. */
function listOf(items: ListLine[]): AdfNode {
  const make = (it: ListLine): AdfNode => ({ type: it.ordered ? 'orderedList' : 'bulletList', ...(it.ordered && it.num !== 1 ? { attrs: { order: it.num } } : {}), content: [] });
  const root = make(items[0]!);
  const stack: { indent: number; list: AdfNode }[] = [{ indent: items[0]!.indent, list: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1]!.indent) stack.pop();
    const top = stack[stack.length - 1]!;
    if (it.indent > top.indent) {
      const parent = top.list.content![top.list.content!.length - 1]!;
      const list = make(it);
      parent.content!.push(list);
      stack.push({ indent: it.indent, list });
    }
    stack[stack.length - 1]!.list.content!.push({ type: 'listItem', content: [{ type: 'paragraph', content: lines(it.text) }] });
  }
  return root;
}

function blocksOf(md: string): AdfNode[] {
  const out: AdfNode[] = [];
  const all = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let items: ListLine[] = [];
  const flush = () => {
    if (para.length) out.push({ type: 'paragraph', content: lines(para) });
    if (items.length) out.push(listOf(items));
    para = [];
    items = [];
  };
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!.trimEnd();
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    const item = LIST.exec(line);
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < all.length && !/^\s*```\s*$/.test(all[i]!); i += 1) code.push(all[i]!);
      out.push({ type: 'codeBlock', ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
    } else if (!line.trim()) {
      flush();
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      out.push({ type: 'rule' });
    } else if (item) {
      if (para.length) flush();
      items.push({ indent: item[1]!.length, ordered: Boolean(item[3]), num: Number(item[3] ?? 1), text: [item[4]!] });
    } else if (items.length && /^\s{2,}\S/.test(line)) {
      // An indented line goes on in the list item above it.
      items[items.length - 1]!.text.push(line);
    } else if (heading) {
      flush();
      out.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inlineOf(heading[2]!.trim()) });
    } else if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < all.length && /^\s*>/.test(all[i]!); i += 1) quoted.push(all[i]!.replace(/^\s*>\s?/, ''));
      i -= 1;
      out.push({ type: 'blockquote', content: blocksOf(quoted.join('\n')).filter((b) => b.type === 'paragraph' || b.type.endsWith('List') || b.type === 'codeBlock') });
    } else {
      if (items.length) flush();
      para.push(line);
    }
  }
  flush();
  return out;
}

/** A Markdown text as an ADF document Jira takes for a description, a comment or a rich text field. */
export function markdownToAdf(md: string): AdfNode & { version: 1 } {
  const content = blocksOf(md);
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}
