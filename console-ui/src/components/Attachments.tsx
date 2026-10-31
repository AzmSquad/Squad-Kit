import { useState } from 'react';
import { Download, Maximize2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, ticketFileUrl } from '../api/client';
import { Zoomable } from './Lightbox';
import { Modal } from './ui';

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
 */
export function Mockup({ ticket, file, title = 'Mockup' }: { ticket: string; file: string; title?: string }) {
  const [big, setBig] = useState(false);
  const link = useQuery({
    queryKey: ['mockup-link', ticket, file],
    queryFn: () => api<{ url: string }>(`/api/v1/tickets/${encodeURIComponent(ticket)}/mockup-link?path=${encodeURIComponent(file)}`),
    staleTime: Infinity,
  });
  if (link.isError) return <p className="note">The mockup could not be read.</p>;
  const frame = (cls: string) => <iframe className={cls} title={title} sandbox="allow-scripts" src={link.data?.url ?? 'about:blank'} />;
  return (
    <div className="mockup">
      <div className="mockbar">
        <span>{title} · click around, it is only a picture of the idea</span>
        <button className="btn sm" onClick={() => setBig(true)}>
          <Maximize2 size={12} /> Full size
        </button>
      </div>
      {frame('mockframe')}
      {big && (
        <Modal title={title} wide onClose={() => setBig(false)}>
          {frame('mockframe big')}
        </Modal>
      )}
    </div>
  );
}

function baseName(f: string): string {
  return f.split(/[\\/]/).pop() ?? f;
}
