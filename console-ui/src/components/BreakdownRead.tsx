import { useEffect, useState } from 'react';
import { Check, MessageCircle, RotateCcw, Send, Square, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { BrdRef, BreakdownQuestion, BreakdownView } from '../api/requirements-types';
import { SKIP_CHOICE, afterTitle, clockWords, jobBusy, readSteps, refShort, type ReadStep } from '../lib/requirements';
import { useReqAct } from '../lib/requirementsData';
import { Cmd, ROLE_NAME } from './ui';
import { ErrorCard } from './ErrorCard';
import { useDraft } from '../lib/drafts';

/**
 * The breakdown before there is one to edit: the Analyst reading the document live, its questions, and the card when
 * the read stopped. The person may leave the page at any time; Waiting for you calls them back.
 */

const base = (id: string) => `/api/v1/requirements/${encodeURIComponent(id)}`;

/** Re-renders every few seconds, so "4 min so far" keeps up between polls. */
function useTick(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

function StepDot({ s }: { s: ReadStep }) {
  return (
    <span className={`rq-dot ${s.state}`} aria-hidden="true">
      {s.state === 'done' ? <Check size={12} strokeWidth={3.2} /> : s.state === 'now' ? <i /> : null}
    </span>
  );
}

const STATE_WORDS: Record<ReadStep['state'], string> = { done: 'Done', now: 'Now', todo: 'Still to come', failed: 'Stopped here' };

/** "The Analyst is reading your BRD": its steps, how far it got, and Stop. */
export function ReadingCard({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const job = v.state.job;
  const busy = jobBusy(job);
  const now = useTick(5000, busy);
  const steps = readSteps(v);
  const stopping = job?.status === 'stopping';
  const title = v.status === 'drafting' ? 'The Analyst is writing the breakdown' : 'The Analyst is reading your BRD';
  return (
    <section className="rq-card rq-reading" aria-label={title}>
      <div className="rq-reading-head">
        <h2>{title}</h2>
        <span className="rq-clock">{clockWords(job, now)}</span>
      </div>
      <ol className="rq-steps">
        {steps.map((s) => (
          <li key={s.key} className={`rq-step ${s.state}`}>
            <StepDot s={s} />
            <div className="rq-step-t">
              <b>
                {s.title}
                <span className="sr-only">: {STATE_WORDS[s.state]}</span>
              </b>
              <span>{s.sub}</span>
              {s.bar && s.state === 'now' && (
                <span className="rq-readbar" role="progressbar" aria-valuemin={0} aria-valuemax={s.bar.of} aria-valuenow={s.bar.done} aria-label="How far the Analyst read">
                  <i style={{ flexGrow: Math.max(0, s.bar.done) }} />
                  <em style={{ flexGrow: Math.max(0, s.bar.of - s.bar.done) }} />
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="rq-reading-foot">
        <p>You can leave this page. Waiting for you tells you when the Analyst needs you.</p>
        {v.mine && busy && (
          <button className="btn" disabled={stopping || act.isPending} title={`squad requirements stop ${v.id}`} onClick={() => act.mutate({ path: `${base(v.id)}/stop`, done: 'Stopping the Analyst. Try again carries on from here.' })}>
            <Square size={13} /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
    </section>
  );
}

/** The read or the draft stopped: what happened, and the ways on. */
export function FailedCard({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const navigate = useNavigate();
  const [sure, setSure] = useState(false);
  // The person's own Stop ("You stopped the Analyst…"), not a step that stopped on something technical.
  const stopped = /^You stopped\b/.test(v.error ?? v.state.job?.error ?? '');
  const title = stopped ? 'You stopped the Analyst' : 'The Analyst stopped';
  return (
    <ErrorCard
      calm={stopped}
      title={title}
      what={afterTitle(v.error ?? v.state.job?.error ?? 'The read did not get through.', title)}
      safe={['Your document is saved.', ...(v.epics.length ? ['What the Analyst wrote so far is kept.'] : [])]}
      hint={<Cmd text={`squad requirements retry ${v.id}`} />}
      ways={
        v.mine
          ? [
              { label: 'Try again', primary: true, icon: <RotateCcw size={14} />, onClick: () => act.mutate({ path: `${base(v.id)}/retry`, done: 'The Analyst carries on.' }), disabled: act.isPending, title: `squad requirements retry ${v.id}` },
              ...(sure
                ? [
                    {
                      label: 'Yes, delete it',
                      icon: <Trash2 size={14} />,
                      title: `squad requirements delete ${v.id}`,
                      disabled: act.isPending,
                      onClick: () =>
                        act.mutate(
                          { path: base(v.id), method: 'DELETE', done: `Deleted ${v.id}.` },
                          { onSuccess: () => void navigate({ to: '/requirements' }) },
                        ),
                    },
                    { label: 'Keep it', onClick: () => setSure(false) },
                  ]
                : [{ label: 'Delete this breakdown', icon: <Trash2 size={14} />, onClick: () => setSure(true), title: 'Deletes the breakdown and its document' }]),
            ]
          : []
      }
    />
  );
}

type Answers = Record<string, { choice: string; value?: string }>;

/** "The Analyst has 2 questions": only gaps and clashes, each with its place in the BRD. */
export function QuestionsView({ v, onOpenRef }: { v: BreakdownView; onOpenRef(ref: BrdRef): void }) {
  const act = useReqAct();
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(v.questions.filter((q) => q.answer).map((q) => [q.id, q.answer!])));
  const qs = v.questions;
  const filled = (id: string) => {
    const a = answers[id];
    return Boolean(a && (a.choice !== 'Other' || a.value?.trim()));
  };
  const ready = qs.every((q) => filled(q.id));
  const busy = jobBusy(v.state.job) && v.state.job?.step !== 'reply';
  const decided = v.decided.length;
  const skip = () => {
    // Answers already picked go with it; only the open questions are left to the Analyst.
    const picked = qs.filter((q) => filled(q.id));
    if (!picked.length) return act.mutate({ path: `${base(v.id)}/skip`, done: 'The Analyst decides the open questions and writes each one down.' });
    const all = Object.fromEntries(qs.map((q) => [q.id, filled(q.id) ? answers[q.id]! : { choice: SKIP_CHOICE }]));
    act.mutate({ path: `${base(v.id)}/answers`, body: { answers: all }, done: 'Answers sent. The Analyst decides the rest and writes the breakdown.' });
  };
  return (
    <div className="rq-questions">
      <div className="rq-qhead">
        <span className="rq-qn" aria-hidden="true">{qs.length}</span>
        <h2>The Analyst has {qs.length} {qs.length === 1 ? 'question' : 'questions'}</h2>
      </div>
      <p className="rq-qlead">
        The rest of the BRD is clear.
        {decided > 0 && ` The Analyst decided ${decided} small ${decided === 1 ? 'thing' : 'things'} itself and wrote each one down. You will see them in the breakdown and can change any of them.`}
      </p>
      {v.state.job?.status === 'failed' && v.state.job.step === 'reply' && (
        <div className="rq-err" role="alert">
          The Analyst could not answer your question{v.state.job.error ? `: ${v.state.job.error}` : '.'}{' '}
          {v.mine && (
            <button className="rq-link" onClick={() => act.mutate({ path: `${base(v.id)}/retry`, done: 'The Analyst tries to answer again.' })}>
              Try again
            </button>
          )}
        </div>
      )}
      {qs.map((q, i) => (
        <QuestionCard key={q.id} v={v} q={q} n={i + 1} answer={answers[q.id]} onAnswer={(a) => setAnswers((s) => ({ ...s, [q.id]: a }))} onOpenRef={onOpenRef} />
      ))}
      {v.mine && (
        <div className="rq-qfoot">
          <Cmd text={`squad requirements answer ${v.id}`} />
          <span className="grow" />
          <button className="btn" disabled={act.isPending || busy} onClick={skip} title={`squad requirements answer ${v.id} --skip`}>
            {SKIP_CHOICE}
          </button>
          <button className="btn you" disabled={!ready || act.isPending || busy} onClick={() => act.mutate({ path: `${base(v.id)}/answers`, body: { answers }, done: 'Answers sent. The Analyst writes the breakdown now.' })}>
            <Send size={14} /> Send answers
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  v,
  q,
  n,
  answer,
  onAnswer,
  onOpenRef,
}: {
  v: BreakdownView;
  q: BreakdownQuestion;
  n: number;
  answer?: { choice: string; value?: string };
  onAnswer(a: { choice: string; value?: string }): void;
  onOpenRef(ref: BrdRef): void;
}) {
  const act = useReqAct();
  const [text, setText] = useDraft(v.id, `ask-${q.id}`, '');
  const [asking, setAsking] = useState(Boolean(text));
  const name = `q-${v.id}-${q.id}`;
  const ask = () => {
    if (!text.trim()) return;
    act.mutate({ path: `${base(v.id)}/questions/${q.id}/ask`, body: { text } }, { onSuccess: () => setText('') });
    setAsking(false);
  };
  const other = answer?.choice === 'Other';
  return (
    <fieldset className="rq-q">
      <legend className="sr-only">Question {n}</legend>
      <div className="rq-qtop">
        <span className={`rq-tag ${q.kind === 'clash' ? 'clash' : 'gap'}`}>{q.kind === 'clash' ? 'Two parts clash' : 'Missing in the BRD'}</span>
        <span className="rq-qsrc">
          {(q.refs ?? []).map((r, i) => (
            <span key={i}>
              {i > 0 && (i === (q.refs?.length ?? 0) - 1 ? ' and ' : ', ')}
              <button className="rq-link" onClick={() => onOpenRef(r)} title="Open this place in the document">
                {refShort(r)}
              </button>
            </span>
          ))}
          {q.refs?.length && q.impact ? ' · ' : ''}
          {q.impact}
        </span>
      </div>
      <div className="rq-qt">{q.text}</div>
      {(q.thread?.length || q.thinking) && (
        <div className="thread">
          {q.thread?.map((m, i) => (
            <div key={i} className={`msg ${m.who === 'you' ? '' : 'squad'}`}>
              <small>{m.who === 'you' ? 'You' : ROLE_NAME[m.who]}</small>
              {m.text}
            </div>
          ))}
          {q.thinking && (
            <div className="msg squad">
              <small>Analyst</small>
              <span className="typing" aria-label="Writing a reply">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
        </div>
      )}
      {q.options.map((o) => (
        <label key={o} className={`rq-opt ${answer?.choice === o ? 'on' : ''}`}>
          <input type="radio" name={name} checked={answer?.choice === o} onChange={() => onAnswer({ choice: o })} disabled={!v.mine} />
          {o}
        </label>
      ))}
      <label className={`rq-opt ${other ? 'on' : ''}`}>
        <input type="radio" name={name} checked={other} onChange={() => onAnswer({ choice: 'Other', value: answer?.value ?? '' })} disabled={!v.mine} />
        Something else…
      </label>
      {other && <input className="input rq-own" autoFocus aria-label="Your answer" placeholder="Your answer" value={answer?.value ?? ''} onChange={(e) => onAnswer({ choice: 'Other', value: e.target.value })} />}
      {v.mine &&
        (asking ? (
          <div className="askrow">
            <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the Analyst about this question" aria-label="Your question to the Analyst" onKeyDown={(e) => e.key === 'Enter' && ask()} />
            <button className="btn" onClick={ask} disabled={!text.trim() || act.isPending}>
              Ask
            </button>
            <button className="btn quiet" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="asklink" onClick={() => setAsking(true)} disabled={q.thinking} title={`squad requirements ask ${v.id} ${q.id} "<text>"`}>
            <MessageCircle size={14} /> Ask about this
          </button>
        ))}
    </fieldset>
  );
}
