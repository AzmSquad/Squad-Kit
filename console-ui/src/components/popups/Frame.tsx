import { useState, type ReactNode } from 'react';
import { Maximize2, Minus, X } from 'lucide-react';
import { popups, type Pop } from '../../lib/popups';
import { REDUCED } from '../../lib/reveal';
import { Written } from '../ui';

/** The frame every popup shares: its head line with who it is, and Open full page, Minimise and Close. */
export function Frame({ pop, avatar, title, sub, busy, dir, onExpand, children }: { pop: Pop; avatar: ReactNode; title: ReactNode; sub: string; busy?: boolean; dir?: 'rtl' | 'ltr'; onExpand(): void; children: ReactNode }) {
  const [out, setOut] = useState(false);
  const close = () => {
    if (window.matchMedia?.(REDUCED).matches) return popups.close(pop.id);
    setOut(true);
    setTimeout(() => popups.close(pop.id), 200);
  };
  const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    fn();
  };
  return (
    <section className={`pop ${pop.min ? 'mini' : ''} ${out ? 'out' : ''}`} dir={dir} aria-label={typeof title === 'string' ? title : sub}>
      <header className="ph" onClick={() => pop.min && popups.open(pop.id)}>
        {avatar}
        <div className="pt">
          <h2>{title}</h2>
          <div className="sub">
            <span className={`dot ${busy ? 'busy' : ''}`} aria-hidden="true" />
            <Written text={sub} />
          </div>
        </div>
        <div className="tools">
          <button className="ib" onClick={stop(onExpand)} aria-label="Open the full page" title="Open the full page">
            <Maximize2 size={16} />
          </button>
          <button className="ib" onClick={stop(() => (pop.min ? popups.open(pop.id) : popups.minimise(pop.id)))} aria-label={pop.min ? 'Open it again' : 'Minimise'} title={pop.min ? 'Open it again' : 'Minimise'}>
            <Minus size={16} />
          </button>
          <button className="ib" onClick={stop(close)} aria-label="Close" title="Close">
            <X size={16} />
          </button>
        </div>
      </header>
      {!pop.min && children}
    </section>
  );
}
