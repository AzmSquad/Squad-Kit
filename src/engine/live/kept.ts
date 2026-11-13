import fs from 'node:fs';
import path from 'node:path';
import { addActivity, listTickets, readTicket, updateTicket } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { RunningApp } from '../checks.js';
import { appIn, untilEnded } from '../copy-turn.js';
import { workFolder } from '../copies.js';
import { productCopiesDir, stopProduct } from '../product-run.js';
import { productHold } from '../product-lock.js';
import { treeOf } from '../lane.js';
import {
  copyWords,
  folderOf,
  projectCopies,
  runsEnded,
  stopLeftovers,
  stoppedLines,
  ticketCopies,
  type Leftover,
  type LookOptions,
} from '../leftovers.js';
import { KEPT_APP_MS } from './limits.js';
import type { LiveSquad } from './squad.js';

/** True when something answers at the address: any answer, even an error page, is the app running. */
async function answersAt(url: string): Promise<boolean> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
}

/** What runs in squad-kit's copies: clearing it after a step, and the app kept from the review into the proof. */
export const keptPart = {
  /* ── what squad-kit's copies leave running ──────────── */

  /**
   * Copies to leave alone while sweeping: those of steps running now (other than `except`), the copy the before
   * screenshots or the setup work in, and a ticket the person took over.
   */
  busyCopies(this: LiveSquad, except?: string, runs = true): string[] {
    const tickets = listTickets(this.bp);
    const out: string[] = tickets.filter((t) => t.takenOver).flatMap((t) => [t.takenOver!.cwd, ...ticketCopies(this.bp, t)]).filter(Boolean);
    for (const k of runs ? this.running : []) {
      if (k === '__setup') out.push(...projectCopies(this.bp).map((r) => path.join(r, 'setup-copy')));
      if (k.startsWith('__before:')) {
        const t = tickets.find((x) => x.id === k.slice(9));
        if (t) out.push(...ticketCopies(this.bp, t).filter((d) => d !== workFolder(t)));
      }
      const t = !k.startsWith('__') && k !== except ? tickets.find((x) => x.id === k) : undefined;
      if (t) out.push(...ticketCopies(this.bp, t));
    }
    // The running product is someone's, while they hold it.
    if (productHold(this.bp)) out.push(productCopiesDir(this.bp));
    return out;
  },

  /**
   * Stops what squad-kit's copies `dirs` have left running, and says so in one plain line each: on ticket `forId`
   * when it is for that ticket's next step, else on the ticket whose copy it was in.
   */
  async clearCopies(this: LiveSquad, dirs: string[], opts: LookOptions & { graceMs?: number; only?: number[] }, forId?: string): Promise<Leftover[]> {
    const found = await stopLeftovers(dirs, opts);
    if (!found.length) return found;
    const tickets = listTickets(this.bp);
    const ids = tickets.map((t) => t.id);
    this.log('info', `Stopped ${found.length} program${found.length === 1 ? '' : 's'} left running in squad-kit's copies: ${found.map((p) => `${p.pid} ${p.command.slice(0, 80)} in ${p.cwd}`).join('; ')}`, forId);
    const say = (id: string, list: Leftover[]) => {
      const t = tickets.find((x) => x.id === id);
      const lines = stoppedLines(list, (cwd) => copyWords(this.bp, cwd, t, ids));
      try {
        if (lines.length) updateTicket(this.bp, id, (x) => lines.forEach((l) => addActivity(x, 'squad', l)));
      } catch {
        // The ticket was removed meanwhile.
      }
    };
    if (forId) say(forId, found);
    else for (const t of tickets) {
      const mine = found.filter((p) => folderOf(p.cwd, ticketCopies(this.bp, t)));
      if (mine.length) say(t.id, mine);
    }
    return found;
  },

  /** A step ended: once its runs have ended, what they left running in the ticket's copy stops. */
  async clearAfterStep(this: LiveSquad, id: string): Promise<void> {
    if (this.closing) return;
    const t = readTicket(this.bp, id);
    if (!t?.worktree || t.takenOver || !fs.existsSync(t.worktree)) return;
    stopProduct(this.bp, id);
    // An app kept for the proof is one of squad-kit's runs in the copy: waiting for it would only take the whole time.
    await runsEnded([workFolder(t)!], this.kept.has(id) ? 0 : 6000);
    await this.clearCopies([workFolder(t)!], {}, id);
  },

  /**
   * Before the checks, and before squad-kit starts the app for the Tester: nothing left running in the ticket's copy,
   * and no port held by a server another of squad-kit's copies of this project left behind.
   */
  async clearBeforeApp(this: LiveSquad, id: string): Promise<void> {
    const t = readTicket(this.bp, id);
    if (!t?.worktree) return;
    await this.clearCopies([workFolder(t)!], {}, id);
    await this.clearCopies(projectCopies(this.bp), { busy: [workFolder(t)!, ...this.busyCopies(id)], listening: true }, id);
  },

  /* ── one app for the review and the proof ────────────── */

  /**
   * A window hands on the app squad-kit started in `cwd`, for the next step of this ticket that uses it (kept): the
   * review's for the proof, a round of pictures' for the next round. `tree` is the code it started from, when known.
   */
  keepApp(this: LiveSquad, id: string, cwd: string, app: RunningApp, tree?: string): boolean {
    if (this.closing) return false;
    const old = this.kept.get(id);
    old?.leave();
    if (old && old.app !== app) old.app.stop();
    // On its copy's list (copy-turn.ts): a run of the checks there stops it first, with a line in the log only.
    const leave = appIn(cwd, async () => {
      if (this.kept.get(id)?.app !== app) return false;
      this.log('info', `squad-kit stops the app it kept at ${app.url}, so the checks in its copy can start their own`, id);
      await this.dropKept(id);
      return true;
    });
    this.kept.set(id, { app, cwd, ...(tree ? { tree } : {}), at: Date.now(), leave });
    this.log('info', `squad-kit keeps the app at ${app.url} running for the next step that uses it`, id);
    return true;
  },

  /**
   * The app kept for this ticket, handed to the caller from now on: only while it runs from `cwd`, still answers at its
   * address, and the copy's code is the code it started from. Otherwise it stops, and null: the caller starts a new one.
   */
  async keptFor(this: LiveSquad, id: string, cwd: string): Promise<{ app: RunningApp; tree: string } | null> {
    const k = this.kept.get(id);
    if (!k) return null;
    const real = (dir: string) => {
      try {
        return fs.realpathSync.native(dir);
      } catch {
        return path.resolve(dir);
      }
    };
    let why = '';
    if (!k.tree) why = 'it was not kept for this step';
    else if (real(k.cwd) !== real(cwd)) why = 'it runs from another copy';
    else if (k.app.ended?.()) why = 'it stopped';
    else if (!(await answersAt(k.app.url))) why = 'it does not answer any more';
    else if ((await treeOf(cwd)) !== k.tree) why = "the copy's code changed since it started";
    // Stopped meanwhile (the story's Stop): nothing is left to hand over.
    if (this.kept.get(id) !== k) return null;
    if (why) {
      this.log('info', `squad-kit starts the app again: the one it kept ${why}`, id);
      await this.dropKept(id);
      return null;
    }
    this.kept.delete(id);
    k.leave();
    return { app: k.app, tree: k.tree! };
  },

  /** The app kept for this ticket stops, and squad-kit waits until it has gone, so a new start never meets it. */
  async dropKept(this: LiveSquad, id: string): Promise<void> {
    const k = this.kept.get(id);
    if (!k) return;
    this.kept.delete(id);
    k.leave();
    k.app.stop();
    this.log('info', `squad-kit stopped the app it kept at ${k.app.url}`, id);
    await untilEnded(k.app);
  },

  /**
   * The review is over: its app waits for the proof when the review approved and the proof is next, with the code it
   * runs. Any other way out (back to the Builder, a question, a stop) stops it, as before.
   */
  async afterReview(this: LiveSquad, id: string): Promise<void> {
    const k = this.kept.get(id);
    if (!k) return;
    const t = readTicket(this.bp, id);
    const next = Boolean(t && t.gates?.review === 'pass' && t.squad?.phase === 'proof' && !t.stopRequested && !this.stops.get(id)?.signal.aborted);
    const tree = next && !k.app.ended?.() ? await treeOf(k.cwd) : undefined;
    if (this.kept.get(id) !== k) return;
    if (!tree) return this.dropKept(id);
    k.tree = tree;
    k.at = Date.now();
  },

  /** At each turn: a kept app no step is going to use stops. Its story stopped, went or moved on, or it waited too long. */
  sweepKept(this: LiveSquad): void {
    for (const [id, k] of this.kept) {
      let t: Ticket | null = null;
      try {
        t = readTicket(this.bp, id);
      } catch {
        // Unreadable: no step is going to use its app.
      }
      const runs = this.running.has(id);
      const ahead = Boolean(t && !t.deleting && !t.stopRequested && (runs || t.squad?.phase === 'proof'));
      if (!ahead || k.app.ended?.() || (!runs && Date.now() - k.at > KEPT_APP_MS)) void this.dropKept(id);
    }
  },
};
