import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * One talk in one place. While a page shows a talk itself (the Squad lead page, the Conversations page with that talk
 * picked, a story's Conversation tab), that talk's popup hides and its head says "on this page"; a press on the head
 * brings the page's own message box into view instead of opening a copy. Once the page lets go, the popup comes back
 * as it was. Popups of other talks stay as they are.
 */

let here = new Map<string, () => void>();
const listeners = new Set<() => void>();

function changed(): void {
  here = new Map(here);
  for (const l of listeners) l();
}

export const shownHere = {
  has: (id: string) => here.has(id),
  /** Brings the page's own message box into view, with the cursor in it. */
  focus: (id: string) => here.get(id)?.(),
  /** The page shows this talk; the returned function lets go. */
  add(id: string, focus: () => void): () => void {
    here.set(id, focus);
    changed();
    return () => {
      if (here.get(id) !== focus) return;
      here.delete(id);
      changed();
    };
  },
};

/** The talks the page shows itself now. */
export function useShownHere(): ReadonlyMap<string, () => void> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => here,
  );
}

/** Puts the cursor in the message box inside `el`, or brings `el` into view when the talk has none. */
export function focusBoxIn(el: HTMLElement | null): void {
  const box = el?.querySelector<HTMLTextAreaElement>('textarea');
  (box ?? el)?.scrollIntoView?.({ block: 'nearest' });
  box?.focus();
}

/** A page shows talk `id` (null: none now). `focus` brings its own message box into view. */
export function useShowsTalk(id: string | null, focus: () => void): void {
  const latest = useRef(focus);
  latest.current = focus;
  useEffect(() => (id ? shownHere.add(id, () => latest.current()) : undefined), [id]);
}
