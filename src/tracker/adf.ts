type AdfNode = {
  type: string;
  text?: string;
  content?: AdfNode[];
};

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'rule',
  'panel',
  'table',
  'tableRow',
]);

export function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const lines: string[] = [];
  walk(node as AdfNode, lines);
  return lines.join('').trim();
}

function walk(node: AdfNode, out: string[]): void {
  if (!node) return;
  if (typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, out);
  }
  if (BLOCK_TYPES.has(node.type)) {
    // ensure block separation
    if (out.length > 0 && !out[out.length - 1]!.endsWith('\n\n')) {
      out.push('\n\n');
    }
  }
}
