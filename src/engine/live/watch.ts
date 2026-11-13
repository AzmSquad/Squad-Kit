import fs from 'node:fs';
import path from 'node:path';
import { addActivity, now, readMeta, readTicket, updateTicket } from '../../board/store.js';
import { scheduleSquad } from '../../board/schedule.js';
import { fixRoundStopped } from '../contribution/actions.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { DOING } from '../plain-doing.js';
import type { CopyHow } from '../git.js';
import * as P from '../prompts.js';
import { repoFor, rulesFiles } from '../repos.js';
import { computerBusy, processTable, type Quiet } from '../watchdog.js';
import { copiesOf } from '../copies.js';
import { guardSupport, ticketGuard, type GuardSpec } from '../project-guard.js';
import { HEALED_LINE } from '../cache-home.js';
import { fetchPushed } from '../handover.js';
import { slowStep } from '../../board/clock.js';
import { readUsual } from '../../board/usual.js';
import { slowActivity } from '../../board/now.js';
import { watchPort } from '../free-port.js';
import { markInterrupted } from '../interrupt.js';
import { moreTimeByItself } from '../lead/by-itself.js';
import { OUTSIDE_WAITS } from '../../board/outside-step.js';
import { PICK_UP_MS } from './limits.js';
import { attachmentDirs, projectRoot, STOPPED } from './shared.js';
import type { LiveSquad } from './squad.js';

