import { useState } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import type { Question, Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { Cmd, Glyph, ROLE_NAME, Runs, Written } from '../../components/ui';
import { TalkButton } from '../../components/Chat';
import { useDraft } from '../../lib/drafts';
import { detect, langProps, typedDir } from '../../lib/lang';

/* ── Questions ─────────────────────────────────────────── */

type Answers = Record<string, { choice: string; value?: string }>;

export function QuestionsPanel({ t }: { t: Ticket }) {
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
      <h4 {...langProps(q.text)}>
        {n}. <Runs text={q.text} dir={detect(q.text).dir} />
      </h4>
      {(q.thread?.length || q.thinking) && (
        <div className="thread" dir={detect(q.text).dir}>
          {q.thread?.map((m, i) => (
            <div key={i} className={`msg ${m.who === 'you' ? '' : 'squad'}`}>
              <small>{m.who === 'you' ? 'You' : ROLE_NAME[m.who]}</small>
              <Written as="div" text={m.text} />
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
      <div className="choices" dir={detect(q.options.join(' ')).dir}>
        {options.map((o) => {
          const on = answer?.choice === o;
          const typed = o === q.inputOption || o === 'Other';
          return (
            <div key={o} className={`choice ${on ? 'on' : ''}`} {...langProps(o)} role="radio" aria-checked={on} tabIndex={0} onClick={() => !on && onAnswer({ choice: o })} onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && !on && onAnswer({ choice: o })}>
              <span className="rd" />
              <Written text={o.replace(/:$/, '')} />
              {typed && on && (
                <input
                  autoFocus
                  dir={typedDir(answer?.value ?? '')}
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
          <input className="input" autoFocus dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask the ${ROLE_NAME[q.from]} about this question`} onKeyDown={(e) => e.key === 'Enter' && send()} />
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
