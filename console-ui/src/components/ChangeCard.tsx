import { useState } from 'react';
import { Bug, Check, Loader2, PencilLine, Plus, TriangleAlert } from 'lucide-react';
import type { AgentName, ChangePart, SpecChange, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { changeWaits, openChange } from '../lib/waiting';
import { shellQuote } from '../lib/text';
import { Cmd, Modal } from './ui';

/**
 * A change goes through the spec. The person proposes it (from the ticket or a chat message); the Analyst writes the
 * old and new wording and says whether it is small or big; the person approves or declines. A big one also brings
 * the Architect's design update for approval. Accepted work only answers questions: a change there becomes a new
 * linked ticket or a bug report.
 */

// The open change and whether it waits for the person live with the rest of Waiting for you.
export { changeWaits, openChange };

/** Accepted (merged, or waiting for its release) or released: the work is for questions only. */
export function shipped(t: Ticket): boolean {
  return t.stage === 'release' || t.stage === 'done';
}

/** A change can be proposed once the spec is approved; before that the spec card has its own ways to change it. */
export function canPropose(t: Ticket): boolean {
  return shipped(t) || Boolean(t.specApproved) || ['implement', 'test', 'review'].includes(t.stage);
}

function partName(p: ChangePart): string {
  if (p.part === 'story') return 'The story';
  return p.index === undefined ? 'New done when' : `Done when ${p.index + 1}`;
}

function listOf(n: number[]): string {
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : String(n[0] ?? '');
}

/** The old and the new wording of each part, side by side. */
function Parts({ parts }: { parts: ChangePart[] }) {
  return (
    <div className="changeparts">
      {parts.map((p, i) => (
        <div className="chrow" key={i}>
          <div className="chlabel">{partName(p)}</div>
          <div className={p.before ? 'chold' : 'chold empty'}>{p.before || <i>new</i>}</div>
          <div className="chnew">{p.after || <i>removed</i>}</div>
        </div>
      ))}
    </div>
  );
}

const STEP_MARK = { same: 'Stays', changed: 'Redone', new: 'New' } as const;

/**
 * A big change's design update: the steps that are redone or new, one line for the steps that stay as they are, and
 * the ones that go.
 */
function DesignUpdate({ c }: { c: SpecChange }) {
  const d = c.design!;
  const gone = d.before.filter((b) => !d.steps.some((s) => s.title === b));
  const stay = d.steps.flatMap((s, i) => (s.change === 'same' ? [i + 1] : []));
  return (
    <div className="changeparts">
      {stay.length > 0 && (
        <div className="chrow">
          <div className="chlabel">{stay.length === 1 ? 'Step' : 'Steps'} {listOf(stay)}</div>
          <div>
            <span className="pill wait">{STEP_MARK.same}</span>
          </div>
          <div className="chnew note">Built already, as they are.</div>
        </div>
      )}
      {d.steps.map((s, i) =>
        s.change === 'same' ? null : (
          <div className="chrow" key={i}>
            <div className="chlabel">Step {i + 1}</div>
            <div>
              <span className="pill you">{STEP_MARK[s.change]}</span>
            </div>
            <div className="chnew">{s.title}</div>
          </div>
        ),
      )}
      {gone.map((g) => (
        <div className="chrow" key={g}>
          <div className="chlabel">Dropped</div>
          <div />
          <div className="chold">{g}</div>
        </div>
      ))}
    </div>
  );
}

/** What approving does, said before you press it. */
function effect(t: Ticket, c: SpecChange): string {
  const building = Boolean(t.sessions?.build);
  if (c.size === 'big') {
    return building
      ? 'Approve, and the Builder pauses after its current step. The Architect updates the design and you approve that too. Then the Builder redoes only the steps the change touches.'
      : t.steps
        ? 'Approve, and the spec says it now. The Architect updates the design, and you approve it as usual.'
        : 'Approve, and the spec says it now. The Architect designs from the new spec.';
  }
  return building
    ? 'Approve, and the spec says it now. The Builder gets it at the end of its current step; the work does not stop.'
    : 'Approve, and the spec says it now. The Builder builds from the new spec.';
}

/** The open change on a ticket, at the top of its Now tab: its state, and the buttons that move it on. */
export function ChangeCard({ t }: { t: Ticket }) {
  const act = useAct<Ticket>();
  const [declining, setDeclining] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const c = openChange(t);
  if (!c) return null;
  // Approved, and the squad has not built it yet: it can still be taken back.
  const canWithdraw = c.status === 'approved' || c.status === 'designing';
  const busy = c.status === 'writing' || c.status === 'designing' || c.status === 'building';
  const redo = (t.steps ?? []).flatMap((s, i) => (s.status === 'done' ? [] : [i + 1]));
  const head = {
    writing: `Change ${c.id}: the Analyst is writing it into the spec`,
    failed: `Change ${c.id}: the Analyst could not write it`,
    proposed: `Change ${c.id} to the spec`,
    approved: `Change ${c.id} is approved`,
    designing: `Change ${c.id}: the Architect is updating the design`,
    'design-ready': `The design update for change ${c.id}`,
    building: c.size === 'big' ? `Change ${c.id}: the Builder is redoing ${redo.length === 1 ? 'step' : 'steps'} ${listOf(redo)}` : `Change ${c.id}: the Builder is making it`,
    done: '',
    declined: '',
  }[c.status];
  const decide = (path: string, done: string, body?: unknown) =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/spec-change/${path}`, body, done },
      {
        onSuccess: () => {
          setDeclining(false);
          setWithdrawing(false);
        },
      },
    );

  return (
    <div className="outdated" aria-label="Change to the spec">
      <div className="outdated-item changecard">
        <div className="outdated-head">
          <span className="ic">{busy ? <Loader2 size={15} className="spin" /> : c.status === 'failed' ? <TriangleAlert size={15} /> : <PencilLine size={15} />}</span>
          <b>{head}</b>
          {c.size && <span className={`pill ${c.size === 'big' ? 'you' : 'wait'}`}>{c.size === 'big' ? 'Big change' : 'Small change'}</span>}
        </div>
        <div className="changebody">
          {c.summary ? <p>{c.summary}</p> : <p>“{c.ask}”</p>}
          {c.status === 'writing' && <p className="note">The work goes on meanwhile. Nothing changes until you approve it.</p>}
          {c.status === 'failed' && <p className="note">{c.error}</p>}
          {c.why && (c.status === 'proposed' || c.status === 'approved') && <p className="note">{c.why}</p>}
          {c.status === 'proposed' && c.parts && <Parts parts={c.parts} />}
          {c.status === 'proposed' && <p className="note">{effect(t, c)}</p>}
          {c.status === 'approved' && (
            <p className="note">{c.size === 'big' ? 'The Builder finishes its current step, then pauses while the Architect updates the design.' : 'It reaches the Builder at the end of its current step. The work goes on.'}</p>
          )}
          {c.status === 'designing' && <p className="note">The Builder paused after its step. The design update comes to you next.</p>}
          {c.status === 'design-ready' && c.design && (
            <>
              {c.design.summary && <p>{c.design.summary}</p>}
              <DesignUpdate c={c} />
              {c.parts && (
                <>
                  <p className="note">And the spec, as you approved it:</p>
                  <Parts parts={c.parts} />
                </>
              )}
              <p className="note">
                Approve, and the Builder redoes only {(() => {
                  const n = c.design.steps.flatMap((s, i) => (s.change === 'same' ? [] : [i + 1]));
                  return n.length ? `${n.length === 1 ? 'step' : 'steps'} ${listOf(n)}` : 'what changed';
                })()}. Decline, and the spec stays as it was; the Builder carries on.
              </p>
            </>
          )}
        </div>
        {withdrawing ? (
          <div className="row">
            <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why take it back? (optional, it stays in the spec's record)" />
            <button className="btn sm" disabled={act.isPending} onClick={() => decide('withdraw', 'Withdrawn. The spec is back to how it was.', { reason })}>
              Withdraw
            </button>
            <button className="btn sm quiet" onClick={() => setWithdrawing(false)}>
              Cancel
            </button>
          </div>
        ) : canWithdraw ? (
          <div className="row">
            <button className="btn sm" disabled={act.isPending} onClick={() => setWithdrawing(true)}>
              Withdraw change
            </button>
            <span className="grow" />
            <Cmd text={`squad propose ${t.id} --withdraw`} />
          </div>
        ) : declining ? (
          <div className="row">
            <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional, it stays in the spec's record)" />
            <button className="btn sm" disabled={act.isPending} onClick={() => decide('decline', 'Declined. Nothing changes.', { reason })}>
              Decline
            </button>
            <button className="btn sm quiet" onClick={() => setDeclining(false)}>
              Cancel
            </button>
          </div>
        ) : c.status === 'proposed' || c.status === 'design-ready' ? (
          <div className="row">
            <button
              className="btn sm pri"
              disabled={act.isPending}
              onClick={() =>
                decide(
                  'approve',
                  c.status === 'design-ready' ? 'Approved. The Builder redoes what changed.' : c.size === 'big' ? 'Approved. The Architect updates the design next.' : 'Approved. The spec says it now.',
                )
              }
            >
              <Check size={14} strokeWidth={2.5} /> {c.status === 'design-ready' ? 'Approve the new design' : 'Approve'}
            </button>
            <button className="btn sm" onClick={() => setDeclining(true)}>
              {c.status === 'design-ready' ? 'Decline the change' : 'Decline'}
            </button>
            <span className="grow" />
            <Cmd text={c.status === 'design-ready' ? `squad approve ${t.id}` : `squad propose ${t.id} --approve`} />
          </div>
        ) : c.status === 'failed' ? (
          <div className="row">
            <button className="btn sm pri" disabled={act.isPending} onClick={() => decide('retry', 'The Analyst writes it again.')}>
              Try again
            </button>
            <button className="btn sm" disabled={act.isPending} onClick={() => decide('decline', 'Dropped the change.')}>
              Drop it
            </button>
            <span className="grow" />
            <Cmd text={`squad propose ${t.id} --retry`} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Write a change and send it to the Analyst. On accepted work the engine says no to a change, so this offers the two
 * ways it can go instead: a new ticket linked to this one, or a bug report.
 */
export function ProposeChange({ t, initial = '', from, onClose }: { t: Ticket; initial?: string; from?: AgentName; onClose(): void }) {
  const act = useAct<Ticket>();
  const [text, setText] = useState(initial);
  const done = shipped(t);
  const open = openChange(t);
  const ready = Boolean(text.trim()) && !act.isPending;
  const quoted = shellQuote(text.trim() || '…');
  const after = (as: 'ticket' | 'bug') =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/spec-change/new-ticket`, body: { text, as }, done: as === 'bug' ? `Reported a bug, linked to ${t.id}.` : `Made a new ticket, linked to ${t.id}.` },
      { onSuccess: onClose },
    );
  return (
    <Modal
      title={done ? 'Ask for a change' : 'Propose a change'}
      icon={<PencilLine size={16} />}
      onClose={onClose}
      footer={
        <>
          {done ? (
            <>
              <button className="btn pri" disabled={!ready} onClick={() => after('ticket')}>
                <Plus size={15} /> Make a new linked ticket
              </button>
              <button className="btn" disabled={!ready} onClick={() => after('bug')}>
                <Bug size={15} /> Report a bug
              </button>
            </>
          ) : (
            <button
              className="btn pri"
              disabled={!ready || Boolean(open)}
              onClick={() =>
                act.mutate(
                  { path: `/api/v1/tickets/${t.id}/spec-change`, body: { text, ...(from ? { from } : {}) }, done: 'Proposed. The Analyst writes it into the spec; the work goes on.' },
                  { onSuccess: onClose },
                )
              }
            >
              <PencilLine size={15} /> Propose
            </button>
          )}
          <span className="grow" />
          <Cmd text={done ? `squad propose ${t.id} --as ticket ${quoted}` : `squad propose ${t.id} ${quoted}`} />
        </>
      }
    >
      <p className="note" style={{ marginBottom: 10 }}>
        {done
          ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}${t.release ? ` (${t.release})` : ''}, so it only answers questions. Your change becomes a new ticket linked to it, or a bug report.`
          : open
            ? `Change ${open.id} is still open. One change at a time: approve or decline it first.`
            : 'Say what should change. The Analyst writes it into the spec, old and new, and says if it is small or big. Nothing changes until you approve it, and the work goes on meanwhile.'}
      </p>
      <textarea className="input" rows={4} style={{ width: '100%' }} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: allow 5 bookings a day, not 3" />
    </Modal>
  );
}

/** "Propose a change" on the ticket. */
export function ProposeChangeButton({ t }: { t: Ticket }) {
  const [open, setOpen] = useState(false);
  if (!canPropose(t)) return null;
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title={shipped(t) ? 'Becomes a new linked ticket or a bug report' : 'The Analyst writes it into the spec; you approve it'}>
        <PencilLine size={13} /> {shipped(t) ? 'Ask for a change' : 'Propose a change'}
      </button>
      {open && <ProposeChange t={t} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Propose as a change" under a message in a chat: the message becomes the proposal, ready to edit. */
export function ProposeFromMessage({ t, text, from }: { t: Ticket; text: string; from?: AgentName }) {
  const [open, setOpen] = useState(false);
  if (!canPropose(t)) return null;
  return (
    <>
      <button className="looked" onClick={() => setOpen(true)}>
        <PencilLine size={12} /> Propose as a change
      </button>
      {open && <ProposeChange t={t} initial={text} from={from} onClose={() => setOpen(false)} />}
    </>
  );
}

const STATUS_WORD: Record<SpecChange['status'], string> = {
  writing: 'Being written',
  proposed: 'Waits for you',
  approved: 'Approved',
  designing: 'Design update',
  'design-ready': 'Waits for you',
  building: 'Being built',
  done: 'In the spec',
  declined: 'Declined',
  failed: 'Not written',
};

/** Every change to the spec, newest first: the spec's own record. */
export function ChangeHistory({ t }: { t: Ticket }) {
  const all = [...(t.changes ?? [])].reverse();
  if (!all.length) return null;
  return (
    <>
      <div className="lbl">Changes to the spec · {all.length}</div>
      <ul className="ticketnotes">
        {all.map((c) => (
          <li key={c.id}>
            <span className={`pill ${c.status === 'done' ? 'ok' : c.status === 'declined' ? 'wait' : 'you'}`}>{c.decided?.withdrawn ? 'Withdrawn' : STATUS_WORD[c.status]}</span>
            <span className="grow">
              {c.id}: {c.summary ?? c.ask}
              {c.size ? ` (${c.size})` : ''}
              {c.decided?.reason ? `. Why not: ${c.decided.reason}` : ''}
            </span>
            <span className="note">{c.by}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
