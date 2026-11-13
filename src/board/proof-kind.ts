/**
 * How a "done when" line is proved: the Analyst proposes it in the spec, squad-kit's own rules may lock it (a line about
 * what someone sees keeps its picture), and the person can change it before approving.
 */
export type ProofKind = 'screen' | 'api' | 'data' | 'test' | 'none';

export interface CriterionProof {
  kind: ProofKind;
  /** One plain line on why this kind fits, shown under the line in the spec. */
  why?: string;
  /** Set by squad-kit, never by an agent: the kind stays Screen. */
  locked?: boolean;
  /**
   * A Test line that keeps something that already works ("stays as it is"): its test passes on main's code and on the
   * story's. The Analyst may propose it; after the spec's approval only the person changes it.
   */
  keeps?: boolean;
}
