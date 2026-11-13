import type { ReviewRecord } from '../../board/review-types.js';
import { whenWords, whereWords } from '../../board/review-doc.js';
import { plainMarkdown } from '../../core/safe-markdown.js';
import type { NoteView } from './view.js';

/** The review's own sentences, the same in the pull request, the merge commit and the terminal. */

/**
 * "Momen approved: Looks right, 13 Nov 2026 10:42", or the squad's own accept, which no person approved. `bold`: for
 * Markdown, the name in bold and as plain text.
 */
export function approvalWords(ok: NonNullable<ReviewRecord['looksRight']>, bold = false): string {
  if (ok.byItself) return `squad-kit accepted it by itself, on the Builds by itself track, ${whenWords(ok.at)}`;
  return `${bold ? `**${plainMarkdown(ok.by)}**` : ok.by} approved: Looks right, ${whenWords(ok.at)}`;
}

/** "Fixed in a3f9c21", "Fixed, the Reviewer says", "Went past", "Open". */
export function stateWords(n: Pick<NoteView, 'state' | 'fixed'>): string {
  if (n.state === 'fixed') return n.fixed?.commit ? `Fixed in ${n.fixed.commit}` : 'Fixed, the Reviewer says';
  return n.state === 'past' ? 'Went past' : 'Open';
}

/** The person's reason for going past a note: "Momen's reason: later, in MA-30. Recorded on 13 Nov 2026 10:40." */
export function reasonWords(n: Pick<NoteView, 'past'>): string {
  return n.past ? `${n.past.by}'s reason: ${n.past.reason.trim().replace(/[.\s]+$/, '')}. Recorded on ${whenWords(n.past.at)}.` : '';
}

/** One note in one line, cut to `most` characters: "src/a.ts line 42: Round once, after tax." */
export function oneLine(n: Pick<NoteView, 'file' | 'line' | 'text'>, most = 140): string {
  const where = whereWords(n);
  const text = `${where ? `${where}: ` : ''}${n.text.replace(/\s+/g, ' ').trim()}`;
  return text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;
}
