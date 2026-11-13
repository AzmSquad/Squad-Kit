import type { ProofKind } from '../../board/proof-kind.js';
import type { Ticket } from '../../board/types.js';

/**
 * How a story's proof was made, in a check-in's words: its pictures, or the way its "done when" lines were proved
 * when it has none ("proved by a test"), or plain words when squad-kit cannot tell ("no pictures for this story").
 * Never "0 pictures".
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A line proved without a picture, one and many. Screen lines are pictures; "none" needs no proof. */
const OTHER: Partial<Record<ProofKind, [string, string]>> = {
  test: ['a test', 'tests'],
  api: ['an API answer', 'API answers'],
  data: ['a check of the saved data', 'checks of the saved data'],
};

function andWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** "5 pictures", "2 pictures and a test", "proved by 2 tests and an API answer", "no pictures for this story". */
export function proofWords(t: Pick<Ticket, 'criteria'>, pictures: number): string {
  const counts = new Map<ProofKind, number>();
  for (const c of t.criteria ?? []) {
    const k = c.proof?.kind;
    if (k && OTHER[k]) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const other = [...counts].map(([k, n]) => (n === 1 ? OTHER[k]![0] : `${n} ${OTHER[k]![1]}`));
  if (pictures > 0) return other.length ? `${plural(pictures, 'picture')} and ${andWords(other)}` : plural(pictures, 'picture');
  return other.length ? `proved by ${andWords(other)}` : 'no pictures for this story';
}
