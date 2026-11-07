import { useState } from 'react';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { shellQuote } from '../lib/text';
import { Cmd, Modal, Written } from './ui';

/**
 * A program squad-kit did not start is in the Builder's way. squad-kit stops its own leftovers and goes around the rest
 * by itself, so this card only shows when that did not work: plain words, Stop it (after a confirm) or go on without
 * it. The port, the process and what the Builder asked are under the details, for engineers. Both are a reply, like any
 * answer.
 */
export function PortAskPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [confirm, setConfirm] = useState(false);
  const q = t.agentQuestion!;
  const p = q.port!;
  // "Stop it" only where squad-kit can stop the program; the other choice goes on without it.
  const stop = q.options.find((o) => o === 'Stop it');
  const other = q.options.find((o) => o !== 'Stop it');
  const reply = (text: string, done: string) => act.mutate({ path: `/api/v1/tickets/${t.id}/reply`, body: { text }, done }, { onSettled: () => setConfirm(false) });
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">?</span>
          <div>
            <b>Another program is in the way</b>
            <span>You decide. Nothing is stopped unless you press Stop it.</span>
          </div>
        </div>
        <div className="lbl">What is in the way</div>
        <Written as="p" className="stuckq" text={q.text} />
        {q.why && <Written as="p" className="note" text={q.why} />}
        <details className="costdetails">
          <summary>Details for engineers</summary>
          <p className="note">
            {p.program || 'A program'}
            {p.pid ? ` (process ${p.pid})` : ', which the system does not name,'}
            {p.port ? ` listens on port ${p.port}` : ''}
            {p.app ? `: your app ${p.app}, which squad-kit runs from Your apps` : ''}.
          </p>
          <p className="note">The Builder asked: “{p.asked}”</p>
        </details>
      </div>
      <div className="df">
        {stop && (
          <button className="btn pri" disabled={act.isPending} onClick={() => setConfirm(true)}>
            {stop}
          </button>
        )}
        {other && (
          <button className={`btn ${stop ? '' : 'pri'}`} disabled={act.isPending} onClick={() => reply(other, 'Sent. The Builder carries on without it.')}>
            {other}
          </button>
        )}
        <span className="grow" />
        <Cmd text={`squad reply ${t.id} ${shellQuote(stop ?? other ?? '')}`} />
      </div>
      {confirm && stop && (
        <Modal
          title={p.app ? `Stop your app ${p.app}?` : 'Stop that program?'}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn pri" disabled={act.isPending} onClick={() => reply(stop, 'Stopping it. The Builder carries on.')}>
                {act.isPending ? 'Stopping it…' : 'Stop it'}
              </button>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <span className="grow" />
              <Cmd text={`squad reply ${t.id} ${shellQuote(stop)}`} />
            </>
          }
        >
          <p>
            squad-kit stops {p.app ? `your app ${p.app}` : 'that program'}, then the Builder carries on. {p.app ? 'You can start it again from Your apps afterwards.' : 'Anything not saved in that program is lost.'}
          </p>
          <p className="note">squad-kit checks again first that it is still the same program.</p>
        </Modal>
      )}
    </>
  );
}
