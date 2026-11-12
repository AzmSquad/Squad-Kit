import { useSyncExternalStore } from 'react';
import type { LeadContext } from '../api/types';

/**
 * The ask box (⌘K or Ctrl+K on any board page, "Ask the lead" on a card, "Ask about it" in Your apps): whether it is
 * open, the question it starts with, where it was asked from, and the conversation it shows once sent. One per tab.
 */
export interface AskState {
  open: boolean;
  text: string;
  context: LeadContext | null;
  /** The conversation the box shows, once the question is sent. */
  conversation: string | null;
  /** Bumped on every open, so the box starts again with what it was opened with. */
  n: number;
}

const listeners = new Set<() => void>();
let state: AskState = { open: false, text: '', context: null, conversation: null, n: 0 };

function set(next: Partial<AskState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const leadAsk = {
  get: () => state,
  /** Opens the box with a question already filled in, or empty, and where it is asked from. */
  open: (o: { text?: string; context: LeadContext }) => set({ open: true, text: o.text ?? '', context: o.context, conversation: null, n: state.n + 1 }),
  close: () => set({ open: false }),
  /** The question went: the box follows its conversation. */
  sent: (conversation: string) => set({ conversation }),
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
