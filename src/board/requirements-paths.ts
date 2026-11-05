import path from 'node:path';
import type { BoardPaths } from './store.js';

/** Where breakdowns live: the project's part in `.squad/requirements/`, this computer's part beside the ticket state. */

/** A breakdown's id as it is written: BR-1, BR-2 … */
export const BREAKDOWN_ID = /^BR-\d{1,9}$/;

/** Only a breakdown id ever names a folder or a file, never anything a file or a request said. */
function checked(id: string): string {
  if (!BREAKDOWN_ID.test(id)) throw new Error(`"${id.slice(0, 40)}" is not a breakdown id (BR-1, BR-2 …).`);
  return id;
}

/** `.squad/requirements/`: one folder per breakdown. */
export function requirementsDir(bp: BoardPaths): string {
  return path.join(bp.squadDir, 'requirements');
}

/** `.squad/requirements/BR-1/`: breakdown.yaml, with the document in source/, its text in text/ and its pictures in media/. */
export function breakdownDir(bp: BoardPaths, id: string): string {
  return path.join(requirementsDir(bp), checked(id));
}

export function breakdownFile(bp: BoardPaths, id: string): string {
  return path.join(breakdownDir(bp, id), 'breakdown.yaml');
}

/** The document's text, split in parts the Analyst reads one by one (part-01.md …), and its pictures. */
export function breakdownTextDir(bp: BoardPaths, id: string): string {
  return path.join(breakdownDir(bp, id), 'text');
}

export function breakdownMediaDir(bp: BoardPaths, id: string): string {
  return path.join(breakdownDir(bp, id), 'media');
}

/** This computer's part: the Analyst's job, the build switch and the send's progress. */
export function breakdownStateFile(bp: BoardPaths, id: string): string {
  return path.join(bp.localDir, 'requirements', `${checked(id)}.yaml`);
}
