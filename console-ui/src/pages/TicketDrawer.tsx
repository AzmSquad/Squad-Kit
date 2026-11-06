import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightLeft, ArrowUp, Check, Code, Copy, Download, ExternalLink, GitPullRequest, LifeBuoy, Loader2, Maximize2, MessageCircle, Minimize2, PencilLine, Send, Square, TriangleAlert, X } from 'lucide-react';
import { assetUrl, ticketFileUrl } from '../api/client';
import type { PlanComment, Question, Ticket, TicketNote } from '../api/types';
import { useAct, useBoard, useTicket } from '../lib/data';
import { partNames } from '../lib/overview';
import { ApiProof } from '../components/ApiProof';
import { usePrefs } from '../lib/prefs';
import { Cmd, Glyph, Modal, ROLE_NAME, Tracker, ago, clock, commandFor } from '../components/ui';
import { ConversationTab } from '../components/Conversation';
import { ChangesTab, OpenInEditor } from '../components/Changes';
import { TakeOverButton, canTakeOver } from '../components/TakeOver';
import { Attachments as AgentFiles, Mockup } from '../components/Attachments';
import { Part, WhatChanged, type Review } from '../components/PlanReview';
import { AGENT_TITLE, TalkButton } from '../components/Chat';
import { ChangeCard, ChangeHistory, ProposeChange, ProposeChangeButton, canPropose, changeWaits, shipped } from '../components/ChangeCard';
import { Lightbox, type Picture } from '../components/Lightbox';
import { CostTab, TicketUsage } from '../components/Usage';
import { HandOverDialog, HandedOverBanner, NotYoursPanel, canHandOver, isMine, ownerOf, useMe } from '../components/HandOver';
import { AskBox, NowCard, SlowPanel, WorkSoFar, isRunning } from '../components/LiveNow';
import { PortAskPanel } from '../components/PortAsk';
import { ExactError, StuckCard } from '../components/ErrorCard';
import { TestCommandCard } from '../components/TestCommand';
import { GatePill, NotCheckedNote } from '../components/Gates';
import { checksWords, noShotsText, overrideWhat, proofLead, proofWords } from '../lib/gates';
import { testChangeWaits } from '../lib/waiting';
import { AlsoChanged, MorePictures, OffScreenList, VerdictIcon, VerdictTag } from '../components/Verdict';
import { isApiProof, proofViewer, verdictClass, verdictNote } from '../lib/verdict';
import { report } from '../lib/report';
import { shellQuote } from '../lib/text';
import { DeleteArchiveBanner, TicketMenu } from '../components/DeleteTicket';
import { BringInButton, DependsCard, DependsLine, waitsForDependency } from '../components/Depends';
import { BreakdownPlace, DecidedForYou, StopPanel, TrackWords } from '../components/AutoTicket';
import { YourCheck } from '../components/YourCheck';
import { AskButton, useAskAgent } from '../components/AskQuestion';
import { pageOf, waitsAtReview } from '../lib/review';
import { useDraft } from '../lib/drafts';
import { useReach } from '../lib/use-reach';
import { ticketTrouble } from '../lib/ticket-trouble';

type Tab = 'now' | 'story' | 'plan' | 'activity' | 'conversation' | 'proof' | 'changes' | 'cost' | 'developer';

