import { Check, Send } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { Cmd, Written } from '../../components/ui';
import { Attachments as AgentFiles } from '../../components/Attachments';
import { PortAskPanel } from '../../components/PortAsk';
import { AlsoChanged } from '../../components/Verdict';
import { shellQuote } from '../../lib/text';
import { StopPanel } from '../../components/AutoTicket';
import { useDraft } from '../../lib/drafts';
import { langProps, typedDir } from '../../lib/lang';
import { RecentActivity, WorkingPanel } from './Working';

/* ── An agent asks mid-work ────────────────────────────── */

const DECIDE_YOURSELF = 'Decide yourself: take the simplest choice that fits the plan, and say what you chose';

/** The Builder or Reviewer stopped to ask. The answer goes back into the same conversation and the work carries on. */
export function AskPanel({ t }: { t: Ticket }) {
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
        <Written as="p" className="stuckq" text={q.text} />
        {q.why && <Written as="p" className="note" style={{ marginTop: -4 }} lead="Why it matters:" text={q.why} />}
        {q.files && q.files.length > 0 && <AgentFiles ticket={t.id} files={q.files} />}
        <div className="opts2">
          {choices.map((o) => (
            <button key={o} className={`opt2 ${pick === o ? 'pick' : ''}`} {...langProps(o)} onClick={() => setPick(o)}>
              <b>
                <Written text={o === DECIDE_YOURSELF ? 'Let it decide' : o} />
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
        {pick === '' && <textarea className="input" rows={3} style={{ width: '100%', marginTop: 8 }} autoFocus dir={typedDir(own)} value={own} placeholder="Your answer" onChange={(e) => setOwn(e.target.value)} />}
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
