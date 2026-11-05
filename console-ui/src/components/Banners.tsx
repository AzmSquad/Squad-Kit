import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useBoard } from '../lib/data';
import { PHONE, useMedia } from '../lib/chatDock';
import { needsYou } from '../lib/waiting';
import { useBreakdownWaits } from './BreakdownWaits';
import { updateLine, useUpdate } from './Update';
import { useUsageLimit } from './UsageLimit';

/**
 * The banners over a project's pages: the update, the usage limit, squad-kit was updated, and Waiting for you. With a
 * ticket open in a narrow board area (a phone, or the chat docked beside the board) they would take much of the height
 * above it, so they fold into one slim row that names each; a tap opens them all. They stay on the page while folded,
 * so the tab title and the desktop notices go on.
 */
export function Banners({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const ticket = useRouterState({ select: (s) => (s.location.search as { ticket?: string }).ticket });
  const phone = useMedia(PHONE);
  const narrow = useNarrow();
  const chips = useChips(path);
  const drawer = path.startsWith('/board') && Boolean(ticket);
  const [open, setOpen] = useState(false);
  // Each ticket opened starts folded again.
  useEffect(() => setOpen(false), [ticket]);
  const fold = drawer && (phone || narrow.is) && chips.length > 0;
  return (
    <div ref={narrow.ref} className={`banners ${fold && open ? 'unfolded' : ''}`}>
      {fold && open && (
        <button className="bless" onClick={() => setOpen(false)} aria-expanded>
          <ChevronUp size={14} aria-hidden /> Show less
        </button>
      )}
      {fold && !open && (
        <button className="bslim" onClick={() => setOpen(true)} aria-expanded={false} aria-label={`${chips.map((c) => c.text).join(', ')}. Show the messages`}>
          <span className="bchips">
            {chips.map((c) => (
              <span key={c.key} className={`bchip ${c.tone}`}>
                {c.text}
              </span>
            ))}
          </span>
          <ChevronDown size={16} aria-hidden />
        </button>
      )}
      <div className="banners-all" hidden={fold && !open}>
        {children}
      </div>
    </div>
  );
}

interface Chip {
  key: string;
  text: string;
  tone: 'you' | 'acc';
}

/** A few words for each banner showing now, in the same order as the banners: three fit a phone's width. */
function useChips(path: string): Chip[] {
  const update = useUpdate().data;
  const limit = useUsageLimit().data;
  const board = useBoard().data;
  const chips: Chip[] = [];
  const u = update ? updateLine(update) : null;
  if (u) chips.push({ key: 'update', text: u, tone: update?.progress.state === 'failed' ? 'you' : 'acc' });
  if (limit?.pause && limit.text) chips.push({ key: 'limit', text: 'Usage limit', tone: 'you' });
  if (board?.ready && board.console?.outdated) chips.push({ key: 'restart', text: 'Restart to update', tone: 'you' });
  // A breakdown whose Analyst has questions counts too, as in the banner (components/BreakdownWaits).
  const breakdowns = useBreakdownWaits().length;
  const waiting = board?.ready && !path.startsWith('/inbox') ? board.tickets.filter(needsYou).length + breakdowns : 0;
  if (waiting) chips.push({ key: 'waiting', text: `${waiting} need${waiting === 1 ? 's' : ''} you`, tone: 'you' });
  return chips;
}

/** The board area is narrow: the banners' own width is under the width the drawer needs to stand beside the board. */
function useNarrow(): { ref: (el: HTMLDivElement | null) => void; is: boolean } {
  const [is, setIs] = useState(false);
  const watch = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    watch.current = new ResizeObserver(([e]) => setIs((e?.contentRect.width ?? Infinity) < 820));
    watch.current.observe(el);
  }, []);
  useEffect(() => () => watch.current?.disconnect(), []);
  return { ref, is };
}
