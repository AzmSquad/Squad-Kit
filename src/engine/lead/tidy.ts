import type { LeadCard } from './types.js';

/**
 * An answer that brings cards says each story once, on its card: its words stay short instead of listing what the
 * cards below show, and a story never gets the same card twice.
 */

const STORY_ID = /\b[A-Z][A-Z0-9]*-\d+\b(?!\.\d)/g;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NUMBERED = /^(\s*)\d+([.)])\s+/;

/** The body without the list lines about a story whose decision card comes with the answer, renumbered. */
export function trimCarded(body: string, cards: LeadCard[]): string {
  const carded = new Set(cards.flatMap((c) => (c.kind === 'decide' ? [c.story] : [])));
  if (!carded.size) return body;
  // A list line is about the story it names first: "2. MA-9 Customer confirms…: 5 questions".
  const kept = body.split('\n').filter((line) => !(ITEM.test(line) && carded.has(line.match(STORY_ID)?.[0] ?? '')));
  let n = 0;
  const renumbered = kept.map((line) => {
    if (!NUMBERED.test(line)) {
      if (line.trim()) n = 0;
      return line;
    }
    n += 1;
    return line.replace(/^(\s*)\d+([.)])/, `$1${n}$2`);
  });
  return renumbered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The answer already has this card for this story: the same story's decision or Open card, handed in twice. */
export function sameStoryCard(cards: LeadCard[], card: LeadCard): boolean {
  if (card.kind !== 'decide' && card.kind !== 'open_story') return false;
  return cards.some((x) => x.kind === card.kind && x.story === card.story);
}
