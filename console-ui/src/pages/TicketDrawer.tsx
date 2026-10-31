import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUp, Check, Code, Copy, Download, ExternalLink, GitPullRequest, MessageCircle, Send, Square, X } from 'lucide-react';
import { assetUrl, ticketFileUrl } from '../api/client';
import type { Question, Ticket, TicketNote } from '../api/types';
import { useAct, useTicket } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd, Glyph, Modal, ROLE_NAME, Tracker, ago, clock, commandFor } from '../components/ui';
import { ConversationTab } from '../components/Conversation';
import { ChangesTab, OpenInEditor } from '../components/Changes';
import { Lightbox, type Picture } from '../components/Lightbox';

type Tab = 'now' | 'story' | 'plan' | 'activity' | 'conversation' | 'proof' | 'changes' | 'developer';

export function TicketDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const ticket = useTicket(id);
  const [tab, setTab] = useState<Tab>('now');
  useEffect(() => setTab('now'), [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = ticket.data;
  return (
    <>
      <div className="veil" onClick={onClose} />
      <aside className="drawer" aria-label={t ? `${t.id} ${t.title}` : 'Ticket'}>
        {!t ? (
          <div className="center">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>
        ) : (
          <>
            <div className="dh">
              <div className="dtop">
                <span className="idtag">{t.id}</span>
                {t.source.type === 'azure' &&
                  (t.source.url ? (
                    <a className="src" href={t.source.url} target="_blank" rel="noreferrer">
                      <Download size={14} /> {t.source.itemType ?? 'Azure'} {t.source.ref} <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="src">
                      <Download size={14} /> From Azure {t.source.ref}
                    </span>
                  ))}
                {t.pr && (
                  <a className="src" href={t.pr.url} target="_blank" rel="noreferrer">
                    <GitPullRequest size={14} /> Pull request {t.pr.id} <ExternalLink size={12} />
                  </a>
                )}
                {t.kind === 'bug' && <span className="prio">Bug{t.foundIn ? ` found in ${t.foundIn}` : ''}</span>}
                {t.priority === 'high' && t.kind !== 'bug' && <span className="prio">High priority</span>}
                <span className="grow" />
                {t.waiting?.kind === 'proof' && (
                  <Link to="/tickets/$id/proof" params={{ id: t.id }} className="iconbtn" aria-label="Open the proof page">
                    <ExternalLink size={15} />
                  </Link>
                )}
                <button className="iconbtn" onClick={onClose} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              <h2>{t.title}</h2>
              <div className="sub">
                <span>
                  Created by <b>{t.createdBy}</b> {ago(t.createdAt)}
                  {' · '}
                  <b>{t.track === 'express' ? 'Express' : 'Full'}</b> track
                </span>
                {t.repo && (
                  <span>
                    Repo <b className="mono" style={{ fontSize: 12.5 }}>{t.repo}</b>
                  </span>
                )}
                {t.builder && (
                  <span>
                    Builder <b>{t.builder}</b>
                  </span>
                )}
                {t.reviewer && (
                  <span>
                    Reviewer <b>{t.reviewer}</b>
                  </span>
                )}
              </div>
              <Tracker ticket={t} />
            </div>
            <div className="tabs" role="tablist">
              {(
                [
                  ['now', 'Now'],
                  ['story', 'Story'],
                  ['plan', 'Plan'],
                  ['activity', 'Activity'],
                  ['conversation', 'Conversation'],
                  ['proof', 'Proof'],
                  ['changes', 'Changes'],
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {label}
                  {k === 'now' && t.waiting && <span className="dot" />}
                </button>
              ))}
              <button className={`dev ${tab === 'developer' ? 'on' : ''}`} onClick={() => setTab('developer')}>
                <Code size={15} /> Developer
              </button>
            </div>
            {tab === 'now' && <NowPanel t={t} />}
            {tab === 'story' && <StoryTab t={t} />}
            {tab === 'plan' && <PlanTab t={t} />}
            {tab === 'activity' && <ActivityTab t={t} />}
            {tab === 'conversation' && <ConversationTab t={t} />}
            {tab === 'proof' && <ProofTab t={t} />}
            {tab === 'changes' && <ChangesTab t={t} />}
            {tab === 'developer' && <DeveloperTab t={t} />}
          </>
        )}
      </aside>
    </>
  );
}

function NowPanel({ t }: { t: Ticket }) {
  if (!t.waiting && t.quiet) return <QuietPanel t={t} />;
  switch (t.waiting?.kind) {
    case 'questions':
      return <QuestionsPanel t={t} />;
    case 'plan':
      return <PlanPanel t={t} />;
    case 'proof':
      return <ProofPanel t={t} />;
    case 'stuck':
      return <StuckPanel t={t} />;
    case 'ask':
      return <AskPanel t={t} />;
    default:
      return <WorkingPanel t={t} />;
  }
}

/* ── Questions ─────────────────────────────────────────── */

type Answers = Record<string, { choice: string; value?: string }>;

function QuestionsPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries((t.questions ?? []).filter((q) => q.answer).map((q) => [q.id, q.answer!])),
  );
  const questions = t.questions ?? [];
  const groups: { from: 'analyst' | 'architect'; label: string }[] = [
    { from: 'analyst', label: 'From the Analyst, about what to build' },
    { from: 'architect', label: 'From the Architect, about how to build it' },
  ];
  const ready = questions.every((q) => {
    const a = answers[q.id];
    if (!a) return false;
    return a.choice === q.inputOption || a.choice === 'Other' ? Boolean(a.value?.trim()) : true;
  });
  return (
    <>
      <div className="db">
        {groups.map((g) => {
          const qs = questions.filter((q) => q.from === g.from);
          if (!qs.length) return null;
          return (
            <div key={g.from} className="qblock">
              <div className="qgroup">
                <Glyph role={g.from} small />
                {g.label}
              </div>
              {qs.map((q) => (
                <QuestionBlock
                  key={q.id}
                  t={t}
                  q={q}
                  n={questions.indexOf(q) + 1}
                  answer={answers[q.id]}
                  onAnswer={(a) => setAnswers((s) => ({ ...s, [q.id]: a }))}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="df">
        <button
          className="btn pri"
          disabled={!ready || act.isPending}
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/answers`, body: { answers }, done: 'Answers sent. The Architect is choosing the design.' })}
        >
          <Send size={15} /> Send answers
        </button>
        <button className="btn" onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/skip`, done: 'The squad made its own guesses. You will see them in the plan.' })}>
          Skip, let the squad guess
        </button>
        <span className="grow" />
        <Cmd text={`squad answer ${t.id}`} />
      </div>
    </>
  );
}

function QuestionBlock({
  t,
  q,
  n,
  answer,
  onAnswer,
}: {
  t: Ticket;
  q: Question;
  n: number;
  answer?: { choice: string; value?: string };
  onAnswer(a: { choice: string; value?: string }): void;
}) {
  const act = useAct();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    act.mutate({ path: `/api/v1/tickets/${t.id}/ask`, body: { questionId: q.id, text } });
    setText('');
    setAsking(false);
  };
  const options = [...q.options, 'Other'];
  return (
    <div className="q">
      <h4>
        {n}. {q.text}
      </h4>
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
              <small>{ROLE_NAME[q.from]}</small>
              <span className="typing" aria-label="Writing a reply"><i /><i /><i /></span>
            </div>
          )}
        </div>
      )}
      <div className="choices">
        {options.map((o) => {
          const on = answer?.choice === o;
          const typed = o === q.inputOption || o === 'Other';
          return (
            <div key={o} className={`choice ${on ? 'on' : ''}`} role="radio" aria-checked={on} tabIndex={0} onClick={() => !on && onAnswer({ choice: o })} onKeyDown={(e) => e.key === 'Enter' && onAnswer({ choice: o })}>
              <span className="rd" />
              {o === 'Other' ? 'Other' : o.replace(/:$/, '')}
              {typed && on && (
                <input
                  autoFocus
                  value={answer?.value ?? ''}
                  placeholder={o === 'Other' ? 'Your answer' : 'Which one?'}
                  onChange={(e) => onAnswer({ choice: o, value: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </div>
          );
        })}
      </div>
      {asking ? (
        <div className="askrow">
          <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask the ${ROLE_NAME[q.from]} about this question`} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="btn" onClick={send} disabled={!text.trim()}>Ask</button>
        </div>
      ) : (
        <button className="asklink" onClick={() => setAsking(true)} disabled={q.thinking}>
          <MessageCircle size={14} /> Ask about this
        </button>
      )}
    </div>
  );
}

/* ── Plan ──────────────────────────────────────────────── */

function PlanBody({ t }: { t: Ticket }) {
  return (
    <>
      <div className="lbl">The story</div>
      <p className="story">{t.story}</p>
      {t.criteria && (
        <>
          <div className="lbl">Done when</div>
          <ol className="ac">
            {t.criteria.map((c, i) => (
              <li key={i}>
                <span>
                  <em>Given</em> {c.given}, <em>when</em> {c.when}, <em>then</em> {c.then}.
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {t.decision && (
        <>
          <div className="lbl">The Architect's decision {t.decision.adr && <span className="pill ok">Saved as {t.decision.adr}</span>}</div>
          <div className="decision">
            <h3>
              <Glyph role="architect" small />
              {t.decision.title}
            </h3>
            <div className="opts2">
              {t.decision.options.map((o) => (
                <div key={o.name} className={`opt2 ${o.chosen ? 'pick' : ''}`}>
                  <b>
                    {o.name}
                    {o.chosen && (
                      <span>
                        <Check size={13} strokeWidth={2.5} /> Chosen
                      </span>
                    )}
                  </b>
                  {o.note}
                </div>
              ))}
            </div>
            <div className="why">
              <span>
                <b>Why</b> {t.decision.why}
              </span>
              {t.decision.clientCheck && (
                <span>
                  <b>Client's choice</b> {t.decision.clientCheck}
                </span>
              )}
            </div>
          </div>
        </>
      )}
      {t.work && (
        <>
          <div className="lbl">The work</div>
          <div className="pills">
            <span className="pill">{t.work.steps} small steps</span>
            <span className="pill">{t.work.tests} new tests</span>
            {t.work.screens > 0 && <span className="pill">{t.work.screens} before and after screens</span>}
          </div>
        </>
      )}
    </>
  );
}

function PlanPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');
  const [askDev, setAskDev] = useState(false);
  return (
    <>
      <div className="db">
        <PlanBody t={t} />
        {t.decision && <p className="note" style={{ marginTop: 14 }}>Approved decisions are saved in Decisions. Later tickets must follow them.</p>}
      </div>
      {changing ? (
        <div className="df">
          <input className="input" style={{ flex: 1 }} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? One line is enough." onKeyDown={(e) => e.key === 'Enter' && note.trim() && act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: 'Sent to the Spec writer.' })} />
          <button className="btn pri" disabled={!note.trim()} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: 'Sent to the Spec writer.' })}>
            Send
          </button>
          <button className="btn" onClick={() => setChanging(false)}>Cancel</button>
        </div>
      ) : (
        <div className="df">
          <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/approve`, done: 'Plan approved. The Builder started.' })}>
            <Check size={15} strokeWidth={2.5} /> Approve plan
          </button>
          <button className="btn" onClick={() => setChanging(true)}>Change something</button>
          <button className="btn quiet" onClick={() => setAskDev(true)}>Ask a developer</button>
          <span className="grow" />
          <Cmd text={`squad approve ${t.id}`} />
        </div>
      )}
      {askDev && <AskDeveloper t={t} onClose={() => setAskDev(false)} />}
    </>
  );
}

