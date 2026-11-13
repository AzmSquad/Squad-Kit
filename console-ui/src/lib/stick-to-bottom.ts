import { useCallback, useEffect, useRef, useState } from 'react';
import { REDUCED } from './reveal';

/**
 * Scrolling like a modern chat, the same in every chat (the popups, the lead's page, the Conversations page, a story's
 * talk). A talk opens at its newest message, or at its first unread one under a "New" line, and so does a popup brought
 * back from its bar. Your own message always goes to the bottom. New messages, and words as they are written, follow
 * only while you are at the bottom or near it; scrolled up to read, the talk stays put and a chip counts what came in.
 * Pictures and cards that load late never move what you read, and the bottom stays in view when the box grows, the
 * window changes size or another popup opens. The rules are a plain class, tested on its own; the hook is at the end.
 */

/** Near enough to the bottom to count as at it, in pixels. */
export const NEAR = 72;
/** Room kept above the "New" line when a talk opens at it. */
const ABOVE_NEW = 12;

/** The scrolling box, as much of it as the rules read. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  getBoundingClientRect(): { top: number };
  querySelector(selector: string): { getBoundingClientRect(): { top: number } } | null;
}

/** What the box holds: its children are the messages, the anchors that keep their place. */
export interface ScrollContent {
  readonly children: ArrayLike<{ getBoundingClientRect(): { top: number; bottom: number } }>;
}

export interface StickState {
  /** At the bottom, following what comes in. */
  pinned: boolean;
  /** New messages that came in while scrolled up. */
  unseen: number;
}

export class StickToBottom {
  pinned = true;
  unseen = 0;
  private box: ScrollBox | null = null;
  private content: ScrollContent | null = null;
  /** The person has moved the talk since it opened: from then on it is never placed for them again. */
  private settled = false;
  private last = 0;
  private count: number | null = null;
  /** The message at the top of the view and how far down it was, so late pictures above it move nothing. */
  private anchor: { i: number; top: number } | null = null;

  constructor(private onChange: (s: StickState) => void = () => {}) {}

  /** The box and what it holds appear (a talk opens, or a popup comes back from its bar). */
  attach(box: ScrollBox | null, content: ScrollContent | null): void {
    this.box = box;
    this.content = content;
    if (box) {
      this.settled = false;
      this.place();
    }
  }

  /** Another talk in the same place: it opens like a new one. */
  reset(): void {
    this.settled = false;
    this.count = null;
    this.set(true, 0);
    this.place();
  }

  /** The person scrolled, typed a key or touched the talk: it is theirs now. */
  touched(): void {
    this.settled = true;
  }

  onScroll(): void {
    const box = this.box;
    if (!box) return;
    const top = box.scrollTop;
    // A scroll squad-kit did not make is the person's: from then on the talk is theirs.
    if (Math.abs(top - this.last) > 1) this.settled = true;
    if (gap(box) <= NEAR) this.set(true, 0);
    else if (top < this.last - 1) this.set(false, this.unseen);
    this.last = top;
    this.keepAnchor();
  }

  /** The talk or its box changed size: follow the bottom, or keep what is read where it is. */
  onResize(): void {
    const box = this.box;
    if (!box) return;
    if (!this.settled) return this.place();
    if (this.pinned) return this.down(box);
    const a = this.anchor;
    const el = a ? this.content?.children[a.i] : undefined;
    if (!a || !el) return;
    const moved = rel(box, el) - a.top;
    if (Math.abs(moved) > 0.5) {
      box.scrollTop += moved;
      this.last = box.scrollTop;
    }
  }

  /** How many messages the talk has now. More while the person reads further up: the chip counts them. */
  onCount(n: number): void {
    const before = this.count;
    this.count = n;
    if (before === null || n <= before) return;
    if (this.settled && !this.pinned) this.set(false, this.unseen + (n - before));
  }

  /** Down to the newest message: your own message, or the chip. */
  toBottom(smooth = false): void {
    this.settled = true;
    this.set(true, 0);
    const box = this.box;
    if (!box) return;
    const scroll = (box as { scrollTo?: (o: { top: number; behavior: 'smooth' | 'auto' }) => void }).scrollTo;
    if (smooth && scroll) scroll.call(box, { top: box.scrollHeight, behavior: 'smooth' });
    else this.down(box);
  }

