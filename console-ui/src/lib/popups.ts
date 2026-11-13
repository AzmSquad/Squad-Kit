import { useSyncExternalStore } from 'react';
import { PROJECT } from '../api/client';

/**
 * The chat popups over every page of a project: which talks are open (the lead's and the stories'), which are
 * minimised, the lead's conversation, and how much of each talk the person has seen. Kept in this browser, one set per
 * project, so the popups stay as they were after a page change or a reload. No React here, so each rule is tested on
 * its own; the hooks are at the end.
 */

/** One open popup: "lead", or a story's id for its talk. */
export interface Pop {
  id: string;
  min: boolean;
}

export interface PopState {
  /** Newest first: the first one sits next to the heads. */
  open: Pop[];
  /** Messages of each talk the person has seen. */
  seen: Record<string, number>;
  /** The mark of what each story waited for when its popup was last looked at, so a new decision shows on its head. */
  looked: Record<string, string>;
  /** The conversation the lead's popup shows, or none yet. */
  lead: string | null;
}

/** At most three side by side, on a window wide enough. */
export const MAX_OPEN = 3;
/** A popup and the gap beside it, and the room the heads keep at the right. */
const POP_W = 368 + 12;
const HEADS_W = 90;

export const EMPTY: PopState = { open: [], seen: {}, looked: {}, lead: null };

/** How many fit side by side on a window this wide: one on a phone-width window, up to three. */
export function maxOpen(width: number, phone = width <= 760): number {
  if (phone) return 1;
  return Math.max(1, Math.min(MAX_OPEN, Math.floor((width - HEADS_W - 16) / POP_W)));
}

/** Opens a popup, or brings it back when minimised. Opening one more than fits closes the oldest. */
export function openPop(s: PopState, id: string, max = MAX_OPEN): PopState {
  if (s.open.some((p) => p.id === id)) return { ...s, open: s.open.map((p) => (p.id === id ? { ...p, min: false } : p)) };
  return { ...s, open: [{ id, min: false }, ...s.open].slice(0, Math.max(1, max)) };
}

export function closePop(s: PopState, id: string): PopState {
  // Closing the lead's popup ends its conversation here: the next one opens on what needs you. It stays on the lead's page.
  return { ...s, open: s.open.filter((p) => p.id !== id), ...(id === 'lead' ? { lead: null } : {}) };
}

export function minimisePop(s: PopState, id: string): PopState {
  return { ...s, open: s.open.map((p) => (p.id === id ? { ...p, min: true } : p)) };
}

/** A head's press: opens its popup, brings a minimised one back, or closes an open one. */
export function togglePop(s: PopState, id: string, max = MAX_OPEN): PopState {
  const p = s.open.find((x) => x.id === id);
  if (!p || p.min) return openPop(s, id, max);
  return closePop(s, id);
}

/**
 * The popups shown on a window that fits `max`: the newest ones. The others wait in the list until there is room. With
 * room for one (a phone), the newest one that is not minimised.
 */
export function shownPops(s: PopState, max: number): Pop[] {
  if (max <= 1) {
    const one = s.open.find((p) => !p.min) ?? s.open[0];
    return one ? [one] : [];
  }
  return s.open.slice(0, max);
}

/**
 * The popups left once the page shows some talks itself: those hide, untouched, and come back as they were when the
 * page lets go (lib/here.ts). The others keep their order and their room.
 */
export function notShownHere(s: PopState, here: { has(id: string): boolean }): PopState {
  return s.open.some((p) => here.has(p.id)) ? { ...s, open: s.open.filter((p) => !here.has(p.id)) } : s;
}

/** True while the popup is open and not minimised. */
export function isOpen(s: PopState, id: string): boolean {
  return s.open.some((p) => p.id === id && !p.min);
}

/**
 * Forgets what was seen and looked at on stories that are gone. `live` is every story the board and the talks have now;
 * with none (still loading), nothing is dropped. A popup closes itself when its story is gone (popups/StoryPopup).
 */
export function pruneState(s: PopState, live: Set<string>): PopState {
  if (!live.size) return s;
  const keep = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => live.has(id)));
  const seen = keep(s.seen);
  const looked = keep(s.looked);
  const same = Object.keys(seen).length === Object.keys(s.seen).length && Object.keys(looked).length === Object.keys(s.looked).length;
  return same ? s : { ...s, seen, looked };
}

/** What a stored state may hold: anything else is dropped, so an old or broken one never breaks the page. */
export function readState(raw: unknown, old?: unknown): PopState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PopState>;
  const open = Array.isArray(r.open) ? r.open.filter((p): p is Pop => Boolean(p) && typeof p.id === 'string').map((p) => ({ id: p.id, min: Boolean(p.min) })) : [];
  const record = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, never>) : {});
  // The chat panel beside the board kept what was seen of each talk until 1.3.16: it carries over once.
  const seen = r.seen ? record(r.seen) : record((old as { seen?: unknown } | undefined)?.seen);
  return { open: open.slice(0, MAX_OPEN), seen, looked: record(r.looked), lead: typeof r.lead === 'string' ? r.lead : null };
}

/* ── The store ─────────────────────────────────────────── */

const KEY = `sk.popups.${PROJECT ?? 'local'}`;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function load(): PopState {
  const st = storage();
  try {
    const raw = st?.getItem(KEY);
    const old = raw ? undefined : JSON.parse(st?.getItem('sk.chatdock') ?? 'null');
    return readState(raw ? JSON.parse(raw) : null, old);
  } catch {
    return EMPTY;
  }
}

let state: PopState = load();

function set(next: PopState): void {
  if (next === state) return;
  state = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private windows can refuse storage; the popups then stay for this visit only.
  }
  for (const l of listeners) l();
}

/** The window's width now, for how many popups fit. */
const width = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);

export const popups = {
  get: () => state,
  open: (id: string) => set(openPop(state, id, maxOpen(width()))),
  toggle: (id: string) => set(togglePop(state, id, maxOpen(width()))),
  close: (id: string) => set(closePop(state, id)),
  minimise: (id: string) => set(minimisePop(state, id)),
  /** The lead's popup follows this conversation. */
  follow: (conversation: string | null) => state.lead !== conversation && set({ ...state, lead: conversation }),
  /** Mark the messages of a talk as read. */
  seen: (id: string, count: number) => state.seen[id] !== count && set({ ...state, seen: { ...state.seen, [id]: count } }),
  /** Forgets the stories the board no longer has. */
  prune: (live: Set<string>) => set(pruneState(state, live)),
  /** The person looked at what the story waits for now. */
  looked: (id: string, key: string | undefined) => key && state.looked[id] !== key && set({ ...state, looked: { ...state.looked, [id]: key } }),
};

export function usePopups(): PopState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

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

/** The window's width, as it changes. */
export function useWidth(): number {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('resize', l);
      return () => window.removeEventListener('resize', l);
    },
    width,
  );
}
