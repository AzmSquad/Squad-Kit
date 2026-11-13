import { questionWords, scheduleSquad } from '../schedule.js';
import {
  addActivity,
  listDecisions,
  nextDecisionId,
  now,
  readMeta,
  requireTicket,
  updateTicket,
  writeDecision,
  queueImpactCheck,
  type BoardPaths,
} from '../store.js';
import type { Ticket } from '../types.js';
import { holdForDependency, refuseBeforeDependency } from '../depends.js';
import { BoardActionError, tellLater } from './errors.js';
import { acceptProof } from './accept.js';
import { approveChange, openChange } from './change.js';

export interface AnswerInput {
  choice: string;
  value?: string;
}

export function answerQuestions(bp: BoardPaths, id: string, answers: Record<string, AnswerInput>): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'questions' || !t.questions) {
      throw new BoardActionError(`${t.id} has no open questions.`);
    }
    for (const q of t.questions) {
      const a = answers[q.id] ?? (q.answer ? q.answer : undefined);
      if (!a || !a.choice) throw new BoardActionError(`Question "${q.text}" still needs an answer.`);
      if (!q.options.includes(a.choice) && a.choice !== 'Other') {
        throw new BoardActionError(`"${a.choice}" is not a choice for "${q.text}".`);
      }
      q.answer = { choice: a.choice, ...(a.value ? { value: a.value.trim() } : {}) };
    }
    t.waiting = null;
    t.live = true;
    t.status = 'Architect is choosing the design';
    addActivity(t, 'you', `Answered ${questionWords(t.questions.length)}`);
    scheduleSquad(t, 'plan-write', 2, meta.speed);
    tellLater(t, meta.engine, { kind: 'answered' });
  });
}

/** "Skip, let the squad guess": the squad takes its own first choice and marks it as a guess. */
export function skipQuestions(bp: BoardPaths, id: string): Ticket {
  const ticket = requireTicket(bp, id);
  const answers: Record<string, AnswerInput> = {};
  for (const q of ticket.questions ?? []) answers[q.id] = q.answer ?? { choice: q.options[0]!, value: undefined };
  updateTicket(bp, id, (t) => {
    for (const q of t.questions ?? []) {
      if (!q.answer) q.thread = [...(q.thread ?? []), { who: 'squad', text: `Guessed "${q.options[0]}". You can change it in the plan.`, at: now() }];
    }
  });
  return answerQuestions(bp, id, answers);
}

export function askAbout(bp: BoardPaths, id: string, questionId: string, text: string): Ticket {
  const ask = text.trim();
  if (!ask) throw new BoardActionError('Write what you want to ask.');
  return updateTicket(bp, id, (t) => {
    const q = t.questions?.find((x) => x.id === questionId);
    if (!q) throw new BoardActionError(`${t.id} has no question ${questionId}.`);
    q.thread = [...(q.thread ?? []), { who: 'you', text: ask, at: now() }];
    q.thinking = true;
  });
}

/** Approves whatever the ticket is waiting on: the plan or the proof. */
export function approve(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const ticket = requireTicket(bp, id);
  const kind = ticket.waiting?.kind;
  if (kind === 'spec') return approveSpec(bp, ticket, meta.speed);
  if (kind === 'plan') return approvePlan(bp, ticket, meta.speed);
  if (kind === 'proof') {
    // The proof does not show a change that is still open, so it cannot be accepted yet.
    const c = openChange(ticket);
    if (c) throw new BoardActionError(`Change ${c.id} is still open. ${c.status === 'proposed' || c.status === 'failed' ? 'Approve or decline it first.' : 'The squad builds it first, then the proof comes again.'}`);
    refuseBeforeDependency(bp, ticket);
    return acceptProof(bp, ticket);
  }
  if (kind === 'change') return approveChange(bp, ticket.id);
  if (kind === 'questions') throw new BoardActionError(`${ticket.id} needs answers first.`);
  if (kind === 'stuck') throw new BoardActionError(`${ticket.id} needs a decision first.`);
  throw new BoardActionError(`${ticket.id} is not waiting for an approval right now.`);
}

/** Express and Builds by itself: the plan is approved on its own. You still see it; nothing waits for you. */
export function approveExpress(bp: BoardPaths, id: string): Ticket {
  const ticket = requireTicket(bp, id);
  if (ticket.track !== 'express' && ticket.track !== 'auto') throw new BoardActionError(`${ticket.id} is on the Full track.`);
  return approvePlan(bp, { ...ticket, waiting: { kind: 'plan', summary: '' } }, readMeta(bp).speed, ticket.track);
}

/** True when the Full track still needs the spec approved before the Architect designs. */
export function needsSpec(t: Ticket): boolean {
  return t.track !== 'express' && !t.specApproved;
}

