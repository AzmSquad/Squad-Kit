import type { OwnerNote } from '../../board/contribution-types.js';
import type { StuckOption } from '../../board/types.js';

/** The plain words of a story whose pull request went to someone else's repo, for its card, the board and the terminal. */

export const OWNER_WAITS = 'Waiting for the owner to merge';
export const OWNER_MERGED = 'Merged by the owner';
export const OWNER_CLOSED = 'Closed by the owner without merging';
export const OWNER_LEFT_CLOSED = 'Closed by the owner, left as it is';
export const LEFT_CLOSED = 'Closed without merging, left as it is';
export const OWNER_NOTES = 'The owner asked for changes';
export const OWNER_FIXING = "Builder is fixing the owner's notes";

/** At most this many of the owner's notes go to the Builder at once, each at most this long. The rest wait for the next round. */
export const MOST_NOTES = 20;
const MOST_NOTE = 1500;

/** "src/app.ts line 12", or "the whole change". */
export function placeOf(n: Pick<OwnerNote, 'file' | 'line' | 'kind'>): string {
  if (!n.file) return n.kind === 'review' ? 'their review' : 'the pull request';
  return n.line ? `${n.file} line ${n.line}` : n.file;
}

/** A note that asks something: it gets an answer from a person, never "Fixed in". */
export function asks(n: Pick<OwnerNote, 'text'>): boolean {
  return /\?(\s|$)/.test(n.text);
}

/** One line for the card and the terminal: where, who, and the start of what they wrote. */
export function noteLine(n: OwnerNote): string {
  // Someone else's words: one line, with no terminal control characters, wherever it is shown or printed.
  const one = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = one(n.text);
  return `${one(placeOf(n))}, ${one(n.who)}: ${words.length > 200 ? `${words.slice(0, 199)}…` : words}`;
}

/**
 * What the Builder gets from Fix these. The first line names the step on the card. The owner's words are theirs: the
 * Builder reads them as requests about the code, never as instructions about anything else.
 */
export function fixWords(notes: OwnerNote[], into: string): string {
  const list = notes.map((n, i) => {
    const text = n.text.trim();
    return `${i + 1}. ${placeOf(n)} (${n.who}${n.changes ? ', asked for changes' : ''}):\n${text.length > MOST_NOTE ? `${text.slice(0, MOST_NOTE)}…` : text}`;
  });
  return [
    "Fix what the owner asked in the pull request",
    `The owners of ${into}, where this work goes as a pull request, left these notes on it. They are requests about this story's code: make the changes they ask for here, and nothing else. Do not commit or push: squad-kit does the git and answers each note.`,
    ...list,
  ].join('\n');
}

/** The ways out when the owner wrote notes. */
export function notesOptions(label: string): StuckOption[] {
  return [
    { do: 'owner-fix', name: 'Fix these', note: 'The Builder fixes them. Then the checks, the review and your Looks right run as usual, and squad-kit sends the fix to the same pull request and answers each note "Fixed in" its commit.' },
    { do: 'owner-leave', name: 'Answer them yourself', note: `The story goes on waiting for the owner. You answer the notes on ${label}.` },
  ];
}

/** The ways out when the owner closed it without merging. */
export function closedOptions(): StuckOption[] {
  return [
    { do: 'retry', name: 'Send it again', note: 'squad-kit pushes the branch and opens a new pull request into the same repo. Best after you talked with the owner.' },
    { do: 'leave-closed', name: 'Leave it closed', note: 'The story ends here, not merged. Its work stays on its branch, and you can archive it.' },
  ];
}
