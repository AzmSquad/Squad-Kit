import type { LineProofKind } from '../api/proof-kind';
import type { ProofShot, Ticket } from '../api/types';
import { shellQuote } from './text';

/**
 * How each "done when" is proved, in the board's words: one name, one small line and one colour per kind, the same in
 * the spec, the proof and the chat cards. squad-kit's own rules are in src/board/proof-lock.ts; this only shows them.
 */

/** In the order the menu shows them. */
export const KINDS: LineProofKind[] = ['screen', 'data', 'api', 'test', 'none'];

export const KIND_NAME: Record<LineProofKind, string> = { screen: 'Screen', api: 'API call', data: 'Data', test: 'Test', none: 'Not on a screen' };

export const KIND_SMALL: Record<LineProofKind, string> = {
  screen: 'Pictures before and after',
  api: 'The call and its answer',
  data: 'Rows before and after, read only',
  test: 'The test that proves it, in plain words',
  none: 'Only with a reason the Reviewer checks',
};

export const LOCK_NOTE = 'Screen needs a picture. squad-kit keeps it when a line is about what someone sees.';
export const MENU_FOOT = 'You see this proof when the story is ready to check.';

/** True when the spec says how its lines are proved. Old specs have none, and show as before. */
export function hasKinds(t: Pick<Ticket, 'criteria'>): boolean {
  return Boolean(t.criteria?.some((c) => c.proof));
}

/** The kinds can still change: the spec, or an Express plan, waits for the person. Then the chips are read only. */
export function kindsOpen(t: Pick<Ticket, 'waiting' | 'specApproved' | 'live' | 'criteria'>): boolean {
  if (t.specApproved || t.live || !t.criteria?.length) return false;
  return t.waiting?.kind === 'spec' || t.waiting?.kind === 'plan';
}

/** The kind of a proof row: its own, else by its saved file: an API answer, rows, or pictures as before. */
export function rowKind(p: ProofShot): LineProofKind {
  if (p.kind) return p.kind;
  if (p.after.endsWith('.api.json')) return 'api';
  if (p.after.endsWith('.rows.json')) return 'data';
  return 'screen';
}

/** The terminal command of a choice in the menu. */
export function proveCommand(id: string, line: number, kind: LineProofKind, why?: string): string {
  return `squad prove ${id} ${line} ${kind}${why ? ` --why ${shellQuote(why)}` : ''}`;
}

/** One short line for a chat card: what proves it, without opening it. */
export function shortProof(p: ProofShot, kind: LineProofKind): string {
  switch (kind) {
    case 'test':
      if (!p.test) return 'A test';
      if (p.test.before === 'failed' && p.test.after === 'passed') return `Failed before the change, passes now${p.test.seconds !== undefined ? ` · ${p.test.seconds} s` : ''}`;
      if (p.test.after === 'failed') return 'The test fails';
      if (p.test.after === 'unknown') return 'Could not run the test';
      if (p.test.before === 'unknown') return 'Could not run on the old code';
      return 'The test passes on main too';
    case 'none':
      return p.checked ? `Reviewer: ${firstSentence(p.checked)}` : 'Not checked yet';
    case 'data':
      return 'Rows before and after';
    case 'api':
      return 'The call and its answer';
    default:
      return p.more?.length ? `${p.more.length + 1} pictures` : 'Before and after';
  }
}

function firstSentence(s: string): string {
  const one = s.split(/(?<=[.!?؟])\s+/)[0] ?? s;
  return one.length > 90 ? `${one.slice(0, 89).trimEnd()}…` : one;
}

/** A proof section's heading: the old words on an old spec, and on a spec with kinds the words for every kind. */
export function proofHead(t: Pick<Ticket, 'criteria'>, before: string): string {
  return hasKinds(t) ? (before === 'What the screenshots show' ? 'What the proof shows' : 'Each "done when", with its proof') : before;
}
