import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Written } from './ui';
import '../styles/design-preview.css';

/** The signed link a mockup runs at: no board token in it, and a sealed policy on the page it serves. */
export function useMockupLink(ticket: string, file: string) {
  return useQuery({
    queryKey: ['mockup-link', ticket, file],
    queryFn: () => api<{ url: string }>(`/api/v1/tickets/${encodeURIComponent(ticket)}/mockup-link?path=${encodeURIComponent(file)}`),
    staleTime: Infinity,
  });
}

/**
 * The one way to look at a mockup in full, from a card, a chat, a popup or a story's plan: nearly the whole window,
 * over the page, its popups and their heads. It opens at the page's top level, so a popup or a card that moves or
 * clips what is inside it (a transform, an overflow) can never hold it. Close or Esc shuts it, also after a click into
 * the mockup, Tab stays inside it, and `opener`, the button that opened it, has the focus back: Safari never focuses a
 * button it clicks. It shows only: the card keeps Approve, for the person to press.
 */
export function MockupViewer({ ticket, file, title, opener, onClose }: { ticket: string; file: string; title: string; opener: HTMLElement | null; onClose(): void }) {
  const link = useMockupLink(ticket, file);
  const close = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const back = opener ?? (document.activeElement as HTMLElement | null);
    close.current?.focus();
    return () => {
      if (back?.isConnected) back.focus?.();
    };
  }, [opener]);
  useEffect(() => {
    // First, before any other Esc on the page: it closes only this viewer, not the popup, the drawer or a window under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Esc inside the mockup: its sealed page keeps the key and says so to this frame alone (api/mockup.ts on the server).
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && (e.data as { squadKit?: unknown } | null)?.squadKit === 'mockup-escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('message', onMessage);
    };
  }, [onClose]);
  return createPortal(
    <div className="mockview-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Tab past either end comes back round: the page under it stays out of reach while it is open. */}
      <span className="mockview-guard" tabIndex={0} onFocus={() => (frame.current ?? close.current)?.focus()} />
      <div className="mockview" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <Written as="h3" text={title} />
          <span className="mockview-hint">Click around, it is only a picture of the idea</span>
          <button ref={close} className="iconbtn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </header>
        {link.isError ? (
          <p className="note mockview-err">The mockup could not be read.</p>
        ) : (
          <iframe ref={frame} className="mockview-frame" title={title} sandbox="allow-scripts" src={link.data?.url ?? 'about:blank'} />
        )}
      </div>
      <span className="mockview-guard" tabIndex={0} onFocus={() => close.current?.focus()} />
    </div>,
    document.body,
  );
}
