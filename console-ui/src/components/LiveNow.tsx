import { useState } from 'react';
import { Clock, PencilLine, Send, Square, TriangleAlert } from 'lucide-react';
import type { AskAnswer, AskOffer, LiveNow, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { send } from '../api/client';
import { detect } from '../lib/lang';
import { Cmd, Glyph, ROLE_NAME, clock } from './ui';
import { ProposeChange } from './ChangeCard';
import { TalkButton } from './Chat';
import '../styles/now.css';

/**
 * What is happening on a ticket now, as squad-kit works it out from the live record: the card's line on the board,
 * the Now tab's sentence with what comes next, the "Taking longer than usual" and "Looks stuck" cards, and the Ask box.
 * The words come from the engine, so the board and `squad show` always say the same thing.
 */

/** Running, waiting for a place, or stopping: the live line applies. */
export function isRunning(t: Ticket): boolean {
  return Boolean(t.now && (t.now.state === 'working' || t.now.state === 'queued' || t.now.state === 'stopping'));
}

/** "4 seconds ago", "2 minutes ago". */
function sinceWords(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  return `${m} minute${m === 1 ? '' : 's'} ago`;
}

export function StepBar({ bar, big }: { bar?: LiveNow['bar']; big?: boolean }) {
  if (!bar?.length) return null;
  return (
    <div className={`segbar ${big ? 'big' : ''}`} aria-hidden>
      {bar.map((b, i) => (
        <span key={i} className={b === 'done' ? 'd' : b === 'now' ? 'n' : ''} />
      ))}
    </div>
  );
}

/** The card's line on the board: who, which step, what it does, how long, and the usual time. */
export function CardLine({ t }: { t: Ticket }) {
  const n = t.now!;
  if (n.state === 'queued') return <div className="nl1 quiet">{n.line}</div>;
  const [who, ...rest] = n.line.split(' · ');
  const slow = t.quiet;
  return (
    <>
      <div className="nl1">
        <span className="live" />
        <span>
          <b>{who}</b>
          {rest.length ? ` · ${rest.join(' · ')}` : ''}
        </span>
      </div>
      {slow ? (
        <div className={`nl2 slow ${slow.kind}`}>
          {slow.kind === 'stuck' ? <TriangleAlert size={12} /> : <Clock size={12} />}
          {slow.kind === 'stuck' ? 'Looks stuck' : 'Taking longer than usual'}
          {n.seconds !== undefined && slow.kind === 'long' ? ` · ${n.time?.split(' · ')[0]}` : ''}
        </div>
      ) : (
        n.time && <div className="nl2">{n.time}</div>
      )}
      <StepBar bar={n.bar} />
    </>
  );
}

/** The Now tab while the squad works: one plain sentence, the step and its time, and what comes next. */
export function NowCard({ t }: { t: Ticket }) {
  const n = t.now!;
  const head = n.state === 'queued' ? 'Next in line' : n.state === 'stopping' ? 'Stopping' : 'Working';
  const [first, ...more] = (n.detail ?? '').split(' · ');
  return (
    <section className="nowcard" aria-label="What is happening now">
      <div className="nowhead">
        {n.state === 'working' && <span className="live" />}
        <span>
          {head}
          {n.state === 'working' && n.lastAt ? ` · last update ${sinceWords(n.lastAt)}` : ''}
        </span>
      </div>
      <p className="nowsay">{n.sentence}</p>
      {n.detail && (
        <div className="nowmeta">
          {n.part ? <b>{first}</b> : first}
          {more.length ? ` · ${more.join(' · ')}` : ''}
        </div>
      )}
      <StepBar bar={n.bar} big />
      {n.next && (
        <div className="nownext">
          <b>What comes next:</b> {n.next}
        </div>
      )}
    </section>
  );
}

/** The work so far in plain words: the latest lines of the role working now, else of the whole squad. */
export function WorkSoFar({ t }: { t: Ticket }) {
  const role = t.now?.role === 'squad' ? 'tester' : t.now?.role;
  const theirs = role ? t.activity.filter((a) => a.who === role) : [];
  const items = (theirs.length >= 2 ? theirs : t.activity).slice(0, 6);
  if (!items.length) return null;
  const who = theirs.length >= 2 && role ? ROLE_NAME[role] : 'squad';
  return (
    <>
      <div className="lbl">What the {who} did, in plain words</div>
      <div className="feed">
        {items.map((a, i) => (
          <div className="fe" key={a.at + i}>
            <span className="tm">{clock(a.at)}</span>
            <Glyph role={a.who} small />
            <span>{a.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Taking longer, looks stuck ────────────────────────── */

/** The step is slow or quiet: say what it does and what squad-kit checked, with the ways on. Nothing hangs silently. */
export function SlowPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const s = t.now?.slow;
  const busy = act.isPending || t.stopRequested;
  if (!s) return null;
  const stuck = s.kind === 'stuck';
  const more = () => act.mutate({ path: `/api/v1/tickets/${t.id}/keep-waiting`, body: { minutes: 10 }, done: 'OK. squad-kit stays quiet about it for 10 minutes.' });
  const again = () => act.mutate({ path: `/api/v1/tickets/${t.id}/restart`, done: 'Stopping the step. It starts again at once, with the work so far.' });
  const stop = () => act.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping. The work so far is kept.' });
  const end = () => act.mutate({ path: `/api/v1/tickets/${t.id}/unstick`, done: 'Ended the stuck command. The squad carries on.' });
  return (
    <section className={`slowcard ${stuck ? 'stuck' : ''}`} aria-label={s.title}>
      <div className="slowhead">
        {stuck ? <TriangleAlert size={17} /> : <Clock size={17} />}
        <b>{s.title}</b>
        <span className="grow" />
        <span className="where">{s.where}</span>
      </div>
      <div className="slowbody">
        <p className="slowsay">{s.text}</p>
        <div className="facts">
          {s.facts.map((f) => (
            <div className="fact" key={f.label}>
              <span>{f.label}</span>
              <span>{f.value}</span>
            </div>
          ))}
        </div>
        <div className="ways">
          {stuck && s.canEnd && (
            <button className="btn pri" disabled={busy} onClick={end}>
              End the stuck command
            </button>
          )}
          {!stuck && (
            <button className="btn you" disabled={busy} onClick={more}>
              Give it 10 more minutes
            </button>
          )}
          <button className="btn" disabled={busy} onClick={again}>
            Stop and try again
          </button>
          {stuck && (
            <button className="btn" disabled={busy} onClick={more}>
              Keep waiting
            </button>
          )}
          <button className="btn" disabled={busy} onClick={stop}>
            <Square size={12} /> Stop
          </button>
        </div>
        {stuck && s.canEnd && <p className="note slownote">Ending the command gives the squad an error back, and it carries on in the same conversation.</p>}
        <div className="slowfoot">
          <span>{s.limit ?? 'Nothing is lost whatever you choose.'}</span>
          <span className="grow" />
          <Cmd text={stuck && s.canEnd ? `squad unstick ${t.id}` : `squad wait ${t.id} --more 10m`} />
        </div>
      </div>
    </section>
  );
}

/* ── Ask about this ticket ─────────────────────────────── */

type Said = { q: string; a?: AskAnswer; error?: string; at: string };

/** A status question gets its answer at once from the live record. Anything else offers an agent or a change. */
export function AskBox({ t }: { t: Ticket }) {
  const [text, setText] = useState('');
  const [said, setSaid] = useState<Said[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const a = await send<AskAnswer>(`/api/v1/tickets/${t.id}/status/ask`, 'POST', { text: q });
      setSaid((s) => [...s, { q, a, at: new Date().toISOString() }]);
      setText('');
    } catch (err) {
      setSaid((s) => [...s, { q, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };
  const dir = detect(text).dir;
  return (
    <section className="askbox" aria-label="Ask about this ticket">
      <label htmlFor={`ask-${t.id}`} className="lbl">
        Ask about this ticket
      </label>
      {said.length > 0 && (
        <div className="askthread">
          {said.map((s, i) => (
            <AskTurn key={s.at + i} t={t} said={s} />
          ))}
        </div>
      )}
      <div className="askrow">
        <input
          id={`ask-${t.id}`}
          className="input"
          dir={dir}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void ask()}
          placeholder="For example: is there a problem? when will it be ready?"
        />
        <button className="btn pri" disabled={!text.trim() || busy} onClick={() => void ask()}>
          <Send size={14} /> Ask
        </button>
      </div>
      <div className="askfoot">
        <span>Status answers come at once, in English or Arabic, with no AI cost. Questions for an agent reach it at its next safe moment.</span>
        <span className="grow" />
        <Cmd text={`squad status ${t.id}`} />
      </div>
    </section>
  );
}

function AskTurn({ t, said }: { t: Ticket; said: Said }) {
  const a = said.a;
  const ar = a?.lang === 'ar';
  const qdir = detect(said.q).dir;
  return (
    <div className="askturn">
      <div className="askme" dir={qdir}>
        {said.q}
      </div>
      <div className={`askit ${ar ? 'ar' : ''}`} dir={ar ? 'rtl' : 'ltr'} lang={ar ? 'ar' : 'en'}>
        <div className="who">
          <b>squad-kit</b>
          {a?.instant && <span className="tag">{ar ? 'إجابة فورية' : 'answered at once'}</span>}
          <span className="note">{clock(said.at)}</span>
        </div>
        {said.error ? <p className="err">{said.error}</p> : a?.lines.map((l, i) => <p key={i}>{l}</p>)}
        {a && a.offers.length > 0 && (
          <div className="askoffers">
            {a.offers.map((o) => (
              <Offer key={o.do + o.label} t={t} o={o} question={said.q} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Offer({ t, o, question }: { t: Ticket; o: AskOffer; question: string }) {
  const act = useAct();
  const { toast } = usePrefs();
  const [proposing, setProposing] = useState(false);
  const [sent, setSent] = useState(false);
  switch (o.do) {
    case 'propose':
      return (
        <>
          <button className="btn sm offer" onClick={() => setProposing(true)}>
            <span className="ol">
              <PencilLine size={13} /> {o.label}
            </span>
            <span className="on">{o.note}</span>
          </button>
          {proposing && <ProposeChange t={t} initial={question} onClose={() => setProposing(false)} />}
        </>
      );
    case 'note':
      return (
        <button
          className="btn sm offer"
          disabled={sent || act.isPending}
          onClick={() =>
            act.mutate(
              { path: `/api/v1/tickets/${t.id}/notes`, body: { text: question, ...(o.to ? { to: o.to } : {}) } },
              {
                onSuccess: () => {
                  setSent(true);
                  toast(`Sent. ${o.note}`);
                },
              },
            )
          }
        >
          <span className="ol">
            <Send size={13} /> {sent ? 'Sent' : o.label}
          </span>
          <span className="on">{o.note}</span>
        </button>
      );
    case 'chat':
      return <TalkButton t={t} agent={o.to} label={o.label} />;
    case 'stop':
      return (
        <button className="btn sm" disabled={act.isPending || t.stopRequested} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping. The work so far is kept.' })}>
          <Square size={12} /> {o.label}
        </button>
      );
  }
}
