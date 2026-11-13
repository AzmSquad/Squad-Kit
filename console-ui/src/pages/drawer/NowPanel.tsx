import { Link } from '@tanstack/react-router';
import { MessageCircle } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { OutsidePanel } from '../../components/Outside';
import { AGENT_TITLE } from '../../components/Chat';
import { StuckCard } from '../../components/ErrorCard';
import { AlsoChanged } from '../../components/Verdict';
import { CheckMerge, DependsCard, waitsForDependency } from '../../components/Depends';
import { YourCheck } from '../../components/YourCheck';
import { waitsAtReview } from '../../lib/review';
import { SplitCard } from '../../components/split/SplitCard';
import { QuestionsPanel } from './Questions';
import { PlanPanel } from './Plan';
import { ProofPanel, ProofShots } from './Proof';
import { AskPanel } from './AskPanel';
import { proofHead } from '../../lib/proof-kinds';
import { QuietPanel, RecentActivity, SavingPanel, WorkingPanel, YoursPanel } from './Working';
import { PullRequestNow, showsPullRequest } from '../../components/pr/PullRequestNow';

export function NowPanel({ t }: { t: Ticket }) {
  // Sent to the owner's repo: the pull request's steps, and the owner's notes or merge (components/pr).
  if (showsPullRequest(t)) return <PullRequestNow t={t} />;
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
      // Looks right was pressed: it is being saved and merged now.
      return t.now?.merging ? <SavingPanel t={t} /> : <ProofPanel t={t} />;
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
                  <div className="lbl">{proofHead(t, 'What the screenshots show')}</div>
                  <ProofShots t={t} />
                </>
              )}
              {waitsAtReview(t) && <YourCheck t={t} />}
              {/* Its pull request stays open on the code host: settled and merged there, the story is merged here too. */}
              {t.stuck?.gate === 'merge' && t.clashedPr && (
                <CheckMerge t={t} text={`Settled the clash and merged pull request ${t.clashedPr.id} on the code host yourself? squad-kit looks by itself every few minutes, or now:`} />
              )}
              <RecentActivity t={t} />
            </>
          }
        />
      );
    case 'ask':
      return <AskPanel t={t} />;
    case 'split':
      return (
        <div className="db">
          <SplitCard t={t} />
        </div>
      );
    case 'yours':
      return t.takenOver?.free ? <OutsidePanel t={t} extra={<RecentActivity t={t} />} /> : <YoursPanel t={t} />;
    case 'chat':
      return t.chat ? <ChatOpen t={t} /> : <WorkingPanel t={t} />;
    default:
      return <WorkingPanel t={t} />;
  }
}

/** The talk itself lives in its popup over the page, so the board stays in view while you talk. Open the chat is at the top. */
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
          <span>The talk is open in its popup, at the bottom right. Its work waits until you press a button there.</span>
        </div>
        <span className="grow" />
        <Link to="/conversations" search={{ ticket: t.id }} className="btn sm">
          Full screen
        </Link>
      </div>
    </div>
  );
}
