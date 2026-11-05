import { useMemo, useState } from 'react';
import { ArrowRightLeft, Square, UserRound } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { shellArg, shellQuote } from '../lib/text';
import { Cmd, Modal, ago } from './ui';

/**
 * Owners and hand over (ADR-001). Each ticket has one owner; only the owner's squad works on it, on their computer.
 * Hand over pushes the ticket's branch with its code and documents and names the new owner. What happened on this
 * computer (live progress, agent chats, screenshots) stays here.
 */

export function ownerOf(t: Ticket): string {
  return t.owner?.trim() || t.createdBy;
}

function same(a?: string, b?: string): boolean {
  return Boolean(a?.trim()) && a!.trim().toLowerCase() === b?.trim().toLowerCase();
}

/** The person on this computer, as the board knows them. */
export function useMe(): string | undefined {
  const board = useBoard();
  return board.data?.ready ? board.data.meta.user?.name : undefined;
}

export function isMine(t: Ticket, me: string | undefined): boolean {
  return same(ownerOf(t), me);
}

/** Your own ticket, not accepted yet, and not in your hands right now. */
export function canHandOver(t: Ticket, me: string | undefined): boolean {
  return isMine(t, me) && !t.takenOver && t.stage !== 'release' && t.stage !== 'done';
}

export function HandOverButton({ t }: { t: Ticket }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Give this ticket to a teammate. Their squad carries on from its branch.">
        <ArrowRightLeft size={13} /> Hand over
      </button>
      {open && <HandOverDialog t={t} onClose={() => setOpen(false)} />}
    </>
  );
}

export function HandOverDialog({ t, onClose }: { t: Ticket; onClose(): void }) {
  const act = useAct();
  const stop = useAct();
  const board = useBoard();
  const me = useMe();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const live = board.data?.ready ? board.data.meta.engine === 'live' : true;
  const branch = t.branch ?? `squad/${t.id.toLowerCase()}`;
  const working = Boolean(t.live || t.squad || t.stopRequested);
  const blocked = t.chat?.open ? 'A chat is open on this ticket. Finish the talk first.' : working ? 'The squad is working on it right now. It hands over once the step is done, or you stop it.' : null;
  // People this project knows: owners, and whoever made, noted or approved a ticket.
  const people = useMemo(() => {
    const names = new Map<string, string>();
    for (const x of board.data?.ready ? board.data.tickets : []) {
      for (const n of [ownerOf(x), x.createdBy, x.specApproved?.by, x.handedOver?.from, x.handedOver?.to, ...(x.notes ?? []).map((m) => m.by)]) {
        if (n?.trim() && !same(n, me)) names.set(n.trim().toLowerCase(), n.trim());
      }
    }
    return [...names.values()].slice(0, 8);
  }, [board.data, me]);
  const who = to.trim() || 'them';
  const submit = () =>
    to.trim() &&
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/hand-over`, body: { to, note }, done: `Handed ${t.id} over to ${to.trim()}. Their squad carries on from the branch.` },
      { onSuccess: onClose },
    );
  return (
    <Modal
      title={`Hand over ${t.id}`}
      onClose={onClose}
      icon={<span className="glyph"><ArrowRightLeft size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={!to.trim() || Boolean(blocked) || act.isPending} onClick={submit}>
            <ArrowRightLeft size={15} /> {act.isPending ? 'Pushing…' : 'Hand over'}
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={`squad hand-over ${t.id} ${to.trim() ? shellArg(to.trim()) : 'Name'}${note.trim() ? ` --note ${shellQuote(note.trim())}` : ''}`} />
        </>
      }
    >
      <p>Give this ticket to a teammate. Their squad carries on where it is now.</p>
      {blocked && (
        <div className="stuckbox" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{blocked}</span>
          {working && !t.chat?.open && (
            <button className="btn sm" disabled={t.stopRequested || stop.isPending} onClick={() => stop.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping. The work so far is kept.' })}>
              <Square size={12} /> {t.stopRequested ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor="handover-to">Hand it over to</label>
        <input id="handover-to" className="input" autoFocus value={to} placeholder="Their name, as their board shows it" onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !blocked && submit()} />
        {people.length > 0 && (
          <div className="pills" style={{ marginTop: 8 }}>
            {people.map((p) => (
              <button key={p} className={`pill click ${same(p, to) ? 'on' : ''}`} onClick={() => setTo(p)}>
                <UserRound size={12} /> {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="handover-note">A note for {who} (optional)</label>
        <textarea id="handover-note" className="input" rows={2} value={note} placeholder="Where you got to, and anything to watch out for. Every agent reads it too." onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="lbl">What happens</div>
      <ul className="brief">
        {live ? (
          <>
            <li>
              squad-kit saves the work so far and the ticket&apos;s documents on its branch, <span className="mono">{branch}</span>, and pushes it.
            </li>
            <li>{who === 'them' ? 'They become' : `${who} becomes`} the owner. Their squad makes its copy of the code from that branch, and the Builder starts a fresh chat from the spec, the design and the code.</li>
          </>
        ) : (
          <li>{who === 'them' ? 'They become' : `${who} becomes`} the owner. This is a sample board, so nothing is pushed.</li>
        )}
        <li>Your squad stops working on it. You still see it on your board, with its new owner.</li>
      </ul>
      <div className="lbl">What stays on this computer</div>
      <p className="note" style={{ fontSize: 13 }}>Live progress, agent chats and screenshots. They see the documents and the code, not the chat. The Tester takes the screenshots again on their computer.</p>
    </Modal>
  );
}

/** On the ticket of the person it was handed to: where it came from, and what did not come with it. */
export function HandedOverBanner({ t }: { t: Ticket }) {
  const me = useMe();
  const h = t.handedOver;
  if (!h || !same(h.to, me) || !isMine(t, me)) return null;
  return (
    <div className="calm" style={{ flex: 'none', margin: '16px 28px 0' }}>
      <span className="ring"><ArrowRightLeft size={16} /></span>
      <div>
        <b>{h.from} handed this ticket to you {ago(h.at)}</b>
        <span>
          The spec, the design, the notes and the code came with its branch. Live progress, agent chats and screenshots stayed on {h.from}&apos;s computer, so the
          Builder starts a fresh chat from the spec, the design and the code, and the Tester takes the screenshots again.
        </span>
      </div>
    </div>
  );
}

/** Someone else's ticket: their squad works on it on their computer. You see their work when they push it. */
export function NotYoursPanel({ t }: { t: Ticket }) {
  const owner = ownerOf(t);
  const h = t.handedOver;
  return (
    <>
      <div className="db">
        <div className="calm">
          <span className="ring"><UserRound size={17} /></span>
          <div>
            <b>{owner} owns this ticket</b>
            <span>
              {h ? `${h.from} handed it to ${h.to} ${ago(h.at)}. ` : ''}Their squad works on it, on their computer. You see their work here when they push it: when
              they hand it over, or when its pull request opens.
            </span>
          </div>
        </div>
        <p className="note" style={{ marginTop: 12, fontSize: 13 }}>
          Live progress and agent chats stay on {owner}&apos;s computer. The spec, the design and the notes here are as {owner} last pushed them.
        </p>
      </div>
      <div className="df">
        <span className="grow" />
        <Cmd text={`squad show ${t.id}`} />
      </div>
    </>
  );
}
