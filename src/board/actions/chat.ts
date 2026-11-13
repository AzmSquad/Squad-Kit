import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../store.js';
import type { Ticket, AgentChat, AgentName } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { askAgent, squadWorks, waitsAtReview, whereItStands } from '../at-review.js';
import { bigText } from '../split.js';
import { BoardActionError } from './errors.js';
import { saveTicketUploads, type UploadedFile } from './new-ticket.js';
import { refuseWhileSaving } from './save.js';
import { shipped } from './change.js';
import { planSnapshot } from './plan-edits.js';

/* ── Talk it through with an agent ────────────────────── */

export const AGENT_TITLE: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };

/** The session each agent talks in: its own AI tool conversation on the ticket. */
export const CHAT_SESSION: Record<AgentName, 'intake' | 'build' | 'review' | 'tester'> = {
  analyst: 'intake',
  architect: 'intake',
  builder: 'build',
  reviewer: 'review',
  tester: 'tester',
};

export function openChat(t: Ticket, agent: AgentName, before: AgentChat['before']): void {
  const keep = t.chat?.with === agent ? t.chat.messages : [];
  t.chat = { with: agent, open: true, messages: keep, thinking: true, before };
  t.waiting = { kind: 'chat', summary: `Talking it through with the ${AGENT_TITLE[agent]}` };
  t.live = false;
  t.squad = null;
  t.status = `Talking with the ${AGENT_TITLE[agent]}`;
}

/**
 * Talk it through: open a chat with any agent on the ticket. Asking never stops the work: while the squad works on the
 * ticket, the chat runs beside it and changes nothing; a change goes through the spec instead (proposeChange). A
 * ticket that waits for you stays with you while you talk, so the two of you never pull it in different directions.
 * An accepted or released ticket answers questions only, and so does one that waits for your check at review: it
 * stays waiting for Looks right, and Something's wrong is the way to ask for a change. The agent opens with where it
 * is and what it is unsure of. `ask` is Ask a question: questions only in every state, taken over too, and the ticket
 * stays exactly where it is (askQuestion).
 */
export function startChat(bp: BoardPaths, id: string, agent: AgentName, opts: { ask?: boolean } = {}): Ticket {
  if (!opts.ask) refuseWhileSaving(bp, id);
  const meta = readMeta(bp);
  if (!AGENT_TITLE[agent]) throw new BoardActionError('Pick an agent: analyst, architect, builder, reviewer or tester.');
  return updateTicket(bp, id, (t) => {
    if (t.chat?.open) throw new BoardActionError(`${t.id} already has a chat open with the ${AGENT_TITLE[t.chat.with]}.`);
    if (t.takenOver && !opts.ask) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
    const later = agent === 'builder' || agent === 'reviewer' || agent === 'tester';
    if (later && meta.engine === 'live' && !t.sessions?.[CHAT_SESSION[agent]]) {
      throw new BoardActionError(`The ${AGENT_TITLE[agent]} has not worked on ${t.id} yet, so there is nothing to talk through with it.`);
    }
    const done = shipped(t);
    const review = !done && waitsAtReview(t);
    if (opts.ask || done || review || t.live || t.squad) {
      // Beside the work. Talking to the same agent again keeps the earlier messages; the agent starts a fresh side
      // conversation that reads them, so what it knows about the ticket is never out of date.
      const again = t.chat?.with === agent && t.chat.beside ? t.chat : undefined;
      t.chat = { with: agent, open: true, messages: again?.messages ?? [], thinking: true, before: { waiting: t.waiting }, beside: true };
      const line = opts.ask
        ? `Questions only: ${whereItStands(t)}`
        : done
          ? 'Questions only: the accepted work stays as it is'
          : review
            ? 'Questions only: it still waits for your check'
            : 'The work goes on';
      addActivity(t, 'you', `Started ${opts.ask ? 'asking' : 'talking with'} the ${AGENT_TITLE[agent]}. ${line}`);
      return;
    }
    openChat(t, agent, { waiting: t.waiting });
    addActivity(t, 'you', `Started talking it through with the ${AGENT_TITLE[agent]}`);
  });
}

/**
 * Ask a question, in every state: a questions-only chat with whoever knows the story best (askAgent), or the agent
 * named. The ticket stays exactly where it was: the same stage, wait, queue place and work, and a running squad goes
 * on. With a chat open already, that chat is the one to ask in, so nothing changes.
 */
export function askQuestion(bp: BoardPaths, id: string, agent?: AgentName): Ticket {
  const t = requireTicket(bp, id);
  if (t.chat?.open) return t;
  return startChat(bp, t.id, agent ?? askAgent(t, readMeta(bp).engine === 'live'), { ask: true });
}

