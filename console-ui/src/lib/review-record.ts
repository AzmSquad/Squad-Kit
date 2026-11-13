/**
 * The review of a story as the engine gives it (GET /api/v1/tickets/:id/review, src/engine/review-record/view.ts): each
 * round with its notes, where each note stands, and who pressed Looks right. The words match the terminal's and the
 * pull request's.
 */

export type NoteState = 'open' | 'fixed' | 'past';

export interface ReviewNoteView {
  n: number;
  round: number;
  file?: string;
  line?: number;
  text: string;
  state: NoteState;
  fixed?: { commit?: string; by: 'git' | 'reviewer'; checked?: boolean };
  /** A later Builder round changed its place: the Reviewer's next round says whether it is fixed. */
  touched?: string;
  past?: { by: string; reason: string; at: string };
}

export interface ReviewRoundView {
  n: number;
  at: string;
  approved: boolean;
  notes: ReviewNoteView[];
  fix: string[];
}

export interface ReviewViewData {
  rounds: ReviewRoundView[];
  counts: { notes: number; fixed: number; past: number; open: number };
  fixes: string[];
  looksRight?: { by: string; at: string; byItself?: boolean };
  posted?: { at: string; ok: boolean; pr: number; threads?: number; why?: string };
  old: boolean;
  canWrite: boolean;
  canPast: boolean;
}

/** "13 Nov 10:42", in this computer's time. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "4 notes: 3 fixed, 1 you went past". */
export function countLine(v: Pick<ReviewViewData, 'counts'>): string {
  const { notes, fixed, past, open } = v.counts;
  if (!notes) return 'No notes';
  const parts = [fixed ? `${fixed} fixed` : '', past ? `${past} you went past` : '', open ? `${open} open` : ''].filter(Boolean);
  return `${notes} ${notes === 1 ? 'note' : 'notes'}: ${parts.join(', ')}`;
}

/** The thread's head: the file and its line, or the whole change. */
export function whereLine(n: Pick<ReviewNoteView, 'file' | 'line'>): string {
  if (!n.file) return 'The whole change';
  return n.line ? `${n.file}:${n.line}` : n.file;
}

/** The chip on a thread: Fixed, Went past or Open. */
export const STATE_CHIP: Record<NoteState, string> = { fixed: 'Fixed', past: 'Went past', open: 'Open' };

/** The approval line: "Momen approved: Looks right, 13 Nov 10:42". */
export function approvalLine(ok: NonNullable<ReviewViewData['looksRight']>): string {
  return ok.byItself ? `squad-kit accepted it by itself, ${shortWhen(ok.at)}` : `${ok.by} approved: Looks right, ${shortWhen(ok.at)}`;
}