function AskDeveloper({ t, onClose }: { t: Ticket; onClose(): void }) {
  const { toast } = usePrefs();
  const text = `Hi, can you check the plan for ${t.id} "${t.title}" before I approve it? It's on the board, or run: squad show ${t.id}`;
  return (
    <Modal
      title="Ask a developer"
      onClose={onClose}
      footer={
        <>
          <button className="btn pri" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Message copied'))}>
            <Copy size={15} /> Copy message
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <p>Send this to a developer on your team. They can read the plan in the terminal and tell you what they think.</p>
      <div className="wa">{text}</div>
    </Modal>
  );
}

/* ── Proof ─────────────────────────────────────────────── */

function GatePills({ t }: { t: Ticket }) {
  const g = t.gates;
  const pill = (state: string | undefined, text: string) => (
    <span className={`pill ${state === 'pass' ? 'ok' : state === 'skipped' ? 'skip' : 'wait'}`}>
      {state === 'pass' && <Check size={13} strokeWidth={2.5} />}
      {text}
    </span>
  );
  return (
    <>
      <div className="pills">
        {pill(g?.checks, g?.checks === 'skipped' ? 'Checks failed, you continued' : (g?.checksText ?? 'All checks pass'))}
        {pill(g?.review, g?.review === 'pass' ? `Review approved by ${g.reviewBy}` : g?.review === 'skipped' ? 'Review notes open, you continued' : 'Review approved')}
        {pill(g?.proof, 'Proof made')}
      </div>
      {t.overrides?.map((o) => (
        <p className="note override" key={o.at}>
          <b>Continued anyway</b> past the {o.gate === 'checks' ? 'failed checks' : 'open review'}, by {o.by}: {o.reason}
        </p>
      ))}
    </>
  );
}

function ProofShots({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  if (!t.proof?.length) return <p className="note">No screens change in this ticket, so the passing checks are the proof.</p>;
  const pictures: Picture[] = t.proof.flatMap((p) => [
    { src: assetUrl(`/api/v1/proof/${p.before}`), caption: `${p.criterion} · ${p.beforeLabel}` },
    { src: assetUrl(`/api/v1/proof/${p.after}`), caption: `${p.criterion} · ${p.afterLabel}` },
  ]);
  return (
    <>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      {t.proof.map((p, k) => (
        <div className="critrow" key={p.criterion}>
          <h5>
            <Check size={15} strokeWidth={2.5} />
            {p.criterion}
          </h5>
          <div className="proofmini">
            <div>
              <small>{p.beforeLabel}</small>
              <button className="zoom" onClick={() => setZoom(k * 2)} aria-label={`Open ${p.beforeLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.before}`)} alt={`${p.criterion}, ${p.beforeLabel}`} />
              </button>
            </div>
            <div>
              <small>{p.afterLabel}</small>
              <button className="zoom" onClick={() => setZoom(k * 2 + 1)} aria-label={`Open ${p.afterLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.after}`)} alt={`${p.criterion}, ${p.afterLabel}`} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export function ProofDecision({ t, sticky }: { t: Ticket; sticky?: boolean }) {
  const act = useAct();
  const [wrong, setWrong] = useState(false);
  const [note, setNote] = useState('');
  const sendBack = () => act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: 'Sent back to the Builder with your note.' });
  return wrong ? (
    <div className={sticky ? 'stickybar' : 'df'}>
      <input className="input" style={{ flex: 1 }} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong? Tell the squad in one line." onKeyDown={(e) => e.key === 'Enter' && note.trim() && sendBack()} />
      <button className="btn pri" disabled={!note.trim()} onClick={sendBack}>Send back</button>
      <button className="btn" onClick={() => setWrong(false)}>Cancel</button>
    </div>
  ) : (
    <div className={sticky ? 'stickybar' : 'df'}>
      <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/approve`, done: `${t.id} is ready to release.` })}>
        <Check size={15} strokeWidth={2.5} /> Looks right
      </button>
      <button className="btn" onClick={() => setWrong(true)}>Something's wrong</button>
      <span className="grow" />
      <Cmd text={`squad approve ${t.id}`} />
    </div>
  );
}

function ProofPanel({ t }: { t: Ticket }) {
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring"><Check size={18} strokeWidth={2.5} /></span>
          <div>
            <b>Check that it works the way you want</b>
            <span>Every gate is green. Compare the screens before and after each "done when".</span>
          </div>
          <span className="grow" />
          <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn sm">
            <ExternalLink size={14} /> Full page
          </Link>
        </div>
        <div className="lbl">Gates, checked by squad-kit</div>
        <GatePills t={t} />
        <div className="lbl">Before and after</div>
        <ProofShots t={t} />
      </div>
      <ProofDecision t={t} />
    </>
  );
}

/* ── An agent asks mid-work ────────────────────────────── */

const DECIDE_YOURSELF = 'Decide yourself: take the simplest choice that fits the plan, and say what you chose';

/** The Builder or Reviewer stopped to ask. The answer goes back into the same conversation and the work carries on. */
function AskPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const q = t.agentQuestion;
  const [pick, setPick] = useState<string | null>(null);
  const [own, setOwn] = useState('');
  if (!q) return <WorkingPanel t={t} />;
  const who = q.from === 'builder' ? 'Builder' : 'Reviewer';
  const answer = pick === '' ? own.trim() : pick;
  const choices = [...q.options, DECIDE_YOURSELF];
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">?</span>
          <div>
            <b>The {who} has a question</b>
            <span>It stopped instead of guessing. Your answer goes back into the same conversation, and the work carries on.</span>
          </div>
        </div>
        <div className="lbl">{who} asks</div>
        <p className="stuckq">{q.text}</p>
        {q.why && <p className="note" style={{ marginTop: -4 }}>Why it matters: {q.why}</p>}
        <div className="opts2">
          {choices.map((o) => (
            <button key={o} className={`opt2 ${pick === o ? 'pick' : ''}`} onClick={() => setPick(o)}>
              <b>
                {o === DECIDE_YOURSELF ? 'Let it decide' : o}
                {pick === o && (
                  <span>
                    <Check size={13} strokeWidth={2.5} /> Your pick
                  </span>
                )}
              </b>
              {o === DECIDE_YOURSELF ? 'It takes the simplest choice that fits the plan and tells you which.' : ''}
            </button>
          ))}
          <button className={`opt2 ${pick === '' ? 'pick' : ''}`} onClick={() => setPick('')}>
            <b>Write my own answer</b>
          </button>
        </div>
        {pick === '' && <textarea className="input" rows={3} style={{ width: '100%', marginTop: 8 }} autoFocus value={own} placeholder="Your answer" onChange={(e) => setOwn(e.target.value)} />}
        <RecentActivity t={t} />
      </div>
      <div className="df">
        <button
          className="btn pri"
          disabled={!answer || act.isPending}
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/reply`, body: { text: answer }, done: `Sent. The ${who} carries on.` })}
        >
          <Send size={15} /> Send answer
        </button>
        <span className="grow" />
        <Cmd text={`squad reply ${t.id}${answer ? ` "${answer.length > 40 ? `${answer.slice(0, 40)}…` : answer}"` : ''}`} />
      </div>
    </>
  );
}

