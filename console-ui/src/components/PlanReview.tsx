import { useState, type ReactNode } from 'react';
import { MessageSquare, Pencil, X } from 'lucide-react';
import type { Criterion, PlanComment, PlanPart, Ticket } from '../api/types';
import { useAct } from '../lib/data';

/** Review a spec or design like a document: comment on any part, or edit it yourself. */
export interface Review {
  t: Ticket;
  comments: PlanComment[];
  add(c: PlanComment): void;
  remove(i: number): void;
  canEdit(p: PlanPart): boolean;
}

const same = (a: PlanPart, b: PlanPart) => a.part === b.part && (a.index ?? 0) === (b.index ?? 0);

export function Part({ review, at, children }: { review?: Review; at: PlanPart; children: ReactNode }) {
  const [mode, setMode] = useState<'comment' | 'edit' | null>(null);
  const [text, setText] = useState('');
  if (!review) return <>{children}</>;
  const mine = review.comments.map((c, i) => ({ c, i })).filter(({ c }) => same(c, at));
  const done = () => {
    if (text.trim()) review.add({ ...at, text: text.trim() });
    setText('');
    setMode(null);
  };
  return (
    <div className={`part ${mode ? 'open' : ''}`}>
      <div className="partbody">
        <div className="partmain">{mode === 'edit' ? <EditPart review={review} at={at} onDone={() => setMode(null)} /> : children}</div>
        {mode !== 'edit' && (
          <span className="parttools">
            <button className="iconbtn" title="Comment on this" aria-label="Comment on this" onClick={() => setMode('comment')}>
              <MessageSquare size={13} />
            </button>
            {review.canEdit(at) && (
              <button className="iconbtn" title="Edit it yourself" aria-label="Edit it yourself" onClick={() => setMode('edit')}>
                <Pencil size={13} />
              </button>
            )}
          </span>
        )}
      </div>
      {mine.map(({ c, i }) => (
        <div className="pcomment" key={i}>
          <MessageSquare size={12} /> <span>{c.text}</span>
          <button className="iconbtn" aria-label="Remove comment" onClick={() => review.remove(i)}>
            <X size={12} />
          </button>
        </div>
      ))}
      {mode === 'comment' && (
        <div className="pcomment new">
          <input
            className="input"
            autoFocus
            value={text}
            placeholder="Your comment on this part. Enter to add"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') done();
              if (e.key === 'Escape') setMode(null);
            }}
          />
          <button className="btn sm" onClick={done}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function EditPart({ review, at, onDone }: { review: Review; at: PlanPart; onDone(): void }) {
  const act = useAct();
  const t = review.t;
  const i = at.index ?? 0;
  const [text, setText] = useState(at.part === 'story' ? (t.story ?? '') : at.part === 'step' ? (t.steps?.[i]?.title ?? '') : '');
  const [c, setC] = useState<Criterion>(t.criteria?.[i] ?? { given: '', when: '', then: '' });
  const save = () =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/plan/edit`, body: at.part === 'criterion' ? { ...at, criterion: c } : { ...at, text }, done: 'Edited. Your wording stays.' },
      { onSuccess: onDone },
    );
  return (
    <div className="editpart">
      {at.part === 'criterion' ? (
        (['given', 'when', 'then'] as const).map((k) => (
          <label key={k}>
            <em>{k[0]!.toUpperCase() + k.slice(1)}</em>
            <input className="input" value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} />
          </label>
        ))
      ) : (
        <textarea className="waynote" rows={at.part === 'story' ? 3 : 2} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <div className="editbtns">
        <button className="btn sm pri" disabled={act.isPending} onClick={save}>
          Save
        </button>
        <button className="btn sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const crit = (c?: Criterion) => (c ? `Given ${c.given}, when ${c.when}, then ${c.then}.` : '');

/** The new version next to the old one, part by part, with the comments that were sent. */
export function WhatChanged({ t }: { t: Ticket }) {
  const [open, setOpen] = useState(true);
  const before = t.planReview?.before;
  if (!before) return null;
  const rows: { label: string; old: string; now: string }[] = [];
  const add = (label: string, old = '', now = '') => old !== now && rows.push({ label, old, now });
  add('The story', before.story, t.story);
  const nc = Math.max(before.criteria?.length ?? 0, t.criteria?.length ?? 0);
  for (let i = 0; i < nc; i++) add(`Done when ${i + 1}`, crit(before.criteria?.[i]), crit(t.criteria?.[i]));
  if (before.decision !== undefined || t.decision) add('The decision', before.decision, t.decision ? `${t.decision.title}: ${t.decision.options.find((o) => o.chosen)?.name ?? ''}` : '');
  const ns = Math.max(before.steps?.length ?? 0, t.steps?.length ?? 0);
  for (let i = 0; i < ns; i++) add(`Step ${i + 1}`, before.steps?.[i], t.steps?.[i]?.title);
  return (
    <div className="changed">
      <button className="changedhead" onClick={() => setOpen(!open)}>
        <b>What changed</b> {rows.length ? `${rows.length} ${rows.length === 1 ? 'part' : 'parts'}` : 'nothing'} since the last version {open ? '▾' : '▸'}
      </button>
      {open && (
        <>
          {(t.planReview?.sent ?? []).length > 0 && (
            <div className="sentlist">
              Your comments:{' '}
              {t.planReview!.sent!.map((c, i) => (
                <span key={i}>“{c.text}”</span>
              ))}
            </div>
          )}
          {rows.map((r) => (
            <div className="chrow" key={r.label}>
              <div className="chlabel">{r.label}</div>
              <div className={r.old ? 'chold' : 'chold empty'}>{r.old || <i>new</i>}</div>
              <div className="chnew">{r.now || <i>removed</i>}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
