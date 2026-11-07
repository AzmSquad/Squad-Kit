import { useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, PencilLine, Send } from 'lucide-react';
import { PROJECT_BASE, api } from '../api/client';
import type { Ticket } from '../api/types';
import type { BrdRef, BreakdownView, Decided } from '../api/requirements-types';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { changedWords } from '../lib/requirements';
import { shellQuote } from '../lib/text';
import { Cmd, Modal, Place, Written, ago } from './ui';
import { AGENT_TITLE, TalkButton } from './Chat';
import { Attachments as AgentFiles } from './Attachments';
import { shipped } from './ChangeCard';
import { isMine, useMe } from './HandOver';
import { BrdViewer, useOpenRef } from './BreakdownDialogs';
import { STOP_WORDS, doingWords, optionsOf, placeOf, requirementsPath, sourceRef, waitsLine, type Source, type StopKind } from '../lib/auto';
import '../styles/auto.css';
import { useDraft } from '../lib/drafts';
import { langProps, typedDir } from '../lib/lang';

/**
 * Builds by itself, on the ticket's side: the link back to its breakdown ("From BR-1 › Payments › … › S-14"), the
 * track chip, the stop card when an agent stops for a gap or a clash, Decided for you with Change, and the small tag
 * on the board card. The Requirements page shows the same breakdown from the other side.
 */

/** The breakdown a ticket came from, as the Requirements page shows it. Light: the ticket only needs names and needs. */
export function useBreakdownView(id: string | undefined) {
  return useQuery({ queryKey: ['requirements', id, 'view'], queryFn: () => api<BreakdownView>(`/api/v1/requirements/${id}`), enabled: Boolean(id), refetchInterval: 4000 });
}

/** A link to the Requirements page that stays inside the app (a modified click still opens a new tab). */
export function BreakdownLink({ id, item, children, className }: { id: string; item?: string; children: ReactNode; className?: string }) {
  const router = useRouter();
  const to = requirementsPath(id, item);
  const go = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    void router.navigate({ href: `${PROJECT_BASE}${to}` });
  };
  return (
    <a className={className} href={`${PROJECT_BASE}${to}`} onClick={go}>
      {children}
    </a>
  );
}

/** "Builds by itself" for a story's ticket; "Full track" and "Express track" as before. */
export function TrackWords({ t }: { t: Ticket }) {
  if (t.track === 'auto') return <span className="autochip">Builds by itself</span>;
  return (
    <>
      <b>{t.track === 'express' ? 'Express' : 'Full'}</b> track
    </>
  );
}

/** "From BR-1 › Payments › Invoices and refunds › S-14", under the ticket's title. */
export function BreakdownPlace({ t }: { t: Ticket }) {
  const v = useBreakdownView(t.breakdown?.id).data;
  if (!t.breakdown) return null;
  return (
    <div className="brdplace">
      From{' '}
      <BreakdownLink id={t.breakdown.id} item={t.breakdown.item}>
        {t.breakdown.id}
      </BreakdownLink>{' '}
      › <Place path={placeOf(v, t.breakdown.item)} />
    </div>
  );
}

/** On the board card: the chip beside the id, and "BR-1 › S-14" under the title. */
export function CardAutoTag({ t }: { t: Ticket }) {
  if (t.track !== 'auto') return null;
  return <span className="prio auto">Builds by itself</span>;
}

export function CardBreakdownKey({ t }: { t: Ticket }) {
  if (!t.breakdown) return null;
  return (
    <div className="bkey" title={`From ${t.breakdown.id} › ${t.breakdown.item}`}>
      {t.breakdown.id} › {t.breakdown.item}
    </div>
  );
}

/* ── The three stops ────────────────────────────────────── */

export function StopTag({ kind }: { kind: StopKind }) {
  return <span className={`stoptag ${kind}`}>{STOP_WORDS[kind]}</span>;
}

/**
 * The stop card: an agent on a story that builds by itself stopped for a part missing in the BRD or for two parts
 * that clash. The suggested choice is marked, the card says which stories wait for the answer, and the answer goes
 * back into the same conversation.
 */