/* ── Stuck ─────────────────────────────────────────────── */

/** Every stop has a way out: try again (with a note), fix it yourself in the copy, continue anyway (with a reason), or back to the plan. */
function StuckPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [pick, setPick] = useState<number | null>(null);
  const [text, setText] = useState('');
  const opts = t.stuck?.options ?? [];
  const way = pick === null ? undefined : (opts[pick]?.do ?? (pick === 0 ? 'retry' : undefined));
  const needsReason = way === 'continue' && !text.trim();
  const label = way === 'yourself' ? 'I fixed it, check again' : way === 'continue' ? 'Continue anyway' : way === 'retry' ? 'Try again' : 'Decide';
  const flag = way === 'continue' ? ` --reason "${text.trim() || '…'}"` : way === 'retry' && text.trim() ? ` --note "${text.trim()}"` : '';
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">!</span>
          <div>
            <b>The squad stopped and needs your decision</b>
            <span>Read what happened, then pick a way out. Nothing is lost whatever you pick.</span>
          </div>
        </div>
        <div className="lbl">What happened</div>
        <p className="stuckq">{t.stuck?.question}</p>
        <div className="opts2">
          {opts.map((o, i) => (
            <button
              key={o.name}
              className={`opt2 ${pick === i ? 'pick' : ''}`}
              onClick={() => {
                setPick(i);
                setText('');
              }}
            >
              <b>
                {o.name}
                {pick === i && (
                  <span>
                    <Check size={13} strokeWidth={2.5} /> Your pick
                  </span>
                )}
              </b>
              {o.note}
            </button>
          ))}
        </div>
        {way === 'retry' && (
          <>
            <div className="lbl">A note for the squad (optional)</div>
            <textarea className="waynote" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the test server needs the VPN, it is on now" />
          </>
        )}
        {way === 'continue' && (
          <>
            <div className="lbl">Why continue anyway?</div>
            <textarea className="waynote" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the failing test is broken on main too, fixed in SK-160" />
            <p className="note" style={{ fontSize: 12.5 }}>Only you can do this. Your reason shows on the ticket, the pull request and the release notes.</p>
          </>
        )}
        {way === 'yourself' && (
          <div className="stuckbox">
            <p style={{ margin: '0 0 8px' }}>Open the ticket&apos;s copy, fix it, and save. Then press <b>I fixed it</b>: the checks, review and proof run again.</p>
            <OpenInEditor t={t} />
          </div>
        )}
        <RecentActivity t={t} />
      </div>
      <div className="df">
        <button
          className="btn pri"
          disabled={pick === null || needsReason || act.isPending}
          onClick={() =>
            act.mutate({
              path: `/api/v1/tickets/${t.id}/decide`,
              body: { choice: pick, ...(way === 'continue' ? { reason: text } : way === 'retry' ? { note: text } : {}) },
              done: way === 'yourself' ? 'OK. The checks run again on your fix.' : 'Decided. The squad carries on.',
            })
          }
        >
          <Check size={15} strokeWidth={2.5} /> {label}
        </button>
        <span className="grow" />
        <Cmd text={`squad decide ${t.id}${pick !== null ? ` ${pick + 1}` : ''}${flag}`} />
      </div>
    </>
  );
}

