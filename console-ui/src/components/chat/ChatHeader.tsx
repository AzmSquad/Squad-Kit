import { useState } from 'react';
import { Bug, Check, FileText, Maximize2, MessageCircle, Minimize2, PencilLine, SquarePlus } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { popups } from '../../lib/popups';
import { ProposeChange, canPropose } from '../ChangeCard';
import { TakeOverButton, canTakeOver } from '../TakeOver';
import { Written } from '../ui';
import { whereItStands } from '../../lib/review';
import { AGENT_TITLE, Avatar, type ChatSize, primaryOf, stageLine, talkKind } from './parts';

/* ── The header ────────────────────────────────────────── */

export function ChatHeader({ t, size, onFull, onPanel }: { t: Ticket; size: ChatSize; onFull?(): void; onPanel?(): void }) {
  const act = useAct();
  // A change goes through the spec: proposed here, or on accepted work a new linked ticket or a bug report.
  const [change, setChange] = useState(false);
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  const kind = talkKind(t);
  const stage = stageLine(t);
  const primary = c.open ? primaryOf(t) : null;
  const busy = act.isPending || Boolean(c.thinking);
  const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
  const run = (path: string, done: string) => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/${path}`, done });

  const buttons = (
    <>
      {c.open && primary && (
        <button className="btn pri" disabled={busy} onClick={() => run(primary.path, primary.done)}>
          <Check size={15} strokeWidth={2.5} /> {primary.label}
        </button>
      )}
      {c.open && kind.kind === 'talk' && !later && (
        <button className="btn" disabled={busy} onClick={() => run('done', 'Done talking.')}>
          {primary ? 'Done, no changes' : 'Done'}
        </button>
      )}
      {c.open && kind.kind === 'talk' && later && canTakeOver(t) && <TakeOverButton t={t} />}
      {c.open && kind.kind === 'released' && (
        <>
          <button className="btn" onClick={() => setChange(true)}>
            <SquarePlus size={14} /> New linked ticket
          </button>
          <button className="btn" onClick={() => setChange(true)}>
            <Bug size={14} /> Report a bug
          </button>
        </>
      )}
      {c.open && kind.kind === 'working' && canPropose(t) && (
        <button className="btn" onClick={() => setChange(true)}>
          <PencilLine size={14} /> Propose a change
        </button>
      )}
      {c.open && kind.kind !== 'talk' && (
        <button className="btn" disabled={act.isPending} onClick={() => run('done', `Done asking the ${who}.`)}>
          Done
        </button>
      )}
      {!c.open && (c.beside || !t.takenOver) && (
        <button
          className="btn"
          disabled={act.isPending}
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: c.with, ...(c.beside ? { ask: true } : {}) } }, { onSuccess: () => popups.open(t.id) })}
        >
          <MessageCircle size={14} /> {c.beside ? `Ask the ${who} again` : `Talk to the ${who} again`}
        </button>
      )}
    </>
  );

  // Questions only: one plain line of where the story stands ("RO-7 waits in the queue"), which the talk never changes.
  const stands = c.beside ? whereItStands(t) : '';
  const banner =
    c.open && kind.kind === 'working' ? (
      <div className="cbanner work">
        <span className="livedot" aria-hidden="true" />
        <span>
          <b>{stands}</b>
          {t.status ? <> · {t.status}</> : null}. Asking never stops the work; a change goes through the spec.
        </span>
      </div>
    ) : c.open && kind.kind === 'review' ? (
      <div className="cbanner done">
        <span>
          <b>{stands}.</b> Your questions change nothing on it.{' '}
          {t.waiting?.kind === 'proof' ? "To ask for a change, press Something's wrong." : 'To go on, pick a way out on its card.'}
        </span>
      </div>
    ) : c.open && kind.kind === 'released' ? (
      <div className="cbanner done">
        <span>
          <b>{stands}.</b> Ask anything about it. A change becomes a new linked ticket or a bug report.
        </span>
      </div>
    ) : c.open && kind.kind === 'still' ? (
      <div className="cbanner done">
        <span>
          <b>{stands}.</b> Your questions change nothing on it.
        </span>
      </div>
    ) : null;

  const dialogs = change ? <ProposeChange t={t} from={c.with} onClose={() => setChange(false)} /> : null;

  // In a popup: one line under its head line, with the talk's own buttons.
  if (size === 'pop') {
    return (
      <div className="cstrip">
        <FileText size={15} aria-hidden="true" />
        <b>{c.open ? (kind.kind === 'talk' && c.with === 'analyst' ? `The spec ${t.story ? 'grows' : 'starts'} as you talk` : kind.kind === 'talk' && c.with === 'architect' && t.specApproved ? 'The design grows as you talk' : stands || kind.note) : 'This talk is over'}</b>
        <span className="grow" />
        {c.open && primary && (
          <button className="linkbtn go" disabled={busy} onClick={() => run(primary.path, primary.done)}>
            {primary.label}
          </button>
        )}
        {c.open && (
          <button className="linkbtn" disabled={act.isPending} onClick={() => run('done', kind.kind === 'talk' ? 'Done talking.' : `Done asking the ${who}.`)}>
            {primary && kind.kind === 'talk' && !later ? 'Done, no changes' : 'Done'}
          </button>
        )}
        {!c.open && (c.beside || !t.takenOver) && (
          <button className="linkbtn go" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: c.with, ...(c.beside ? { ask: true } : {}) } })}>
            Talk again
          </button>
        )}
        {dialogs}
      </div>
    );
  }

  if (size === 'phone') {
    return (
      <div className="chead-m">
        <div className="chead-m-row">
          <Written className="ctitle" text={t.title} />
          {c.open && primary && (
            <button className="btn pri sm" disabled={busy} onClick={() => run(primary.path, primary.done)}>
              {primary.label}
            </button>
          )}
          {c.open && !primary && (
            <button className="btn sm" disabled={act.isPending} onClick={() => run('done', 'Done talking.')}>
              Done
            </button>
          )}
        </div>
        {banner}
        {c.open && kind.kind === 'released' && (
          <div className="chead-m-row">
            <button className="btn sm" onClick={() => setChange(true)}>
              <SquarePlus size={13} /> New linked ticket
            </button>
            <button className="btn sm" onClick={() => setChange(true)}>
              <Bug size={13} /> Report a bug
            </button>
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  if (size === 'full') {
    return (
      <div className="chead-f">
        <div className="chead-f-row">
          <Avatar role={c.with} live={c.thinking} />
          <div className="chead-f-t">
            <div className="chead-line">
              <span className="cid">{t.id}</span>
              <span className={`cstage ${stage.tone}`}>{stage.text}</span>
              {c.open && <span className="cnote">{kind.note}</span>}
            </div>
            <Written as="div" className="ctitle" text={t.title} />
          </div>
          <span className="grow" />
          <div className="cbtns">{buttons}</div>
          {onPanel && (
            <button className="iconbtn" onClick={onPanel} aria-label="Back to its popup" title="Back to its popup">
              <Minimize2 size={16} />
            </button>
          )}
        </div>
        {banner}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="chead-p">
      <div className="chead-line">
        <span className="cid">{t.id}</span>
        <span className={`cstage ${stage.tone}`}>{stage.text}</span>
        <span className="grow" />
        {c.open && <span className="cnote">{kind.note}</span>}
        {onFull && (
          <button className="iconbtn sm" onClick={onFull} aria-label="Open full screen" title="Full screen">
            <Maximize2 size={14} />
          </button>
        )}
      </div>
      <Written as="div" className="ctitle" text={t.title} />
      {banner}
      <div className="cbtns">{buttons}</div>
      {dialogs}
    </div>
  );
}
