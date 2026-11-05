import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { PROJECT } from '../api/client';

/**
 * What the person typed and has not sent stays on this computer, per project, ticket and field. Another tab, Esc, a
 * click outside, Close or a reload never lose it; it goes once it is sent, or when the person clears it. Browser storage
 * may refuse (a private window, a full quota): then it lives in memory until the page reloads.
 */

const PREFIX = 'squad.draft.';
/** A draft nobody came back to in this long is not worth bringing back. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const memory = new Map<string, string>();

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function store(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(project: string | null, scope: string, field: string): string {
  return `${PREFIX}${project ?? 'app'}.${scope}.${field}`;
}

function raw(key: string, s: Store | null): string | null {
  const here = memory.get(key);
  if (here !== undefined) return here;
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readDraft<T>(key: string, s: Store | null = store(), now = Date.now()): T | undefined {
  const text = raw(key, s);
  if (!text) return undefined;
  try {
    const { v, at } = JSON.parse(text) as { v: T; at: number };
    return now - at > KEEP_MS ? undefined : v;
  } catch {
    return undefined;
  }
}

export function writeDraft(key: string, value: unknown, s: Store | null = store(), now = Date.now()): void {
  const text = JSON.stringify({ v: value, at: now });
  try {
    if (!s) throw new Error('no storage');
    s.setItem(key, text);
    memory.delete(key);
  } catch {
    memory.set(key, text);
  }
}

export function clearDraft(key: string, s: Store | null = store()): void {
  memory.delete(key);
  try {
    s?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/** Every field of one ticket or dialog: what it typed was sent, or the person cleared it. */
export function clearDrafts(project: string | null, scope: string, s: Store | null = store()): void {
  const start = draftKey(project, scope, '');
  for (const key of [...memory.keys()]) if (key.startsWith(start)) memory.delete(key);
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key?.startsWith(start)) keys.push(key);
    }
    for (const key of keys) s.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/** Drafts past their time go when the app opens, so they never fill the browser's storage. */
export function pruneDrafts(s: Store | null = store(), now = Date.now()): void {
  if (!s) return;
  try {
    const old: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX) && readDraft(key, s, now) === undefined) old.push(key);
    }
    for (const key of old) s.removeItem(key);
  } catch {
    // Browser storage refused: nothing to prune.
  }
}

/**
 * useState that survives. `scope` is the ticket's id or the dialog's name, `field` the box. A value equal to `initial`
 * is no draft. The third item clears it, for when it was sent.
 */
export function useDraft<T>(scope: string, field: string, initial: T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const key = draftKey(PROJECT, scope, field);
  const first = useRef(JSON.stringify(initial));
  const [value, setValue] = useState<T>(() => readDraft<T>(key) ?? initial);
  // The same box on another ticket has its own draft.
  const shown = useRef(key);
  if (shown.current !== key) {
    shown.current = key;
    first.current = JSON.stringify(initial);
    setValue(readDraft<T>(key) ?? initial);
  }
  useEffect(() => {
    if (JSON.stringify(value) === first.current) clearDraft(key);
    else writeDraft(key, value);
  }, [key, value]);
  const clear = useCallback(() => {
    clearDraft(key);
    setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, setValue, clear];
}
