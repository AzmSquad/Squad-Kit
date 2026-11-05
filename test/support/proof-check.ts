/**
 * squad-kit's own check of the proof's pictures, faked: a Reviewer run that answers met, broken or not shown for each
 * picture its prompt lists. Tests whose fake agent answers every run tell the check's run apart with isProofCheck.
 */

/** True for the prompt of squad-kit's check of the screenshots (engine/prompts.ts proofCheckPrompt). */
export function isProofCheck(o: { prompt?: string }): boolean {
  return Boolean(o.prompt?.includes('You check the proof of a software squad'));
}

/** The "done when" numbers a check's prompt asks about, in order. */
export function checkedNumbers(o: { prompt?: string }): number[] {
  return [...(o.prompt ?? '').matchAll(/^(\d+)\. Done when:/gm)].map((m) => Number(m[1]));
}

/** True when the check's prompt lists this "done when" with no picture, only the Tester's reason. */
export function hasNoPicture(o: { prompt?: string }, n: number): boolean {
  return new RegExp(`^${n}\\. Done when:.*\\n {3}No picture\\.`, 'm').test(o.prompt ?? '');
}

/** One verdict of the check: met, broken or not shown, one sentence, and for not shown its advice and whether it can be shown at all. */
export type FakeCheck = ['met' | 'broken' | 'not-shown', string, { advice?: string; noChange?: boolean; canShow?: boolean; canShowWhy?: string }?];

/**
 * The check's answer: each picture it was asked about met, and each "done when" with no picture and the Tester's reason
 * agreed with (it cannot be shown), unless `say` names another verdict for its number.
 */
export function checkAnswer(o: { prompt?: string }, say: Record<number, FakeCheck> = {}): { checks: { criterion: number; shows: string; why: string; advice?: string; noChange: boolean; canShow?: boolean; canShowWhy?: string }[] } {
  return {
    checks: checkedNumbers(o).map((n) => {
      const [shows, why, more] = say[n] ?? (hasNoPicture(o, n) ? (['not-shown', 'No picture shows it.', { canShow: false }] as FakeCheck) : (['met', 'The picture shows it working as written.'] as FakeCheck));
      return {
        criterion: n,
        shows,
        why,
        ...(more?.advice ? { advice: more.advice } : {}),
        noChange: more?.noChange ?? false,
        ...(more?.canShow !== undefined ? { canShow: more.canShow } : {}),
        ...(more?.canShowWhy ? { canShowWhy: more.canShowWhy } : {}),
      };
    }),
  };
}