/* ── Working, ready, released ──────────────────────────── */

/** The watchdog saw no progress: say what the step waits on and let the person decide. Nothing hangs silently. */
function QuietPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const q = t.quiet!;
  const stuck = q.kind === 'stuck';
  return (
    <>
      <div className="db">
        <div className="lbl">{stuck ? 'This step looks stuck' : 'This step is taking long'}</div>
        <div className="stuckbox">
          <p style={{ margin: 0 }}>{q.detail}</p>
          {q.command && <p className="mono" style={{ fontSize: 12.5, margin: '8px 0 0', overflowWrap: 'anywhere' }}>{q.command}</p>}
          <p className="note" style={{ margin: '8px 0 0', fontSize: 12.5 }}>No progress since {clock(q.since)}. Nothing is lost whatever you choose.</p>
        </div>
        <div className="lbl">What to do</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {q.pid && (
            <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/unstick`, done: 'Ended the stuck command. The squad carries on.' })}>
              End the stuck command
            </button>
          )}
          <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/keep-waiting`, done: 'OK. squad-kit stays quiet about it for 10 minutes.' })}>
            Keep waiting
          </button>
          <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping. The work so far is kept.' })}>
            <Square size={13} /> Stop
          </button>
        </div>
        <p className="note" style={{ marginTop: 10, fontSize: 12.5 }}>
          Ending the command gives the squad an error back, and it carries on in the same conversation. See what it was doing in the Conversation tab.
        </p>
      </div>
      <div className="foot">
        <span className="grow" />
        <Cmd text={q.pid ? `squad unstick ${t.id}` : `squad stop ${t.id}`} />
      </div>
    </>
  );
}

