import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';

/**
 * The action bar's less-used buttons (styles/ticket-scroll.css). With room they sit in the bar like any button; in a
 * narrow panel they fold under one More button, so the bar stays one row and Stop and Take over always show. A button
 * that has nothing to offer renders nothing, and with none left More hides too.
 */
export function MoreActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="df-more" ref={box}>
      <button className="btn sm df-more-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <Ellipsis size={14} /> More
      </button>
      {/* A pick closes the list; its own dialog or chat opens as usual. */}
      <span className={`df-extra ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        {children}
      </span>
    </span>
  );
}
