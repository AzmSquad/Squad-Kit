import type { ProofKind } from '../../board/proof-kind.js';
import { hasKinds } from '../../board/proof-rows.js';
import type { Ticket } from '../../board/types.js';
import { doneWhenCount } from '../proof-verdict.js';
import type { WindowTool } from '../window.js';

/**
 * Which "done when" each proof kind covers, for the live squad. A ticket with no kinds (an old spec) is proved as
 * before, so every rule here falls back to what the caller did before.
 */

/** The kinds the Tester proves through the window: pictures, API answers and rows. */
const TESTER_KINDS: ProofKind[] = ['screen', 'api', 'data'];

/** The kind of "done when" n, from 1; a line the person added later, or one with no kind, is Screen. Null with no kinds. */
export function kindOf(t: Pick<Ticket, 'criteria'>, n: number): ProofKind | null {
  if (!hasKinds(t)) return null;
  return t.criteria?.[n - 1]?.proof?.kind ?? 'screen';
}

/** Every "done when" number of a kind. */
export function linesOf(t: Pick<Ticket, 'criteria' | 'notes'>, kinds: ProofKind[]): number[] {
  return Array.from({ length: doneWhenCount(t) }, (_, i) => i + 1).filter((n) => kinds.includes(kindOf(t, n) ?? 'screen'));
}

/** The "done when" the Tester proves in its window: all of them with no kinds. */
export function testerLines(t: Pick<Ticket, 'criteria' | 'notes'>): number[] {
  return hasKinds(t) ? linesOf(t, TESTER_KINDS) : linesOf(t, ['screen', 'api', 'data', 'test', 'none']);
}

export function testerProves(t: Pick<Ticket, 'criteria' | 'notes'>, n: number): boolean {
  return !hasKinds(t) || TESTER_KINDS.includes(kindOf(t, n) ?? 'screen');
}

/** Pictures are taken: a Screen line, or with no kinds what the caller decided before. */
export function picturesNeeded(t: Pick<Ticket, 'criteria' | 'notes'>, before: boolean): boolean {
  return hasKinds(t) ? linesOf(t, ['screen']).length > 0 : before;
}

/** The app starts for the Tester: a Screen, API or Data line, or with no kinds what the caller decided before. */
export function appNeeded(t: Pick<Ticket, 'criteria' | 'notes'>, before: boolean): boolean {
  return hasKinds(t) ? testerLines(t).length > 0 : before;
}

/**
 * The Tester's tools for the after round: with no Screen line no browser tool, so the app runs headless for its API
 * only; read_rows when a line is Data. The before round and an old spec keep theirs.
 */
export function testerTools(t: Pick<Ticket, 'criteria' | 'notes'>, tools: WindowTool[], beside: boolean): WindowTool[] {
  if (beside || !hasKinds(t)) return tools;
  const pictures = picturesNeeded(t, true);
  const out = tools.filter((x) => pictures || (x !== 'take_screenshots' && x !== 'look_at_page'));
  return linesOf(t, ['data']).length && !out.includes('read_rows') ? [...out, 'read_rows'] : out;
}
