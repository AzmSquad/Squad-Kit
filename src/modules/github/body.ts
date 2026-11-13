/**
 * An issue's text as the squad reads it, and the files people put in it. GitHub keeps both in one Markdown body: the
 * "done when" lines under a Done when (or Acceptance criteria) heading, and uploads as links to GitHub's own storage.
 */

/** Only files GitHub itself holds count as attachments, and only these get the sign-in when downloaded. */
const HOSTED =
  /^https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/|github\.com\/[\w.-]+\/[\w.-]+\/(?:assets|files)\/|(?:private-)?user-images\.githubusercontent\.com\/|objects\.githubusercontent\.com\/)/i;

export function hostedFile(url: string): boolean {
  return HOSTED.test(url);
}

/** Every uploaded image and file linked in the body, once each, with a name to save it under. */
export function attachmentsOf(body: string): { name: string; url: string; size: number }[] {
  const found: { name: string; url: string; size: number }[] = [];
  const add = (text: string, url: string) => {
    if (!hostedFile(url) || found.some((f) => f.url === url)) return;
    const raw = url.split(/[?#]/)[0]!.split('/').pop() ?? '';
    let last = raw;
    try {
      last = decodeURIComponent(raw);
    } catch {
      // A stray % in a link: its name stays as written.
    }
    const name = [text.trim(), last].find((n) => /\.[A-Za-z0-9]{2,5}$/.test(n)) ?? `image-${found.length + 1}.png`;
    found.push({ name, url, size: 0 });
  };
  for (const m of body.matchAll(/!?\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g)) add(m[1]!, m[2]!);
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    if (src) add(/\balt="([^"]*)"/i.exec(m[0])?.[1] ?? '', src);
  }
  return found;
}

const CRITERIA = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:done when|acceptance criteria)(?:\*\*)?:?(?:\*\*)?[ \t]*$/im;

/** The text without HTML comments, its pictures as Markdown, and the "done when" part apart. */
export function textOf(body: string | null | undefined): { description: string; acceptance: string } {
  const text = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
      return src ? `![${/\balt="([^"]*)"/i.exec(tag)?.[1] ?? 'image'}](${src})` : '';
    })
    .replace(/\r\n/g, '\n');
  const at = CRITERIA.exec(text);
  if (!at) return { description: text.trim(), acceptance: '' };
  return { description: text.slice(0, at.index).trim(), acceptance: text.slice(at.index + at[0].length).trim() };
}

/** The body squad-kit writes: the text, then Done when. */
export function bodyOf(markdown: string, acceptance: string | undefined): string {
  return [markdown.trim(), acceptance?.trim() ? `**Done when**\n\n${acceptance.trim()}` : ''].filter(Boolean).join('\n\n');
}
