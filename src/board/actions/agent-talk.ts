import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../store.js';
import fs from 'node:fs';
import type { Ticket, AgentName, TicketNote } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { aiTool } from '../../modules/registry.js';
import { readAgent } from '../../engine/agents.js';
import { pushHandOver, type HandOverPush } from '../../engine/handover.js';
import { isMine, ownerOf, sameName } from '../owner.js';
import { actionFailed, BoardActionError, tellLater } from './errors.js';
import { refuseWhileSaving } from './save.js';

/** Answers a question the Builder or Reviewer asked mid-work. "Decide yourself" is always a way out. */
export function answerAgent(bp: BoardPaths, id: string, text: string): Ticket {
  const answer = text.trim();
  if (!answer) throw new BoardActionError('Write your answer, or pick one of the choices.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const q = t.agentQuestion;
    if (t.waiting?.kind !== 'ask' || !q) throw new BoardActionError(`${t.id} has no question waiting for you.`);
    q.answer = answer;
    t.waiting = null;
    t.live = true;
    const who = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' }[q.from];
    t.status = q.from === 'builder' ? 'Builder is carrying on with your answer' : q.from === 'architect' ? 'Architect is writing the design with your answer' : 'Reviewer is finishing with your answer';
    addActivity(t, 'you', `Answered the ${who}: ${answer}`);
    scheduleSquad(t, `answered-${q.from}`, 1, meta.speed);
  });
}

export const DECIDE_YOURSELF = 'Decide yourself: take the simplest choice that fits the plan, and say what you chose';

const NOTE_LABEL = { note: 'a note', criterion: 'an acceptance criterion', rule: 'a business rule' } as const;

/** A note, rule or acceptance criterion added at any time, or a message to one agent. Running agents get it at their next step. */
export function addNote(bp: BoardPaths, id: string, input: { text: string; kind?: TicketNote['kind']; to?: AgentName }): Ticket {
  const text = input.text?.trim();
  if (!text) throw new BoardActionError(input.to ? 'Write the message first.' : 'Write the note first.');
  const kind = input.kind && input.kind in NOTE_LABEL ? input.kind : 'note';
  const to = input.to && AGENT_LABEL[input.to] ? input.to : undefined;
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.stage === 'done') throw new BoardActionError(`${t.id} is released. Add a new ticket instead.`);
    t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind, text, ...(to ? { to } : {}) }];
    addActivity(t, 'you', to ? `Message to the ${AGENT_LABEL[to]}: ${text}` : `Added ${NOTE_LABEL[kind]}: ${text}`);
    tellLater(t, meta.engine, { kind: 'note', text: to ? `To the ${AGENT_LABEL[to]}: ${text}` : text, noteKind: kind });
  });
}

const AGENT_LABEL: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };

/**
 * Take over: the squad stops on this ticket and you work in the Builder's own AI tool session, in the ticket's
 * copy. Nothing runs until you give it back, so you and the squad never edit at the same time.
 */
export function takeOver(bp: BoardPaths, id: string): Ticket {
  refuseWhileSaving(bp, id);
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.takenOver) throw new BoardActionError(`${t.id} is already yours. Give it back when you are done.`);
    if (t.stage === 'release' || t.stage === 'done') throw new BoardActionError(`${t.id} is accepted already. Report a bug or add a new ticket instead.`);
    const demo = meta.engine !== 'live';
    const building = ['implement', 'test', 'review'].includes(t.stage);
    const session = t.sessions?.build ?? (demo && building ? 'demo-session' : undefined);
    const cwd = t.storyDir ?? t.worktree ?? (demo ? bp.root : undefined);
    if (!session && t.outside) throw new BoardActionError(`${t.id} was built outside squad-kit, so it has no Builder session to open. Use Work in another AI tool instead.`);
    if (!session || !cwd || (!demo && !fs.existsSync(cwd))) {
      throw new BoardActionError(`${t.id} has no code yet. You can take over once the Builder has started.`);
    }
    if (t.live && !demo) t.stopRequested = true;
    t.takenOver = { by: meta.user.name, at: now(), session, cwd };
    t.live = false;
    t.squad = null;
    t.waiting = { kind: 'yours', summary: 'You took it over. Give it back when you are done' };
    const tool = aiTool(readAgent(bp, 'builder').tool)?.label ?? 'the AI tool';
    t.status = `${meta.user.name} is working on it in ${tool}`;
    addActivity(t, 'you', `Took it over in ${tool}. The squad waits`);
  });
}

/** Give back: the squad picks up from your changes, and the checks, review and proof run again on them. */
export function giveBack(bp: BoardPaths, id: string, note?: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (!t.takenOver) throw new BoardActionError(`${t.id} is not taken over.`);
    if (t.takenOver.free) throw new BoardActionError(`${t.id} is in a conversation outside squad-kit. Bring it back instead: squad outside back ${t.id}`);
    const text = note?.trim();
    if (text) {
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text }];
      tellLater(t, meta.engine, { kind: 'note', text, noteKind: 'note' });
    }
    t.takenOver = undefined;
    t.stopRequested = undefined;
    t.waiting = null;
    t.stuck = undefined;
    t.agentQuestion = undefined;
    t.retryPhase = undefined;
    t.live = true;
    t.tries = 0;
    t.reviewRound = 0;
    t.reviewNotes = undefined;
    t.proof = undefined;
    t.mergedAt = undefined;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    t.stage = 'test';
    t.status = 'Running the project checks on your changes';
    addActivity(t, 'you', text ? `Gave it back: ${text}` : 'Gave it back');
    scheduleSquad(t, 'test', meta.engine === 'live' ? 0.2 : 2, meta.engine === 'live' ? 1 : meta.speed);
  });
}

