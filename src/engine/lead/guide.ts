import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../../utils/fs.js';

/**
 * squad-kit's own guide, the pages in its `docs/` folder, which ship with squad-kit. The lead reads them to explain
 * squad-kit itself ("why did squad-kit stop my story?"). Only those pages, by name: nothing else on disk.
 */

/** The most of one page the lead reads in one call. */
export const MAX_GUIDE_CHARS = 60_000;

export function guideDir(): string {
  return path.join(packageRoot(), 'docs');
}

/** The guide's pages: each one's name and title. */
export function guidePages(dir = guideDir()): { page: string; title: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => /^[\w-]+\.md$/.test(f)).sort();
  } catch {
    return [];
  }
  return names.map((f) => {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 400);
    const title = /^title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? f.replace(/\.md$/, '');
    return { page: f.replace(/\.md$/, ''), title };
  });
}

/** One page of the guide by its name, or null when there is no such page. */
export function guidePage(page: string, dir = guideDir()): { page: string; title: string; text: string } | null {
  const name = page.trim().replace(/\.md$/, '');
  const found = guidePages(dir).find((p) => p.page === name);
  if (!found) return null;
  const text = fs.readFileSync(path.join(dir, `${found.page}.md`), 'utf8');
  return { ...found, text: text.length > MAX_GUIDE_CHARS ? `${text.slice(0, MAX_GUIDE_CHARS)}\n(cut here)` : text };
}
