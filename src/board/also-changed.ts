/**
 * What a change touches beyond its plan, in the Reviewer's plain words. It never blocks a story, as it may well be
 * right: the person sees it at their check, on a stop, on the ticket and in the release note.
 */

/** The Reviewer's list as it is kept: short plain phrases, no empty or repeated ones. */
export function cleanAlsoChanged(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const words = list.filter((x): x is string => typeof x === 'string').map((x) => x.trim().replace(/[.;]+$/, '').slice(0, 200));
  return [...new Set(words.filter(Boolean))].slice(0, 5);
}

/** "Also changed, not in the plan: the Services screen." Empty when there is nothing to say. */
export function alsoChangedLine(list?: string[]): string {
  return list?.length ? `Also changed, not in the plan: ${list.join('; ')}.` : '';
}