/** Watching the running steps, and reading and changing a ticket's record. */
export const watchPart = {
  /**
   * Every 15 seconds: is any running step quiet? Then say so on the ticket, with what it waits on, so nothing hangs
   * without the person knowing.
   */
  watch(this: LiveSquad): void {
    if (Date.now() - this.lastWatch < 15_000) return;
    this.lastWatch = Date.now();
    const slept = this.dog.resumed();
    const keys = [...this.running].filter((k) => !k.startsWith('__'));
    if (!keys.length) return;
    if (slept) {
      // The steps were not quiet: the computer was asleep. Look again at the next turn.
      const m = Math.max(1, Math.round(slept / 60_000));
      for (const id of keys) {
        try {
          this.update(id, (x) => {
            addActivity(x, 'squad', `Resumed after sleep: the computer slept for about ${m} minute${m === 1 ? '' : 's'}`);
            delete x.quiet;
          });
        } catch {
          // The ticket was removed meanwhile.
        }
      }
      return;
    }
    const rows = processTable();
    const usual = readUsual(this.bp);
    // A busy computer makes every step slower: the card says so, from this look.
    const busy = computerBusy();
    for (const id of keys) {
      const t = readTicket(this.bp, id);
      if (!t) continue;
      const snoozed = t.quietSnoozedUntil && Date.parse(t.quietSnoozedUntil) > Date.now();
      // Quiet, or past twice its usual time: either way the person sees a card with what it is doing.
      const q = snoozed ? null : (this.dog.check(id, Date.now(), rows) ?? slowStep(t, usual));
      this.setQuiet(id, q?.kind === 'long' && busy ? { ...q, busy } : q);
      // A step that needs the app may wait on a busy port: the card says what holds it (src/engine/free-port.ts).
      watchPort(this.bp, id);
    }
  },

  /** Now and then, beside the squad's work: fetch, and bring in the tickets teammates pushed. */
  pickUp(this: LiveSquad): void {
    if (this.pickingUp || Date.now() - this.lastPickUp < PICK_UP_MS) return;
    this.pickingUp = true;
    this.lastPickUp = Date.now();
    fetchPushed(this.bp)
      .catch(() => undefined)
      .finally(() => (this.pickingUp = false));
  },

  setQuiet(this: LiveSquad, id: string, q: Quiet | null): void {
    try {
      const t = readTicket(this.bp, id);
      if (!t || (!q && !t.quiet)) return;
      if (q && t.quiet && q.kind === t.quiet.kind && q.detail === t.quiet.detail && Boolean(q.busy) === Boolean(t.quiet.busy)) return;
      this.update(id, (x) => {
        if (q && x.quiet?.kind !== q.kind) addActivity(x, 'squad', q.kind === 'stuck' ? `Looks stuck: ${q.detail}` : slowActivity(x, q));
        // What the last look found on the app's port stays until the next look.
        if (q) x.quiet = { ...q, ...(x.quiet?.port && q.kind === x.quiet.kind ? { port: x.quiet.port } : {}) };
        else delete x.quiet;
      });
      // Slower than usual but still working, with "Always allow" on for more time: squad-kit gives it, and says so.
      if (q?.kind === 'long' && t.quiet?.kind !== 'long') moreTimeByItself(this.bp, id);
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /**
   * A ticket being deleted: its step, chat answer, change and before shots stop. Once none of them runs (and no
   * tracker update is on its way), the ticket says so, for a delete started in another window.
   */
  letGo(this: LiveSquad, t: Ticket): void {
    const keys = [t.id, `__chat:${t.id}`, `__change:${t.id}`, `__before:${t.id}`];
    for (const k of keys) this.stops.get(k)?.abort();
    if (t.deleting?.stopped || keys.some((k) => this.running.has(k)) || this.syncing.has(t.id)) return;
    try {
      updateTicket(this.bp, t.id, (x) => {
        if (x.deleting) x.deleting.stopped = now();
      });
    } catch {
      // Deleted meanwhile.
    }
  },

  /** The person pressed Stop: park the ticket with a way to pick it up again. */
  stopped(this: LiveSquad, id: string, phase?: string): void {
    const held = readTicket(this.bp, id);
    // It went in before the Stop could land: nothing is left to stop, and a card would run a step again on merged work.
    if (held?.mergedAt) {
      this.update(id, (t) => {
        t.stopRequested = undefined;
        t.retryOnStop = undefined;
      });
      return;
    }
    // Taken over, or talking it through: the person has the ticket now, so no stuck card, just quiet.
    if (held?.takenOver || (held?.chat?.open && !held.chat.beside)) {
      this.update(id, (t) => {
        t.stopRequested = undefined;
        t.retryOnStop = undefined;
        t.live = false;
        t.squad = null;
        addActivity(t, 'squad', 'Stopped the running step for you');
      });
      return;
    }
    // "Stop and try again": the step that ran starts again at once, with the work so far.
    if (held?.retryOnStop) {
      this.update(id, (t) => {
        t.stopRequested = undefined;
        t.retryOnStop = undefined;
        delete t.quiet;
        delete t.clock;
        t.live = true;
        t.status = 'Trying the step again';
        addActivity(t, 'squad', 'Stopped the step and started it again, with the work so far');
        scheduleSquad(t, phase ?? t.squad?.phase ?? t.retryPhase ?? 'analyst-read', 0.2, 1);
      });
      return;
    }
    // The step that ran, else the one that was next (a Stop between steps, or while it waited for a free place): Carry
    // on runs that one, never the Analyst from the start.
    let at = phase ?? held?.squad?.phase ?? held?.retryPhase ?? 'analyst-read';
    // A step that ran was cut off, not failed: Carry on goes on with it from where it was.
    if (phase) this.update(id, (t) => (at = markInterrupted(t, phase, 'stop')));
    this.fail(id, 'You stopped the squad. Nothing was lost; the work so far is kept.', at);
    this.update(id, (t) => {
      t.stopRequested = undefined;
      if (t.stuck) t.stuck.options[0] = { name: 'Carry on', note: 'Run the stopped step again.' };
      // A fix of the owner's notes that stopped: the pull request is watched again, and the notes wait for you again.
      fixRoundStopped(t);
    });
  },

  healed(this: LiveSquad, id: string, detail: string): void {
    this.log('info', detail, id);
    try {
      this.update(id, (x) => addActivity(x, 'squad', HEALED_LINE));
    } catch {
      // The ticket was removed while it ran.
    }
  },

  /**
   * squad-kit's own guard for a project command run in a copy (engine/project-guard.ts): its tests, setup and app
   * cannot read the person's keys, squad-kit's own folder or the project's .env outside the copy. Null where this
   * computer has no guard (Windows): the command runs as before, and Settings says "less protected".
   */
  guardFor(this: LiveSquad, cwd: string, id: string): GuardSpec | undefined {
    if (!guardSupport().on) return undefined;
    const allow = this.meta().guard;
    return ticketGuard(this.bp, { cwd, id, ...(allow ? { allow } : {}) });
  },

  /**
   * How a step makes a first copy of the code, which takes as long as the project's size: the card says so, the ticket's
   * Stop ends it, and the watchdog hears that it works, as nothing else shows progress meanwhile.
   */
  async makingCopy<T>(this: LiveSquad, id: string, make: (how: CopyHow) => Promise<T>): Promise<T> {
    const said = readTicket(this.bp, id)?.status;
    const signal = this.stops.get(id)?.signal;
    const beat = setInterval(() => this.dog.beat(id), 30_000);
    try {
      return await make({ ...(signal ? { signal } : {}), making: () => this.update(id, (x) => (x.status = DOING.copy)) });
    } finally {
      clearInterval(beat);
      if (said !== undefined && readTicket(this.bp, id)?.status === DOING.copy) this.update(id, (x) => (x.status = said));
    }
  },

  /** Between the parts of a step: once the person pressed Stop, nothing new starts. */
  goOn(this: LiveSquad, id: string): void {
    if (this.stops.get(id)?.signal.aborted) throw new Error(STOPPED);
  },

  meta(this: LiveSquad): BoardMeta {
    return readMeta(this.bp);
  },

  ctx(this: LiveSquad, t?: Ticket): P.PromptContext {
    const meta = this.meta();
    const copies = t?.storyDir ? copiesOf(meta, t) : [];
    return {
      rules: this.ruleCopies().files,
      ...(t ? { repo: this.appOf(t)?.repo ?? repoFor(meta, t) } : {}),
      ...(copies.length ? { copies: copies.map((c) => ({ folder: c.repo.path, name: c.label, commands: c.repo.commands, ...(c.baseCommit ? { baseCommit: c.baseCommit } : {}) })) } : {}),
    };
  },

  /** Roles working in a worktree still need to read the project's rule files: they get copies, never the person's own checkout. */
  extraDirs(this: LiveSquad, t: Ticket): string[] {
    const rules = this.ruleCopies();
    return [...attachmentDirs(t), ...(rules.files.length ? [rules.dir] : [])];
  },

  /** The project's rule files, copied into this computer's folder for the project, where an agent may read them freely. */
  ruleCopies(this: LiveSquad): { dir: string; files: string[] } {
    const root = projectRoot(this.bp);
    const dir = path.join(this.bp.localDir, 'rules-read');
    const files = rulesFiles(root).map((from) => {
      const to = path.join(dir, path.relative(root, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return to;
    });
    return { dir, files };
  },

  update(this: LiveSquad, id: string, change: (t: Ticket) => void): Ticket {
    return updateTicket(this.bp, id, (t) => {
      change(t);
      // A step that ends after you took the ticket over must not move it on: it stays yours until you give it back.
      if (t.takenOver) {
        t.waiting = t.takenOver.free ? { kind: 'yours', summary: OUTSIDE_WAITS } : { kind: 'yours', summary: 'You took it over. Give it back when you are done' };
        t.squad = null;
        t.live = false;
      }
      // The same while you talk through a ticket that waited for you: nothing moves until you press a button. A chat
      // beside the work changes nothing: the step goes on.
      else if (t.chat?.open && !t.chat.beside) {
        t.waiting = { kind: 'chat', summary: t.waiting?.kind === 'chat' ? t.waiting.summary : 'Talking it through' };
        t.squad = null;
        t.live = false;
      }
    });
  },
};
