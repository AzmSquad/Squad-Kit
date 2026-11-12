import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, ChevronDown, Clock, Eye, FileText, Loader2, Square } from 'lucide-react';
import { assetUrl } from '../api/client';
import type { LeadAnswer, LeadConversation, LeadSource, LeadStep, LeadTurn } from '../api/types';
import { useAct } from '../lib/data';
import { bodyAfter, contextWords, duration, fileLabel, sourcePlace, traceSummary, turnMeta } from '../lib/lead';
import { ChatMarkdown } from './ChatMarkdown';
import { LeadCardView } from './LeadCards';
import { Lightbox } from './Lightbox';
import { Written, clock } from './ui';

/**
 * One question and its answer, as the lead gives it: the question as a quote, its work first (folded to one line),
 * then a short headline, the body, the pictures from its own copy, the sources, and the cards. While it answers: a
 * calm live line with the steps so far, and Stop. A refusal is an answer like any other, in squad-kit's own words.
 */
export function LeadTurnView({ c, turn, last, onAgain }: { c: LeadConversation; turn: LeadTurn; last: boolean; onAgain(text: string, fresh?: boolean): void }) {
  const thinking = Boolean(c.thinking && last && !turn.answer && !turn.error);
  const ctx = turn.ask.context;
  const showCtx = ctx.from !== 'board' || (ctx.page !== undefined && ctx.page !== 'Squad lead');
  return (
    <div className="lt">
      <div className="lt-you">
        <div className="lt-meta">
          <b>You</b>
          {clock(turn.ask.at)}
        </div>
        <Written as="p" text={turn.ask.text} />
        {showCtx && (
          <span className="lt-ctx">
            <Eye size={12} aria-hidden="true" />
            {contextWords(ctx)}
          </span>
        )}
      </div>
      {thinking ? (
        <Thinking c={c} turn={turn} />
      ) : (
        <>
          {turn.trace.length > 0 && turn.answer?.by !== 'refusal' && <Work trace={turn.trace} seconds={turn.seconds} />}
          {turn.answer && <Answer answer={turn.answer} />}
          {turn.error && (
            <div className="lt-err" role="status">
              <Written as="p" text={turn.error} />
              {last && (
                <button className="btn sm" onClick={() => onAgain(turn.ask.text)}>
                  Ask again
                </button>
              )}
            </div>
          )}
          {(turn.answer || turn.error) && (
            <div className="lt-cost" title={turn.model ? `Ran on ${turn.model}` : undefined}>
              {turnMeta(turn)}
              {turn.answer?.by === 'note' && last && (
                <button className="linkbtn" onClick={() => onAgain(turn.ask.text, true)} title="Looks again in the code and the app, past the saved note. It costs like any question.">
                  Look again
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The newest question at the top of the view: its answer reads from the start, and the live line shows under it. */
export function showNewest(feed: HTMLElement | null): void {
  const turns = feed?.querySelectorAll<HTMLElement>('.lt');
  const last = turns?.[turns.length - 1];
  if (!feed || !last) return;
  feed.scrollTo({ top: Math.max(0, last.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop - 12) });
}

/** The work it did, folded to one line by default: "Worked for 16 s: read 3 files, searched the code twice". */
function Work({ trace, seconds }: { trace: LeadStep[]; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const line = traceSummary(trace) || `${trace.length} ${trace.length === 1 ? 'step' : 'steps'}`;
  return (
    <div className={`lt-work ${open ? 'open' : ''}`}>
      <button className="lt-wh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Clock size={14} aria-hidden="true" />
        <span>
          {seconds ? <b>Worked for {duration(seconds)}: </b> : null}
          {seconds && !line.startsWith('squad-kit') ? line[0]!.toLowerCase() + line.slice(1) : line}
        </span>
        <ChevronDown size={15} className="chev" aria-hidden="true" />
      </button>
      {open && <Steps trace={trace} />}
    </div>
  );
}

function Steps({ trace, live }: { trace: LeadStep[]; live?: boolean }) {
  return (
    <ul className="lt-steps">
      {trace.map((s, i) => (
        <li key={`${s.at}-${i}`} className={s.kind === 'refused' ? 'refused' : ''}>
          {live && i === trace.length - 1 ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Check size={14} strokeWidth={2.4} aria-hidden="true" />}
          <Written text={s.text} />
        </li>
      ))}
    </ul>
  );
}

/** Seconds since a time, moving on by itself. */
function useSince(iso: string): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, (now - Date.parse(iso)) / 1000);
}

/** The lead is answering: what it does now, how long so far, the steps so far, and Stop. */
function Thinking({ c, turn }: { c: LeadConversation; turn: LeadTurn }) {
  const act = useAct();
  const since = useSince(turn.ask.at);
  const now = turn.trace[turn.trace.length - 1]?.text ?? "Reading what squad-kit already knows about the project";
  return (
    <div className="lt-think" role="status" aria-live="polite">
      <div className="lt-th">
        <span className="live" aria-hidden="true" />
        <Written as="b" text={now} />
        <span className="lt-since">{duration(since)}</span>
        <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/lead/conversations/${encodeURIComponent(c.id)}/stop`, done: 'Stopped. What it found so far stays.' })}>
          <Square size={11} /> Stop
        </button>
      </div>
      {turn.trace.length > 1 && <Steps trace={turn.trace.slice(0, -1)} />}
    </div>
  );
}

/** The answer itself, as a short document. */
function Answer({ answer }: { answer: LeadAnswer }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const pictures = answer.evidence.map((e) => ({ src: assetUrl(e.url), caption: e.caption }));
  const body = bodyAfter(answer.headline, answer.body);
  return (
    <div className="lt-answer">
      <Written as="h3" text={answer.headline} />
      {body && <ChatMarkdown text={body} ticket="" />}
      {(pictures.length > 0 || answer.sources.length > 0) && (
        <div className="lt-evidence">
          {pictures.map((p, i) => (
            <button key={p.src} className="lt-shot zoom" onClick={() => setZoom(i)} aria-label={`Open the picture full size: ${p.caption}`}>
              <img src={p.src} alt={p.caption} loading="lazy" />
              <Written className="cap" text={p.caption} />
            </button>
          ))}
          {answer.sources.length > 0 && (
            <div className="lt-src">
              <span className="lbl2">Sources</span>
              {answer.sources.map((s, i) => (
                <Source key={`${s.kind}-${s.ref}-${i}`} s={s} />
              ))}
            </div>
          )}
        </div>
      )}
      {answer.learned && (
        <p className="lt-learned">
          <b>Saved in squad-kit&apos;s notes</b> for the next person: <Written text={answer.learned} />
        </p>
      )}
      {answer.cards.length > 0 && (
        <div className="lt-cards">
          {answer.cards.map((card) => (
            <LeadCardView key={card.id} card={card} />
          ))}
        </div>
      )}
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** One source: a story, a decision or the releases open on the board; a file shows its name and line. */
function Source({ s }: { s: LeadSource }) {
  const place = sourcePlace(s);
  const inner = (
    <>
      {s.kind === 'file' ? <FileText size={13} aria-hidden="true" /> : null}
      <span className="k">{s.kind === 'file' ? fileLabel(s.ref) : s.kind === 'note' ? 'Notes' : s.kind === 'guide' ? 'Guide' : s.kind === 'log' ? 'Log' : s.ref}</span>
      {s.label && <Written text={s.label} />}
    </>
  );
  const title = s.kind === 'file' ? s.ref : s.kind === 'note' ? `Saved on ${s.ref}` : undefined;
  if (!place) return <span className="lt-ref" title={title}>{inner}</span>;
  if (place.to === '/board')
    return (
      <Link to="/board" search={{ ticket: place.ticket }} className="lt-ref">
        {inner}
      </Link>
    );
  if (place.to === '/architecture')
    return (
      <Link to="/architecture" search={{ adr: place.adr }} className="lt-ref">
        {inner}
      </Link>
    );
  return (
    <Link to="/releases" className="lt-ref">
      {inner}
    </Link>
  );
}
