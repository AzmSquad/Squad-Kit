import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUp, Check, Code, Copy, Download, ExternalLink, MessageCircle, Send, X } from 'lucide-react';
import { assetUrl } from '../api/client';
import type { Question, Ticket } from '../api/types';
import { useAct, useTicket } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd, Glyph, Modal, ROLE_NAME, Tracker, ago, clock, commandFor } from '../components/ui';

type Tab = 'now' | 'story' | 'plan' | 'activity' | 'proof' | 'developer';

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
                {t.source.type === 'azure' && (
                  <span className="src">
                    <Download size={14} /> From Azure {t.source.ref}
                  </span>
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
                </span>
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
                  ['proof', 'Proof'],
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
            {tab === 'proof' && <ProofTab t={t} />}
            {tab === 'developer' && <DeveloperTab t={t} />}
          </>
        )}
      </aside>
    </>
  );
}

function NowPanel({ t }: { t: Ticket }) {
  switch (t.waiting?.kind) {
    case 'questions':
      return <QuestionsPanel t={t} />;
    case 'plan':
      return <PlanPanel t={t} />;
    case 'proof':
      return <ProofPanel t={t} />;
    case 'stuck':
      return <StuckPanel t={t} />;
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
    <span className={`pill ${state === 'pass' ? 'ok' : 'wait'}`}>
      {state === 'pass' && <Check size={13} strokeWidth={2.5} />}
      {text}
    </span>
  );
  return (
    <div className="pills">
      {pill(g?.checks, g?.checksText ?? 'All checks pass')}
      {pill(g?.review, g?.review === 'pass' ? `Review approved by ${g.reviewBy}` : 'Review approved')}
      {pill(g?.proof, 'Proof made')}
    </div>
  );
}

function ProofShots({ t }: { t: Ticket }) {
  if (!t.proof?.length) return <p className="note">No screens change in this ticket, so the passing checks are the proof.</p>;
  return (
    <>
      {t.proof.map((p) => (
        <div className="critrow" key={p.criterion}>
          <h5>
            <Check size={15} strokeWidth={2.5} />
            {p.criterion}
          </h5>
          <div className="proofmini">
            <div>
              <small>{p.beforeLabel}</small>
              <img src={assetUrl(`/api/v1/proof/${p.before}`)} alt={`${p.criterion}, ${p.beforeLabel}`} />
            </div>
            <div>
              <small>{p.afterLabel}</small>
              <img src={assetUrl(`/api/v1/proof/${p.after}`)} alt={`${p.criterion}, ${p.afterLabel}`} />
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

/* ── Stuck ─────────────────────────────────────────────── */

function StuckPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [pick, setPick] = useState<number | null>(null);
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">!</span>
          <div>
            <b>The squad stopped and needs your decision</b>
            <span>It tried 3 times and the checks still fail. It won't guess on something this important.</span>
          </div>
        </div>
        <div className="lbl">The question</div>
        <p className="stuckq">{t.stuck?.question}</p>
        <div className="opts2">
          {t.stuck?.options.map((o, i) => (
            <button key={o.name} className={`opt2 ${pick === i ? 'pick' : ''}`} onClick={() => setPick(i)}>
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
        <RecentActivity t={t} />
      </div>
      <div className="df">
        <button className="btn pri" disabled={pick === null || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/decide`, body: { choice: pick }, done: 'Decided. The Builder is trying your choice.' })}>
          <Check size={15} strokeWidth={2.5} /> Decide
        </button>
        <span className="grow" />
        <Cmd text={`squad decide ${t.id}${pick !== null ? ` ${pick + 1}` : ''}`} />
      </div>
    </>
  );
}

/* ── Working, ready, released ──────────────────────────── */

function WorkingPanel({ t }: { t: Ticket }) {
  const calm =
    t.stage === 'release'
      ? { title: `Ready for ${t.release}`, text: 'It goes out with the next release. Nothing needed from you until then.' }
      : t.stage === 'done'
        ? { title: t.status, text: 'This ticket is live. Found a problem? Report a bug and it comes back around.' }
        : { title: 'Nothing needed from you', text: `${t.status}. You'll get a card when the squad needs you.` };
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
        <span className="note">{t.live ? 'Updates live as the squad works.' : ''}</span>
        <span className="grow" />
        <Cmd text={commandFor(t)} />
      </div>
    </>
  );
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
      {t.story ? (
        <PlanBody t={{ ...t, decision: undefined, work: undefined }} />
      ) : (
        <p className="note" style={{ marginTop: 16 }}>The Analyst writes the user story after your answers.</p>
      )}
    </div>
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
      <p className="mono" style={{ fontSize: 13 }}>squad/{t.id.toLowerCase()}</p>
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
