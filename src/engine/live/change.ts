import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions, readTicket } from '../../board/store.js';
import { changeParts, changeWork, openChange, type ChangeAnswer } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { ChangeStep, SpecChange, Ticket } from '../../board/types.js';
import * as P from '../prompts.js';
import { workFolder } from '../copies.js';
import { LimitReached } from '../usage-limit.js';
import { StepError } from '../../board/problem.js';
import { carriesOn, carryOnLine, carryOnPrompt } from '../interrupt.js';
import { WORDS_STEP_MS } from './limits.js';
import { attachmentDirs, projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** A change to an approved spec: written, designed and built. */
export const changePart = {
  /**
   * The Analyst writes a proposed change into the spec, beside the work, in a conversation of its own: the old and new
   * words of each part it touches, and whether it is small or big. The old words come from the ticket itself.
   */
  async writeChange(this: LiveSquad, id: string): Promise<void> {
    const t = readTicket(this.bp, id);
    const c = t ? openChange(t) : undefined;
    if (!t || !c || c.status !== 'writing') return;
    const set = (change: (x: Ticket, y: SpecChange) => void) =>
      this.update(id, (x) => {
        const y = x.changes?.find((z) => z.id === c.id);
        if (y?.status === 'writing') change(x, y);
      });
    try {
      const chat = c.from && t.chat?.with === c.from ? t.chat.messages.slice(-6) : [];
      const r = await this.runAgent({
        role: 'analyst',
        step: 'spec',
        ticket: id,
        job: `__change:${id}`,
        cwd: projectRoot(this.bp),
        sessionId: randomUUID(),
        prompt: P.changePrompt(this.meta(), listDecisions(this.bp), t, c, chat, this.ctx(t)),
        permissions: ['read'],
        schema: P.CHANGE_SCHEMA,
        timeoutMs: WORDS_STEP_MS,
        addDirs: attachmentDirs(t),
      });
      const out = r.structured as ChangeAnswer;
      set((x, y) => {
        const parts = changeParts(x, out);
        if (!parts.length) {
          y.status = 'failed';
          y.error = `The Analyst found nothing in the spec to change. It said: ${out.summary}`;
          addActivity(x, 'analyst', `Found nothing in the spec to change for ${y.id}`);
          return;
        }
        y.status = 'proposed';
        y.size = out.size === 'big' ? 'big' : 'small';
        y.summary = out.summary.trim();
        y.why = out.why.trim();
        y.parts = parts;
        delete y.error;
        addActivity(x, 'analyst', `Wrote change ${y.id} into the spec (${y.size}): ${y.summary}`);
      });
    } catch (err) {
      // Closing the board is not a failure: the Analyst writes it again when the board opens. Nor is the usage limit.
      if (this.closing || err instanceof LimitReached) return;
      set((x, y) => {
        y.status = 'failed';
        y.error = (err as Error).message;
        addActivity(x, 'analyst', `Could not write change ${y.id}: ${y.error}`);
      });
    }
  },

  /**
   * A big change: the Builder's step has ended, so it pauses here while the Architect updates the design. The update
   * waits for you; on approval the Builder redoes only the steps it touches.
   */
  async changeDesign(this: LiveSquad, id: string): Promise<void> {
    const t0 = this.update(id, (x) => {
      const c = openChange(x)!;
      if (x.squad && x.squad.phase !== 'change-design') {
        c.paused = { phase: x.squad.phase };
        if (c.status === 'approved') addActivity(x, 'builder', `Paused after its step for change ${c.id}`);
      }
      c.status = 'designing';
      x.live = true;
      x.status = `Architect is updating the design for change ${c.id}`;
    });
    const c = openChange(t0)!;
    const root = projectRoot(this.bp);
    // The Architect goes on in its own conversation when it has one; it reads the code built so far.
    const had = t0.sessions?.intake;
    const r = await this.runAgent({
      role: 'architect',
      step: 'design',
      ticket: id,
      cwd: root,
      ...(had ? { resume: had } : { sessionId: randomUUID() }),
      prompt: P.changeDesignPrompt(t0, c, had ? undefined : { meta: this.meta(), decisions: listDecisions(this.bp), ctx: this.ctx(t0) }),
      permissions: ['read'],
      schema: P.CHANGE_DESIGN_SCHEMA,
      timeoutMs: WORDS_STEP_MS,
      addDirs: this.extraDirs(t0).concat(t0.worktree && fs.existsSync(t0.worktree) ? [workFolder(t0)!] : []),
      onTool: this.watcher(id, 'architect', root),
    });
    const out = r.structured as { summary: string; steps: { title: string; change: ChangeStep['change'] }[] };
    const steps: ChangeStep[] = (out.steps ?? [])
      .filter((s) => s.title?.trim())
      .map((s) => ({ title: s.title.trim(), change: s.change === 'same' || s.change === 'new' ? s.change : 'changed' }));
    if (!steps.length) throw new StepError('The Architect wrote no steps for the design update.');
    this.update(id, (x) => {
      const y = openChange(x);
      if (!y) return;
      y.design = { summary: (out.summary ?? '').trim(), before: (x.steps ?? []).map((s) => s.title), steps };
      y.status = 'design-ready';
      x.live = false;
      x.squad = null;
      x.status = 'Design update ready for you';
      x.waiting = { kind: 'change', summary: `The design update for change ${y.id} is ready: is this how to build it?` };
      addActivity(x, 'architect', `Updated the design for change ${y.id}: ${y.design.summary}`);
    });
  },

  /** The Builder makes an approved change: a small one as a step of its own, a big one by redoing only what it touches. */
  async changeBuild(this: LiveSquad, id: string): Promise<void> {
    await this.workspace(id);
    const c = openChange(readTicket(this.bp, id)!);
    if (c?.size === 'big' && c.status === 'building') {
      const t = this.update(id, (x) => {
        x.stage = 'implement';
        x.live = true;
        x.tries = 0;
        x.reviewRound = 0;
      });
      const redo = (t.steps ?? []).filter((s) => s.status !== 'done').length;
      // Cut off by a restart, a Stop or sleep: the redo carries on where it was, in the same conversation.
      const handed = t.activity.some((a) => a.who === 'builder' && a.text.startsWith('Started redoing') && a.text.endsWith(`for change ${c.id}`));
      const cut = handed ? carriesOn(t, 'change-build') : undefined;
      this.update(id, (x) => addActivity(x, 'builder', cut ? carryOnLine(x, cut.by) : `Started redoing ${redo} ${redo === 1 ? 'step' : 'steps'} for change ${c.id}`));
      await this.runBuilder(id, cut ? carryOnPrompt(t, cut.by) : P.changeRedoPrompt(c, t.steps ?? []), true, 'build');
      this.update(id, (x) => {
        for (const s of x.steps ?? []) {
          s.status = 'done';
          s.live = undefined;
        }
        const y = openChange(x);
        if (y?.id === c.id) y.status = 'done';
        x.progress = 100;
        addActivity(x, 'builder', `Redid the steps for change ${c.id}`);
      });
    } else if (c && changeWork(readTicket(this.bp, id)!) === 'build') {
      this.update(id, (x) => {
        x.stage = 'implement';
        x.live = true;
        x.status = `Builder is making change ${c.id}`;
      });
      await this.runBuilder(id, '', true, 'build');
    }
    // The code changed, so every gate runs again.
    this.update(id, (x) => {
      x.stage = 'test';
      x.status = 'Running the project checks';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
