/**
 * Two lines that say the same thing in other words, like two "Decided for you" entries a later run wrote again:
 * "The 30 days are counted from today's date, so a booking on day 30 is allowed" and "The 30 days are counted from
 * today's date, so a booking exactly 30 days ahead is allowed". The words are made plain (small words out, endings
 * off), then compared by how many they share. A line that says "not" never matches one that does not.
 */

/** Small words that say nothing on their own. "not", "no" and "never" stay: they turn a line around. */
const SMALL = new Set(
  'a an the is are was were be been being so and or of to in on at for by it its that this as with from can may will would should could also then than which who when where there here their them they these those one any all each every do does did has have had just only'.split(
    ' ',
  ),
);
const NEGATIVE = new Set(['not', 'no', 'never', 'none', 'nothing', 'without']);

/** A word without its ending, so "counted" and "count", "days" and "day", "refused" and "refuse" are one word. */
function stem(w: string): string {
  if (/^\d/.test(w)) return w;
  let s = w;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/** The words that carry a line's meaning, each once. Times stay whole ("08:00"). */
export function meaningWords(text: string): Set<string> {
  const s = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\bcannot\b/g, 'can not')
    .replace(/n't\b/g, ' not')
    .replace(/'s\b/g, '');
  return new Set((s.match(/\d{1,2}:\d{2}|[a-z0-9]+/g) ?? []).filter((w) => !SMALL.has(w)).map((w) => (NEGATIVE.has(w) ? w : stem(w))));
}

/** How much two lines share: of the shorter one's words (overlap), and of all their words (jaccard), each 0 to 1. */
export function sharedWords(a: string, b: string): { overlap: number; jaccard: number } {
  const A = meaningWords(a);
  const B = meaningWords(b);
  if (!A.size || !B.size) return { overlap: 0, jaccard: 0 };
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return { overlap: both / Math.min(A.size, B.size), jaccard: both / (A.size + B.size - both) };
}

/**
 * True when two lines say the same thing: most of the shorter one's words are in the other, and a good share of all
 * of them. Very short lines must match word for word. Two lines with nearly the same words where only one says "not"
 * say the opposite ("day 31 is allowed", "day 31 is not allowed"), so they never match.
 */
export function saysTheSame(a: string, b: string): boolean {
  const A = meaningWords(a);
  const B = meaningWords(b);
  if (Math.min(A.size, B.size) < 3) return A.size === B.size && [...A].every((w) => B.has(w));
  const { overlap, jaccard } = sharedWords(a, b);
  if (overlap < 0.6 || jaccard < 0.45) return false;
  const negative = (s: Set<string>) => [...s].some((w) => NEGATIVE.has(w));
  if (negative(A) === negative(B)) return true;
  // Only one says "not": the same words otherwise is an opposite, not the same line in other words.
  const rest = (s: Set<string>) => [...s].filter((w) => !NEGATIVE.has(w));
  const ra = rest(A);
  const rb = new Set(rest(B));
  const both = ra.filter((w) => rb.has(w)).length;
  return both / (ra.length + rb.size - both) < 0.75;
}