/** Full track: you approve the what. Then the Architect designs the how from it, and you approve that too. */
function approveSpec(bp: BoardPaths, ticket: Ticket, speed: number): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, ticket.id, (t) => {
    t.specApproved = { by: meta.user.name, at: now() };
    t.planReview = undefined;
    t.waiting = null;
    t.stage = 'specs';
    t.live = true;
    t.status = 'Architect is choosing the design';
    addActivity(t, 'you', 'Approved the spec');
    scheduleSquad(t, 'plan-write', 2, speed, 0);
    tellLater(t, meta.engine, { kind: 'note', text: `Spec approved by ${meta.user.name}: ${t.story ?? ''}`, noteKind: 'note' });
  });
}

/** `self`: the track that approves the plan on its own (Express, Builds by itself); otherwise the person approves it. */
function approvePlan(bp: BoardPaths, ticket: Ticket, speed: number, self?: 'express' | 'auto'): Ticket {
  const meta = readMeta(bp);
  const adr = saveDesignDecision(bp, ticket, self ? `${meta.user.name} (${self === 'auto' ? 'Builds by itself' : 'Express track'})` : meta.user.name);
  return updateTicket(bp, ticket.id, (t) => {
    t.planReview = undefined;
    // Written and brought back from a conversation outside: the design is the first thing the person approved here.
    if (t.outside && !t.specApproved) t.specApproved = { by: meta.user.name, at: now() };
    if (t.decision && adr) t.decision.adr = adr;
    t.waiting = null;
    t.stage = 'implement';
    t.live = true;
    t.progress = 0;
    t.status = `Step 1 of ${t.steps?.length ?? 1} with ${t.builder ?? 'the Builder'}`;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    const approved =
      self === 'auto' ? 'Builds by itself: approved the plan on its own' : self ? 'Express track: approved the plan on its own' : t.specApproved ? 'Approved the design' : 'Approved the plan';
    addActivity(t, self ? 'squad' : 'you', adr ? `${approved}. Decision saved as ${adr}${t.decision?.replaces ? `, replacing ${t.decision.replaces}` : ''}` : approved);
    scheduleSquad(t, 'build', 2, speed, 0);
    // A ticket it depends on is not merged yet: the build waits for the person's choice (board/depends.ts).
    holdForDependency(bp, t);
    tellLater(t, meta.engine, { kind: 'planned' });
  });
}

/** An approved design's decision goes in the project's decisions, once. Returns its id when it is new. */
export function saveDesignDecision(bp: BoardPaths, ticket: Ticket, approvedBy: string): string | undefined {
  let adr: string | undefined;
  if (ticket.decision && !ticket.decision.adr) {
    adr = nextDecisionId(bp, ticket.id);
    const chosen = ticket.decision.options.find((o) => o.chosen) ?? ticket.decision.options[0];
    writeDecision(bp, {
      id: adr,
      title: ticket.decision.title,
      why: ticket.decision.why,
      options: ticket.decision.options.map((o) => o.name),
      chosen: chosen?.name ?? '',
      from: ticket.id,
      approvedBy,
      date: now(),
      checkedBy: { kind: 'test', name: testNameFor(ticket), passing: false },
      tickets: [ticket.id],
      ...(ticket.decision.area ? { area: ticket.decision.area } : {}),
      ...(ticket.follows?.length ? { buildsOn: ticket.follows } : {}),
      ...(ticket.decision.replaces ? { replaces: ticket.decision.replaces } : {}),
    });
  }
  linkDecisions(bp, ticket, adr);
  if (adr) queueImpactCheck(bp, adr);
  return adr;
}

/** Each decision the design followed lists the ticket; the one a new decision replaces stops being a rule. */
function linkDecisions(bp: BoardPaths, ticket: Ticket, adr: string | undefined): void {
  const all = listDecisions(bp);
  for (const id of ticket.follows ?? []) {
    const d = all.find((x) => x.id === id);
    if (d && !d.tickets.includes(ticket.id)) writeDecision(bp, { ...d, tickets: [...d.tickets, ticket.id] });
  }
  const old = adr && ticket.decision?.replaces ? all.find((x) => x.id === ticket.decision!.replaces) : undefined;
  if (old && adr && old.id !== adr) {
    const fresh = listDecisions(bp).find((x) => x.id === old.id) ?? old;
    writeDecision(bp, { ...fresh, replacedBy: adr, tickets: fresh.tickets.includes(ticket.id) ? fresh.tickets : [...fresh.tickets, ticket.id] });
  }
}

function testNameFor(ticket: Ticket): string {
  return `${ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.spec.ts`;
}
