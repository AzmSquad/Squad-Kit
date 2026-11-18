import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

/**
 * The link at the top of an open ticket to the story on its tracker (#29). It used to start with a download icon, which
 * read as "download a file". Now it starts with the tracker's own small mark, in the text's colour, and says in words
 * where the story came from. Real React, rendered to text.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown };
const { renderToStaticMarkup } = (await import(/* @vite-ignore */ file('node_modules/react-dom/server.node.js'))) as { renderToStaticMarkup(n: unknown): string };
const { TrackerMark, pulledFrom, trackerName } = await import(/* @vite-ignore */ file('src/components/TrackerMark.tsx'));

const mark = (type: string) => renderToStaticMarkup(React.createElement(TrackerMark, { type }));

describe("the tracker's mark on a pulled story's link", () => {
  it('each tracker squad-kit pulls from has its own mark, in the text colour, hidden from screen readers', () => {
    const seen = new Set<string>();
    for (const type of ['azure', 'jira', 'github']) {
      const svg = mark(type);
      expect(svg, type).toMatch(/^<svg class="tracker-mark"/);
      expect(svg, type).toContain('fill="currentColor"');
      expect(svg, type).toContain('aria-hidden="true"');
      seen.add(/ d="([^"]+)"/.exec(svg)![1]!);
    }
    expect(seen.size).toBe(3);
  });

  it('a tracker with no mark gets a plain link icon, never the download one', () => {
    expect(mark('linear')).toContain('lucide-link');
    expect(mark('linear')).not.toContain('download');
  });

  it('says where the story came from, in words', () => {
    expect(pulledFrom('azure', true)).toBe('Pulled from Azure DevOps. Opens it there.');
    expect(pulledFrom('jira', false)).toBe('Pulled from Jira');
    expect(pulledFrom('github', true)).toBe('Pulled from GitHub. Opens it there.');
    expect(pulledFrom('linear', true)).toBe('Pulled from your tracker. Opens it there.');
    expect(trackerName('manual')).toBeNull();
  });

  it('the open ticket uses it, and the download icon is gone from its top row', () => {
    const drawer = fs.readFileSync(file('src/pages/TicketDrawer.tsx'), 'utf8');
    expect(drawer).toContain('<TrackerMark type={t.source.type} />');
    expect(drawer).not.toMatch(/\bDownload\b/);
  });
});
