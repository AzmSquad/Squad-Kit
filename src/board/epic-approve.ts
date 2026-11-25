import { now, readMeta, type BoardPaths } from './store.js';
import type { Breakdown } from './requirements-types.js';
import { addBreakdownActivity, updateBreakdownState } from './requirements.js';
import { parallelLimit } from '../core/settings.js';
import { BoardActionError } from './actions.js';

/**
 * A run from the tracker builds by itself once it is approved (ADR-013): one round of questions, one approval, then each
 * story builds and merges on its own and stops only when it needs the person. Releasing stays theirs.
 */
export function buildOnApproved(bp: BoardPaths, b: Pick<Breakdown, 'id' | 'source'>, by: string): void {
  if (b.source.kind !== 'tracker') return;
  const meta = readMeta(bp);
  const atOnce = Math.min(parallelLimit(meta.parallel), meta.atOnce ?? Infinity);
  updateBreakdownState(bp, b.id, (s) => {
    s.build = { on: true, by, at: now() };
    addBreakdownActivity(s, 'squad', `Turned on Build continuously, ${atOnce} at a time: each story builds and merges by itself, and stops only when it needs you. Releasing stays yours`);
  });
}

/**
 * A run mirrors its tracker: a new part is added there, and comes to the run as a new story to add. Its stories can still
 * be changed or taken out here.
 */
export function notFromTracker<B extends Pick<Breakdown, 'id' | 'source'>>(b: B): B {
  const t = b.source.kind === 'tracker' ? b.source.tracker : undefined;
  if (t) throw new BoardActionError(`${b.id} mirrors ${t.ref} on ${t.label}. Add the story there: it shows here as new, and Add to the run brings it in.`);
  return b;
}

