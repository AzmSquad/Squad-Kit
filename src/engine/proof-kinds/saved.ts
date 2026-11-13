import { hasKinds } from '../../board/proof-rows.js';
import type { Ticket } from '../../board/types.js';
import { isApiProof } from '../proof-verdict.js';
import { isRowsProof } from './rows.js';

/** A proof squad-kit saved as a file of its own, not a picture: an API answer, rows, a test run, a Reviewer's check. */
export const isSavedProof = (file: string): boolean => isApiProof(file) || isRowsProof(file) || /\.(test|none)\.json$/.test(file);

/** The Tester's activity line for one round: "Saved 2 screenshots and 1 answer from the API", with any rows it read. */
export function savedWords(files: string[], rejected: number): string {
  const answers = files.filter(isApiProof).length;
  const rows = files.filter(isRowsProof).length;
  const pictures = files.length - answers - rows - rejected;
  if (!rows && (pictures || !answers)) return `Saved ${pictures} ${answers && pictures === 1 ? 'screenshot' : 'screenshots'}${answers ? ` and ${answers} ${answers === 1 ? 'answer' : 'answers'} from the API` : ''}`;
  const parts = [pictures ? `${pictures} ${pictures === 1 ? 'screenshot' : 'screenshots'}` : '', answers ? `${answers} ${answers === 1 ? 'answer' : 'answers'} from the API` : '', rows ? `${rows} ${rows === 1 ? 'set' : 'sets'} of rows` : ''].filter(Boolean);
  return `Saved ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
}

/**
 * squad-kit's check of the proof, in the activity: "Checked the screenshots: 2 met, 1 not shown yet" as before, and on a
 * spec with kinds "Checked the proof", counting only what the check looked at: pictures, answers and rows.
 */
export function checkedLine(x: Pick<Ticket, 'criteria' | 'proof'>, open: string[]): string {
  const kinds = hasKinds(x);
  const met = (x.proof ?? []).filter((p) => p.shows === 'met' && (!kinds || !p.kind || ['screen', 'api', 'data'].includes(p.kind))).length;
  if (open.length) return `Checked the ${kinds ? 'proof' : 'screenshots'}: ${[`${met} met`, ...open].join(', ')}`;
  return kinds ? 'Checked the proof: each "done when" it shows is met' : 'Checked the screenshots: each "done when" on a screen is met';
}
