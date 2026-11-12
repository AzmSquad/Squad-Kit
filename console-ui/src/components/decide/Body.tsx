import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Check, CircleAlert, FileText } from 'lucide-react';
import { assetUrl } from '../../api/client';
import type { Ticket } from '../../api/types';
import { proofShots, type DecideKind } from '../../lib/decide';
import { Lightbox } from '../Lightbox';
import { Written } from '../ui';

/** What the person decides on: the pictures and the "done when" ticks, the spec's words, the plan's steps, the reason. */
export function Body({ t, kind }: { t: Ticket; kind: DecideKind }) {
  const [zoom, setZoom] = useState<number | null>(null);
  if (kind === 'proof') {
    const shots = proofShots(t);
    const pictures = shots.map((s) => ({ src: assetUrl(`/api/v1/proof/${s.file}`), caption: s.label }));
    const g = t.gates;
    const gates = g?.checks === 'pass' && g.review === 'pass' ? 'Checks and review passed' : g?.checks === 'pass' ? 'Checks passed' : null;
    return (
      <div className="db">
        {shots.length > 0 && (
          <div className="shots">
            {shots.slice(0, 3).map((s, i) => (
              <button key={s.file} className="shot" onClick={() => setZoom(i)} aria-label={`Open the picture full size: ${s.label}`}>
                <Written className="shot-l" text={s.label} />
                <img src={pictures[i]!.src} alt={s.label} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        <ul>
          {(t.proof ?? []).map((p) => (
            <li key={p.criterion} className={p.shows && p.shows !== 'met' && p.shows !== 'off-screen' ? 'warn' : ''}>
              {p.shows && p.shows !== 'met' && p.shows !== 'off-screen' ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
              <Written className="clamp" text={p.criterion} />
            </li>
          ))}
          {gates && (
            <li>
              <Check aria-hidden="true" />
              <span>{gates}</span>
            </li>
          )}
        </ul>
        {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      </div>
    );
  }
  if (kind === 'spec') {
    // Each "done when" in one line: "A room is closed: the heading still reads Rooms (5)".
    const items = (t.criteria ?? []).filter((c) => c.then).map((c) => (c.when?.trim() ? `${c.when.trim()[0]!.toUpperCase()}${c.when.trim().slice(1)}: ${c.then}` : c.then));
    return (
      <div className="db">
        {t.story && <Written as="p" className="sum" text={short(t.story, 220)} />}
        <List items={items} />
      </div>
    );
  }
  if (kind === 'plan' || kind === 'design') {
    const chosen = t.decision?.options.find((o) => o.chosen) ?? t.decision?.options[0];
    return (
      <div className="db">
        {t.decision && <Written as="p" className="sum" lead={<b>{t.decision.title}:</b>} text={chosen?.name ?? ''} />}
        <List items={(t.steps ?? []).map((s) => s.title)} />
      </div>
    );
  }
  if (kind === 'ask') return <div className="db"><Written as="p" className="q" text={t.agentQuestion?.text ?? ''} /></div>;
  if (kind === 'questions') return null;
  return (
    <div className="db">
      <Written as="p" className="sum" text={t.waiting?.summary ?? t.status} />
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul>
      {items.slice(0, 3).map((x, i) => (
        <li key={i}>
          <Check aria-hidden="true" />
          <Written className="clamp" text={x} />
        </li>
      ))}
      {items.length > 3 && <li className="more">and {items.length - 3} more in Read it all</li>}
    </ul>
  );
}

function short(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

/** "Full proof", "Read it all", "Open": the story on the board, where its own buttons are too. */
export function OpenLink({ t, label, btn }: { t: Ticket; label: string; btn?: boolean }) {
  const cls = btn ? 'btn' : 'link';
  if (t.waiting?.kind === 'proof')
    return (
      <Link to="/tickets/$id/proof" params={{ id: t.id }} className={cls}>
        {btn && <ArrowUpRight size={14} aria-hidden="true" />}
        {label}
      </Link>
    );
  return (
    <Link to="/board" search={{ ticket: t.id }} className={cls}>
      {btn ? <ArrowUpRight size={14} aria-hidden="true" /> : label === 'Read it all' ? <FileText size={13} aria-hidden="true" /> : null}
      {label}
    </Link>
  );
}
