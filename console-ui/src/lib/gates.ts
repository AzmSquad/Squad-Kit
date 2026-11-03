import type { GateOverride, Gates } from '../api/types';

/**
 * The gates in words. Green only for a pass: "Not checked" (no tests ran) and a gate you continued past say so, so a
 * project with no tests never looks fully checked.
 */

/** Why "Not checked" is no pass, in plain words. */
export const NOT_CHECKED_WHY =
  'No tests ran, so squad-kit could not check that the work does what it should. Check the proof with extra care. To turn tests on, add a test command in Settings.';

/** The checks gate in words. */
export function checksWords(g: Gates | undefined | null): string {
  if (g?.checks === 'unchecked') return 'Not checked: no tests ran';
  if (g?.checks === 'skipped') return /weakened/i.test(g.checksText ?? '') ? 'Tests weakened, you continued' : 'Checks failed, you continued';
  return g?.checksText ?? 'All checks pass';
}

/** The explanation under "Not checked", with what did pass ("build passes, the app starts"). */
export function notCheckedWhy(g: Gates | undefined | null): string | null {
  if (g?.checks !== 'unchecked') return null;
  const passed = g.checksText?.split(' · ').slice(1).join(' · ');
  return NOT_CHECKED_WHY.replace('Check the proof', `${passed ? `Passed: ${passed}. ` : ''}Check the proof`);
}

/** The line above the proof: "every gate is green" only when it is true. */
export function proofLead(g: Gates | undefined | null): string {
  const compare = 'Compare the screens before and after each "done when".';
  if (g?.checks === 'unchecked') return `Not checked: no tests ran, so look closely. ${compare}`;
  if (g && [g.checks, g.review, g.proof].some((s) => s === 'skipped')) return `You went past a gate, so look closely. ${compare}`;
  return `Every gate is green. ${compare}`;
}

/** Why a proof has no screenshots. With no tests either, nothing checked the work, and it says so. */
export function noShotsText(t: { gates?: Gates | null; work?: { screens: number } }): string {
  if (t.gates?.proof === 'skipped' || (t.work?.screens ?? 0) > 0) return 'No screenshots were taken for this ticket. See the activity for why.';
  if (t.gates?.checks === 'unchecked') return 'No screens change in this ticket and no tests ran, so read the changes in the Changes tab.';
  return 'No screens change in this ticket, so the passing checks are the proof.';
}

/** What a Continue anyway went past, for its line on the ticket. */
export function overrideWhat(o: GateOverride): string {
  if (o.weakened?.length) return 'weakened tests';
  return o.gate === 'checks' ? 'failed checks' : o.gate === 'proof' ? 'missing screenshots' : 'open review';
}