  /** Where a talk opens: at its "New" line when it has one, else at the bottom. */
  private place(): void {
    const box = this.box;
    if (!box) return;
    const line = box.querySelector('[data-new-line]');
    if (line) {
      box.scrollTop = Math.max(0, box.scrollTop + rel(box, line) - ABOVE_NEW);
      this.last = box.scrollTop;
      this.set(gap(box) <= NEAR, this.unseen);
      this.keepAnchor();
    } else {
      this.set(true, 0);
      this.down(box);
    }
  }

  private down(box: ScrollBox): void {
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    this.last = box.scrollTop;
  }

  /** The first message still in view, and where it is. */
  private keepAnchor(): void {
    const box = this.box;
    const kids = this.content?.children;
    if (!box || !kids) return;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i]!;
      if (el.getBoundingClientRect().bottom - box.getBoundingClientRect().top > 0) {
        this.anchor = { i, top: rel(box, el) };
        return;
      }
    }
    this.anchor = null;
  }

  private set(pinned: boolean, unseen: number): void {
    if (pinned === this.pinned && unseen === this.unseen) return;
    this.pinned = pinned;
    this.unseen = unseen;
    this.onChange({ pinned, unseen });
  }
}

/** How far the box is from its bottom. */
function gap(box: ScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/** Where an element is, from the top of the box's view. */
function rel(box: ScrollBox, el: { getBoundingClientRect(): { top: number } }): number {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

/* ── The hook ──────────────────────────────────────────── */

export interface Stick extends StickState {
  /** On the scrolling box. */
  boxRef(el: HTMLElement | null): void;
  /** On the column of messages inside it. */
  contentRef(el: HTMLElement | null): void;
  /** Down to the newest message: at once for your own message, smoothly from the chip unless motion is reduced. */
  toBottom(smooth?: boolean): void;
}

/**
 * One chat's scrolling. `talk` names the talk (another one opens like new); `count` is how many messages it has. The
 * refs are callbacks, so a box that comes back (a popup brought back from its bar) is placed again.
 */
export function useStickToBottom(talk: string, count: number): Stick {
  const [state, setState] = useState<StickState>({ pinned: true, unseen: 0 });
  const ctl = useRef<StickToBottom | null>(null);
  if (!ctl.current) ctl.current = new StickToBottom(setState);
  const c = ctl.current;
  const els = useRef<{ box: HTMLElement | null; content: HTMLElement | null; off?: () => void }>({ box: null, content: null });

  const wire = useCallback(() => {
    const { box, content } = els.current;
    els.current.off?.();
    els.current.off = undefined;
    if (!box || !content) return c.attach(null, null);
    // squad-kit keeps the place itself, the same in every browser.
    box.style.overflowAnchor = 'none';
    c.attach(box, content);
    const onScroll = () => c.onScroll();
    const onTouch = () => c.touched();
    box.addEventListener('scroll', onScroll, { passive: true });
    for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.addEventListener(e, onTouch, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => c.onResize());
    ro?.observe(box);
    ro?.observe(content);
    els.current.off = () => {
      box.removeEventListener('scroll', onScroll);
      for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.removeEventListener(e, onTouch);
      ro?.disconnect();
    };
  }, [c]);

  const boxRef = useCallback(
    (el: HTMLElement | null) => {
      if (els.current.box === el) return;
      els.current.box = el;
      wire();
    },
    [wire],
  );
  const contentRef = useCallback(
    (el: HTMLElement | null) => {
      if (els.current.content === el) return;
      els.current.content = el;
      wire();
    },
    [wire],
  );
  useEffect(() => () => els.current.off?.(), []);

  const first = useRef(talk);
  useEffect(() => {
    if (first.current === talk) return;
    first.current = talk;
    c.reset();
  }, [talk, c]);
  useEffect(() => c.onCount(count), [count, c]);

  const toBottom = useCallback((smooth = false) => c.toBottom(smooth && !window.matchMedia?.(REDUCED).matches), [c]);
  return { ...state, boxRef, contentRef, toBottom };
}