export function StopPanel({ t, extra }: { t: Ticket; extra?: ReactNode }) {
  const act = useAct();
  const q = t.agentQuestion!;
  const kind = q.kind!;
  const v = useBreakdownView(t.breakdown?.id).data;
  const options = optionsOf(q.options);
  const [pick, setPick] = useState<string | null>(() => options.find((o) => o.suggested)?.text ?? null);
  const [own, setOwn] = useDraft(t.id, 'stop-own', '');
  const who = AGENT_TITLE[q.from];
  const answer = pick === '' ? own.trim() : pick;
  const line = waitsLine(v, t);
  const doc = useOpenRef(v);
  return (
    <>
      <div className="db">
        <section className="stopcard" aria-label="Needs you">
          <div className="stophead">
            <StopTag kind={kind} />
            <span>
              The {who} found it while {doingWords(t)}, {ago(q.at)}
            </span>
          </div>
          <Written as="p" className="stuckq" text={q.text} />
          <Sources list={q.sources} onOpenRef={v ? doc.open : undefined} />
          {q.files && q.files.length > 0 && <AgentFiles ticket={t.id} files={q.files} />}
          <div className="opts2">
            {options.map((o) => (
              <button key={o.text} className={`opt2 ${pick === o.text ? 'pick' : ''}`} {...langProps(o.text)} onClick={() => setPick(o.text)} aria-pressed={pick === o.text}>
                <b><Written text={o.text} /></b>
                {(o.suggested || pick === o.text) && (
                  <span className="optfoot">
                    {o.suggested && <span className="rec">{who} suggests</span>}
                    {pick === o.text && (
                      <span className="yourpick">
                        <Check size={13} strokeWidth={2.5} /> Your pick
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
            <button className={`opt2 ${pick === '' ? 'pick' : ''}`} onClick={() => setPick('')} aria-pressed={pick === ''}>
              <b>Something else…</b>
            </button>
          </div>
          {pick === '' && <textarea className="input" rows={3} style={{ width: '100%' }} autoFocus dir={typedDir(own)} value={own} placeholder="Your answer" onChange={(e) => setOwn(e.target.value)} />}
          {(q.why || line) && <Written as="p" className="stopwhy" text={[q.why, line].filter(Boolean).join(' ')} />}
        </section>
        <DecidedForYou t={t} />
        {extra}
      </div>
      {v && doc.viewer !== undefined && createPortal(<BrdViewer v={v} at={doc.viewer ?? undefined} onClose={doc.close} />, document.body)}
      <div className="df">
        <button
          className="btn you"
          disabled={!answer || act.isPending}
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/reply`, body: { text: answer }, done: `Sent. The ${who} carries on.` })}
        >
          <Send size={15} /> Answer
        </button>
        {!t.chat?.open && <TalkButton t={t} agent={q.from} label="Ask about this" />}
        <span className="grow" />
        <Cmd text={`squad reply ${t.id}${answer ? ` ${shellQuote(answer.length > 40 ? `${answer.slice(0, 40)}…` : answer)}` : ''}`} />
      </div>
    </>
  );
}

/**
 * "Sources: BRD 4.2, page 18 · your answer to question 1 · RO-12 Cancel and refund". A place in the BRD opens the
 * document there, a ticket opens that ticket, anything else is just said.
 */
function Sources({ list, onOpenRef }: { list?: Source[]; onOpenRef?(ref: BrdRef): void }) {
  if (!list?.length) return null;
  return (
    <p className="stopsrc">
      Sources:{' '}
      {list.map((src, i) => {
        const ref = sourceRef(src);
        return (
          <span key={`${src.text}-${i}`}>
            {i > 0 && ' · '}
            {src.ticket ? (
              <Link to="/board" search={{ ticket: src.ticket }}>
                <Written text={src.text} />
              </Link>
            ) : ref && onOpenRef ? (
              <button className="linkbtn" onClick={() => onOpenRef(ref)} title="Open this place in the document">
                <Written text={src.text} />
              </button>
            ) : (
              <Written text={src.text} />
            )}
          </span>
        );
      })}
    </p>
  );
}

/* ── Decided for you ────────────────────────────────────── */

function byWords(d: Decided): string {
  return d.by === 'answer' ? 'from your answer' : `${d.by.charAt(0).toUpperCase()}${d.by.slice(1)}`;
}

/** What a changed entry became: a small change on this ticket (c2), or a new linked ticket. */
function Became({ d }: { d: Decided }) {
  const to = d.changed?.ticket;
  if (!to) return null;
  if (/^c\d+$/.test(to)) return <span className="became">It became change {to} on this ticket.</span>;
  return (
    <span className="became">
      It became{' '}
      <Link to="/board" search={{ ticket: to }}>
        {to}
      </Link>
      , linked to this one.
    </span>
  );
}

/** The small choices the squad made on this story instead of asking, each with who made it, and Change. */
export function DecidedForYou({ t }: { t: Ticket }) {
  const me = useMe();
  const [changing, setChanging] = useState<Decided | null>(null);
  const list = t.decided ?? [];
  if (!list.length) return null;
  const mine = isMine(t, me) || !me;
  return (
    <>
      <div className="lbl">Decided for you on this story</div>
      <ul className="decided">
        {list.map((d) => (
          <li key={d.id}>
            <span className="dwho">
              {byWords(d)} · {ago(d.at)}
            </span>
            {d.changed ? (
              <>
                <Written className="was" text={d.text} />
                <Written lead={<b>Now:</b>} text={d.changed.text} />
                <Became d={d} />
              </>
            ) : (
              <>
                <Written text={d.text} />
                {mine && (
                  <button className="linkbtn" onClick={() => setChanging(d)}>
                    Change
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {changing && <ChangeDecided t={t} d={changing} onClose={() => setChanging(null)} />}
    </>
  );
}

/** "What do you want instead?": a small change on this ticket, or a new linked ticket once it is merged. */
function ChangeDecided({ t, d, onClose }: { t: Ticket; d: Decided; onClose(): void }) {
  const act = useAct<Ticket>();
  const { toast } = usePrefs();
  const [text, setText, clearText] = useDraft(t.id, `decided-${d.id}`, '');
  const done = shipped(t);
  const words = text.trim();
  return (
    <Modal
      title="Change what was decided"
      icon={<PencilLine size={16} />}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn pri"
            disabled={!words || act.isPending}
            onClick={() =>
              act.mutate(
                { path: `/api/v1/tickets/${t.id}/decided/${d.id}`, body: { text: words } },
                {
                  // What it became comes back on the ticket: a small change on it, or a new linked ticket.
                  onSuccess: (r) => {
                    toast(changedWords(t.id, r?.decided?.find((x) => x.id === d.id)?.changed?.ticket));
                    clearText();
                    onClose();
                  },
                },
              )
            }
          >
            <PencilLine size={15} /> Change it
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <Cmd text={`squad decided ${t.id} ${d.id} ${shellQuote(words || 'what you want instead')}`} />
        </>
      }
    >
      <p className="note" style={{ marginBottom: 8 }}>
        {d.by === 'answer' ? 'From your answer, the squad decided:' : `The ${byWords(d)} decided:`}
      </p>
      <Written as="div" className="decidedq" text={d.text} />
      <label className="lbl" htmlFor="decided-instead" style={{ marginTop: 0 }}>
        What do you want instead?
      </label>
      <textarea id="decided-instead" className="input" rows={3} style={{ width: '100%' }} autoFocus dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the refund goes back as store credit" />
      <p className="note" style={{ marginTop: 8 }}>
        {done
          ? `${t.id} is merged, so this becomes a new ticket linked to it.`
          : 'It becomes a small change on this ticket: the Analyst writes it into the spec, you approve it, and the Builder makes it.'}
      </p>
    </Modal>
  );
}
