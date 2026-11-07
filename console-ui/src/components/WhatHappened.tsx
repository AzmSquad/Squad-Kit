import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { api, assetUrl } from '../api/client';
import type { Ticket } from '../api/types';
import type { HandedIn, Happened, HappenedStep, SessionKey } from '../api/tabs';
import { Lightbox, type Picture } from './Lightbox';
import { langProps } from '../lib/lang';
import { Written, clock } from './ui';
import '../styles/tabs.css';

/**
 * "What happened": one card per step, oldest first, with its time, a line on what it did and what it handed in, drawn
 * as the real thing. Each card links to the tab that shows it in full, and to its conversation in the Full log.
 */

export type HappenedTab = 'plan' | 'changes' | 'proof';

export function useHappened(t: Ticket) {
  return useQuery({
    queryKey: ['happened', t.id],
    queryFn: () => api<Happened>(`/api/v1/tickets/${t.id}/happened`),
    refetchInterval: t.live ? 5000 : 15_000,
  });
}

/** "28 s", "5 min 23 s", "1 h 5 min". */
export function took(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${Math.max(1, s)} s`;
  if (s < 600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} h ${m} min` : `${Math.floor(s / 3600)} h`;
}

export function WhatHappened({ t, onTab, onLog }: { t: Ticket; onTab?: (tab: HappenedTab) => void; onLog: (key: SessionKey) => void }) {
  const q = useHappened(t);
  if (!q.data) return <p className="note">{q.isError ? 'Could not read what happened. It tries again by itself.' : 'Loading…'}</p>;
  if (!q.data.steps.length) {
    return <p className="note">Nothing has happened yet. The first card comes when the first step ends, for example the Analyst's questions.</p>;
  }
  return (
    <div className="happened">
      {q.data.steps.map((s, i) => (
        <StepCard key={`${s.step}-${s.from ?? s.to ?? i}`} s={s} t={t} onTab={onTab} onLog={onLog} />
      ))}
      <p className="note happened-foot">
        Engineers: Full log shows every action the agents took, with commands, file changes and their exact words, and how to open each session in a terminal.
      </p>
    </div>
  );
}

function StepCard({ s, t, onTab, onLog }: { s: HappenedStep; t: Ticket; onTab?: (tab: HappenedTab) => void; onLog: (key: SessionKey) => void }) {
  const time = s.seconds !== undefined ? took(s.seconds) : '';
  const meta = [s.running ? `now${time ? ` · ${time}` : ''}` : time, ...s.notes].filter(Boolean).join(' · ');
  return (
    <article className={`hstep ${s.running ? 'now' : ''}`} aria-label={s.name}>
      <div className="hhd">
        {s.running ? <span className="hring" aria-label="Working now" /> : <span className="hok" aria-label="Done"><Check size={11} strokeWidth={3} /></span>}
        <b>{s.name}</b>
        {meta && <span>{meta}</span>}
        <span className="grow" />
        {s.to && !s.running && <span className="hat">{clock(s.to)}</span>}
      </div>
      <Written as="p" className="hsum" text={s.summary} />
      {s.handedIn && <Got h={s.handedIn} tab={s.tab} onTab={onTab} ticket={t} />}
      {s.session && (s.actions ?? 0) > 0 && (
        <button className="linkbtn hmore" onClick={() => onLog(s.session!)}>
          What it looked at and said ({s.actions} {s.actions === 1 ? 'action' : 'actions'})
        </button>
      )}
      {s.skipped ? (
        <div className="hskip">
          <Minus size={12} /> Skipped {s.skipped === 1 ? 'one action' : `${s.skipped} actions`} this step may not take (by design, nothing went wrong)
        </div>
      ) : null}
    </article>
  );
}

const LINK: Record<HappenedTab, string> = { plan: 'Open it in Plan', changes: 'See the changes', proof: 'Open it in Proof' };

/** The first few of a list, with "+N more" to show the rest. */
function useMore<T>(items: T[], first = 3): { shown: T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const rest = items.length - first;
  return {
    shown: all ? items : items.slice(0, first),
    more:
      rest > 0 ? (
        <button className="linkbtn" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `+${rest} more`}
        </button>
      ) : null,
  };
}

function Got({ h, tab, onTab, ticket }: { h: HandedIn; tab?: HappenedTab; onTab?: (tab: HappenedTab) => void; ticket: Ticket }) {
  // The verdict is the Reviewer's answer itself, shown beside its line rather than as something handed in.
  if (h.kind === 'verdict') {
    return (
      <div className="hverdict">
        <GotBody h={h} ticket={ticket} />
      </div>
    );
  }
  const link = tab && onTab ? (
    <button className="linkbtn" onClick={() => onTab(tab)}>
      {h.kind === 'checks' ? 'See them in Proof' : LINK[tab]}
    </button>
  ) : null;
  return (
    <div className="hgot">
      <b>Handed in</b>
      <GotBody h={h} ticket={ticket} />
      {link && <div className="hlink">{link}</div>}
    </div>
  );
}