export function TicketDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const ticket = useTicket(id);
  const me = useMe();
  const { ticketFull, toggleTicketFull } = usePrefs();
  // Hand over and Propose a change live in the ⋯ menu, so the header stays one row at any width.
  const [menuDialog, setMenuDialog] = useState<'hand-over' | 'propose' | null>(null);
  const [tab, setTab] = useState<Tab>('now');
  useEffect(() => setTab('now'), [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = ticket.data;
  const board = useBoard();
  const known = board.data?.ready ? board.data.meta.parts : undefined;
  const parts = t?.parts?.length ? t.parts.map((id) => known?.find((p) => p.id === id)?.name ?? id) : partNames(known, t?.repo);
  return (
    <>
      <div className="veil" onClick={onClose} />
      <aside className={`drawer ${ticketFull ? 'full' : ''}`} aria-label={t ? `${t.id} ${t.title}` : 'Ticket'}>
        {!t ? (
          <div className="center">
            {ticket.isError ? (
              <div>
                <p>{ticketTrouble(ticket.error, id)}</p>
                <button className="btn" onClick={onClose}>Close</button>
              </div>
            ) : (
              'Loading…'
            )}
          </div>
        ) : (
          <>
            <div className="dh">
              <div className="dtop">
                <span className="idtag">{t.id}</span>
                {t.source.type !== 'manual' &&
                  (t.source.url ? (
                    <a className="src" href={t.source.url} target="_blank" rel="noreferrer">
                      <Download size={14} /> {t.source.itemType ?? 'Item'} {t.source.ref} <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="src">
                      <Download size={14} /> From {t.source.ref}
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
                {/* The actions stay together: when the row is too narrow, they move under the id as one group. */}
                <span className="dacts">
                  {/* Ask a question, in every state: questions only, and the story stays where it is. */}
                  <AskButton t={t} />
                  {t.waiting?.kind === 'proof' && (
                    <Link to="/tickets/$id/proof" params={{ id: t.id }} className="iconbtn" aria-label="Open the proof page">
                      <ExternalLink size={15} />
                    </Link>
                  )}
                  <button className="iconbtn" onClick={() => report.open({ ticket: t.id })} aria-label="Report a problem" title="Report a problem">
                    <LifeBuoy size={15} />
                  </button>
                  <TicketMenu
                    t={t}
                    onDeleted={onClose}
                    items={[
                      ...((isMine(t, me) || !me) && canPropose(t)
                        ? [{ key: 'propose', label: <><PencilLine size={15} /> {shipped(t) ? 'Ask for a change…' : 'Propose a change…'}</>, onPick: () => setMenuDialog('propose') }]
                        : []),
                      ...(canHandOver(t, me) ? [{ key: 'hand-over', label: <><ArrowRightLeft size={15} /> Hand over…</>, onPick: () => setMenuDialog('hand-over') }] : []),
                    ]}
                  />
                  <button
                    className="iconbtn fullbtn"
                    onClick={toggleTicketFull}
                    aria-pressed={ticketFull}
                    aria-label={ticketFull ? 'Back to the side panel' : 'Full width'}
                    title={ticketFull ? 'Back to the side panel' : 'Full width'}
                  >
                    {ticketFull ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                  <button className="iconbtn" onClick={onClose} aria-label="Close">
                    <X size={16} />
                  </button>
                </span>
              </div>
              {menuDialog === 'hand-over' && <HandOverDialog t={t} onClose={() => setMenuDialog(null)} />}
              {menuDialog === 'propose' && <ProposeChange t={t} onClose={() => setMenuDialog(null)} />}
              <h2>{t.title}</h2>
              <BreakdownPlace t={t} />
              <div className="sub">
                <span>
                  Created by <b>{t.createdBy}</b> {ago(t.createdAt)}
                  {' · '}
                  <TrackWords t={t} />
                </span>
                <span>
                  Owner <b>{ownerOf(t)}</b>
                  {isMine(t, me) ? ' (you)' : ''}
                </span>
                {parts.length > 0 && (
                  <span>
                    {parts.length > 1 ? 'Parts' : 'Part'} <b>{parts.join(', ')}</b>
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
                  ['cost', 'Cost'],
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {label}
                  {k === 'now' && (t.waiting || t.outdated?.length || changeWaits(t) || testChangeWaits(t)) && <span className="dot" />}
                </button>
              ))}
              <button className={`dev ${tab === 'developer' ? 'on' : ''}`} onClick={() => setTab('developer')}>
                <Code size={15} /> Developer
              </button>
            </div>
            {tab === 'now' && t.outdated?.length ? <OutdatedBanner t={t} /> : null}
            {/* With the design waiting, the change shows in it; otherwise (Express, or a design approved before) here. */}
            {tab === 'now' && testChangeWaits(t) && t.waiting?.kind !== 'plan' && (isMine(t, me) || !me) ? <TestCommandCard t={t} banner /> : null}
            {tab === 'now' && <HandedOverBanner t={t} />}
            {tab === 'now' && <DeleteArchiveBanner t={t} onDeleted={onClose} />}
            {tab === 'now' && (isMine(t, me) || !me) && <ChangeCard t={t} />}
            {/* A panel of its own per ticket: what is typed on one never shows on another. */}
            {tab === 'now' && (isMine(t, me) || !me ? <NowPanel key={t.id} t={t} /> : <NotYoursPanel t={t} />)}
            {tab === 'story' && <StoryTab t={t} />}
            {tab === 'plan' && <PlanTab t={t} />}
            {tab === 'activity' && <ActivityTab t={t} />}
            {tab === 'conversation' && <ConversationTab t={t} onTab={setTab} />}
            {tab === 'proof' && <ProofTab t={t} />}
            {tab === 'changes' && <ChangesTab t={t} />}
            {tab === 'cost' && (
              <div className="db">
                <CostTab t={t} />
              </div>
            )}
            {tab === 'developer' && <DeveloperTab t={t} />}
          </>
        )}
      </aside>
    </>
  );
}

function NowPanel({ t }: { t: Ticket }) {
  if (!t.waiting && t.quiet) return <QuietPanel t={t} />;
  // It needs a ticket that is not merged yet: the ways to build (components/Depends).
  if (waitsForDependency(t)) return <DependsCard t={t} />;
  switch (t.waiting?.kind) {
    case 'questions':
      return <QuestionsPanel t={t} />;
    case 'spec':
    case 'plan':
      return <PlanPanel t={t} />;
    case 'proof':
      return <ProofPanel t={t} />;
    case 'stuck':
      // Every stop has a way out: the plain error card (components/ErrorCard). Stopped at a gate, the person can also
      // ask a question and try the ticket's own copy of the app.
      return (
        <StuckCard
          t={t}
          extra={
            <>
              <AlsoChanged t={t} />
              {/* Stopped at the proof: what each screenshot shows, Met, Not working yet or Not shown yet. */}
              {t.stuck?.gate === 'proof' && t.proof?.some((p) => p.after) && (
                <>
                  <div className="lbl">What the screenshots show</div>
                  <ProofShots t={t} />
                </>
              )}
              {waitsAtReview(t) && <YourCheck t={t} />}
              <RecentActivity t={t} />
            </>
          }
        />
      );
    case 'ask':
      return <AskPanel t={t} />;
    case 'yours':
      return <YoursPanel t={t} />;
    case 'chat':
      return t.chat ? <ChatOpen t={t} /> : <WorkingPanel t={t} />;
    default:
      return <WorkingPanel t={t} />;
  }
}

/** The talk itself lives in the chat panel beside the board, so the board stays in view while you talk. Open the chat is at the top. */
function ChatOpen({ t }: { t: Ticket }) {
  const who = AGENT_TITLE[t.chat!.with];
  return (
    <div className="db">
      <div className="youbox">
        <span className="ring">
          <MessageCircle size={15} />
        </span>
        <div>
          <b>Talking it through with the {who}</b>
          <span>The talk is open in the chat panel beside the board. Its work waits until you press a button there.</span>
        </div>
        <span className="grow" />
        <Link to="/conversations" search={{ ticket: t.id }} className="btn sm">
          Full screen
        </Link>
      </div>
    </div>
  );
}

/* ── Questions ─────────────────────────────────────────── */

type Answers = Record<string, { choice: string; value?: string }>;

function QuestionsPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const saved: Answers = Object.fromEntries((t.questions ?? []).filter((q) => q.answer).map((q) => [q.id, q.answer!]));
  // Kept on this computer until sent: another tab, Esc, a click outside or a reload lose nothing.
  const [answers, setAnswers, clearAnswers] = useDraft<Answers>(t.id, 'answers', saved);
  // Skip throws the picks away, so it asks once when there are any.
  const [askSkip, setAskSkip] = useState(false);
  const picks = Object.keys(answers).length;
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
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/answers`, body: { answers }, done: 'Answers sent. The Architect is choosing the design.' }, { onSuccess: clearAnswers })}
        >
          <Send size={15} /> Send answers
        </button>
        <button
          className="btn"
          disabled={act.isPending}
          onClick={() => {
            if (picks > 0 && !askSkip) return setAskSkip(true);
            act.mutate({ path: `/api/v1/tickets/${t.id}/skip`, done: 'The squad made its own guesses. You will see them in the plan.' }, { onSuccess: clearAnswers });
          }}
        >
          {askSkip ? `Skip and lose your ${picks === 1 ? 'answer' : `${picks} answers`}?` : 'Skip, let the squad guess'}
        </button>
        {askSkip && <button className="btn quiet" onClick={() => setAskSkip(false)}>Keep them</button>}
        <TalkButton t={t} agent="analyst" label="Talk it through instead" />
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
  const [text, setText] = useDraft(t.id, `ask-${q.id}`, '');
  const [asking, setAsking] = useState(Boolean(text));
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
            <div key={o} className={`choice ${on ? 'on' : ''}`} role="radio" aria-checked={on} tabIndex={0} onClick={() => !on && onAnswer({ choice: o })} onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && !on && onAnswer({ choice: o })}>
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

function PlanBody({ t, review }: { t: Ticket; review?: Review }) {
  return (
    <>
      <div className="lbl">The story</div>
      <Part review={review} at={{ part: 'story' }}>
        <p className="story">{t.story}</p>
      </Part>
      {t.criteria && (
        <>
          <div className="lbl">Done when</div>
          <ol className="ac">
            {t.criteria.map((c, i) => (
              <li key={i}>
                <Part review={review} at={{ part: 'criterion', index: i }}>
                  <span>
                    <em>Given</em> {c.given}, <em>when</em> {c.when}, <em>then</em> {c.then}.
                  </span>
                </Part>
              </li>
            ))}
          </ol>
        </>
      )}
      {t.decision && (
        <>
          <div className="lbl">The Architect's decision {t.decision.adr && <span className="pill ok">Saved as {t.decision.adr}</span>}</div>
          <Part review={review} at={{ part: 'decision' }}>
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
              {t.decision.replaces && (
                <span>
                  <b>Replaces</b> {t.decision.replaces}. Once you approve, it is no longer a rule and later tickets follow this one.
                </span>
              )}
            </div>
          </div>
          </Part>
        </>
      )}
      {t.work && t.follows && t.follows.length > 0 && (
        <>
          <div className="lbl">Follows saved decisions</div>
          <div className="pills">
            {t.follows.map((id) => (
              <Link key={id} to="/architecture" search={{ adr: id }} className="pill">{id}</Link>
            ))}
          </div>
        </>
      )}
      {t.work && <DependsLine t={t} />}
      {t.mockup && t.work && (
        <>
          <div className="lbl">How it will look</div>
          <Mockup ticket={t.id} file={t.mockup} title={`${t.title}: mockup`} />
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
      {t.work && <TestCommandCard t={t} />}
      {review && t.work && t.steps && (
        <>
          <div className="lbl">Build steps</div>
          <ol className="ac">
            {t.steps.map((st, i) => (
              <li key={i}>
                <Part review={review} at={{ part: 'step', index: i }}>
                  <span>{st.title}</span>
                </Part>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

/**
 * Full track: the spec (the what) and then the design (the how), each approved on its own. Express: one plan.
 * Reviewed like a document: comment on any part or edit it, send every comment back at once, or start over.
 */
function PlanPanel({ t }: { t: Ticket }) {
  const act = useAct();
  // Comments and the note stay until sent. A spec and the design after it each have their own.
  const place = `plan-${t.waiting?.kind ?? 'plan'}`;
  const [mode, setMode, clearMode] = useDraft<'change' | 'over' | null>(t.id, `${place}-mode`, null);
  const [note, setNote, clearNote] = useDraft(t.id, `${place}-note`, '');
  const [askDev, setAskDev] = useState(false);
  const [comments, setComments, clearComments] = useDraft<PlanComment[]>(t.id, `${place}-comments`, []);
  const sent = () => {
    clearMode();
    clearNote();
    clearComments();
  };
  const spec = t.waiting?.kind === 'spec';
  const design = !spec && Boolean(t.specApproved);
  const who = spec ? 'the Analyst' : design ? 'the Architect' : 'the Spec writer';
  const review: Review = {
    t,
    comments,
    add: (c) => setComments((cs) => [...cs, c]),
    remove: (i) => setComments((cs) => cs.filter((_, k) => k !== i)),
    canEdit: (p) => (spec ? p.part === 'story' || p.part === 'criterion' : p.part === 'step' || (!design && (p.part === 'story' || p.part === 'criterion'))),
  };
  const send = () =>
    mode === 'over'
      ? act.mutate({ path: `/api/v1/tickets/${t.id}/plan/start-over`, body: { direction: note }, done: `Starting over. ${who[0]!.toUpperCase()}${who.slice(1)} writes it again.` }, { onSuccess: sent })
      : act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: `Sent to ${who}.` }, { onSuccess: sent });
  const n = comments.length;
  return (
    <>
      <div className="db">
        {(spec || design) && (
          <div className="twostep">
            <span className={spec ? 'on' : 'done'}>{spec ? '1' : <Check size={12} strokeWidth={3} />} The what</span>
            <span className="bar" />
            <span className={design ? 'on' : ''}>2 The how</span>
            <p>
              {spec
                ? 'Is this what you want? Check the story and the "done when" list. The Architect designs how to build it after you approve.'
                : `The spec was approved by ${t.specApproved!.by}. Now check how the Architect will build it. A developer can approve this part for you.`}
            </p>
          </div>
        )}
        <WhatChanged t={t} />
        <p className="note reviewhint">Point at any part to comment on it or edit it yourself. Send back sends every comment at once.</p>
        {spec ? <PlanBody t={{ ...t, decision: undefined, work: undefined }} review={review} /> : <PlanBody t={t} review={review} />}
        {!spec && t.decision && <p className="note" style={{ marginTop: 14 }}>Approved decisions are saved in Decisions. Later tickets must follow them.</p>}
      </div>
      {mode ? (
        <div className="df">
          <input
            className="input"
            style={{ flex: 1 }}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={mode === 'over' ? 'What is the new direction? It is written again from zero.' : 'What should change? One line is enough.'}
            onKeyDown={(e) => e.key === 'Enter' && note.trim() && !act.isPending && send()}
          />
          <button className="btn pri" disabled={!note.trim() || act.isPending} onClick={send}>
            {mode === 'over' ? 'Start over' : 'Send'}
          </button>
          <button className="btn" onClick={() => setMode(null)}>Cancel</button>
        </div>
      ) : (
        <div className="df">
          {n > 0 ? (
            <button
              className="btn pri"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { path: `/api/v1/tickets/${t.id}/plan/send-back`, body: { comments }, done: `Sent back to ${who} with ${n} ${n === 1 ? 'comment' : 'comments'}.` },
                  { onSuccess: sent },
                )
              }
            >
              <Send size={15} /> Send back ({n})
            </button>
          ) : (
            <button
              className="btn pri"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  {
                    path: `/api/v1/tickets/${t.id}/approve`,
                    done: spec ? 'Spec approved. The Architect is designing how to build it.' : 'Plan approved. The Builder started.',
                  },
                  { onSuccess: sent },
                )
              }
            >
              <Check size={15} strokeWidth={2.5} /> {spec ? 'Approve spec' : design ? 'Approve design' : 'Approve plan'}
            </button>
          )}
          {n === 0 && <button className="btn" onClick={() => setMode('change')}>Change something</button>}
          {(spec || design) && <TalkButton t={t} agent={spec ? 'analyst' : 'architect'} label="Talk it through" />}
          <button className="btn quiet" onClick={() => setMode('over')}>Start over</button>
          <button className="btn quiet" onClick={() => setAskDev(true)}>Ask a developer</button>
          <span className="grow" />
          <Cmd text={n > 0 ? `squad send-back ${t.id} ${comments.map((c) => shellQuote(`${partName(c)}: ${c.text}`)).join(' ')}` : `squad approve ${t.id}`} />
        </div>
      )}
      {askDev && <AskDeveloper t={t} onClose={() => setAskDev(false)} />}
    </>
  );
}

function partName(c: PlanComment): string {
  return c.part === 'criterion' ? `done when ${(c.index ?? 0) + 1}` : c.part === 'step' ? `step ${(c.index ?? 0) + 1}` : c.part;
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
  return (
    <>
      <div className="pills">
        <GatePill state={g?.checks} text={checksWords(g)} />
        <GatePill state={g?.review} text={g?.review === 'pass' ? `Review approved by ${g.reviewBy}` : g?.review === 'skipped' ? 'Review notes open, you continued' : 'Review approved'} />
        <GatePill state={g?.proof} text={proofWords(t)} />
      </div>
      <NotCheckedNote g={g} />
      {t.overrides?.map((o) => (
        <p className="note override" key={o.at}>
          <b>Continued anyway</b> past the {overrideWhat(o)}, by {o.by}: {o.reason}
        </p>
      ))}
    </>
  );
}

function ProofShots({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  if (!t.proof?.length) {
    return (
      <>
        <p className="note">{noShotsText(t)}</p>
        <OffScreenList t={t} />
      </>
    );
  }
  const { pictures, starts } = proofViewer(t.proof, (file) => assetUrl(`/api/v1/proof/${file}`));
  return (
    <>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      {t.proof.map((p, k) => (
        <div className={`critrow ${verdictClass(p.shows)}`} key={p.criterion}>
          <h5>
            <VerdictIcon shows={p.shows} />
            {p.criterion}
            <VerdictTag shows={p.shows} />
          </h5>
          {verdictNote(p) && <p className="verdictnote">{verdictNote(p)}</p>}
          {pageOf(p) && (
            <p className="critpage">
              Page <code>{pageOf(p)}</code>
            </p>
          )}
          {isApiProof(p.after) ? <ApiProof file={p.after} {...(p.note ? { note: p.note } : {})} /> : <div className="proofmini">
            <div>
              <small>{p.beforeLabel}</small>
              <button className="zoom" onClick={() => setZoom(starts[k]!)} aria-label={`Open ${p.beforeLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.before}`)} alt={`${p.criterion}, ${p.beforeLabel}`} />
              </button>
            </div>
            <div>
              <small>{p.afterLabel}</small>
              <button className="zoom" onClick={() => setZoom(starts[k]! + 1)} aria-label={`Open ${p.afterLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.after}`)} alt={`${p.criterion}, ${p.afterLabel}`} />
              </button>
            </div>
          </div>}
          {p.more?.length && p.why && p.note ? <p className="note proofmore-main">{p.note}</p> : null}
          <MorePictures shot={p} first={starts[k]! + 2} onOpen={setZoom} />
        </div>
      ))}
      <OffScreenList t={t} />
    </>
  );
}

export function ProofDecision({ t, sticky }: { t: Ticket; sticky?: boolean }) {
  const act = useAct();
  const [note, setNote, clearNote] = useDraft(t.id, 'proof-wrong', '');
  const [wrong, setWrong] = useState(Boolean(note));
  const sendBack = () => {
    if (act.isPending) return;
    act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: 'Sent back to the Builder with your note.' }, { onSuccess: clearNote });
  };
  return wrong ? (
    <div className={sticky ? 'stickybar' : 'df'}>
      <input className="input" style={{ flex: 1 }} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong? Tell the squad in one line." onKeyDown={(e) => e.key === 'Enter' && note.trim() && sendBack()} />
      <button className="btn pri" disabled={!note.trim() || act.isPending} onClick={sendBack}>Send back</button>
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
            <span>{proofLead(t.gates)}</span>
          </div>
          <span className="grow" />
          <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn sm">
            <ExternalLink size={14} /> Full page
          </Link>
        </div>
        <div className="lbl">Gates, checked by squad-kit</div>
        <GatePills t={t} />
        <AlsoChanged t={t} />
        <div className="lbl">Before and after</div>
        <ProofShots t={t} />
        <YourCheck t={t} />
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
  const [pick, setPick, clearPick] = useDraft<string | null>(t.id, 'agent-pick', null);
  const [own, setOwn, clearOwn] = useDraft(t.id, 'agent-own', '');
  if (!q) return <WorkingPanel t={t} />;
  // A busy port another program holds: one plain choice instead of the agent's words.
  if (q.port) return <PortAskPanel t={t} />;
  // Builds by itself: a part missing in the BRD, or two parts that clash (components/AutoTicket).
  if (q.kind) return <StopPanel t={t} extra={<><AlsoChanged t={t} /><RecentActivity t={t} /></>} />;
  const who = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' }[q.from];
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
        {q.files && q.files.length > 0 && <AgentFiles ticket={t.id} files={q.files} />}
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
          onClick={() =>
            act.mutate(
              { path: `/api/v1/tickets/${t.id}/reply`, body: { text: answer }, done: `Sent. The ${who} carries on.` },
              {
                onSuccess: () => {
                  clearPick();
                  clearOwn();
                },
              },
            )
          }
        >
          <Send size={15} /> Send answer
        </button>
        <span className="grow" />
        <Cmd text={`squad reply ${t.id}${answer ? ` ${shellQuote(answer.length > 40 ? `${answer.slice(0, 40)}…` : answer)}` : ''}`} />
      </div>
    </>
  );
}

/* ── Working, ready, released ──────────────────────────── */

/** The step is slow, or shows no progress: the card says what it does and what squad-kit checked, with the ways on. */
function QuietPanel({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <SlowPanel t={t} />
      {t.now && <NowCard t={t} />}
      <WorkSoFar t={t} />
      <AskBox t={t} />
    </div>
  );
}

/** A decision approved after this ticket was planned changes it. The person updates the plan or keeps it, with a reason. */
function OutdatedBanner({ t }: { t: Ticket }) {
  const act = useAct<Ticket>();
  const [keeping, setKeeping] = useState<string | null>(null);
  const [reason, setReason, clearReason] = useDraft(t.id, 'keep-reason', '');
  const merged = Boolean(t.mergedAt) || t.stage === 'done';
  return (
    <div className="outdated">
      {t.outdated!.map((o) => (
        <div key={o.adr} className="outdated-item">
          <div className="outdated-head">
            <span className="ic"><TriangleAlert size={15} /></span>
            <b>
              <Link to="/architecture" search={{ adr: o.adr }}>{o.adr}</Link> came after this plan and changes it
            </b>
          </div>
          <p>{o.why}</p>
          <p>
            <span className="note">{merged ? 'What a follow-up would change:' : 'What would change:'}</span> {o.change}
          </p>
          {keeping === o.adr ? (
            <div className="row">
              <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the plan stays as it is" />
              <button className="btn sm" disabled={!reason.trim() || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/decision-update`, body: { adr: o.adr, do: 'keep', reason }, done: 'Kept the plan. The reason is on the ticket.' }, { onSuccess: () => { setKeeping(null); clearReason(); } })}>
                Keep it
              </button>
              <button className="btn sm quiet" onClick={() => setKeeping(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row">
              <button
                className="btn sm pri"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/api/v1/tickets/${t.id}/decision-update`,
                    body: { adr: o.adr, do: 'update' },
                    done: merged ? 'Made a follow-up ticket.' : 'The Architect is updating the plan.',
                  })
                }
              >
                {merged ? 'Make a follow-up ticket' : 'Update the plan'}
              </button>
              <button className="btn sm" onClick={() => { setKeeping(o.adr); setReason(''); }}>
                Keep it as is
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The merge moved the person's own checkout; this says whether its packages and database are up to date. */
function LocalSetupLine({ t }: { t: Ticket }) {
  const again = useAct();
  const ls = t.localSetup!;
  const busy = ls.status === 'pending' || ls.status === 'running';
  return (
    <div className={`localsetup ${ls.status}`}>
      <span className="ic">{busy ? <Loader2 size={15} className="spin" /> : ls.status === 'done' ? <Check size={15} strokeWidth={2.5} /> : <TriangleAlert size={15} />}</span>
      <div>
        <b>
          {busy
            ? 'Updating your copy of the code'
            : ls.status === 'done'
              ? 'Your copy of the code is ready to run'
              : 'Your copy of the code needs a hand'}
        </b>
        <span>
          {busy
            ? 'The merge changed your own folder, so the squad installs new packages and runs the database changes there.'
            : ls.status === 'done'
              ? `New packages and database changes are in your own folder${ls.at ? `, ${ago(ls.at)}` : ''}${ls.seconds !== undefined ? ` (${ls.seconds} s)` : ''}.`
              : 'squad-kit could not finish setting it up. Try again, or ask an engineer to look at what failed.'}
        </span>
        {ls.status === 'failed' && (
          <details className="costdetails">
            <summary>See what failed</summary>
            <code>{ls.command}</code>
            {ls.output && <pre>{ls.output}</pre>}
          </details>
        )}
      </div>
      {ls.status === 'failed' && (
        <button className="btn sm" disabled={again.isPending} onClick={() => again.mutate({ path: `/api/v1/tickets/${t.id}/local-setup`, done: 'Running the setup again' })}>
          Try again
        </button>
      )}
    </div>
  );
}

function WorkingPanel({ t }: { t: Ticket }) {
  const reach = useReach();
  const me = useMe();
  const stop = useAct();
  const asks = useAskAgent(t);
  const calm =
    t.stage === 'release'
      ? { title: `Ready for ${t.release}`, text: 'It goes out with the next release. Nothing needed from you until then.' }
      : t.stage === 'done'
        ? { title: t.status, text: 'This ticket is live. Found a problem? Report a bug and it comes back around.' }
        : t.waiting?.kind === 'change'
          ? { title: 'The Builder paused for your change', text: 'The Architect updated the design. Approve it above, or decline the change and the Builder carries on.' }
          : { title: 'Nothing needed from you', text: `${nowLine(t)} You'll get a card when the squad needs you.` };
  // While the squad works: what it does now, how long, the usual time and what comes next, from the live record.
  const running = isRunning(t);
  return (
    <>
      <div className="db">
        {running ? (
          <NowCard t={t} />
        ) : (
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
        )}
        {t.localSetup && <LocalSetupLine t={t} />}
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
        <AlsoChanged t={t} />
        {(t.stage === 'release' || t.stage === 'done') && t.usage?.length ? <TicketUsage t={t} /> : null}
        <DecidedForYou t={t} />
        {running ? <WorkSoFar t={t} /> : <RecentActivity t={t} />}
        <AskBox t={t} />
      </div>
      <div className="df">
        {t.live && t.stage !== 'release' && t.stage !== 'done' && (
          <button className="btn sm" disabled={t.stopRequested || stop.isPending} onClick={() => stop.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping the squad' })}>
            <Square size={12} /> {t.stopRequested ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {canTakeOver(t) && <TakeOverButton t={t} />}
        <BringInButton t={t} />
        {/* Asking never stops the work: the chat runs beside it. Ask a question and Open the chat are at the top; the
            Analyst gets its own button only while someone else answers those. */}
        {!t.chat?.open && !t.takenOver && !shipped(t) && asks !== 'analyst' && <TalkButton t={t} agent="analyst" label="Ask the Analyst" />}
        {(isMine(t, me) || !me) && <ProposeChangeButton t={t} />}
        <span className="note">{t.live ? (reach === 'down' ? 'Not updating: squad-kit has stopped.' : 'Updates live as the squad works.') : ''}</span>
        <span className="grow" />
        <Cmd text={t.live && t.stage !== 'release' ? `squad stop ${t.id}` : commandFor(t)} />
      </div>
    </>
  );
}

/* ── Take over and give back ───────────────────────────── */

/** The ticket is yours: work in the Builder's session, then give it back so the checks and review run again. */
function YoursPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [note, setNote, clearNote] = useDraft(t.id, 'give-back', '');
  const k = t.takenOver!;
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">
            <Code size={15} />
          </span>
          <div>
            <b>You have this ticket</b>
            <span>The squad stopped and waits. Nothing runs until you give it back.</span>
          </div>
        </div>
        <div className="lbl">1. Open the Builder&apos;s session in Claude Code</div>
        <Cmd text={`cd ${shellQuote(k.cwd)} && claude --resume ${k.session}`} />
        <p className="note" style={{ fontSize: 12.5, marginTop: 6 }}>
          It is the same conversation the Builder had, in the ticket&apos;s own copy of the code. Your folder is not touched. Or just edit the files:
        </p>
        <OpenInEditor t={t} />
        <div className="lbl">2. Give it back</div>
        <textarea className="waynote" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you change? (optional, every agent reads it)" />
        <p className="note" style={{ fontSize: 12.5 }}>Then squad-kit runs the checks, the Reviewer reads all the changes, yours too, and the Tester makes the proof again.</p>
        <RecentActivity t={t} />
      </div>
      <div className="df">
        <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/give-back`, body: { note }, done: 'Given back. The checks run on your changes.' }, { onSuccess: clearNote })}>
          <Check size={15} strokeWidth={2.5} /> Give back
        </button>
        <span className="grow" />
        <Cmd text={`squad give-back ${t.id}${note.trim() ? ` ${shellQuote(note.trim())}` : ''}`} />
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
      <ChangeHistory t={t} />
      <DecidedForYou t={t} />
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
  const [text, setText] = useDraft(t.id, 'note', '');
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
            <Cmd text={`squad note ${t.id}${kind === 'note' ? '' : ` --${kind}`} ${shellQuote(text.trim() || '…')}`} />
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
      <AlsoChanged t={t} />
      <div className="lbl">Before and after</div>
      {t.gates.proof === 'pass' || t.proof?.some((p) => p.shows) ? <ProofShots t={t} /> : <p className="note">The screens are recorded after all checks pass.</p>}
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
      <ExactError t={t} />
      <div className="lbl">Branch</div>
      <p className="mono" style={{ fontSize: 13 }}>
        {t.repo ? `${t.repo}: ` : ''}
        {t.branch ?? `squad/${t.id.toLowerCase()}`}
      </p>
      {t.worktree && (
        <>
          <div className="lbl">The ticket's copy of the code</div>
          <p className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{t.storyDir ?? t.worktree}</p>
          <OpenInEditor t={t} />
        </>
      )}
      {t.gates?.ran?.length ? (
        <>
          <div className="lbl">The checks that ran</div>
          <div className="feed">
            {t.gates.ran.map((r) => (
              <div key={r.name} className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {r.name}: {r.command} ({r.failedOnce ? 'failed once, passed when run again' : r.ok ? 'passed' : 'failed'})
              </div>
            ))}
          </div>
        </>
      ) : null}
      {t.testChange || t.testDecided ? (
        <>
          <div className="lbl">How the tests run</div>
          <div className="feed">
            {t.testDecided && (
              <div className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {t.testDecided.kept === 'new' ? `Kept the new one: ${t.testDecided.to} (was ${t.testDecided.from})` : `Kept the current one: ${t.testDecided.from} (not ${t.testDecided.to})`}, by {t.testDecided.by === 'you' ? 'you' : 'squad-kit'}
                {t.testDecided.ran ? `. ${t.testDecided.ran}` : ''}
              </div>
            )}
            {t.testChange && (
              <div className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {t.testChange.ask ? 'Waiting for a choice' : 'Tried at the next checks'}: {t.testChange.from} or {t.testChange.to}
                {t.testChange.ran ? `. ${t.testChange.ran}` : ''}
              </div>
            )}
          </div>
        </>
      ) : null}
      {t.localSetup && (
        <>
          <div className="lbl">Setting up your own copy</div>
          <p className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
            {t.localSetup.command} in {t.localSetup.dir} ({t.localSetup.status})
          </p>
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
