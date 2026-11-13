import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { listDecisions, now, readTicket } from '../../board/store.js';
import { CHAT_SESSION, shipped } from '../../board/actions.js';
import type { Ticket } from '../../board/types.js';
import * as P from '../prompts.js';
import { isMediaNote, prepareMedia } from '../media.js';
import { allowedFile, ticketFolders } from '../conversations.js';
import { workFolder } from '../copies.js';
import { LimitReached, chatWaitNote, type LimitPause } from '../usage-limit.js';
import { proofPages, squadWorks, waitsAtReview, whereItStands } from '../../board/at-review.js';
import { reviewLook } from '../review-look.js';
import { WORDS_STEP_MS } from './limits.js';
import { attachmentDirs, projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** Talk it through: an agent's answer in a ticket's chat. */
export const chatPart = {
  /**
   * One reply in a talk with the person, in the agent's own session (a new one for the Analyst when you talk first).
   * Beside the work the agent talks in a side session of its own, so the session that works is never touched.
   * The agent only talks and reads; it never moves the ticket on.
   */
  async chatReply(this: LiveSquad, id: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const c = t.chat!;
    const beside = Boolean(c.beside);
    const key = CHAT_SESSION[c.with];
    const had = beside ? c.side : t.sessions?.[key];
    const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
    const cwd = later && t.worktree && fs.existsSync(t.worktree) ? workFolder(t)! : projectRoot(this.bp);
    const session = had ?? randomUUID();
    if (!had) {
      this.update(id, (x) => {
        if (!beside) x.sessions = { ...x.sessions, [key]: session };
        else if (x.chat) x.chat.side = session;
      });
    }
    // A line saying the answer waited for the usage limit is squad-kit's, not part of the talk.
    const said = c.messages.filter((m) => m.note !== 'waits');
    const last = said[said.length - 1];
    const message = last?.who === 'you' ? last.text : null;
    let attached = '';
    if (message !== null && last?.files?.length) {
      // Voice and video notes are written out first; the agent reads the text and the pictures.
      const heard = await prepareMedia(this.bp, last.files);
      const files = [...last.files.filter((f) => !isMediaNote(f)), ...heard.added];
      attached = `The person attached: ${files.join(', ')}${heard.missingKey ? ' (voice notes could not be written out: no speech to text key)' : ''}`;
    }
    const done = shipped(t);
    // Waiting for your check at review: questions only, with what the agent needs to say where to look.
    const review = beside && !done && waitsAtReview(t) ? (t.waiting?.kind === 'proof' ? 'proof' : 'stuck') : undefined;
    // Ask a question on a ticket the squad is not working on: it stays where it is, and the agent says so plainly.
    const stands = beside && !done && !review && !squadWorks(t) ? whereItStands(t) : undefined;
    // Where to look, in every state: once the ticket has a copy of the code or pages in its proof.
    const look = beside && (review || (t.worktree && fs.existsSync(t.worktree)) || proofPages(t).length) ? await reviewLook(this.bp, t) : undefined;
    const next = beside ? P.besideNext(done, review, stands) : P.chatNext(c.with, Boolean(t.story), Boolean(t.specApproved));
    const talk = P.chatPrompt(c.with, message, next, attached, beside);
    const step = { analyst: 'questions', architect: 'design', builder: 'build', reviewer: 'review', tester: 'proof' }[c.with];
    // A side conversation starts fresh each time the chat opens, with what was said before in it.
    const earlier = beside ? said.slice(0, message === null ? undefined : -1).slice(-8) : [];
    const opening = beside
      ? `${P.besidePrompt(this.meta(), listDecisions(this.bp), t, c.with, done, this.ctx(t), look)}${P.earlierTalk(earlier)}`
      : P.intakePrompt(this.meta(), listDecisions(this.bp), t, this.ctx(t));
    try {
      const r = await this.runAgent({
        role: c.with,
        step,
        levelStep: 'chat',
        ticket: id,
        job: `__chat:${id}`,
        cwd,
        ...(had ? { resume: had } : { sessionId: session }),
        // Each answer hears whether the copy runs now: the person may have pressed Try it yourself since the opening.
        prompt: had ? (look ? `${P.copyNow(look)}\n\n${talk}` : talk) : `${opening}\n\n${talk}`,
        permissions: ['read'],
        schema: P.CHAT_SCHEMA,
        timeoutMs: WORDS_STEP_MS,
        // Beside the work, the Analyst and the Architect may read the code built so far to answer.
        addDirs: [...attachmentDirs(t), ...(beside && t.worktree && cwd !== workFolder(t) && fs.existsSync(t.worktree) ? [workFolder(t)!] : [])],
        // Its reply so far, for the board to show as it is written.
        onDraft: (a) => {
          const reply = typeof a.reply === 'string' ? a.reply.trim() : '';
          if (!reply || readTicket(this.bp, id)?.chat?.draft === reply) return;
          this.update(id, (x) => {
            if (x.chat?.thinking) x.chat.draft = reply;
          });
        },
      });
      const out = (r.structured ?? {}) as { reply?: string; ready?: boolean; options?: string[]; files?: string[] };
      const options = (out.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
      // Only files the board can show: inside the ticket's own folders.
      const shown = (out.files ?? []).map((f) => allowedFile(String(f).replace(/^file:\/\//, ''), ticketFolders(t, this.bp))).filter((f): f is string => Boolean(f));
      this.update(id, (x) => {
        if (!x.chat) return;
        x.chat.messages.push({
          who: c.with,
          text: (out.reply ?? r.text ?? '').trim() || '(no answer)',
          at: now(),
          ...(options.length ? { options } : {}),
          ...(shown.length ? { files: [...new Set(shown)].slice(0, 8) } : {}),
        });
        x.chat.ready = !beside && Boolean(out.ready);
        x.chat.thinking = false;
        delete x.chat.draft;
      });
    } catch (err) {
      const after = readTicket(this.bp, id);
      if (after?.chat?.stopping) return this.chatStopped(id);
      if (err instanceof LimitReached && after) return this.chatWaits(after, err.pause);
      this.update(id, (x) => {
        if (!x.chat) return;
        x.chat.messages.push({ who: 'squad', text: this.couldNotAnswer(err, id, 'Could not answer this time. Press Try again.'), at: now(), note: 'failed' });
        x.chat.thinking = false;
        delete x.chat.draft;
      });
    }
  },

  /** The chat's answer waits for the usage limit to reset; the chat says until when. */
  chatWaits(this: LiveSquad, t: Ticket, pause: LimitPause): void {
    if (!t.chat || !chatWaitNote(t.chat, pause)) return;
    this.update(t.id, (x) => {
      const n = x.chat && chatWaitNote(x.chat, pause);
      if (!n || !x.chat) return;
      if (n.replace) x.chat.messages[x.chat.messages.length - 1] = n.message;
      else x.chat.messages.push(n.message);
      x.chat.thinking = true;
    });
  },

  /** You pressed Stop on an answer: the talk stays open, with a way on. */
  chatStopped(this: LiveSquad, id: string): void {
    this.update(id, (x) => {
      const c = x.chat;
      if (!c) return;
      if (c.thinking && c.open) c.messages.push({ who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' });
      c.thinking = false;
      delete c.draft;
      c.stopping = undefined;
    });
  },
};
