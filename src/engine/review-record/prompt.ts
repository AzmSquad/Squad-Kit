import type { Ticket } from '../../board/types.js';
import { noteLine } from './notes.js';
import { openNotes } from './state.js';

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

/** The rule, and the earlier notes nothing settled yet: squad-kit saw no change near them, so the Reviewer says. */
export function notesAsk(t: Pick<Ticket, 'review' | 'overrides'>): string {
  const open = openNotes(t);
  if (!open.length) return NOTES_RULE;
  return `${NOTES_RULE}
squad-kit could not tell from the Builder's changes whether these earlier notes are fixed:
${open.map((n) => `${n.n}. ${noteLine(n)}`).join('\n')}
For each one, say in earlier whether the code handles it now: its number, and fixed true or false. One that is not
fixed stays open, so do not write it again in notes.`;
}
