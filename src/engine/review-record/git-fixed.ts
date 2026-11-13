import type { ReviewNote } from '../../board/review-types.js';

/**
 * Whether the Builder's fix touched a note's place, read from git, never from an agent: the diff between the work as the
 * Reviewer read it and the Builder's fix, with no context lines.
 */

/** Lines a change may sit away from a note's line and still touch it, when no change overlaps the line itself. */
export const NEAR_LINES = 2;

/** One changed file of a diff: its old and new path, whether it was removed, and the old-side lines that changed. */
export interface ChangedFile {
  from?: string;
  to?: string;
  deleted: boolean;
  /** [first, last] old-side lines; lines added after line a are [a, a + 1], the two lines they sit between. */
  ranges: [number, number][];
}

/** `git diff -U0` read file by file. */
export function readDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { deleted: false, ranges: [] };
      files.push(cur);
    } else if (cur && line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.from = p.replace(/^a\//, '');
    } else if (cur && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') cur.deleted = true;
      else cur.to = p.replace(/^b\//, '');
    } else if (cur && line.startsWith('deleted file mode')) cur.deleted = true;
    else if (cur && line.startsWith('rename from ')) cur.from = line.slice(12).trim();
    else if (cur && line.startsWith('rename to ')) cur.to = line.slice(10).trim();
    else if (cur && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      cur.ranges.push(count ? [start, start + count - 1] : [start, start + 1]);
    }
  }
  return files;
}

const away = (line: number, [a, b]: [number, number]) => (line < a ? a - line : line > b ? line - b : 0);

/**
 * The notes a change touched, by number. Each changed run of lines touches the notes it overlaps; with none, only the
 * nearest note within NEAR_LINES, so one change never settles a neighbour too. A note about a whole file is touched by
 * any change in it. A removed file touches nothing: removing code is not fixing it.
 */
export function touchedNotes(notes: Pick<ReviewNote, 'n' | 'file' | 'line'>[], files: ChangedFile[]): Set<number> {
  const out = new Set<number>();
  for (const f of files) {
    if (f.deleted || !f.ranges.length) continue;
    const here = notes.filter((n) => n.file && (n.file === f.from || n.file === f.to));
    for (const n of here) if (!n.line) out.add(n.n);
    const lined = here.filter((n): n is typeof n & { line: number } => Boolean(n.line));
    for (const r of f.ranges) {
      const exact = lined.filter((n) => away(n.line, r) === 0);
      const near = lined.filter((n) => away(n.line, r) <= NEAR_LINES).sort((x, y) => away(x.line, r) - away(y.line, r) || x.n - y.n);
      for (const n of exact.length ? exact : near.slice(0, 1)) out.add(n.n);
    }
  }
  return out;
}

/**
 * Where a line of the work as the Reviewer read it is now, after later changes to its file: shifted by what was added or
 * removed above it. A line that was itself changed keeps the place its change starts at.
 */
export function lineNow(line: number, file: string, diff: string): number {
  let shift = 0;
  let cur: string | undefined;
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) cur = l.slice(4).trim().replace(/^a\//, '');
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m || cur !== file) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    // An insertion after line a (count 0) moves only the lines after a.
    const oldEnd = oldCount ? oldStart + oldCount - 1 : oldStart;
    if (oldCount ? oldEnd < line : oldStart < line) shift += newCount - oldCount;
    else if (oldCount && oldStart <= line) return Math.max(1, newStart);
  }
  return Math.max(1, line + shift);
}
