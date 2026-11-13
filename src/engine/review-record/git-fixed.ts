import type { ReviewNote } from '../../board/review-types.js';

/**
 * Whether the Builder's fix touched a note's place, read from git, never from an agent: the diff between the work as the
 * Reviewer read it and the Builder's fix, with no context lines.
 */

/** Lines a fix may sit away from the note's line and still count as fixing it. */
export const NEAR_LINES = 5;

/** One changed file of a diff: its old and new path, and the old-side line ranges that changed. */
export interface ChangedFile {
  from?: string;
  to?: string;
  /** [first, last] old-side lines; an insertion after line a is [a, a]. */
  ranges: [number, number][];
}

/** `git diff -U0` read file by file. */
export function readDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { ranges: [] };
      files.push(cur);
    } else if (cur && line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.from = p.replace(/^a\//, '');
    } else if (cur && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.to = p.replace(/^b\//, '');
    } else if (cur && line.startsWith('rename from ')) cur.from = line.slice(12).trim();
    else if (cur && line.startsWith('rename to ')) cur.to = line.slice(10).trim();
    else if (cur && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      cur.ranges.push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return files;
}

/** What git says about one note: fixed, or not sure (its file changed elsewhere, did not change, or it names none). */
export function fixedByGit(note: Pick<ReviewNote, 'file' | 'line'>, files: ChangedFile[]): boolean {
  if (!note.file) return false;
  const f = files.find((x) => x.from === note.file || x.to === note.file);
  if (!f) return false;
  // About a whole file: any change to it, or the file itself added, moved or removed.
  if (!note.line) return true;
  const lo = note.line - NEAR_LINES;
  const hi = note.line + NEAR_LINES;
  return f.ranges.some(([a, b]) => a <= hi && b >= lo);
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
