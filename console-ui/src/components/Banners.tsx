import { useEffect, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useBoard } from '../lib/data';
import { PHONE, useMedia } from '../lib/chatDock';
import { needsYou } from '../lib/waiting';
import { updateLine, useUpdate } from './Update';
import { useUsageLimit } from './UsageLimit';

/**
 * The banners over a project's pages: the update, the usage limit, squad-kit was updated, and Waiting for you. On a
 * phone with a ticket open they would take much of the height above it, so they fold into one slim row that names
 * each; a tap opens them all. They stay on the page while folded, so the tab title and the desktop notices go on.
 */
export function Banners({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const ticket = useRouterState({ select: (s) => (s.location.search as { ticket?: string }).ticket });
  const phone = useMedia(PHONE);
  const chips = useChips(path);
  const drawer = path.startsWith('/board') && Boolean(ticket);
  const [open, setOpen] = useState(false);
  // Each ticket opened starts folded again.
  useEffect(() => setOpen(false), [ticket]);
  const fold = drawer && phone && chips.length > 0;
  return (
    <div className={`banners ${fold && open ? 'unfolded' : ''}`}>
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
  const waiting = board?.ready && !path.startsWith('/inbox') ? board.tickets.filter(needsYou).length : 0;
  if (waiting) chips.push({ key: 'waiting', text: `${waiting} need${waiting === 1 ? 's' : ''} you`, tone: 'you' });
  return chips;
}
