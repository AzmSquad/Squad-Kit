import { BoardActionError } from './actions/errors.js';
import { addActivity, readMeta, updateTicket, type BoardPaths } from './store.js';
import { hasAppToStart } from './apps.js';
import { KIND_NAMES, LOCK_NOTE, NO_APP_KINDS, PROOF_KINDS } from './proof-lock.js';
import type { ProofKind } from './proof-kind.js';
import type { Ticket } from './types.js';

/**
 * The person changes how a "done when" is proved, with the chip's menu on the spec or `squad prove <ticket> <line>
 * <kind>`: only before the spec is approved, never away from Screen on a line squad-kit locked, and Not on a screen only
 * with a reason the Reviewer then checks. After the approval, Ask for changes is the way.
 */

/** True while the person may still change the kinds: the spec (or an Express plan) waits for their approval. */
export function kindsOpen(t: Pick<Ticket, 'waiting' | 'specApproved' | 'live' | 'criteria'>): boolean {
  if (t.specApproved || t.live || !t.criteria?.length) return false;
  return t.waiting?.kind === 'spec' || t.waiting?.kind === 'plan';
}

/** "screen", "Screen", "api", "API call", "not-on-a-screen": the kind, or null. */
export function kindNamed(said: string): ProofKind | null {
  const s = String(said ?? '').trim().toLowerCase();
  const plain = s.replace(/[\s_-]+/g, ' ');
  return PROOF_KINDS.find((k) => k === s || KIND_NAMES[k].toLowerCase() === plain) ?? (plain === 'api' ? 'api' : null);
}

export function proveLine(bp: BoardPaths, id: string, line: number, kindSaid: string, whySaid?: string): Ticket {
  const kind = kindNamed(kindSaid);
  if (!kind) throw new BoardActionError(`Choose one of: ${PROOF_KINDS.join(', ')}.`);
  const why = String(whySaid ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!NO_APP_KINDS.includes(kind) && !hasAppToStart(readMeta(bp))) throw new BoardActionError(`This project has no app to start, so nothing can be shown, called or read for its proof. Pick test, or none with a reason.`);
  return updateTicket(bp, id, (t) => {
    if (t.live && !t.specApproved) throw new BoardActionError(`The squad is writing the spec of ${t.id} now. Change it once it is ready.`);
    if (!t.criteria?.length) throw new BoardActionError(`The spec of ${t.id} is not written yet.`);
    if (!kindsOpen(t)) throw new BoardActionError(`The spec of ${t.id} is approved, so how each line is proved is set. Ask for changes to change it.`);
    const c = t.criteria[Math.round(line) - 1];
    if (!Number.isInteger(line) || !c) throw new BoardActionError(`${t.id} has "done when" 1 to ${t.criteria.length}.`);
    if (c.proof?.locked && kind !== 'screen') throw new BoardActionError(LOCK_NOTE);
    const before = c.proof?.kind;
    if (kind === 'none' && !why && !(before === 'none' && c.proof?.why)) throw new BoardActionError('Say why it cannot be shown. The Reviewer checks that reason.');
    // A reason given for another kind no longer fits.
    const keptWhy = why || (before === kind ? c.proof?.why : undefined);
    c.proof = { kind, ...(keptWhy ? { why: keptWhy } : {}), ...(c.proof?.locked ? { locked: true } : {}) };
    // A first kind on an old spec: the other lines are proved by a picture, as before, and say so.
    for (const o of t.criteria) o.proof ??= { kind: 'screen' };
    // The person's own wording of this line, kept for a rewrite, keeps this kind too.
    for (const e of t.planReview?.edits ?? []) if (e.part === 'criterion' && (e.index ?? 0) === line - 1 && e.criterion) e.criterion.proof = { ...c.proof };
    if (before !== kind || why) addActivity(t, 'you', `"Done when" ${line} is proved by ${KIND_NAMES[kind]} now${why ? `: ${why}` : ''}`);
  });
}
