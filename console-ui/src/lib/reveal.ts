import { useEffect, useRef, useState } from 'react';
import { wordCount } from './lang';
import { useMedia } from './popups';

/**
 * Words appear as they are written. The text may grow between two polls (the words the AI tool has handed in so far):
 * the new words come in at a reading pace, the ones already shown stay. A text that was already there when the person
 * looked shows whole at once, and so does everything with reduced motion.
 */

/** How many words to add on the next tick: faster when far behind, so a long answer never keeps the person waiting. */
export function revealStep(shown: number, total: number): number {
  return Math.max(1, Math.ceil((total - shown) / 28));
}

/** Milliseconds between two ticks. */
export const REVEAL_MS = 38;

export const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * Lead turns asked from this page and not written out yet, as "<conversation>.<turn>". An answer squad-kit gives at
 * once (a refusal, a saved note) comes back with the question and is written out once too; then its mark goes, so it
 * never moves again.
 */
export const askedHere = new Set<string>();

/**
 * The words of `text` to show now. `live` says the text arrived while the person watched; once a reveal started it
 * goes on to the end, even when `live` turns off with the finished answer.
 */
export function useReveal(text: string, live: boolean): { shown: number; total: number; done: boolean } {
  const reduced = useMedia(REDUCED);
  const total = wordCount(text);
  const started = useRef(live && !reduced);
  if (live && !reduced) started.current = true;
  const [shown, setShown] = useState(() => (started.current ? 0 : total));
  const on = started.current && !reduced;
  useEffect(() => {
    if (!on) return;
    if (shown >= total) return;
    const timer = setTimeout(() => setShown((n) => Math.min(total, n + revealStep(n, total))), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [on, shown, total]);
  const now = on ? Math.min(shown, total) : total;
  return { shown: now, total, done: now >= total };
}
