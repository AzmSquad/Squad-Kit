import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  Code,
  Download,
  ExternalLink,
  GitPullRequest,
  LifeBuoy,
  Maximize2,
  MessagesSquare,
  Minimize2,
  PencilLine,
  X,
} from 'lucide-react';
import { useBoard, useTicket } from '../lib/data';
import { partNames } from '../lib/overview';
import { usePrefs } from '../lib/prefs';
import { Tracker, Written, ago } from '../components/ui';
import { ConversationTab } from '../components/Conversation';
import { ChangesTab } from '../components/Changes';
import { OutsideDialog, OutsideLabel, canWorkOutside } from '../components/Outside';
import { ChangeCard, ProposeChange, canPropose, changeWaits, shipped } from '../components/ChangeCard';
import { CostTab } from '../components/Usage';
import {
  HandOverDialog,
  HandedOverBanner,
  NotYoursPanel,
  canHandOver,
  isMine,
  ownerOf,
  useMe,
} from '../components/HandOver';
import { TestCommandCard } from '../components/TestCommand';
import { NoNewTestsLabel } from '../components/Gates';
import { testChangeWaits } from '../lib/waiting';
import { report } from '../lib/report';
import { DeleteArchiveBanner, TicketMenu } from '../components/DeleteTicket';
import { BreakdownPlace, TrackWords } from '../components/AutoTicket';
import { AskButton } from '../components/AskQuestion';
import { ticketTrouble } from '../lib/ticket-trouble';
import { AskLeadStrip } from '../components/LeadAsk';
import { NowPanel } from './drawer/NowPanel';
import { OutdatedBanner } from './drawer/Outdated';
import { StoryTab } from './drawer/StoryTab';
import { ActivityTab, PlanTab, ProofTab } from './drawer/Tabs';
import { DeveloperTab } from './drawer/DeveloperTab';

type Tab = 'now' | 'story' | 'plan' | 'activity' | 'conversation' | 'proof' | 'changes' | 'cost' | 'developer';

/** The tabs a link may open the drawer on: /board?ticket=MA-7&tab=proof. */
export type DrawerTab = Extract<Tab, 'story' | 'plan' | 'proof'>;

export function TicketDrawer({ id, tab: start, onClose }: { id: string; tab?: DrawerTab; onClose(): void }) {
  const ticket = useTicket(id);
  const me = useMe();
  const { ticketFull, toggleTicketFull } = usePrefs();
  // Hand over and Propose a change live in the ⋯ menu, so the header stays one row at any width.
  const [menuDialog, setMenuDialog] = useState<'hand-over' | 'outside' | 'propose' | null>(null);
  const [tab, setTab] = useState<Tab>(start ?? 'now');
  useEffect(() => setTab(start ?? 'now'), [id, start]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = ticket.data;
  const board = useBoard();
  const known = board.data?.ready ? board.data.meta.parts : undefined;
  const liveBoard = board.data?.ready ? board.data.meta.engine === 'live' : false;
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
                <OutsideLabel t={t} />
                <NoNewTestsLabel t={t} />
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
                      ...((isMine(t, me) || !me) && canPropose(t) && !t.takenOver?.free
                        ? [{ key: 'propose', label: <><PencilLine size={15} /> {shipped(t) ? 'Ask for a change…' : 'Propose a change…'}</>, onPick: () => setMenuDialog('propose') }]
                        : []),
                      ...(canWorkOutside(t, me, liveBoard) ? [{ key: 'outside', label: <><MessagesSquare size={15} /> Work in another AI tool…</>, onPick: () => setMenuDialog('outside') }] : []),
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
              {menuDialog === 'outside' && <OutsideDialog t={t} onClose={() => setMenuDialog(null)} />}
              {menuDialog === 'propose' && <ProposeChange t={t} onClose={() => setMenuDialog(null)} />}
              <Written as="h2" text={t.title} />
              <BreakdownPlace t={t} />
              <div className="sub">
                <span>
                  Created by <Written as="b" text={t.createdBy} /> {ago(t.createdAt)}
                  {' · '}
                  <TrackWords t={t} />
                </span>
                <span>
                  Owner <Written as="b" text={ownerOf(t)} />
                  {isMine(t, me) ? ' (you)' : ''}
                </span>
                {parts.length > 0 && (
                  <span>
                    {parts.length > 1 ? 'Parts' : 'Part'} <Written as="b" text={parts.join(', ')} />
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
            {/* Waiting for you: the Squad lead reads the story and says what it needs. A stop has it on its own card. */}
            {tab === 'now' && (isMine(t, me) || !me) && t.waiting && t.waiting.kind !== 'stuck' && t.waiting.kind !== 'chat' && !t.now?.merging && <AskLeadStrip t={t} />}
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

export { ProofDecision } from './drawer/Proof';
export { Notes } from './drawer/StoryTab';
