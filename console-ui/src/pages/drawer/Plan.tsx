import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Copy, Send } from 'lucide-react';
import type { PlanComment, Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { usePrefs } from '../../lib/prefs';
import { Cmd, Glyph, Modal, Runs, Written } from '../../components/ui';
import { Mockup } from '../../components/Attachments';
import { Part, WhatChanged, type Review } from '../../components/PlanReview';
import { TalkButton } from '../../components/Chat';
import { TestCommandCard } from '../../components/TestCommand';
import { shellQuote } from '../../lib/text';
import { DependsLine } from '../../components/Depends';
import { useDraft } from '../../lib/drafts';
import { detect, langProps, typedDir } from '../../lib/lang';

/* ── Plan ──────────────────────────────────────────────── */

export function PlanBody({ t, review }: { t: Ticket; review?: Review }) {
  return (
    <>
      <div className="lbl">The story</div>
      <Part review={review} at={{ part: 'story' }} dir={detect(t.story ?? '').dir}>
        <Written as="p" className="story" text={t.story ?? ''} />
      </Part>
      {t.criteria && (
        <>
          <div className="lbl">Done when</div>
          <ol className="ac">
            {t.criteria.map((c, i) => {
              // One sentence: its three parts run the way the whole of it runs.
              const own = langProps(`${c.given} ${c.when} ${c.then}`);
              return (
                <li key={i} {...own}>
                  <Part review={review} at={{ part: 'criterion', index: i }}>
                    <span>
                      <em>Given</em> <Runs text={c.given} dir={own.dir} />, <em>when</em> <Runs text={c.when} dir={own.dir} />, <em>then</em> <Runs text={c.then} dir={own.dir} />.
                    </span>
                  </Part>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {t.decision && (
        <>
          <div className="lbl">The Architect's decision {t.decision.adr && <span className="pill ok">Saved as {t.decision.adr}</span>}</div>
          <Part review={review} at={{ part: 'decision' }} dir={detect(t.decision.title).dir}>
          <div className="decision">
            <h3 {...langProps(t.decision.title)}>
              <Glyph role="architect" small />
              <Written text={t.decision.title} />
            </h3>
            <div className="opts2">
              {t.decision.options.map((o) => (
                <div key={o.name} className={`opt2 ${o.chosen ? 'pick' : ''}`} {...langProps(`${o.name} ${o.note}`)}>
                  <b>
                    <Written text={o.name} />
                    {o.chosen && (
                      <span>
                        <Check size={13} strokeWidth={2.5} /> Chosen
                      </span>
                    )}
                  </b>
                  <Written text={o.note} />
                </div>
              ))}
            </div>
            <div className="why">
              <Written lead={<b>Why</b>} text={t.decision.why} />
              {t.decision.clientCheck && <Written lead={<b>Client's choice</b>} text={t.decision.clientCheck} />}
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
      {review && t.steps && (
        <>
          <div className="lbl">Build steps</div>
          <ol className="ac">
            {t.steps.map((st, i) => (
              <li key={i} {...langProps(st.title)}>
                <Part review={review} at={{ part: 'step', index: i }}>
                  <Written text={st.title} />
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
export function PlanPanel({ t }: { t: Ticket }) {
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
            dir={typedDir(note)}
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
      <Written as="div" className="wa" text={text} />
    </Modal>
  );
}
