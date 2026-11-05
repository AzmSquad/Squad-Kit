import type { AgentName, ProofShot, Ticket } from '../api/types';

/**
 * Your check at review, the same rules as the engine's (src/board/at-review.ts): the proof is ready, or a gate
 * stopped the ticket. Asking then is for questions only, and the person can try the ticket's own copy of the app.
 * Ask a question works the same in every state: who answers, and the line that says where the story stands.
 */

export function waitsAtReview(t: Pick<Ticket, 'waiting' | 'stage' | 'stuck'>): boolean {
  const kind = t.waiting?.kind;
  if (kind === 'proof') return true;
  if (kind !== 'stuck') return false;
  const gate = t.stuck?.gate;
  return gate === 'checks' || gate === 'review' || gate === 'proof' || gate === 'merge' || t.stage === 'test' || t.stage === 'review';
}

/** A page in the app as the proof names it: "/test/sign-up", never a host. Empty when it names none. */
export function pageOf(shot: Pick<ProofShot, 'page'>): string {
  const p = shot.page?.trim() ?? '';
  if (!p) return '';
  const bare = p.replace(/^[a-z]+:\/\/[^/]+/i, '');
  return bare.startsWith('/') ? bare : `/${bare}`;
}

/** The pages a row's pictures name, each once, the main picture's first. */
export function pagesOf(shot: Pick<ProofShot, 'page' | 'more'>): string[] {
  return [...new Set([shot, ...(shot.more ?? [])].map(pageOf).filter(Boolean))];
}

/** Where to look: each page the proof names, once, in the order of the "done when" list. */
export function proofPages(t: Pick<Ticket, 'proof'>): string[] {
  return [...new Set((t.proof ?? []).flatMap(pagesOf))];
}

/* ── Ask a question, in every state ───────────────────── */

/** The fields Ask a question reads. */
export type AskTicket = Pick<
  Ticket,
  'id' | 'stage' | 'status' | 'waiting' | 'stuck' | 'live' | 'squad' | 'takenOver' | 'agentQuestion' | 'dependsOn' | 'dependency' | 'release' | 'sessions' | 'proof'
>;

/** The conversation each agent Ask a question goes to answers from. */
const ASK_SESSION = { analyst: 'intake', builder: 'build', tester: 'tester' } as const;

/** The stages from the build on: the Builder knows the story best from here. */
const BUILT = new Set<Ticket['stage']>(['implement', 'test', 'review', 'release', 'done']);

/** A card waiting for a free place says this first (src/board/now.ts, QUEUED). */
const QUEUED = 'Next in line';

/**
 * Who answers Ask a question: whoever knows the story best at that point. The Analyst before the build, the Builder
 * during and after it, the Tester once there are screenshots. With the live engine an agent answers from its own
 * conversation on the ticket, so one that has none yet leaves it to the Analyst.
 */
export function askAgent(t: Pick<Ticket, 'stage' | 'sessions' | 'proof'>, live = true): AgentName {
  const pick = t.proof?.length ? 'tester' : t.sessions?.build || BUILT.has(t.stage) ? 'builder' : 'analyst';
  if (pick === 'analyst' || !live || t.sessions?.[ASK_SESSION[pick]]) return pick;
  return 'analyst';
}

/** The ticket waits for a free place in the queue. */
export function inQueue(t: Pick<Ticket, 'status' | 'waiting'>): boolean {
  return !t.waiting && (t.status ?? '').startsWith(QUEUED);
}

/** The squad works on the ticket right now: a step runs or comes next, and nothing waits for the person or a place. */
export function squadWorks(t: Pick<Ticket, 'live' | 'squad' | 'waiting' | 'takenOver' | 'status'>): boolean {
  return Boolean(t.live || t.squad) && !t.waiting && !t.takenOver && !inQueue(t);
}

const WHO: Record<'architect' | 'builder' | 'reviewer', string> = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' };

const WORKING: Record<Ticket['stage'], string> = {
  tickets: 'is being read',
  specs: 'is being planned',
  implement: 'is being built',
  test: 'is being checked',
  review: 'is being reviewed',
  release: 'is accepted',
  bugs: 'is being looked into',
  done: 'is released',
};

/**
 * One plain line of where the story stands, for a questions-only chat: "MA-16 waits for your check", "RO-7 waits in
 * the queue". The chat changes none of it.
 */
export function whereItStands(t: AskTicket): string {
  const id = t.id;
  if (t.stage === 'done') return `${id} is released${t.release ? ` in ${t.release}` : ''}`;
  if (t.stage === 'release') return `${id} is accepted${t.release ? ` and goes out in ${t.release}` : ''}`;
  if (t.takenOver) return `You have ${id}, and the squad waits until you give it back`;
  const deps = (t.dependsOn?.length ? t.dependsOn : t.dependency?.on ?? []).join(', ');
  switch (t.waiting?.kind) {
    case 'proof':
      return `${id} waits for your check`;
    case 'stuck':
      return waitsAtReview(t) ? `${id} stopped at a check and waits for your decision` : `${id} stopped and waits for your decision`;
    case 'ask':
      return `${id} waits for your answer to the ${t.agentQuestion ? WHO[t.agentQuestion.from] : 'squad'}'s question`;
    case 'depends':
      return `${id} waits for ${deps || 'another story'} to be merged`;
    case 'questions':
      return `${id} waits for your answers to the questions`;
    case 'spec':
      return `${id}'s spec waits for your approval`;
    case 'plan':
      return `${id}'s design waits for your approval`;
    case 'change':
      return `${id} waits for you to decide on the design update`;
    case 'release':
      return `${id} waits for you to release it`;
    case 'chat':
      return `${id} waits while you talk it through`;
    case 'yours':
      return `You have ${id}, and the squad waits until you give it back`;
  }
  if (t.dependency?.way === 'wait' && !t.dependency.started && !t.squad) return `${id} waits for ${deps || 'another story'} to be merged`;
  if (inQueue(t)) return `${id} waits in the queue`;
  if (t.live || t.squad) return `${id} ${WORKING[t.stage]}`;
  return t.stage === 'tickets' || t.stage === 'bugs' ? `${id} has not started yet` : `${id} is not running right now`;
}
