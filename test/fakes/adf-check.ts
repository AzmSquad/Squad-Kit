/**
 * The checks Jira Cloud makes on an ADF document before it takes it, for the fake Jira: known nodes only, text never
 * empty, marks it allows (never one twice, code only with a link, a link with its address), a heading with its level,
 * lists and quotes never empty, and only what each block may hold. Returns the first problem, or null.
 */

type Node = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; marks?: { type?: unknown; attrs?: Record<string, unknown> }[]; content?: Node[]; version?: unknown };

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date', 'status']);
const MARKS = new Set(['strong', 'em', 'code', 'link', 'strike', 'underline', 'textColor', 'subsup']);
/** What a block may hold: 'inline', or the block types. */
const HOLDS: Record<string, 'inline' | 'none' | string[]> = {
  paragraph: 'inline',
  heading: 'inline',
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: ['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaSingle'],
  blockquote: ['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaGroup', 'mediaSingle'],
  codeBlock: ['text'],
  rule: 'none',
  hardBreak: 'none',
};
const NOT_EMPTY = new Set(['bulletList', 'orderedList', 'listItem', 'blockquote']);

function markProblem(n: Node): string | null {
  const types = (n.marks ?? []).map((m) => String(m.type));
  if (types.some((t) => !MARKS.has(t))) return `unknown mark in ${types.join(', ')}`;
  if (new Set(types).size !== types.length) return `the same mark twice: ${types.join(', ')}`;
  if (types.includes('code') && types.some((t) => t !== 'code' && t !== 'link')) return `code with ${types.join(', ')}`;
  const link = (n.marks ?? []).find((m) => m.type === 'link');
  if (link && typeof link.attrs?.href !== 'string') return 'a link without its address';
  return null;
}

function nodeProblem(n: Node): string | null {
  const type = String(n.type);
  if (type === 'text') return typeof n.text === 'string' && n.text ? markProblem(n) : 'an empty text';
  const holds = HOLDS[type];
  if (!holds) return INLINE.has(type) ? null : `unknown node ${type}`;
  if (type === 'heading' && !(Number(n.attrs?.level) >= 1 && Number(n.attrs?.level) <= 6)) return 'a heading without its level';
  const content = n.content ?? [];
  if (holds === 'none' && content.length) return `${type} holds content`;
  if (NOT_EMPTY.has(type) && !content.length) return `an empty ${type}`;
  if (type === 'listItem' && !['paragraph', 'codeBlock', 'mediaSingle'].includes(String(content[0]?.type))) return 'a list item that does not start with a paragraph';
  for (const child of content) {
    const ok = holds === 'inline' ? INLINE.has(String(child.type)) : Array.isArray(holds) && holds.includes(String(child.type));
    if (!ok) return `${type} holding ${String(child.type)}`;
    if (type === 'codeBlock' && child.marks?.length) return 'marks in a code block';
    const deeper = nodeProblem(child);
    if (deeper) return deeper;
  }
  return null;
}

/** The first problem Jira would find in this document, or null. */
export function adfProblem(value: unknown): string | null {
  const doc = value as Node;
  if (!doc || doc.type !== 'doc' || doc.version !== 1 || !Array.isArray(doc.content)) return 'not an ADF document';
  for (const block of doc.content) {
    const type = String(block.type);
    if (INLINE.has(type) || type === 'listItem') return `${type} straight in the document`;
    const problem = nodeProblem(block);
    if (problem) return problem;
  }
  return null;
}
