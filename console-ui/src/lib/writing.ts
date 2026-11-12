import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../api/types';
import { wordCount } from './lang';
import { REVEAL_MS, revealStep } from './reveal';

/** One message, the same across polls. */
export const keyOf = (m: ChatMessage) => `${m.at}|${m.who}`;
export const isAgent = (m: ChatMessage) => m.who !== 'you' && m.who !== 'squad';

/**
 * A talk with an agent, written out as it comes: a new answer appears word by word at a reading pace, from the words
 * its draft already showed; answers that were already here when the talk opened show whole and never move again. `on`
 * is false while the talk has not loaded, and with reduced motion. `writing` is the answer being written and how far;
 * `fresh` tells a message that came while the talk was open; `drafted` is where the draft's words got to.
 */
export function useWriting(messages: ChatMessage[], loaded: boolean, reduced: boolean) {
  const known = useRef<Set<string> | null>(null);
  const first = useRef<Set<string> | null>(null);
  const drafted = useRef<{ text: string; shown: number }>({ text: '', shown: 0 });
  const [writing, setWriting] = useState<{ key: string; shown: number; total: number } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const keys = messages.map(keyOf);
    if (!known.current) {
      known.current = new Set(keys);
      first.current = new Set(keys);
      return;
    }
    const fresh = messages.filter((m) => !known.current!.has(keyOf(m)));
    for (const k of keys) known.current.add(k);
    const last = fresh.filter(isAgent).at(-1);
    if (!last || reduced) return;
    const d = drafted.current;
    const from = d.text && last.text.startsWith(d.text.slice(0, 40)) ? Math.min(d.shown, wordCount(last.text)) : 0;
    drafted.current = { text: '', shown: 0 };
    setWriting({ key: keyOf(last), shown: from, total: wordCount(last.text) });
  }, [loaded, messages, reduced]);
  useEffect(() => {
    if (!writing) return;
    if (writing.shown >= writing.total) {
      setWriting(null);
      return;
    }
    const timer = setTimeout(() => setWriting((r) => (r ? { ...r, shown: r.shown + revealStep(r.shown, r.total) } : r)), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [writing]);
  const fresh = (m: ChatMessage) => Boolean(first.current && !first.current.has(keyOf(m)));
  return { writing, fresh, drafted };
}
