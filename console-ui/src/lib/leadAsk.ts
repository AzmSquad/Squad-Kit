import { useSyncExternalStore } from 'react';
import type { LeadContext } from '../api/types';
import { popups } from './popups';

/**
 * "Ask the lead" from a card ("Ask about it" on a stop, an error page, Your apps): the lead's popup opens on a new
 * conversation with the question filled in and where it is asked from. Nothing is sent until the person presses Send.
 */
export interface AskState {
  text: string;
  context: LeadContext | null;
  /** Bumped on every ask, so the box starts again with what it was opened with. */
  n: number;
}

const listeners = new Set<() => void>();
let state: AskState = { text: '', context: null, n: 0 };

export const leadAsk = {
  get: () => state,
  /** Opens the lead's popup on a new conversation, with a question already filled in, or empty, and where it is asked from. */
  open: (o: { text?: string; context: LeadContext }) => {
    state = { text: o.text ?? '', context: o.context, n: state.n + 1 };
    popups.follow(null);
    popups.open('lead');
    for (const l of listeners) l();
  },
  /** The question went: the next new conversation asks from the page again. */
  used: () => {
    if (!state.context && !state.text) return;
    state = { text: '', context: null, n: state.n };
    for (const l of listeners) l();
  },
};

export function useLeadAsk(): AskState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
