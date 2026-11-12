import { useMutation, useQueryClient } from '@tanstack/react-query';
import { send } from '../../api/client';
import type { Question, Ticket } from '../../api/types';
import { useDraft } from '../../lib/drafts';
import { outcome } from '../../lib/decide';
import { detect, langProps } from '../../lib/lang';
import { Written } from '../ui';
import { OpenLink } from './Body';

type Answers = Record<string, { choice: string; value?: string }>;

/** The words "Let it decide" sends, the same as the ticket's own card. */
export const LET_IT_DECIDE = 'Decide yourself: take the simplest choice that fits the plan, and say what you chose';

/** An agent's question mid-work: its own options, and Let it decide. One press answers. */
export function AskFoot({ t, busy, onPick }: { t: Ticket; busy: boolean; onPick(answer: string): void }) {
  const q = t.agentQuestion!;
  return (
    <div className="opts" dir={detect(q.options.join(' ')).dir}>
      {[...q.options, LET_IT_DECIDE].map((o, i) => (
        <button key={o} className="opt" style={{ ['--i' as string]: i }} disabled={busy} onClick={() => onPick(o)} {...langProps(o)}>
          {o === LET_IT_DECIDE ? 'Let it decide' : o}
        </button>
      ))}
    </div>
  );
}

/**
 * The Analyst's questions as answer chips, one at a time, "1 of 5". The picks are the same draft as the ticket's own
 * Questions tab, so nothing is lost between the two, and Send answers sends them all, as there.
 */
export function QuestionsFoot({ t, expect, onDone, onRefused }: { t: Ticket; expect?: string; onDone(words: string): void; onRefused(words: string | null): void }) {
  const qc = useQueryClient();
  const questions = t.questions ?? [];
  const saved: Answers = Object.fromEntries(questions.filter((q) => q.answer).map((q) => [q.id, q.answer!]));
  const [answers, setAnswers, clearAnswers] = useDraft<Answers>(t.id, 'answers', saved);
  const done = (q: Question) => {
    const a = answers[q.id];
    return Boolean(a && (a.choice === q.inputOption || a.choice === 'Other' ? a.value?.trim() : true));
  };
  const next = questions.find((q) => !done(q));
  const go = useMutation({
    mutationFn: () => send<Ticket>(`/api/v1/tickets/${t.id}/answers`, 'POST', { answers, ...(expect ? { expect } : {}) }),
    onSuccess: (after) => {
      clearAnswers();
      onRefused(null);
      onDone(outcome('questions', t.id, after, 'answers'));
      void qc.invalidateQueries();
    },
    onError: (err) => onRefused(err instanceof Error ? err.message : String(err)),
  });
  return (
    <div className="qs">
      {questions.map((q, i) => {
        const a = answers[q.id];
        if (q !== next && !done(q)) return null;
        return (
          <div key={q.id} className="qrow">
            <p className="q" {...langProps(q.text)}>
              <Written text={q.text} />
              <span className="qn">
                {i + 1} of {questions.length}
              </span>
            </p>
            {done(q) && q !== next ? (
              <button className="me" onClick={() => setAnswers((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== q.id)))} title="Pick again">
                <Written text={a!.value?.trim() ? `${a!.choice.replace(/:$/, '')}: ${a!.value}` : a!.choice} />
              </button>
            ) : (
              <Chips q={q} answer={a} onAnswer={(x) => setAnswers((s) => ({ ...s, [q.id]: x }))} />
            )}
          </div>
        );
      })}
      <div className="df">
        <button className="btn pri" disabled={Boolean(next) || go.isPending} onClick={() => go.mutate()}>
          {next ? `Answer all ${questions.length} to send` : 'Send answers'}
        </button>
        <OpenLink t={t} label="Open the questions" />
      </div>
    </div>
  );
}

function Chips({ q, answer, onAnswer }: { q: Question; answer?: { choice: string; value?: string }; onAnswer(a: { choice: string; value?: string }): void }) {
  const typed = answer && (answer.choice === q.inputOption || answer.choice === 'Other');
  return (
    <>
      <div className="opts" dir={detect(q.options.join(' ')).dir}>
        {[...q.options, 'Other'].map((o, i) => (
          <button key={o} className={`opt ${answer?.choice === o ? 'on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => onAnswer({ choice: o })} {...langProps(o)}>
            {o === 'Other' ? 'Something else' : o.replace(/:$/, '')}
          </button>
        ))}
      </div>
      {typed && (
        <input
          className="input"
          autoFocus
          value={answer!.value ?? ''}
          dir={answer!.value?.trim() ? detect(answer!.value).dir : 'auto'}
          placeholder={answer!.choice === 'Other' ? 'Your answer' : 'Which one?'}
          onChange={(e) => onAnswer({ choice: answer!.choice, value: e.target.value })}
        />
      )}
    </>
  );
}