/* ── Hand over ─────────────────────────────────────────── */

export interface HandOverInput {
  /** The new owner's name, as their own board shows it. */
  to: string;
  /** A note for them. Every agent on the ticket reads it too. */
  note?: string;
}

/**
 * Hand over: the ticket goes to a teammate. squad-kit saves the work so far and the ticket's documents on its branch,
 * pushes it, and names the new owner. Their squad carries on from that branch; this computer's squad stops working
 * on it. Live progress, agent chats and screenshots stay on this computer.
 */
export async function handOver(bp: BoardPaths, id: string, input: HandOverInput): Promise<Ticket> {
  refuseWhileSaving(bp, id);
  const meta = readMeta(bp);
  const to = (input.to ?? '').trim().replace(/\s+/g, ' ');
  const t = requireTicket(bp, id);
  if (!to) throw new BoardActionError('Write the name of the person who takes it over.');
  if (!isMine(t, meta)) throw new BoardActionError(`${t.id} is ${ownerOf(t)}'s. Only they can hand it over.`);
  if (sameName(to, meta.user.name)) throw new BoardActionError(`${t.id} is yours already. Pick someone else.`);
  if (t.stage === 'release' || t.stage === 'done') throw new BoardActionError(`${t.id} is accepted already. It goes out with the release.`);
  if (t.takenOver) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
  if (t.chat?.open) throw new BoardActionError(`${t.id} has a chat open. Finish the talk first.`);
  // A running step would go on writing here after the push: it finishes its step, or you stop it first.
  if (t.live || t.squad || t.stopRequested || t.questions?.some((q) => q.thinking)) {
    throw new BoardActionError(`${t.id} is working right now. Wait until it needs you, or press Stop first.`);
  }
  const at = now();
  const handedOver = { from: meta.user.name, to, at };
  const note = input.note?.trim();
  const said = note ? { at, by: meta.user.name, kind: 'note' as const, text: note } : null;
  const notes = said ? [...(t.notes ?? []), said] : t.notes;
  let pushed: HandOverPush | null = null;
  if (meta.engine === 'live') {
    try {
      pushed = await pushHandOver(bp, { ...t, owner: to, handedOver, ...(notes ? { notes } : {}) });
    } catch (err) {
      throw actionFailed(bp, t.id, `Could not hand ${t.id} over. An engineer can see why in squad-kit's log.`, err);
    }
  }
  return updateTicket(bp, id, (x) => {
    x.owner = to;
    x.handedOver = handedOver;
    // Read now: the push takes a while, and a note written meanwhile stays.
    if (said) x.notes = [...(x.notes ?? []), said];
    if (pushed) {
      x.branch = pushed.branch;
      x.baseCommit = x.baseCommit ?? pushed.baseCommit;
      if (pushed.hookOwed) x.hookOwed = true;
    }
    x.live = false;
    x.squad = null;
    x.waiting = null;
    x.stuck = undefined;
    x.retryPhase = undefined;
    x.agentQuestion = undefined;
    x.quiet = undefined;
    x.status = `With ${to}`;
    addActivity(x, 'you', `Handed it over to ${to}${note ? `: ${note}` : ''}`);
    if (pushed) {
      addActivity(x, 'squad', `Saved the work so far and the documents on ${pushed.branch} (commit ${pushed.commit}) and pushed it to ${pushed.remote}${pushed.carried.length ? ', with the project settings, rules and knowledge, since the base has none yet' : ''}`);
    }
    tellLater(x, meta.engine, { kind: 'note', text: `Handed over to ${to} by ${meta.user.name}.`, noteKind: 'note' });
  });
}

/** "Change something" on a spec or plan, or "Something's wrong" on the proof. */
export function requestChange(bp: BoardPaths, id: string, text: string): Ticket {
  refuseWhileSaving(bp, id);
  const note = text.trim();
  if (!note) throw new BoardActionError('Say in one line what should change.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const kind = t.waiting?.kind;
    if (kind !== 'spec' && kind !== 'plan' && kind !== 'proof') throw new BoardActionError(`${t.id} has no spec, plan or proof waiting for you.`);
    t.changeRequest = note;
    t.waiting = null;
    t.live = true;
    addActivity(t, 'you', `Asked for a change: ${note}`);
    if (kind === 'spec') {
      t.status = 'Analyst is updating the spec';
      scheduleSquad(t, 'spec-rewrite', 2, meta.speed);
    } else if (kind === 'plan') {
      t.status = t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan';
      scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
    } else {
      t.stage = 'implement';
      t.status = 'Builder is fixing what you found';
      t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      scheduleSquad(t, 'fix', 2, meta.speed);
    }
  });
}
