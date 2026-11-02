import { useSyncExternalStore } from 'react';

/**
 * The chat panel beside the board: which talk is in front, whether it is minimized, how wide it is, and how many
 * messages of each talk you have seen. Kept in this browser only.
 */
export interface DockState {
  tab: string | null;
  min: boolean;
  width: number;
  seen: Record<string, number>;
}

const KEY = 'sk.chatdock';
const listeners = new Set<() => void>();

function load(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DockState>;
    return { tab: raw.tab ?? null, min: Boolean(raw.min), width: clampWidth(raw.width ?? 600), seen: raw.seen ?? {} };
  } catch {
    return { tab: null, min: false, width: 600, seen: {} };
  }
}

let state: DockState = typeof window === 'undefined' ? { tab: null, min: false, width: 600, seen: {} } : load();

export function clampWidth(w: number): number {
  return Math.max(440, Math.min(900, Math.round(w)));
}

function set(next: Partial<DockState>): void {
  state = { ...state, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private windows can refuse storage; the panel then remembers for this visit only.
  }
  for (const l of listeners) l();
}

export const chatDock = {
  get: () => state,
  /** Bring one talk to the front and open the panel. */
  show: (id: string) => set({ tab: id, min: false }),
  pick: (id: string) => set({ tab: id }),
  minimize: () => set({ min: true }),
  restore: () => set({ min: false }),
  resize: (width: number) => set({ width: clampWidth(width) }),
  /** Mark the messages of a talk as read. */
  seen: (id: string, count: number) => {
    if (state.seen[id] !== count) set({ seen: { ...state.seen, [id]: count } });
  },
};

/** True while a media query matches, for example a phone-sized screen. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = window.matchMedia?.(query);
      m?.addEventListener('change', l);
      return () => m?.removeEventListener('change', l);
    },
    () => Boolean(window.matchMedia?.(query).matches),
  );
}

/** Phones and narrow windows get the phone chat. */
export const PHONE = '(max-width: 760px)';

export function useChatDock(): DockState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
