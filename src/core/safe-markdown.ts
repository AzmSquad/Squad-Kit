/**
 * Words an agent or a person wrote, made safe to put in Markdown a code host shows (ADR-007): one paragraph, no HTML,
 * no links or pictures, no headings, lists, quotes or bold, and no mentions. They read as written, as plain text. A
 * note from an agent that was talked into it can then never make the page load an address, fake a line of squad-kit's
 * own, or call people in.
 */

/** Markdown's own marks, shown as themselves. */
const MARKS = /[\\`*_{}[\]()#+!|~^=]/g;

export function plainMarkdown(text: string, most = 2000): string {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > most) s = `${s.slice(0, most - 1).trimEnd()}…`;
  return (
    s
      // A web address shows as its site only: never a link or a picture the page would load.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/+([^\s/?#\\)\]>"']*)[^\s)\]>"']*/gi, (_all, site: string) => `${site.replace(/^www\./i, '') || 'a web address'} (link left out)`)
      .replace(/\bwww\./gi, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(MARKS, '\\$&')
      // A mention, or an email address a host would turn into a link.
      .replace(/@/g, '＠')
      // A line that starts like a list item ("1." or "-"; "1)" is escaped above).
      .replace(/^(\d+)\./, '$1\\.')
      .replace(/^-/, '\\-')
  );
}