/** Your message in the chat, with screenshots, files or voice notes if you add them. */
export function sendChat(bp: BoardPaths, id: string, text: string, uploads: UploadedFile[] = []): Ticket {
  const msg = text?.trim() ?? '';
  if (!msg && !uploads.length) throw new BoardActionError('Write your message first.');
  const t0 = requireTicket(bp, id);
  if (!t0.chat?.open) throw new BoardActionError(`${t0.id} has no chat open.`);
  if (t0.chat.thinking) throw new BoardActionError(`The ${AGENT_TITLE[t0.chat.with]} is still answering. Wait a moment.`);
  const files = saveTicketUploads(bp, t0.id, uploads);
  return updateTicket(bp, id, (t) => {
    const c = t.chat!;
    // A text that looks like several stories, or a whole document, gets a hint under it: a talk beside the work changes nothing.
    const big = c.beside ? bigText(msg) : undefined;
    c.messages.push({ who: 'you', text: msg, at: now(), ...(files.length ? { files } : {}), ...(big ? { big } : {}) });
    if (files.length) t.attachments = [...(t.attachments ?? []), ...files];
    c.thinking = true;
    c.stopping = undefined;
  });
}

/**
 * Write (or update) the spec or the design from the talk. The chat closes, and the new version comes to you as
 * usual, with what changed. Reopen the chat from there to keep talking.
 */
export function chatWrite(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    if (c.beside) {
      throw new BoardActionError(
        shipped(t)
          ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}, so this chat answers questions only. For a change, make a new linked ticket or report a bug.`
          : waitsAtReview(t)
            ? `${t.id} waits for your check, so this chat answers questions only. ${t.waiting?.kind === 'proof' ? "To ask for a change, press Something's wrong and say what." : 'To go on, pick one of the ways out on its card.'}`
            : squadWorks(t)
              ? 'The squad is working on this ticket, so this talk is for questions. To change the spec, propose a change: the Analyst writes it and you approve it.'
              : `${whereItStands(t)}. This chat answers questions only: to change something, use the ticket's own buttons.`,
      );
    }
    if (c.with === 'architect' ? !t.specApproved : c.with !== 'analyst') {
      throw new BoardActionError(c.with === 'architect' ? 'The Architect writes the design once the spec is approved.' : `The ${AGENT_TITLE[c.with]} does not write the spec or design.`);
    }
    const design = c.with === 'architect';
    if (design ? t.steps : t.story) t.planReview = { before: planSnapshot(t), sent: [] };
    c.open = false;
    t.waiting = null;
    t.live = true;
    t.stage = 'specs';
    t.status = design ? (t.steps ? 'Architect is updating the design from your talk' : 'Architect is writing the design from your talk') : t.story ? 'Analyst is updating the spec from your talk' : 'Analyst is writing the spec from your talk';
    addActivity(t, 'you', `Asked the ${AGENT_TITLE[c.with]} to ${(design ? t.steps : t.story) ? 'update' : 'write'} the ${design ? 'design' : 'spec'} from your talk`);
    scheduleSquad(t, design ? 'chat-design' : 'chat-spec', meta.engine === 'live' ? 0.2 : 2, meta.engine === 'live' ? 1 : meta.speed);
  });
}

/**
 * Done talking. The Builder, Reviewer and Tester carry on from what you agreed (the talk is in their session). The
 * Analyst and Architect leave the ticket where it was; to change the spec or design, use chatWrite instead.
 */
export function chatDone(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking && !c.beside) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    c.open = false;
    // Beside the work nothing was paused, so nothing goes back: the ticket is wherever the squad took it. An answer
    // still being written is stopped.
    if (c.beside) {
      if (c.thinking) c.stopping = true;
      addActivity(t, 'you', `Done talking with the ${AGENT_TITLE[c.with]}`);
      return;
    }
    t.stopRequested = undefined;
    addActivity(t, 'you', `Done talking with the ${AGENT_TITLE[c.with]}`);
    const live = meta.engine === 'live';
    const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
    if (later && c.messages.some((m) => m.who === 'you')) {
      t.waiting = null;
      t.live = true;
      t.status = `${AGENT_TITLE[c.with]} is carrying on with what you agreed`;
      scheduleSquad(t, `chat-carry-${c.with}`, live ? 0.2 : 2, live ? 1 : meta.speed);
      return;
    }
    t.waiting = c.before.waiting;
    if (c.before.phase) {
      t.live = true;
      t.status = 'Carrying on';
      scheduleSquad(t, c.before.phase, live ? 0.2 : 2, live ? 1 : meta.speed);
    } else {
      t.live = false;
      t.status = c.before.waiting ? c.before.waiting.summary : t.status;
    }
  });
}

/* ── Stop and try again on a chat answer ─────────────── */

/** Stop the answer the agent is writing. The talk stays open; what was said so far is kept. */
export function chatStop(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open || !c.thinking) throw new BoardActionError(`${t.id} has no answer being written.`);
    c.stopping = true;
  });
}

/** Ask the last question again, after a stop or an answer that failed. */
export function chatRetry(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    while (c.messages.at(-1)?.who === 'squad') c.messages.pop();
    c.thinking = true;
    c.stopping = undefined;
  });
}