function WorkingPanel({ t }: { t: Ticket }) {
  const stop = useAct();
  const calm =
    t.stage === 'release'
      ? { title: `Ready for ${t.release}`, text: 'It goes out with the next release. Nothing needed from you until then.' }
      : t.stage === 'done'
        ? { title: t.status, text: 'This ticket is live. Found a problem? Report a bug and it comes back around.' }
        : { title: 'Nothing needed from you', text: `${nowLine(t)} You'll get a card when the squad needs you.` };
  return (
    <>
      <div className="db">
        <div className="calm">
          <span className="ring">{t.stage === 'release' ? <ArrowUp size={18} /> : <Check size={18} strokeWidth={2.5} />}</span>
          <div>
            <b>{calm.title}</b>
            <span>{calm.text}</span>
          </div>
          {t.stage === 'release' && (
            <>
              <span className="grow" style={{ flex: 1 }} />
              <Link to="/releases" className="btn sm">Open release</Link>
            </>
          )}
        </div>
        {t.steps && t.steps.length > 0 && (
          <>
            <div className="lbl">Steps</div>
            <Steps t={t} />
          </>
        )}
        {t.gates && (
          <>
            <div className="lbl">Gates, checked by squad-kit</div>
            <GatePills t={t} />
          </>
        )}
        <RecentActivity t={t} />
      </div>
      <div className="df">
        {t.live && t.stage !== 'release' && t.stage !== 'done' && (
          <button className="btn sm" disabled={t.stopRequested || stop.isPending} onClick={() => stop.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping the squad' })}>
            <Square size={12} /> {t.stopRequested ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <span className="note">{t.live ? 'Updates live as the squad works.' : ''}</span>
        <span className="grow" />
        <Cmd text={t.live && t.stage !== 'release' ? `squad stop ${t.id}` : commandFor(t)} />
      </div>
    </>
  );
}

/** A calm sentence for what the squad is doing; raw tool lines stay in the steps list. */
function nowLine(t: Ticket): string {
  const steps = t.steps ?? [];
  const i = steps.findIndex((s) => s.status === 'doing');
  if (t.stage === 'implement' && i >= 0) return `The Builder is on step ${i + 1} of ${steps.length}.`;
  if (t.stage === 'test') return 'squad-kit is running the project checks.';
  if (t.stage === 'review') return 'The Reviewer is checking the work.';
  if (t.stage === 'tickets') return 'The Analyst is reading the ticket.';
  if (t.stage === 'specs') return 'The Architect is writing the plan.';
  return `${t.status}.`;
}

function Steps({ t }: { t: Ticket }) {
  return (
    <ul className="steps">
      {t.steps!.map((s, i) => (
        <li key={i} className={s.status === 'doing' ? 'now' : s.status === 'todo' ? 'todo' : ''}>
          <span className={`sd ${s.status === 'done' ? 'ok' : s.status === 'doing' ? 'now' : ''}`}>
            {s.status === 'done' && <Check size={11} strokeWidth={3} />}
          </span>
          <span>
            {s.status === 'doing' ? <b style={{ fontWeight: 600 }}>{s.title}</b> : s.title}
            {s.live && (
              <span className="livetxt">
                <span className="live" />
                {s.live}
              </span>
            )}
          </span>
          <span className="time">{s.status === 'done' ? `${s.minutes ?? 1} min` : s.status === 'doing' ? 'now' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function RecentActivity({ t, all }: { t: Ticket; all?: boolean }) {
  const items = all ? t.activity : t.activity.slice(0, 4);
  if (!items.length) return null;
  return (
    <>
      {!all && <div className="lbl">Latest activity</div>}
      <div className="feed">
        {items.map((a, i) => (
          <div className="fe" key={a.at + i}>
            <span className="tm">{clock(a.at)}</span>
            <Glyph role={a.who} small />
            <span>
              <b>{ROLE_NAME[a.who]}</b> {a.text.charAt(0).toLowerCase() + a.text.slice(1)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Other tabs ────────────────────────────────────────── */

function StoryTab({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <div className="lbl">What was asked</div>
      <p className="story" style={{ whiteSpace: 'pre-wrap' }}>{t.ask}</p>
      <BriefList head="Your acceptance criteria" items={t.brief?.criteria} />
      <BriefList head="Business rules" items={t.brief?.rules} />
      <BriefList head="Edge cases" items={t.brief?.edgeCases} />
      <Attachments t={t} />
      <Notes t={t} />
      {t.story ? (
        <PlanBody t={{ ...t, decision: undefined, work: undefined }} />
      ) : (
        <p className="note" style={{ marginTop: 16 }}>The Analyst writes the user story after your answers.</p>
      )}
    </div>
  );
}

const NOTE_KINDS = [
  { kind: 'note', label: 'Note', head: 'Note', hint: 'Anything the squad should know' },
  { kind: 'rule', label: 'Business rule', head: 'Rule', hint: 'For example: at most 3 bookings a day per person' },
  { kind: 'criterion', label: 'Acceptance criterion', head: 'Done when', hint: 'The Tester must prove it, for example: the clerk sees an error on the 4th booking' },
] as const;

/** Notes the person adds at any time. Every agent on the ticket reads them; a running one gets them at its next step. */
function Notes({ t }: { t: Ticket }) {
  const act = useAct();
  const [kind, setKind] = useState<TicketNote['kind']>('note');
  const [text, setText] = useState('');
  const notes = t.notes ?? [];
  const open = t.stage !== 'done';
  const pick = NOTE_KINDS.find((k) => k.kind === kind)!;
  const add = () =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/notes`, body: { text, kind }, done: t.live ? 'Added. The squad reads it at its next step.' : 'Added. Every agent on this ticket reads it.' },
      { onSuccess: () => setText('') },
    );
  if (!open && !notes.length) return null;
  return (
    <>
      <div className="lbl">Notes{notes.length ? ` · ${notes.length}` : ''}</div>
      {notes.length > 0 && (
        <ul className="ticketnotes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className={`pill ${n.kind === 'criterion' ? 'ok' : n.kind === 'rule' ? 'wait' : ''}`}>{NOTE_KINDS.find((k) => k.kind === n.kind)?.head}</span>
              <span className="grow">{n.text}</span>
              <span className="note">{n.by} · {ago(n.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="addnote">
          <div className="seg" style={{ width: 'fit-content' }}>
            {NOTE_KINDS.map((k) => (
              <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
                {k.label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            rows={2}
            value={text}
            placeholder={pick.hint}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) add();
            }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn pri sm" disabled={!text.trim() || act.isPending} onClick={add}>
              Add {pick.label.toLowerCase()}
            </button>
            <span className="note">Every agent on this ticket reads it{t.live ? ', the one working now from its next step' : ''}.</span>
            <span className="grow" />
            <Cmd text={`squad note ${t.id}${kind === 'note' ? '' : ` --${kind}`} "${text.trim() || '…'}"`} />
          </div>
        </div>
      )}
    </>
  );
}

function BriefList({ head, items }: { head: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <>
      <div className="lbl">{head}</div>
      <ul className="brief">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** The files that came with the ticket. Pictures open in the viewer; anything else opens or downloads. */
function Attachments({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const files = t.attachments ?? [];
  if (!files.length) return null;
  const name = (f: string) => f.split(/[\\/]/).pop() ?? f;
  const pictures: Picture[] = files.filter((f) => IMAGE.test(f)).map((f) => ({ src: ticketFileUrl(t.id, f), caption: name(f) }));
  const others = files.filter((f) => !IMAGE.test(f));
  return (
    <>
      <div className="lbl">Attached · {files.length}</div>
      {pictures.length > 0 && (
        <div className="thumbs">
          {pictures.map((p, i) => (
            <button key={p.src} className="zoom thumb" onClick={() => setZoom(i)} aria-label={`Open ${p.caption} full size`}>
              <img src={p.src} alt={p.caption} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a key={f} className="filechip mono" href={ticketFileUrl(t.id, f)} target="_blank" rel="noreferrer">
          {name(f)}
        </a>
      ))}
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}

function PlanTab({ t }: { t: Ticket }) {
  if (!t.story) return <div className="db"><p className="note">The plan is written after the questions are answered.</p></div>;
  return (
    <div className="db">
      <PlanBody t={t} />
      {t.steps && (
        <>
          <div className="lbl">Steps</div>
          <Steps t={t} />
        </>
      )}
    </div>
  );
}

function ActivityTab({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <RecentActivity t={t} all />
    </div>
  );
}

function ProofTab({ t }: { t: Ticket }) {
  if (!t.gates) return <div className="db"><p className="note">The Tester records the proof after the Builder finishes.</p></div>;
  return (
    <div className="db">
      <div className="lbl">Gates, checked by squad-kit</div>
      <GatePills t={t} />
      <div className="lbl">Before and after</div>
      {t.gates.proof === 'pass' ? <ProofShots t={t} /> : <p className="note">The screens are recorded after all checks pass.</p>}
    </div>
  );
}

function DeveloperTab({ t }: { t: Ticket }) {
  const files = useMemo(() => {
    const found = new Set<string>();
    const lines = [...t.activity.map((a) => a.text), ...(t.steps ?? []).map((s) => s.live ?? '')];
    for (const l of lines) for (const m of l.matchAll(/[\w./-]+\/[\w.-]+\.\w+/g)) found.add(m[0]);
    return [...found];
  }, [t]);
  return (
    <div className="db">
      <div className="lbl">Branch</div>
      <p className="mono" style={{ fontSize: 13 }}>
        {t.repo ? `${t.repo}: ` : ''}
        {t.branch ?? `squad/${t.id.toLowerCase()}`}
      </p>
      {t.worktree && (
        <>
          <div className="lbl">The ticket's copy of the code</div>
          <p className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{t.worktree}</p>
          <OpenInEditor t={t} />
        </>
      )}
      <div className="lbl">Files the squad touched</div>
      {files.length ? (
        <div className="feed">
          {files.map((f) => (
            <div key={f} className="mono" style={{ fontSize: 12.5 }}>{f}</div>
          ))}
        </div>
      ) : (
        <p className="note">No files changed yet.</p>
      )}
      <div className="lbl">In the terminal</div>
      <div className="pills">
        <Cmd text={`squad show ${t.id}`} />
        <Cmd text={`squad watch ${t.id}`} />
      </div>
    </div>
  );
}
