import path from 'node:path';
import { now } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { ReviewNote, ReviewRecord, ReviewRound } from '../../board/review-types.js';
import { whereWords } from '../../board/review-doc.js';
import { openNotes } from './state.js';

/**
 * The Reviewer's notes, round by round (ADR-007). Its answer gives notes with a file and a line; squad-kit numbers them
 * across the story, keeps every round, and passes them to the Builder with where they point.
 */

/** The parts of the Reviewer's answer this reads and fills in. `comments` stays what the rest of the review step reads. */
export interface ReviewAnswer {
  approved: boolean;
  comments: string[];
  notes?: unknown;
  earlier?: unknown;
}

/** A note as the Reviewer wrote it, before squad-kit numbers it. */
export type SaidNote = Pick<ReviewNote, 'file' | 'line' | 'text'>;

/** A path from the story's folder: what the Reviewer wrote, without "./", a leading slash or the folder itself. */
export function cleanFile(file: unknown, folder?: string): string | undefined {
  if (typeof file !== 'string' || !file.trim()) return undefined;
  let f = file.trim().replace(/\\/g, '/');
  if (folder && path.isAbsolute(f)) {
    const rel = path.relative(folder, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    f = rel.split(path.sep).join('/');
  }
  f = f.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return f && !f.startsWith('../') ? f : undefined;
}

function cleanLine(line: unknown): number | undefined {
  return typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : undefined;
}

/** The notes in the answer: its `notes` when it gave them, else its plain `comments` (answers of the older shape). */
export function readNotes(out: Pick<ReviewAnswer, 'notes' | 'comments'>, folder?: string): SaidNote[] {
  if (Array.isArray(out.notes)) {
    return out.notes.flatMap((n: { file?: unknown; line?: unknown; text?: unknown }) => {
      const text = typeof n?.text === 'string' ? n.text.trim() : '';
      if (!text) return [];
      const file = cleanFile(n.file, folder);
      const line = file ? cleanLine(n.line) : undefined;
      return [{ ...(file ? { file } : {}), ...(line ? { line } : {}), text }];
    });
  }
  return (out.comments ?? []).filter((c) => typeof c === 'string' && c.trim()).map((c) => ({ text: c.trim() }));
}

/** One note as one line for the Builder, the activity and the stop card: "src/a.ts line 42: Round once, after tax." */
export function noteLine(n: SaidNote): string {
  const where = whereWords(n);
  return where ? `${where}: ${n.text}` : n.text;
}

/**
 * Reads the notes once, so `comments`, which the review step passes on, says where each one points. The notes it read
 * are given back, for recordRound.
 */
export function readAnswer(out: ReviewAnswer, folder?: string): SaidNote[] {
  const said = readNotes(out, folder);
  out.comments = said.map(noteLine);
  return said;
}

/** Every note of every round, oldest first. */
export function allNotes(record: ReviewRecord | undefined): ReviewNote[] {
  return (record?.rounds ?? []).flatMap((r) => r.notes);
}

/** The Reviewer's word on earlier notes git could not settle: fixed or not, by number. */
function earlierWord(earlier: unknown): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const e of Array.isArray(earlier) ? earlier : []) {
    const item = e as { n?: unknown; fixed?: unknown };
    if (typeof item?.n === 'number' && typeof item.fixed === 'boolean') out.set(item.n, item.fixed);
  }
  return out;
}

/**
 * Saves the round on the story. Before it, the Reviewer's word on the earlier notes git could not settle: one it says
 * is fixed is fixed in the Builder's last fix; one it says is not stays open, and goes back to the Builder with the new
 * notes when the round asks for changes. Checklist answers (a "no" to the team's list) come in as `extra`, with no file.
 */
export function recordRound(t: Ticket, out: ReviewAnswer, said: SaidNote[]): ReviewRound {
  const record: ReviewRecord = t.review ?? { rounds: [] };
  const last = record.rounds.at(-1);
  const word = earlierWord(out.earlier);
  const lastFix = Object.values(last?.fix ?? {})[0];
  const stillOpen: ReviewNote[] = [];
  for (const n of openNotes({ ...t, review: record })) {
    const fixed = word.get(n.n);
    if (fixed === true) n.fixed = { ...(lastFix ? { commit: lastFix } : {}), by: 'reviewer' };
    else if (fixed === false) stillOpen.push(n);
  }
  // Answers to the team's checklist come after the notes in `comments`, as plain sentences.
  const extra = out.comments.slice(said.length).map((text) => ({ text }));
  let next = allNotes(record).reduce((m, n) => Math.max(m, n.n), 0);
  const round: ReviewRound = { n: (last?.n ?? 0) + 1, at: now(), approved: out.approved, notes: [...said, ...extra].map((n) => ({ n: ++next, ...n })) };
  record.rounds.push(round);
  t.review = record;
  if (!out.approved && stillOpen.length) out.comments = [...out.comments, ...stillOpen.map(noteLine)];
  return round;
}

/** Old stories kept only the latest notes, as plain text: they read as round 1, with no file and line. */
export function withOldNotes(t: Pick<Ticket, 'review' | 'reviewNotes' | 'reviewAsked' | 'reviewRound' | 'createdAt'>): ReviewRecord | undefined {
  if (t.review?.rounds.length) return t.review;
  const old = t.reviewNotes?.length ? t.reviewNotes : t.reviewAsked;
  if (!old?.length) return t.review;
  return { ...t.review, rounds: [{ n: 1, at: t.createdAt, approved: false, notes: old.map((text, i) => ({ n: i + 1, text })) }] };
}
