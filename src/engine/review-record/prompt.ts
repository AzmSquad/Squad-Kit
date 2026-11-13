import type { Ticket } from '../../board/types.js';
import { noteLine } from './notes.js';
import type { ReviewNote } from '../../board/review-types.js';
import { fixesToConfirm, openNotes } from './state.js';

/**
 * What the Reviewer is asked about its notes (ADR-007): each with its file and line, and, from the second round, whether
 * the earlier notes git could not settle are fixed. Shown read only on the Harness page, so it stays plain.
 */

const STR = { type: 'string' } as const;

/** Each note: the file from the story's folder, the line in it, and one sentence. Only the sentence is a must. */
export const REVIEW_NOTES = {
  type: 'array',
  items: { type: 'object', properties: { file: STR, line: { type: 'integer' }, text: STR }, required: ['text'] },
} as const;

/** The Reviewer's word on earlier notes, by their number. */
export const EARLIER_NOTES = {
  type: 'array',
  items: { type: 'object', properties: { n: { type: 'integer' }, fixed: { type: 'boolean' } }, required: ['n', 'fixed'] },
} as const;

const NOTES_RULE = `Write each problem in notes: one concrete sentence, the file it is in (its path from this folder) and the
line in that file as it is now. Leave out the line when it is about a whole file, and the file when it is about the whole
change.`;

/**
 * The rule, then the earlier notes the Reviewer settles this round: the fixes git found, to confirm or reopen, and the
 * notes git could not settle, with the commit that changed their file when one did.
 */
export function notesAsk(t: Pick<Ticket, 'review' | 'overrides'>): string {
  const found = fixesToConfirm(t);
  const open = openNotes(t);
  if (!found.length && !open.length) return NOTES_RULE;
  const line = (n: ReviewNote) => `${n.n}. ${noteLine(n)}${n.touched ? ` (its place changed in ${n.touched})` : ''}`;
  const parts = [NOTES_RULE];
  if (found.length) parts.push(`squad-kit saw the Builder change the lines of these earlier notes, so it counts them as fixed:\n${found.map(line).join('\n')}`);
  if (open.length) parts.push(`squad-kit could not tell whether these earlier notes are fixed:\n${open.map(line).join('\n')}`);
  parts.push(`For each one, say in earlier whether the code handles it now: its number, and fixed true or false. One that is not
fixed stays open, so do not write it again in notes.`);
  return parts.join('\n');
}
