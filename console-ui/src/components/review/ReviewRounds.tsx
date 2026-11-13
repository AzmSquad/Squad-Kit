import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Circle, Forward, GitPullRequest, RotateCw } from 'lucide-react';
import { api } from '../../api/client';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { langProps, typedDir } from '../../lib/lang';
import { STATE_CHIP, approvalLine, countLine, shortWhen, whereLine, type ReviewNoteView, type ReviewRoundView, type ReviewViewData } from '../../lib/review-record';
import { Cmd } from '../ui';
import '../../styles/review.css';

/**
 * The review on the Changes tab (ADR-007): each round of the Reviewer, each note on its file and line with where it
 * stands, as the pull request shows it. Fixed in a commit, gone past with the person's reason, or open, with Go past.
 */
export function ReviewRounds({ t }: { t: Pick<Ticket, 'id' | 'activity' | 'live'> }) {
  const q = useQuery({
    queryKey: ['review', t.id, t.activity.length],
    queryFn: () => api<ReviewViewData>(`/api/v1/tickets/${t.id}/review`),
    refetchInterval: t.live ? 10_000 : false,
  });
  return q.data?.rounds.length ? <ReviewView id={t.id} v={q.data} /> : null;
}

/** The record itself, with no loading: what the tests render. */
export function ReviewView({ id, v }: { id: string; v: ReviewViewData }) {
  return (
    <section className="rv" aria-label="The review">
      <div className="rv-head">
        <b>The review</b>
        <span className="rv-sum">
          {v.rounds.length} {v.rounds.length === 1 ? 'round' : 'rounds'} · {countLine(v)} · Builder changes after review: {v.fixes.length ? `${v.fixes.length} ${v.fixes.length === 1 ? 'commit' : 'commits'}` : 'none'}
        </span>
        <span className="grow" />
        <Posted id={id} v={v} />
      </div>
      {v.old && <p className="note">Kept the old way: the latest notes only, with no file or line.</p>}
      {v.rounds.map((r) => (
        <Round key={r.n} id={id} r={r} canPast={v.canPast} />
      ))}
      {v.looksRight && (
        <div className="rv-ok">
          <span className="ok">
            <Check size={12} />
          </span>
          <span>{approvalLine(v.looksRight)}</span>
        </div>
      )}
      <div className="pills">
        <Cmd text={`squad review ${id}`} />
      </div>
    </section>
  );
}

function Round({ id, r, canPast }: { id: string; r: ReviewRoundView; canPast: boolean }) {
  return (
    <div className="rv-round">
      <div className="rv-rhead">
        <span className="r">{r.n}</span>
        <span>
          Round {r.n} · {shortWhen(r.at)} · {r.approved ? 'approved' : 'changes asked'}
          {r.fix.length ? (
            <>
              {' '}· the Builder's fix <code dir="ltr">{r.fix.join(', ')}</code>
            </>
          ) : null}
        </span>
      </div>
      {r.notes.length ? r.notes.map((n) => <NoteThread key={n.n} id={id} n={n} canPast={canPast} />) : <p className="rv-none">Round {r.n}: no new notes</p>}
    </div>
  );
}

function NoteThread({ id, n, canPast }: { id: string; n: ReviewNoteView; canPast: boolean }) {
  const Icon = n.state === 'fixed' ? Check : n.state === 'past' ? Forward : Circle;
  return (
    <div className={`rv-thread ${n.state}`}>
      <div className="rv-file" dir="ltr">
        <span className="path">{whereLine(n)}</span>
        <span className={`res ${n.state}`}>
          <Icon size={12} /> {STATE_CHIP[n.state]}
        </span>
      </div>
      <div className="rv-note">
        <span className="av">Re</span>
        <div className="body">
          <small>
            <b>Reviewer</b> · round {n.round}
            {n.line ? ` · line ${n.line}` : ''} · note {n.n}
          </small>
          <p {...langProps(n.text)}>{n.text}</p>
          {n.state === 'fixed' && (
            <div className="rv-fixed">
              <Check size={13} />
              {n.fixed?.commit ? (
                <>
                  Fixed in <code dir="ltr">{n.fixed.commit}</code>
                </>
              ) : (
                'Fixed, the Reviewer says'
              )}
            </div>
          )}
          {n.state === 'past' && n.past && (
            <div className="rv-past">
              <b>You went past it</b>: <span {...langProps(n.past.reason)}>{n.past.reason}</span>
              <small>
                {n.past.by}, {shortWhen(n.past.at)}
              </small>
            </div>
          )}
          {n.state === 'open' && canPast && <GoPast id={id} n={n.n} />}
        </div>
      </div>
    </div>
  );
}

/** Only the person goes past a note, and only with a reason that stays on the record. */
function GoPast({ id, n }: { id: string; n: number }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  const act = useAct();
  if (!open) {
    return (
      <button className="btn sm rv-go" onClick={() => setOpen(true)}>
        <Forward size={13} /> Go past…
      </button>
    );
  }
  const send = () => act.mutate({ path: `/api/v1/tickets/${id}/review/past`, body: { note: n, reason: why }, done: `Went past note ${n}. Your reason is on the record`, after: () => setOpen(false) });
  return (
    <div className="rv-why">
      <input autoFocus value={why} dir={typedDir(why)} placeholder="Why you go past it. It goes in the pull request too." onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && why.trim() && send()} />
      <button className="btn sm pri" disabled={!why.trim() || act.isPending} onClick={send}>
        Go past
      </button>
      <button className="btn sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <Cmd text={`squad review ${id} --past ${n} --reason "${why.trim() || '<why>'}"`} />
    </div>
  );
}

/** Whether the review is in the pull request, and Write it again when the code host said no. */
function Posted({ id, v }: { id: string; v: ReviewViewData }) {
  const act = useAct<{ ok: boolean; why?: string }>();
  const p = v.posted;
  if (!p) return null;
  if (p.ok) {
    return (
      <span className="rv-pr ok">
        <GitPullRequest size={13} /> In pull request {p.pr}
      </span>
    );
  }
  return (
    <span className="rv-pr no">
      <span>Not in pull request {p.pr} yet: {p.why}</span>
      {v.canWrite && (
        <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${id}/review/write`, done: (d) => (d.ok ? 'Wrote the review into the pull request' : `Not written: ${d.why ?? 'the code host said no.'}`) })}>
          <RotateCw size={13} /> Write it again
        </button>
      )}
      <Cmd text={`squad review ${id} --write`} />
    </span>
  );
}
