import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { AgentName, ChatSummary, Ticket } from '../../api/types';
import { INITIALS, unreadOf, useChats } from '../../lib/chats';
import { useBoard } from '../../lib/data';
import { agentFor, decideKind } from '../../lib/decide';
import { useLead } from '../../lib/leadData';
import { isOpen, popups, type PopState } from '../../lib/popups';
import { REDUCED } from '../../lib/reveal';
import { AGENT_TITLE } from '../Chat';
import { LeadMark } from '../LeadMark';

/** Story heads shown at once; the rest are one press away on the Conversations page. */
const MAX_HEADS = 6;

/** The lead's head first, then one per open talk or open popup, newest first. */
export function Heads({ s }: { s: PopState }) {
  const talks0 = useChats();
  const chats = talks0.data ?? [];
  const chatsReady = talks0.isSuccess;
  const board = useBoard();
  const lead = useLead(5000).data;
  const tickets = board.data?.ready ? board.data.tickets : [];
  // The talks still open, newest first, and the stories whose popup is open without a talk.
  const talks = chats.filter((c) => c.open).sort((a, b) => b.at.localeCompare(a.at));
  const ids = [...new Set([...s.open.filter((p) => p.id !== 'lead').map((p) => p.id), ...talks.map((c) => c.id)])];
  const needs = (lead?.needsYou ?? []).filter((n) => n.kind !== 'slow').length;
  // What was seen of stories that are gone is forgotten, once the board and the talks are both in.
  const known = board.data?.ready && chatsReady ? [...tickets, ...(board.data.archived ?? [])].map((t) => t.id).concat(chats.map((c) => c.id)).join(' ') : '';
  useEffect(() => {
    if (known) popups.prune(new Set(known.split(' ')));
  }, [known]);
  const answering = lead?.conversations.some((c) => c.thinking) ?? false;
  return (
    <div className="heads" aria-label="Chats">
      <Head
        id="lead"
        cls="lead"
        on={isOpen(s, 'lead')}
        badge={needs}
        live={answering}
        tip="Squad lead"
        small={needs ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you` : 'Ask anything'}
        nudge={needs}
      >
        <LeadMark size={30} />
      </Head>
      {ids.slice(0, MAX_HEADS).map((id, i) => (
        <StoryHead key={id} id={id} i={i} s={s} t={tickets.find((t) => t.id === id)} talk={chats.find((c) => c.id === id)} />
      ))}
      {ids.length > MAX_HEADS && (
        <Link to="/conversations" className="head more" title="Every conversation">
          <span className="face">+{ids.length - MAX_HEADS}</span>
        </Link>
      )}
    </div>
  );
}

function StoryHead({ id, i, s, t, talk }: { id: string; i: number; s: PopState; t?: Ticket; talk?: ChatSummary }) {
  const role: AgentName = talk?.with ?? (t ? agentFor(t) : 'analyst');
  const open = isOpen(s, id);
  const unread = talk ? unreadOf(talk, s.seen) : 0;
  // A decision waits that the person has not looked at in this popup yet.
  const waits = t && decideKind(t) && t.waitKey && s.looked[id] !== t.waitKey ? 1 : 0;
  const small = talk?.thinking ? 'Writing…' : t?.waiting ? t.waiting.summary : talk?.yourTurn ? 'Your turn' : 'Talking it through';
  return (
    <Head id={id} cls={`av-${role}`} on={open} badge={open ? 0 : unread + waits} live={Boolean(talk?.thinking)} tip={`${AGENT_TITLE[role]} ${id}`} small={small} nudge={(talk?.count ?? 0) + (t?.waitKey ? 1 : 0)} nudgeKey={t?.waitKey} delay={120 + i * 90} sid={id}>
      <span className="face">{INITIALS[role]}</span>
    </Head>
  );
}

/**
 * One head. It nudges when its talk gets a new message or a new decision while its popup is closed. `nudge` grows
 * with each new message; `nudgeKey` changes with a new decision.
 */
function Head({ id, cls, on, badge, live, tip, small, nudge, nudgeKey, delay, sid, children }: { id: string; cls: string; on: boolean; badge: number; live: boolean; tip: string; small: string; nudge: number; nudgeKey?: string; delay?: number; sid?: string; children: ReactNode }) {
  const [ping, setPing] = useState(false);
  const before = useRef({ nudge, nudgeKey });
  useEffect(() => {
    const was = before.current;
    before.current = { nudge, nudgeKey };
    const grew = nudge > was.nudge || (nudgeKey !== undefined && nudgeKey !== was.nudgeKey);
    if (on || !grew) return;
    if (window.matchMedia?.(REDUCED).matches) return;
    setPing(true);
    const timer = setTimeout(() => setPing(false), 750);
    return () => clearTimeout(timer);
  }, [nudge, nudgeKey, on]);
  return (
    <button
      className={`head ${cls} ${on ? 'on' : ''} ${ping ? 'ping' : ''}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      onClick={() => popups.toggle(id)}
      aria-label={`${tip}${badge ? `, ${badge} new` : ''}${on ? ', open' : ''}`}
      aria-pressed={on}
    >
      {children}
      {sid && <span className="sid">{sid}</span>}
      {badge > 0 && <span className="n">{badge}</span>}
      {live && <span className="live" aria-hidden="true" />}
      <span className="tip" role="tooltip">
        {tip}
        <small>{small}</small>
      </span>
    </button>
  );
}
