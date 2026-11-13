import { ChevronDown, CircleMinus, CodeXml, Database, FlaskConical, Lock, Monitor, type LucideIcon } from 'lucide-react';
import type { LineProofKind } from '../../api/proof-kind';
import { KEEPS_NAME, KIND_NAME } from '../../lib/proof-kinds';
import '../../styles/proof-kinds.css';

/** One picture per kind, the same in the spec, the proof and the chat cards. */
export const KIND_ICON: Record<LineProofKind, LucideIcon> = { screen: Monitor, api: CodeXml, data: Database, test: FlaskConical, none: CircleMinus };

/**
 * The kind's chip: its colour, picture and name; a lock when squad-kit keeps it, an arrow when its menu opens. A Test
 * line that keeps something that already works reads "Test · stays as it is".
 */
export function KindChip({ kind, locked, caret, small, keeps }: { kind: LineProofKind; locked?: boolean; caret?: boolean; small?: boolean; keeps?: boolean }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={`pkind k-${kind}${small ? ' sm' : ''}`}>
      <Icon aria-hidden="true" />
      {KIND_NAME[kind]}
      {keeps && kind === 'test' && ` · ${KEEPS_NAME}`}
      {locked && <Lock className="kindlock" aria-label="Kept by squad-kit" />}
      {caret && !locked && <ChevronDown className="kindcaret" aria-hidden="true" />}
    </span>
  );
}
