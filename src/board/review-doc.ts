import { splitHeader, withHeader } from './docs.js';
import type { ReviewNote, ReviewRecord, ReviewRound } from './review-types.js';
import { plainMarkdown } from '../core/safe-markdown.js';

/**
 * A story's review.md (ADR-001: a new part of a ticket is a new file in its folder). The header holds the record squad-kit
 * reads back; the text under it says the same for people, and is written again from the header on every save.
 */

/** "13 Nov 2026 10:42", in this computer's time. */
export function whenWords(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()} ${time}`;
}

/** Where a note points: "src/a.ts line 42", "src/a.ts", or nothing for the whole change. */
export function whereWords(n: Pick<ReviewNote, 'file' | 'line'>): string {
  if (!n.file) return '';
  return n.line ? `${n.file} line ${n.line}` : n.file;
}

function noteDoc(n: ReviewNote): string {
  const where = whereWords(n);
  const state = n.past ? ` (went past: ${n.past.reason}, ${n.past.by})` : n.fixed ? ` (fixed${n.fixed.commit ? ` in ${n.fixed.commit}` : ''})` : '';
  return `${n.n}. ${plainMarkdown(`${where ? `${where}: ` : ''}${n.text}${state}`)}`;
}

function roundDoc(r: ReviewRound): string {
  const head = `## Round ${r.n}, ${whenWords(r.at)}: ${r.approved ? 'approved' : 'changes asked'}`;
  const body = r.notes.length ? r.notes.map(noteDoc).join('\n') : 'No notes.';
  const fix = Object.values(r.fix ?? {});
  return `${head}\n\n${body}${fix.length ? `\n\nThe Builder's fix: ${fix.join(', ')}` : ''}`;
}

export function reviewDoc(title: string, record: ReviewRecord): string {
  const parts = [`# ${title}: review`, ...record.rounds.map(roundDoc)];
  const ok = record.looksRight;
  if (ok) parts.push(ok.byItself ? `squad-kit accepted it by itself, ${whenWords(ok.at)}` : `${plainMarkdown(ok.by)} approved: Looks right, ${whenWords(ok.at)}`);
  return withHeader(record as unknown as Record<string, unknown>, parts.join('\n\n'));
}

/** The ticket's documents, with review.md when it has a review. */
export function withReviewDoc(docs: Record<string, string>, t: { title: string; review?: ReviewRecord }): Record<string, string> {
  if (t.review) docs['review.md'] = reviewDoc(t.title, t.review);
  return docs;
}

/** The review from review.md's header, when there is one: a header with no rounds and no Looks right reads as none. */
export function parseReviewDoc(text: string | undefined): { review?: ReviewRecord } {
  if (!text) return {};
  const { header } = splitHeader(text);
  const rounds = Array.isArray(header.rounds) ? (header.rounds as ReviewRound[]).filter((r) => r && typeof r.n === 'number' && Array.isArray(r.notes)) : [];
  const looksRight = header.looksRight && typeof header.looksRight.by === 'string' ? (header.looksRight as ReviewRecord['looksRight']) : undefined;
  if (!rounds.length && !looksRight) return {};
  return { review: { rounds, ...(looksRight ? { looksRight } : {}) } };
}
