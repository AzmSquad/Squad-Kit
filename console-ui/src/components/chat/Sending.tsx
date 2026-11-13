import { useEffect } from 'react';
import type { AgentName, Ticket } from '../../api/types';
import { useReveal } from '../../lib/reveal';
import { detect, firstWords, textClass } from '../../lib/lang';
import { ChatMarkdown } from '../ChatMarkdown';
import type { PickedFile } from '../dialogs';
import { AGENT_TITLE, Avatar, type ChatSize } from './parts';

/** The agent's reply as far as it came, written out at a reading pace. */
export function Drafting({ t, role, text, size, onShown }: { t: Ticket; role: AgentName; text: string; size: ChatSize; onShown(n: number): void }) {
  const r = useReveal(text, true);
  useEffect(() => onShown(r.shown), [r.shown, onShown]);
  return (
    <div className={`cag cmsg ag-${role}`}>
      <Avatar role={role} live />
      <div className="cwho">
        <b>{AGENT_TITLE[role]}</b>
        <span className="shim">Writing</span>
      </div>
      <div className="cagb">
        <ChatMarkdown text={firstWords(text, r.shown)} ticket={t.id} stream caret />
      </div>
      {size === 'phone' && <span className="cmeta">{AGENT_TITLE[role]} · now</span>}
    </div>
  );
}

/* ── Messages ──────────────────────────────────────────── */

export interface Pending {
  text: string;
  files: PickedFile[];
  count: number;
}

/** Your message on its way: each file with its upload bar, then the words. */
export function Sending({ p }: { p: Pending }) {
  const d = detect(p.text);
  return (
    <div className="cyou cmsg">
      <div className="cybub">
        {p.files.length > 0 && (
          <div className="cup">
            {p.files.map((f, i) => (
              <div key={i} className="cup-row">
                {f.preview ? <img className="cup-img" src={f.preview} alt="" /> : <span className="cfic sm file">{(f.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</span>}
                <span className="cfname">{f.name}</span>
                <span className="cbar">
                  <i />
                </span>
              </div>
            ))}
          </div>
        )}
        {p.text.trim() && (
          <p className={textClass(d)} dir={d.dir} lang={d.dir === 'rtl' ? 'ar' : 'en'}>
            {p.text}
          </p>
        )}
      </div>
      <span className="cmeta">You · now · sending</span>
    </div>
  );
}
