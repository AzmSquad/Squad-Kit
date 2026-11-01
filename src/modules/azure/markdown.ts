import { escapeHtml } from './client.js';

/**
 * Azure Boards comments and bug steps are HTML. squad-kit writes Markdown for every tracker, so this turns the small
 * part of Markdown it uses into HTML: paragraphs, line breaks, bullet and numbered lists, headings, bold, code and
 * links.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s{0,1}[-*] (.*)$/.exec(line);
    const numbered = /^\s{0,1}\d+\. (.*)$/.exec(line);
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(inline((bullet ?? numbered)![1]!));
    } else if (list && /^\s{2,}\S/.test(line)) {
      // An indented line goes on in the list item above it.
      list.items[list.items.length - 1] += `<br>${inline(line.trim())}`;
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(heading[1]!)}</h3>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`);
}
