import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, Ellipsis, EyeOff, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import type { DeletePlan, Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd, Modal, ago } from './ui';

/**
 * Delete and Archive, from the ticket's overflow menu. Delete is for a ticket that is not merged: the dialog lists
 * what goes and what stays, in the engine's own words, and asks once. Archive takes a merged or released ticket off
 * the board; Unarchive brings it back.
 */

/** Merged into the base, or released. On the sample board an accepted ticket counts as merged. */
export function isMerged(t: Ticket, demo: boolean): boolean {
  return Boolean(t.mergedAt) || t.stage === 'done' || (demo && t.stage === 'release');
}

/** Dialogs open from inside a header or a banner; on the page itself they keep the page's own text styles. */
function onTop(node: ReactNode) {
  return createPortal(node, document.body);
}

function useDemo(): boolean {
  const board = useBoard();
  return board.data?.ready ? board.data.meta.engine === 'demo' : false;
}

/** The "…" button in the ticket's header: Delete for a ticket not merged, Archive or Unarchive for a merged one. */
export function TicketMenu({ t, onDeleted }: { t: Ticket; onDeleted(): void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'archive' | null>(null);
  const merged = isMerged(t, useDemo());
  const unarchive = useUnarchive(t);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const pick = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  return (
    <span className="more" ref={ref}>
      <button className="iconbtn" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} title="More actions" onClick={() => setOpen(!open)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="more-menu" role="menu">
          {t.archived ? (
            <button role="menuitem" onClick={pick(unarchive)}>
              <ArchiveRestore size={15} /> Unarchive
            </button>
          ) : merged ? (
            <button role="menuitem" onClick={pick(() => setDialog('archive'))}>
              <Archive size={15} /> Archive…
            </button>
          ) : (
            <button role="menuitem" className="danger" onClick={pick(() => setDialog('delete'))}>
              <Trash2 size={15} /> Delete ticket…
            </button>
          )}
        </div>
      )}
      {dialog === 'delete' && onTop(<DeleteDialog t={t} onClose={() => setDialog(null)} onDeleted={onDeleted} />)}
      {dialog === 'archive' && onTop(<ArchiveDialog t={t} onClose={() => setDialog(null)} />)}
    </span>
  );
}

function useUnarchive(t: Ticket): () => void {
  const act = useAct();
  return () => act.mutate({ path: `/api/v1/tickets/${t.id}/archive`, body: { undo: true }, done: `${t.id} is back on the board.` });
}

