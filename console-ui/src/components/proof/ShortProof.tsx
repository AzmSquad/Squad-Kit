import type { ProofShot } from '../../api/types';
import { rowKind, shortProof } from '../../lib/proof-kinds';
import { KindChip } from './KindChip';

/** On a chat card: a line's kind and its proof in a few words, without opening it. */
export function ShortProof({ p }: { p: ProofShot }) {
  const kind = rowKind(p);
  return (
    <span className="shortproof">
      <KindChip kind={kind} small keeps={p.test?.keeps} />
      <bdi>{shortProof(p, kind)}</bdi>
    </span>
  );
}
