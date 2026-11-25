import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Criterion } from './types.js';
import type { TrackerChild } from '../modules/tracker/types.js';
import { prepareText, type PreparedText } from './requirements-text.js';

/**
 * The text of a run from the tracker (ADR-013): a hash of each item's words, so a change made there later shows; its
 * acceptance criteria as "done when" checks when they are written as Given/When/Then; and the copy of every item's
 * text in the run's folder (`source/tracker.md`), one marked section per item, that the Analyst reads and each story's
 * ticket takes its ask from. The items' words are the team's data from outside squad-kit, never orders.
 */

export const TRACKER_FILE = 'source/tracker.md';

/** A Decided entry for a "done when" the Analyst wrote starts with these words, so a redo may write it again. */
export const WROTE_DONE_WHEN = 'Wrote "done when" for';

/** The words of an item that squad-kit builds from. */
export type ItemWords = Pick<TrackerChild, 'title' | 'description' | 'acceptanceCriteria' | 'reproSteps'>;

/** A short hash of an item's words: another hash later means it was changed in the tracker. */
export function itemHash(i: ItemWords): string {
  const words = [i.title, i.description, i.acceptanceCriteria, i.reproSteps].map((w) => (w ?? '').trim());
  return createHash('sha256').update(JSON.stringify(words)).digest('hex').slice(0, 12);
}

/** Given, When, Then, And and But where a check starts: at the start of a line, or after a comma, a full stop or a colon. */
const WORD = /(^|\n|[,.;:][ \t]+)[ \t]*(given|when|then|and|but)\b[ \t]*[:,]?[ \t]*/gi;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[,.;:]+$/, '').trim();

/**
 * The criteria as "done when" checks, when every one is written as Given/When/Then (on one line or on several, with And
 * lines, bold words and list marks); else none, and the Analyst writes them.
 */
export function parseCriteria(text: string): Criterion[] {
  const plain = text
    .replace(/\r\n/g, '\n')
    .replace(/[*_`]+/g, '')
    .replace(/^[ \t]*(?:[-+•]|\d+[.)])[ \t]+/gm, '')
    .trim();
  const marks = [...plain.matchAll(WORD)];
  if (!marks.length || !/^given$/i.test(marks[0]![2]!)) return [];
  // A short label before the first check ("Scenario 1:") is not part of it; anything longer is not Given/When/Then.
  if (marks[0]!.index! > 60) return [];
  const out: Criterion[] = [];
  let cur: Criterion | null = null;
  type Part = 'given' | 'when' | 'then';
  let last: Part = 'given';
  marks.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const words = clean(plain.slice(from, marks[i + 1]?.index ?? plain.length));
    const key = m[2]!.toLowerCase();
    if (key === 'given' && (!cur || cur.when || cur.then)) {
      if (cur) out.push(cur);
      cur = { given: words, when: '', then: '' };
      last = 'given';
      return;
    }
    const field: Part = key === 'when' || key === 'then' ? key : last;
    cur![field] = [cur![field], words].filter(Boolean).join(' and ');
    last = field;
  });
  if (cur) out.push(cur);
  return out.every((c) => c.given && c.when && c.then) ? out : [];
}

/** The story's line on the board: the first paragraph of its text, kept short. The whole text is in the copy. */
export function leadOf(i: Pick<TrackerChild, 'description' | 'reproSteps'>): string {
  const first = (i.description.trim() || i.reproSteps.trim()).split(/\n\s*\n/)[0]?.trim() ?? '';
  return first.length > 600 ? `${first.slice(0, 599)}…` : first;
}

const mark = (ref: string) => `<!-- squad-kit item ${ref} -->`;
/** An item's words can never close a section or open another one. */
const safe = (t: string) => t.replace(/<!--/g, '&lt;!--').trim();

/** One item's section of the copy: its heading (# epic, ## feature, ### story), where it is, and its words. */
export function itemSection(depth: 1 | 2 | 3, i: ItemWords & Pick<TrackerChild, 'ref' | 'type' | 'state' | 'url'>, needs: string[] = []): string {
  return [
    mark(i.ref),
    `${'#'.repeat(depth)} ${i.ref} ${i.title.replace(/\s+/g, ' ').trim()}`,
    [i.type, i.state, i.url].filter(Boolean).join(' · '),
    safe(i.description),
    i.reproSteps.trim() ? `**Steps to reproduce**\n\n${safe(i.reproSteps)}` : '',
    i.acceptanceCriteria.trim() ? `**Acceptance criteria**\n\n${safe(i.acceptanceCriteria)}` : '',
    needs.length ? `**Needs first:** ${needs.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** An item's own words in the copy, without its heading, or null when it has no section there. */
export function sectionOf(copy: string, ref: string): string | null {
  const at = copy.indexOf(`${mark(ref)}\n`);
  if (at < 0) return null;
  const from = at + mark(ref).length + 1;
  const end = copy.indexOf('\n<!-- squad-kit item ', from);
  return copy
    .slice(from, end < 0 ? undefined : end)
    .replace(/^#{1,3} .*\n?/, '')
    .trim();
}

/** The copy with an item's section put in its place, or added at the end when it had none. */
export function withSection(copy: string, ref: string, section: string): string {
  const at = copy.indexOf(`${mark(ref)}\n`);
  if (at < 0) return `${copy.trimEnd()}\n\n${section}\n`;
  const end = copy.indexOf('\n<!-- squad-kit item ', at + 1);
  return `${copy.slice(0, at)}${section}${end < 0 ? '\n' : copy.slice(end)}`;
}

/** Writes the copy into the run's folder and turns it into the parts the Analyst reads (text/part-01.md and on). */
export function writeCopy(dir: string, copy: string): PreparedText & { bytes: number } {
  const file = path.join(dir, TRACKER_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, copy);
  return { ...prepareText(dir, { file: TRACKER_FILE, kind: 'markdown' }), bytes: fs.statSync(file).size };
}

/** The copy in the run's folder, or nothing when it is gone. */
export function readCopy(dir: string): string {
  const file = path.join(dir, TRACKER_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