function GotBody({ h, ticket }: { h: HandedIn; ticket: Ticket }) {
  switch (h.kind) {
    case 'questions':
      return <Questions items={h.items} />;
    case 'spec':
      return <Spec story={h.story} criteria={h.criteria} />;
    case 'design':
      return <Design h={h} />;
    case 'files':
      return <Files h={h} />;
    case 'checks':
      return (
        <span>
          <span className={`pill ${h.ok ? 'ok' : 'bug'}`}>{h.ok ? 'Pass' : 'Failed'}</span> <Written text={h.text} />
        </span>
      );
    case 'verdict':
      return (
        <span>
          <span className={`pill ${h.approved ? 'ok' : 'you'}`}>{h.approved ? 'Approved' : 'Asked for fixes'}</span>
          {h.notes.length > 0 && (
            <ul className="hlist">
              {h.notes.map((n, i) => (
                <Written as="li" key={i} text={n} />
              ))}
            </ul>
          )}
        </span>
      );
    case 'shots':
      return <Shots shots={h.shots} ticket={ticket} />;
  }
}

function Questions({ items }: { items: Extract<HandedIn, { kind: 'questions' }>['items'] }) {
  const { shown, more } = useMore(items);
  return (
    <>
      <ol className="hlist">
        {shown.map((q, i) => (
          <li key={i} {...langProps(q.text)}>
            <Written text={q.text} />
            {q.answer && <Written className="hans" lead="You:" text={q.answer} />}
          </li>
        ))}
      </ol>
      {more}
    </>
  );
}

function Spec({ story, criteria }: { story?: string; criteria: string[] }) {
  const { shown, more } = useMore(criteria);
  return (
    <>
      {story && <Written as="p" className="hstory" text={story} />}
      {criteria.length > 0 && (
        <>
          <span className="hsub">Done when</span>
          <ul className="hlist">
            {shown.map((c, i) => (
              <Written as="li" key={i} text={c} />
            ))}
          </ul>
          {more}
        </>
      )}
    </>
  );
}

function Design({ h }: { h: Extract<HandedIn, { kind: 'design' }> }) {
  const { shown, more } = useMore(h.steps);
  const extras = [h.mockup ? 'With a mockup' : '', h.follows.length ? `Follows ${h.follows.join(', ')}` : '', h.adr ? `Saved as ${h.adr}` : ''].filter(Boolean);
  return (
    <>
      {h.title && (
        <p className="hstory" {...langProps(h.title)}>
          <Written as="b" text={h.title} />
          {h.chosen ? <Written text={`: ${h.chosen}`} /> : ''}
        </p>
      )}
      {h.steps.length > 0 && (
        <>
          <span className="hsub">{h.steps.length} {h.steps.length === 1 ? 'step' : 'steps'} to build</span>
          <ol className="hlist">
            {shown.map((s, i) => (
              <Written as="li" key={i} text={s} />
            ))}
          </ol>
          {more}
        </>
      )}
      {extras.length > 0 && <span className="hsub">{extras.join(' · ')}</span>}
    </>
  );
}

function Files({ h }: { h: Extract<HandedIn, { kind: 'files' }> }) {
  const groups = ([
    ['New', h.added],
    ['Changed', h.changed],
    ['Removed', h.removed],
  ] as [string, string[]][]).filter(([, files]) => files.length);
  if (!groups.length) {
    return (
      <ol className="hlist">
        {h.steps.map((s, i) => (
          <Written as="li" key={i} text={s} />
        ))}
      </ol>
    );
  }
  return (
    <span className="hfiles">
      {groups.map(([label, files]) => (
        <span key={label}>
          {label}: <span className="mono">{files.slice(0, 8).join(', ')}</span>
          {files.length > 8 ? ` and ${files.length - 8} more` : ''}
        </span>
      ))}
    </span>
  );
}

function Shots({ shots, ticket }: { shots: { criterion: string; file: string }[]; ticket: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const pictures: Picture[] = shots.map((s) => ({ src: assetUrl(`/api/v1/proof/${s.file}`), caption: s.criterion }));
  return (
    <>
      <div className="hshots">
        {pictures.map((p, i) => (
          <button key={p.src} className="zoom" onClick={() => setZoom(i)} aria-label={`Open the screenshot for ${p.caption} full size`}>
            <img src={p.src} alt={`${ticket.id}: ${p.caption}`} loading="lazy" />
            <Written as="small" text={p.caption} />
          </button>
        ))}
      </div>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}
