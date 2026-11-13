import { useCallback, useRef, useState } from 'react';
import { Download, Maximize2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, ticketFileUrl } from '../api/client';
import { Zoomable } from './Lightbox';
import { Modal } from './ui';
import '../styles/design-preview.css';

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const PAGE = /\.html?$/i;

/** Files an agent attached: pictures open full size, an HTML mockup runs in a sealed frame, anything else downloads. */
export function Attachments({ ticket, files }: { ticket: string; files: string[] }) {
  const pictures = files.filter((f) => PICTURE.test(f));
  const pages = files.filter((f) => PAGE.test(f));
  const other = files.filter((f) => !PICTURE.test(f) && !PAGE.test(f));
  return (
    <div className="attached">
      {pages.map((f) => (
        <Mockup key={f} ticket={ticket} file={f} />
      ))}
      {pictures.length > 0 && (
        <div className="attpics">
          {pictures.map((f) => (
            <Zoomable key={f} src={ticketFileUrl(ticket, f)} alt={baseName(f)} />
          ))}
        </div>
      )}
      {other.map((f) => (
        <a key={f} className="btn sm" href={ticketFileUrl(ticket, f)} download>
          <Download size={13} /> {baseName(f)}
        </a>
      ))}
    </div>
  );
}

/**
 * A clickable mockup. It runs its own scripts in a sandbox without the board's origin (no allow-same-origin), and the
 * server's policy for it allows no network, so it cannot read the board, its token or its data, or send anything out.
 * `preview`: a small picture of it in a card, which cannot be clicked into, and "Open the mockup" for the full one.
 */
export function Mockup({ ticket, file, title = 'Mockup', preview }: { ticket: string; file: string; title?: string; preview?: boolean }) {
  const [big, setBig] = useState(false);
  const fit = useFit();
  const link = useQuery({
    queryKey: ['mockup-link', ticket, file],
    queryFn: () => api<{ url: string }>(`/api/v1/tickets/${encodeURIComponent(ticket)}/mockup-link?path=${encodeURIComponent(file)}`),
    staleTime: Infinity,
  });
  if (link.isError) return <p className="note">The mockup could not be read.</p>;
  const frame = (cls: string) => <iframe className={cls} title={title} sandbox="allow-scripts" src={link.data?.url ?? 'about:blank'} />;
  const full = big && (
    <Modal title={title} wide onClose={() => setBig(false)}>
      {frame('mockframe big')}
    </Modal>
  );
  if (preview) {
    return (
      <div className="mockprev">
        <button className="mockprev-pic" ref={fit} onClick={() => setBig(true)} aria-label={`Open the mockup: ${title}`}>
          {/* Scaled down and out of reach: a picture of the screen, with a fixed size so nothing moves when it loads. */}
          <iframe className="mockprev-frame" title={title} sandbox="allow-scripts" src={link.data?.url ?? 'about:blank'} tabIndex={-1} aria-hidden="true" loading="lazy" />
        </button>
        <button className="linkbtn mockprev-open" onClick={() => setBig(true)}>
          <Maximize2 size={12} aria-hidden="true" /> Open the mockup
        </button>
        {full}
      </div>
    );
  }
  return (
    <div className="mockup">
      <div className="mockbar">
        <span>{title} · click around, it is only a picture of the idea</span>
        <button className="btn sm" onClick={() => setBig(true)}>
          <Maximize2 size={12} /> Full size
        </button>
      </div>
      {frame('mockframe')}
      {full}
    </div>
  );
}

/** The width a preview is drawn at before it is scaled down to its card. */
const PREVIEW_W = 960;

/** Scales a preview's frame to its box's width, as the box changes size. */
function useFit() {
  const watch = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    watch.current?.disconnect();
    watch.current = null;
    if (!el) return;
    const set = () => el.style.setProperty('--s', String(Math.max(0.1, el.clientWidth / PREVIEW_W)));
    set();
    if (typeof ResizeObserver === 'undefined') return;
    watch.current = new ResizeObserver(set);
    watch.current.observe(el);
  }, []);
}

function baseName(f: string): string {
  return f.split(/[\\/]/).pop() ?? f;
}
