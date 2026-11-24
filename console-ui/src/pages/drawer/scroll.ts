import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlipGuard, topRow, type TopRow } from './top-row';

/**
 * One scroll for the open ticket (styles/ticket-scroll.css). The top row (id and buttons) and the tabs stay in place;
 * the title and the steps scroll away. `past` is true once the title is out of sight, so the top row shows it instead.
 * The top row's height goes to `--dtop-h`, so the tabs stop right under it at any width.
 */
export function useTicketScroll(id: string, tab: string) {
  const panel = useRef<HTMLElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [past, setPast] = useState(false);
  const rowNow = useRef<TopRow>({ past: false, full: 0 });
  const guard = useRef<FlipGuard | null>(null);
  guard.current ??= new FlipGuard((fn) => (typeof requestAnimationFrame === 'undefined' ? setTimeout(fn, 16) : requestAnimationFrame(fn)));

  // Showing the title in the row must never flip it back (drawer/top-row.ts).
  const measure = useCallback(() => {
    const p = panel.current;
    const row = top.current;
    if (!p || !row) return;
    p.style.setProperty('--dtop-h', `${row.offsetHeight}px`);
    const title = p.querySelector<HTMLElement>('.dh h2');
    const short = p.classList.contains('past');
    // With the title the row keeps the height it had with its links (styles/ticket-scroll.css): nothing below it moves.
    if (!short) p.style.setProperty('--dtop-full', `${row.offsetHeight}px`);
    const next = topRow(rowNow.current, {
      row: row.offsetHeight,
      short,
      scroll: p.scrollTop,
      titleBottom: title ? title.getBoundingClientRect().bottom - (p.getBoundingClientRect().top + p.clientTop) : null,
    });
    if (next.past !== short && !guard.current!.allow()) return;
    rowNow.current = next;
    setPast(next.past);
  }, []);

  // The top row changes height when it wraps (a narrow panel) or when the ticket loads.
  useLayoutEffect(() => {
    const row = top.current;
    if (!row) return;
    measure();
    // A page without it (an old browser, a test's page) measures once per render.
    if (typeof ResizeObserver === 'undefined') return;
    const seen = new ResizeObserver(measure);
    seen.observe(row);
    return () => seen.disconnect();
  });

  // Another ticket starts at its top.
  useEffect(() => {
    panel.current?.scrollTo?.({ top: 0 });
    rowNow.current = { past: false, full: 0 };
    setPast(false);
  }, [id]);

  // Another tab starts at its own top: when the tabs already stay at the top, they stay there.
  useEffect(() => {
    const p = panel.current;
    const head = p?.querySelector<HTMLElement>(':scope > .dh');
    const row = top.current;
    if (!p || !head || !row) return;
    // The tabs come right after the title and steps (a sticky element's own offsetTop moves while it sticks).
    const stuck = head.offsetTop + head.offsetHeight - row.offsetHeight;
    if (p.scrollTop > stuck) p.scrollTo?.({ top: stuck });
  }, [tab]);

  return { panel, top, past, onScroll: measure };
}
