import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';

/**
 * A story's question card stays where it came in the talk, in time order like any message (#32). Before, it always
 * closed the talk, so new messages landed above it and could not be seen without scrolling up. A slim bar under the
 * talk says the story waits for an answer while the card is out of view, and takes you to it.
 */

/** Where the card came in, by ticket: the number of messages before it. Kept while the page is open. */
const placed = new Map<string, number>();

/** The message count the card sits after: the count when it first showed, else the end of the talk. */
export function useCardPlace(id: string, waits: boolean, count: number): number {
  const at = waits ? (placed.get(id) ?? count) : count;
  useEffect(() => {
    if (!waits) placed.delete(id);
    else if (!placed.has(id)) placed.set(id, count);
  }, [id, waits, count]);
  return Math.min(at, count);
}

/** The card, with what tells whether it shows in the talk now. */
export function useCardSeen(): { ref: (el: HTMLDivElement | null) => void; seen: boolean; el: HTMLDivElement | null } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setSeen(Boolean(e?.isIntersecting)), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return { ref: setEl, seen, el };
}

export function CardSlot({ slot, children }: { slot: (el: HTMLDivElement | null) => void; children: ReactNode }) {
  return (
    <div className="ccard-slot" ref={slot}>
      {children}
    </div>
  );
}

/** "MA-12 waits for your answer": one line under the talk while the card is out of view. Pressing it goes to the card. */
export function WaitsBar({ id, show, card }: { id: string; show: boolean; card: HTMLDivElement | null }) {
  const reduce = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  if (!show || !card) return null;
  return (
    <button className="cwaits-bar" onClick={() => card.scrollIntoView({ behavior: reduce.current ? 'auto' : 'smooth', block: 'center' })}>
      <span>{id} waits for your answer</span>
      <ArrowDown size={13} strokeWidth={2.4} aria-hidden="true" />
    </button>
  );
}
