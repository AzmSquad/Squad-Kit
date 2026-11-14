/**
 * Jira keeps descriptions and comments as ADF (Atlassian Document Format), a JSON tree. The squad reads Markdown, so
 * this turns the tree into it: headings, lists, code, links, tables, mentions, and pictures or files as their names.
 * A node it does not know gives its text.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function marked(node: AdfNode): string {
  let text = node.text ?? '';
  if (!text) return '';
  const marks = node.marks ?? [];
  const has = (t: string) => marks.some((m) => m.type === t);
  if (has('code')) text = `\`${text}\``;
  if (has('strong')) text = `**${text}**`;
  if (has('em')) text = `*${text}*`;
  if (has('strike')) text = `~~${text}~~`;
  const link = marks.find((m) => m.type === 'link');
  if (link && str(link.attrs?.href)) text = `[${text}](${str(link.attrs?.href)})`;
  return text;
}

function inline(nodes: AdfNode[] = []): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return marked(n);
        case 'hardBreak':
          return '\n';
        case 'mention': {
          const name = str(n.attrs?.text) || 'someone';
          return name.startsWith('@') ? name : `@${name}`;
        }
        case 'emoji':
          return str(n.attrs?.text) || str(n.attrs?.shortName);
        case 'inlineCard':
          return str(n.attrs?.url);
        case 'date': {
          const ms = Number(n.attrs?.timestamp);
          return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';
        }
        case 'status':
          return `[${str(n.attrs?.text)}]`;
        case 'media':
        case 'mediaInline':
          return media(n);
        default:
          return n.text ?? inline(n.content);
      }
    })
    .join('');
}

/** A picture or file in the text: its name, as the attachments list has it. A picture from the web keeps its link. */
function media(n: AdfNode): string {
  const name = str(n.attrs?.alt) || str(n.attrs?.fileName);
  if (n.attrs?.type === 'external' && str(n.attrs?.url)) return `![${name || 'image'}](${str(n.attrs?.url)})`;
  return name ? `[attachment: ${name}]` : '[attachment]';
}

const indent = (text: string, by: string) => text.replace(/\n(?=.)/g, `\n${by}`);

function list(node: AdfNode): string {
  const start = Number(node.attrs?.order ?? 1) || 1;
  return (node.content ?? [])
    .map((item, i) => {
      const lead = node.type === 'orderedList' ? `${start + i}. ` : item.type === 'taskItem' ? `- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ` : '- ';
      const body = item.type === 'taskItem' || item.type === 'decisionItem' ? inline(item.content) : blocks(item.content, '\n');
      return lead + indent(body, ' '.repeat(lead.length));
    })
    .join('\n');
}

function cell(node: AdfNode): string {
  return blocks(node.content, ' ').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function table(node: AdfNode): string {
  const rows = (node.content ?? []).map((r) => (r.content ?? []).map(cell));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function block(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inline(node.content)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'decisionList':
      return list(node);
    case 'codeBlock':
      return `\`\`\`${str(node.attrs?.language)}\n${(node.content ?? []).map((t) => t.text ?? '').join('')}\n\`\`\``;
    case 'blockquote':
    case 'panel':
      return blocks(node.content).replace(/^/gm, '> ');
    case 'rule':
      return '---';
    case 'table':
      return table(node);
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? []).map(media).join('\n');
    case 'expand':
    case 'nestedExpand': {
      const title = str(node.attrs?.title);
      return [title ? `**${title}**` : '', blocks(node.content)].filter(Boolean).join('\n\n');
    }
    case 'blockCard':
    case 'embedCard':
      return str(node.attrs?.url);
    default:
      return node.content ? (node.content.some((c) => c.type === 'text') ? inline(node.content) : blocks(node.content)) : (node.text ?? '');
  }
}

function blocks(nodes: AdfNode[] = [], gap = '\n\n'): string {
  return nodes
    .map(block)
    .filter((b) => b.trim())
    .join(gap);
}

/** A description, comment or text field as Markdown. A field kept as plain text comes back as it is. */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const node = value as AdfNode;
  return (node.type === 'doc' ? blocks(node.content) : block(node)).replace(/\n{3,}/g, '\n\n').trim();
}
