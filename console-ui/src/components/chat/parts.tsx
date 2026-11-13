import { Code, Compass, Eye, MessageCircle, Search, SquareCheck, type LucideIcon } from 'lucide-react';
import type { AgentName, Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { popups } from '../../lib/popups';
import type { Item as AcpItem } from '../../lib/conversation';
import { shipped } from '../ChangeCard';
import { STAGE_NAME } from '../ui';
import { squadWorks, waitsAtReview } from '../../lib/review';

export const AGENT_TITLE: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };
export const SESSION: Record<AgentName, 'intake' | 'build' | 'review' | 'tester'> = { analyst: 'intake', architect: 'intake', builder: 'build', reviewer: 'review', tester: 'tester' };
const ICON: Record<AgentName, LucideIcon> = { analyst: Search, architect: Compass, builder: Code, reviewer: Eye, tester: SquareCheck };

/** Who is working on a ticket right now, from the step it is on. */
const PHASE_ROLE: Record<string, AgentName> = {
  'analyst-read': 'analyst',
  triage: 'analyst',
  'spec-rewrite': 'analyst',
  'chat-spec': 'analyst',
  'plan-write': 'architect',
  'plan-rewrite': 'architect',
  'answered-architect': 'architect',
  'chat-design': 'architect',
  build: 'builder',
  unstick: 'builder',
  fix: 'builder',
  test: 'builder',
  'review-fix': 'builder',
  'restore-tests': 'builder',
  'update-base': 'builder',
  'proof-fix': 'builder',
  'answered-builder': 'builder',
  'chat-carry-builder': 'builder',
  review: 'reviewer',
  'answered-reviewer': 'reviewer',
  'chat-carry-reviewer': 'reviewer',
  proof: 'tester',
  'chat-carry-tester': 'tester',
};

/** `pop`: in a chat popup over any page, whose own head line says who it is. */
export type ChatSize = 'panel' | 'full' | 'phone' | 'pop';
export type Tool = Extract<AcpItem, { kind: 'tool' }>;

/** An agent's mark in its own color; it breathes while the agent works. */
export function Avatar({ role, small, live }: { role: AgentName; small?: boolean; live?: boolean }) {
  const Icon = ICON[role] ?? Search;
  return (
    <span className={`cav av-${role} ${small ? 'sm' : ''} ${live ? 'live' : ''}`} aria-hidden="true">
      <Icon size={small ? 13 : 16} strokeWidth={2} />
    </span>
  );
}

/** Open a talk with one agent from anywhere. It opens in its popup, over the page. */
export function TalkButton({ t, agent, label, primary, small }: { t: Ticket; agent: AgentName; label?: string; primary?: boolean; small?: boolean }) {
  const act = useAct();
  return (
    <button
      className={`btn ${primary ? 'pri' : ''} ${small ? 'sm' : ''}`}
      disabled={act.isPending}
      onClick={() =>
        act.mutate(
          { path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: agent } },
          { onSuccess: () => popups.open(t.id) },
        )
      }
    >
      <MessageCircle size={14} /> {label ?? `Talk to the ${AGENT_TITLE[agent]}`}
    </button>
  );
}

/** The agent working on the ticket now, if any. */
export function workingRole(t: Ticket): AgentName | null {
  return t.live && t.squad?.phase ? (PHASE_ROLE[t.squad.phase] ?? null) : null;
}

/** "Specs · your turn", "Implement · working", "Released · v0.3.0". */
export function stageLine(t: Ticket): { text: string; tone: 'you' | 'work' | 'done' } {
  if (t.stage === 'done') return { text: `Released${t.release ? ` · ${t.release}` : ''}`, tone: 'done' };
  if (t.stage === 'release') return { text: `Accepted${t.release ? ` · ready for ${t.release}` : ''}`, tone: 'done' };
  const stage = STAGE_NAME[t.stage];
  if (t.chat?.open && !t.chat.beside) return { text: `${stage} · ${t.chat.thinking ? 'talking' : 'your turn'}`, tone: 'you' };
  if (t.waiting) return { text: `${stage} · your turn`, tone: 'you' };
  return { text: `${stage}${t.live ? ' · working' : ''}`, tone: t.live ? 'work' : 'you' };
}

/**
 * What the talk may do, in the words the header uses. A chat beside the work (Ask a question in any state, or a talk
 * while the squad works, at your check or on accepted work) answers questions only and changes nothing: asking never
 * stops the work, and the ticket stays where it is. `still` is a ticket the squad is not working on right now.
 */
export function talkKind(t: Ticket): { kind: 'talk' | 'working' | 'review' | 'released' | 'still'; note: string } {
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  if (!c.beside) return { kind: 'talk', note: `The ${who} waits while you talk` };
  if (shipped(t)) return { kind: 'released', note: 'Questions only' };
  if (waitsAtReview(t)) return { kind: 'review', note: 'Questions only' };
  return { kind: squadWorks(t) ? 'working' : 'still', note: 'Questions only' };
}

/** The button that ends the talk the way it was meant to end. */
export function primaryOf(t: Ticket): { label: string; path: string; done: string } | null {
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  if (c.beside) return null;
  if (c.with === 'analyst') return { label: `${t.story ? 'Update' : 'Write'} the spec`, path: 'write', done: `The Analyst is ${t.story ? 'updating' : 'writing'} the spec from your talk.` };
  if (c.with === 'architect' && t.specApproved) return { label: `${t.steps ? 'Update' : 'Write'} the design`, path: 'write', done: `The Architect is ${t.steps ? 'updating' : 'writing'} the design from your talk.` };
  if (c.with === 'architect') return null;
  return { label: 'Back to work', path: 'done', done: `The ${who} carries on as you agreed.` };
}