function Lines({ items, mark }: { items: string[]; mark: 'x' | 'ok' | 'hide' }) {
  return (
    <ul className="rmlist">
      {items.map((l) => (
        <li key={l}>
          {mark === 'x' ? <X size={16} className="x" aria-hidden /> : mark === 'hide' ? <EyeOff size={16} className="hide" aria-hidden /> : <Check size={16} className="ok" aria-hidden />}
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

export function DeleteDialog({ t, onClose, onDeleted }: { t: Ticket; onClose(): void; onDeleted(): void }) {
  const act = useAct<{ id: string; notes: string[] }>();
  const { toast } = usePrefs();
  const [remote, setRemote] = useState(Boolean(t.deleting?.remote));
  const plan = useQuery({
    queryKey: ['delete-plan', t.id, remote],
    queryFn: () => api<DeletePlan>(`/api/v1/tickets/${t.id}/delete?remote=${remote ? 1 : 0}`),
    placeholderData: keepPreviousData,
  });
  const p = plan.data;
  const submit = () =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/delete`, body: { remote }, done: `Deleted ${t.id}. Its cost stays in Usage.` },
      {
        onSuccess: (r) => {
          if (r.notes.length) toast(`${r.notes.join('. ')}.`);
          onClose();
          onDeleted();
        },
        // The ticket now says what is left; the dialog shows it, with Delete again.
        onError: () => void plan.refetch(),
      },
    );
  return (
    <Modal
      title={`Delete ${t.id}?`}
      onClose={onClose}
      icon={<span className="glyph"><Trash2 size={15} /></span>}
      footer={
        <>
          <button className="btn danger" disabled={!p || Boolean(p.refused) || act.isPending} onClick={submit}>
            <Trash2 size={15} /> {act.isPending ? 'Stopping the squad and deleting…' : p?.unfinished ? 'Delete again' : `Delete ${t.id}`}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <Cmd text={p?.command ?? `squad delete ${t.id}`} />
        </>
      }
    >
      <p>{p?.summary ?? t.title}</p>
      {plan.isError && <div className="stuckbox">{(plan.error as Error).message}</div>}
      {p?.refused && <div className="stuckbox">{p.refused}</div>}
      {p && !p.refused && (
        <>
          {p.unfinished && (
            <div className="stuckbox rm-gap">
              The last delete did not finish: {p.unfinished}. Delete again to finish it. It goes on where it stopped.
            </div>
          )}
          {p.warnings.length > 0 && (
            <div className="stuckbox rm-gap">
              {p.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          <div className="lbl">This removes</div>
          <Lines items={p.removes} mark="x" />
          <div className="lbl">This stays</div>
          <Lines items={p.stays} mark="ok" />
          {p.pushed && (
            <label className="talkfirst">
              <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
              <span>
                <b>Also delete the branch {p.pushed.branch} on {p.pushed.remote}.</b> {p.pushed.why}
              </span>
            </label>
          )}
          <p className="rm-note">
            A ticket that is already merged cannot be deleted, because its code is in {p.base}. Use <b>Archive</b> to hide it from the board. Its history stays.
          </p>
        </>
      )}
    </Modal>
  );
}

function ArchiveDialog({ t, onClose }: { t: Ticket; onClose(): void }) {
  const act = useAct();
  const submit = () =>
    act.mutate({ path: `/api/v1/tickets/${t.id}/archive`, done: `Archived ${t.id}. Show archived, at the bottom of the board, shows it again.` }, { onSuccess: onClose });
  return (
    <Modal
      title={`Archive ${t.id}?`}
      onClose={onClose}
      icon={<span className="glyph"><Archive size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={act.isPending} onClick={submit}>
            <Archive size={15} /> Archive {t.id}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <Cmd text={`squad archive ${t.id}`} />
        </>
      }
    >
      <p>
        {t.title} · {t.status}
      </p>
      <div className="lbl">This hides</div>
      <Lines items={['The ticket from the board. Show archived, at the bottom of the board, shows it again.']} mark="hide" />
      <div className="lbl">This stays</div>
      <Lines items={['Its code, and its history in git and in .squad/', ...(t.release && t.stage !== 'done' ? [`Its place in release ${t.release}`] : []), 'The cost it used, still counted in Usage']} mark="ok" />
      <p className="rm-note">Unarchive brings it back to the board, as it was.</p>
    </Modal>
  );
}

/** On the Now tab: a ticket that is archived, or a delete that has not finished, with the way on. */
export function DeleteArchiveBanner({ t, onDeleted }: { t: Ticket; onDeleted(): void }) {
  const [again, setAgain] = useState(false);
  const unarchive = useUnarchive(t);
  if (t.deleting) {
    // A delete still going (another window started it) shows as such for a while; after that, or after an error, it can be finished.
    const stalled = Boolean(t.deleting.error) || Date.now() - Date.parse(t.deleting.at) > 90_000;
    return (
      <div className="stuckbox rm-banner">
        <span className="grow">
          <b>{t.deleting.error ? 'Delete did not finish.' : 'Deleting…'}</b>{' '}
          {t.deleting.error ? `${t.deleting.error}. Delete again to finish it; it goes on where it stopped.` : 'The squad stops first, then each part of the ticket goes.'}
        </span>
        {stalled && (
          <button className="btn sm" onClick={() => setAgain(true)}>
            <Trash2 size={13} /> Delete again
          </button>
        )}
        <Cmd text={`squad delete ${t.id}`} />
        {again && onTop(<DeleteDialog t={t} onClose={() => setAgain(false)} onDeleted={onDeleted} />)}
      </div>
    );
  }
  if (!t.archived) return null;
  return (
    <div className="calm rm-banner">
      <span className="ring">
        <Archive size={16} />
      </span>
      <div className="grow">
        <b>
          Archived {ago(t.archived.at)} by {t.archived.by}
        </b>
        <span>It is off the board. Its history stays in git and in .squad/.</span>
        <div className="rm-cmd">
          <Cmd text={`squad archive ${t.id} --undo`} />
        </div>
      </div>
      <button className="btn sm" onClick={unarchive}>
        <ArchiveRestore size={13} /> Unarchive
      </button>
    </div>
  );
}
