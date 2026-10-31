import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';

export interface Picture {
  src: string;
  caption: string;
}

/** Full-size view of one picture, with next and previous for the rest. Esc closes, the arrow keys move. */
export function Lightbox({ pictures, start, onClose }: { pictures: Picture[]; start: number; onClose(): void }) {
  const [i, setI] = useState(start);
  const n = pictures.length;
  const move = useCallback((by: number) => setI((x) => (x + by + n) % n), [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, move]);
  const pic = pictures[i];
  if (!pic) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={pic.caption} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lb-top">
        <span className="lb-cap">{pic.caption}</span>
        {n > 1 && <span className="lb-count">{i + 1} of {n}</span>}
        <span className="grow" />
        <a className="iconbtn" href={pic.src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
          <ExternalLink size={15} />
        </a>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <img className="lb-img" src={pic.src} alt={pic.caption} onMouseDown={(e) => e.stopPropagation()} />
      {n > 1 && (
        <>
          <button className="lb-nav prev" onClick={() => move(-1)} aria-label="Previous picture">
            <ChevronLeft size={22} />
          </button>
          <button className="lb-nav next" onClick={() => move(1)} aria-label="Next picture">
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>
  );
}

/** A clickable picture that opens the viewer, for the places that show one picture on its own. */
export function Zoomable({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="zoom" onClick={() => setOpen(true)} aria-label={`Open ${alt} full size`}>
        <img className={className} src={src} alt={alt} loading="lazy" />
      </button>
      {open && <Lightbox pictures={[{ src, caption: alt }]} start={0} onClose={() => setOpen(false)} />}
    </>
  );
}
