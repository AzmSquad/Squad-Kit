import fs from 'node:fs';
import path from 'node:path';
import { addActivity, boardExists, listTickets, now, readMeta, readTicket } from '../../board/store.js';
import { pullRequestClashed } from '../../board/actions.js';
import type { Ticket } from '../../board/types.js';
import { clearHalfCopies, cutOffWords, git, repairCopyLink, settleCopy } from '../git.js';
import { repoFor, reposOf } from '../repos.js';
import { recheckMerge } from '../sync.js';
import { rewireStoryDbs, tidyStoryDbs } from '../story-db.js';
import { fetchBase } from '../handover.js';
import { pauseClock, resumeClock } from '../../board/clock.js';
import type { ToolBlock } from '../tools/index.js';
import { picturesHold } from '../phone/plan.js';
import { isSaveTrouble, noteSaveTrouble, stillHeld, endTurnTrouble, noteTurnTrouble } from '../save-trouble.js';
import { resumeSetup } from '../onboard.js';
import { resumeCutRelease } from '../../board/release-tidy.js';
import { projectCopies } from '../leftovers.js';
import { markInterrupted } from '../interrupt.js';
import { afterPullRequest } from '../../board/auto.js';
import { TURNS_BEFORE_BANNER } from './limits.js';
import { BLIP_WAITS_MIN, held, type PassingTrouble, projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** Waiting: for a free place, a tool, a passing problem or the computer's sleep, and carrying on after a restart or trouble. */
export const waitsPart = {
  /** The project's folder moved: an open ticket's copy gets its link to the repo back, so its work stays in reach. */
  mendCopy(this: LiveSquad, t: Ticket): boolean {
    if (!t.worktree || t.stage === 'done' || !fs.existsSync(t.worktree)) return false;
    for (const c of t.copies ?? []) {
      if (!fs.existsSync(c.dir)) continue;
      if (git(c.dir, ['rev-parse', '--git-dir'], { allowFail: true })) settleCopy(c.dir);
      else repairCopyLink(path.join(projectRoot(this.bp), c.repo), c.dir);
    }
    const repo = path.join(projectRoot(this.bp), repoFor(readMeta(this.bp), t).path);
    if (git(t.worktree, ['rev-parse', '--git-dir'], { allowFail: true })) {
      const onDisk = settleCopy(t.worktree);
      if (onDisk) this.update(t.id, (x) => addActivity(x, 'squad', cutOffWords(onDisk)));
      return false;
    }
    const mended = repairCopyLink(repo, t.worktree);
    this.log(mended ? 'info' : 'warn', mended ? `The project's folder moved; reconnected the copy at ${t.worktree}` : `The copy at ${t.worktree} has lost its link to the repo, and git could not repair it`, t.id);
    if (mended) this.update(t.id, (x) => addActivity(x, 'squad', "The project's folder moved, so squad-kit reconnected this ticket's copy of the code"));
    return mended;
  },

  /** A step that was running when the console stopped is picked up again right away. */
  resumeAfterRestart(this: LiveSquad): void {
    try {
      if (!boardExists(this.bp) || readMeta(this.bp).engine !== 'live') return;
      // A release cut off half-way is finished or undone, never left half-done (board/release-tidy.ts).
      void resumeCutRelease(this.bp).then((r) => r && this.log('warn', `Settled ${r.version}, which a restart cut off: ${r.status === 'released' ? 'finished' : 'undone'}`));
      resumeSetup(this.bp);
      for (const t of listTickets(this.bp)) {
        this.mendCopy(t);
        if (t.squad && Date.parse(t.squad.nextAt) > Date.now()) {
          // A board that ended without closing (a crash, a kill) kept no record that it cut the step off.
          const cut = !t.interrupted && Date.parse(t.squad.nextAt) - Date.now() > 10 * 60_000;
          this.update(t.id, (x) => {
            if (cut && x.squad) x.squad.phase = markInterrupted(x, x.squad.phase, 'restart');
            if (x.squad) x.squad.nextAt = now();
            // The step carries on with its time so far, and says once that it resumed after a restart.
            resumeClock(x);
          });
        }
      }
      // What the last board's runs left running in squad-kit's copies stops before any step carries on.
      this.swept = this.clearCopies(projectCopies(this.bp), { busy: this.busyCopies() }).catch(() => undefined);
      // Stories with a database of their own point at it again before any step runs; the databases of stories that are
      // merged, released or deleted go, beside everything else.
      rewireStoryDbs(this.bp);
      void tidyStoryDbs(this.bp).catch(() => undefined);
      // Half a copy a crash left goes, beside everything else: nothing works in one, so nothing waits for this.
      for (const repo of reposOf(readMeta(this.bp))) void clearHalfCopies(path.join(projectRoot(this.bp), repo.path)).catch(() => undefined);
    } catch {
      // Unreadable board; the tick will report it.
    }
  },

  /** One turn. Whatever it finds wrong stays inside this project: nothing above a timer would catch it. */
  safeTick(this: LiveSquad): void {
    try {
      this.tick();
      this.turnsFailed = 0;
      endTurnTrouble(this.bp);
    } catch (err) {
      if (this.holdForSaving(err)) return;
      this.turnsFailed += 1;
      // Said on the first one and when the banner comes: a turn runs every second.
      if (this.turnsFailed === 1 || this.turnsFailed === TURNS_BEFORE_BANNER) this.log('error', `A turn of the squad failed: ${(err as Error).stack ?? (err as Error).message}`);
      if (this.turnsFailed >= TURNS_BEFORE_BANNER) noteTurnTrouble(this.bp, err);
    }
  },

  /**
   * True when saving does not work right now, so a failure says nothing about the work: the squad holds this project
   * until a test write gets through, with one line in the log and one banner on every page.
   */
  holdForSaving(this: LiveSquad, err: unknown): boolean {
    if (!isSaveTrouble(this.bp, err)) return false;
    if (noteSaveTrouble(this.bp, err)) this.log('error', `squad-kit cannot save its files for this project, so its squad waits: ${(err as Error).message}`);
    return true;
  },

  /** A held squad starts nothing. When saving works again, what the trouble cut off carries on. */
  savingHeld(this: LiveSquad): boolean {
    const { held, fixed } = stillHeld(this.bp);
    if (fixed) this.carryOnAfterTrouble();
    return held;
  },

  carryOnAfterTrouble(this: LiveSquad): void {
    this.log('info', 'squad-kit can save its files again, so the squad carries on');
    for (const t of listTickets(this.bp)) {
      if (t.squad && !this.running.has(t.id) && Date.parse(t.squad.nextAt) > Date.now()) {
        this.update(t.id, (x) => {
          if (x.squad) x.squad.nextAt = now();
        });
      }
    }
  },

  /**
   * A merge that waits is looked at again every 2 minutes, beside the work and never counted against the limit: merged
   * on the code host (or the person's copy free again) merges it here; a clash brings in the base again, or gives the
   * clash card (board/bring-in.ts).
   */
  lookAtMerge(this: LiveSquad, id: string): void {
    const last = this.mergeLooks.get(id);
    if (last !== undefined && (last < 0 || Date.now() - last < 2 * 60_000)) return;
    this.mergeLooks.set(id, -1);
    recheckMerge(this.bp, id)
      .then((r) => (r === 'clash' ? this.pullRequestClash(id) : undefined))
      .catch(() => undefined)
      .finally(() => this.mergeLooks.set(id, Date.now()));
  },

  /**
   * The change clashes with newer work on the code host or here: the clash card, and the latest base comes in again by
   * itself. The base is fetched first, so "has it moved" is about the team's base.
   */
  async pullRequestClash(this: LiveSquad, id: string): Promise<void> {
    await fetchBase(this.bp, pullRequestClashed(this.bp, id));
    afterPullRequest(this.bp, id, true);
  },

  /** The card says why a ready ticket waits: for a free place, or for the usage limit to reset. */
  hold(this: LiveSquad, t: Ticket, text: string): void {
    if (t.status === text && !t.quiet) return;
    if (!held(t.status)) this.beforeQueue.set(t.id, t.status);
    try {
      this.update(t.id, (x) => {
        x.status = text;
        delete x.quiet;
        // Nothing runs for it now, so its step's clock stands still until the step starts again.
        pauseClock(x);
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /**
   * A Required tool is missing or too old for the step: the card says what can't happen and why, the activity says it
   * once, and nothing fails. The board links it to the Tools page; the step starts once the tool is there.
   */
  waitForTools(this: LiveSquad, t: Ticket, b: ToolBlock): void {
    const told = t.status === b.status;
    this.hold(t, b.status);
    if (told || b.checking) return;
    this.log('info', `Waits for tools: ${b.text}`, t.id);
    try {
      this.update(t.id, (x) => addActivity(x, 'squad', `${b.text} It waits, and goes on by itself once the tool is there`));
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /**
   * A phone app's pictures wait for its phone tools when it has no web version to show meanwhile (engine/phone/plan.ts):
   * it never takes the proof without pictures, and goes on by itself once the tools are there.
   */
  picturesWait(this: LiveSquad, t: Ticket, phase: string): ToolBlock | null {
    if (phase !== 'proof') return null;
    return picturesHold(this.bp, t, this.hasWeb(t));
  },

  /** The project can start its app for the browser: a start command and an address. */
  hasWeb(this: LiveSquad, t: Ticket): boolean {
    const rc = (this.appOf(t)?.repo ?? repoFor(this.meta(), t)).commands;
    return Boolean(rc.start?.trim() && rc.url?.trim());
  },

  /** The tool a story waited for is here now: said once on the story, as it goes on. */
  toolsHere(this: LiveSquad, id: string): void {
    try {
      this.update(id, (x) => addActivity(x, 'squad', 'The tools it needs are on this computer now, so it goes on'));
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /** The ticket got its place: its card says what it said before it waited. */
  unqueue(this: LiveSquad, id: string): void {
    const said = this.beforeQueue.get(id);
    this.beforeQueue.delete(id);
    try {
      if (!held(readTicket(this.bp, id)?.status)) return;
      this.update(id, (x) => (x.status = said ?? 'Carrying on'));
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /**
   * The network or the AI service had a problem: it says nothing about the work and usually passes by itself, so the
   * step runs again a little later, with no stop card and no failed try. Only when it does not pass is it a stop.
   */
  waitOutBlip(this: LiveSquad, id: string, phase: string, err: PassingTrouble): void {
    const tries = readTicket(this.bp, id)?.blips ?? 0;
    const minutes = BLIP_WAITS_MIN[tries];
    if (minutes === undefined) {
      this.update(id, (x) => delete x.blips);
      return this.fail(id, err.message, phase, err.detail);
    }
    this.log('warn', `A network or service problem at ${phase}, so it runs again in ${minutes} min: ${err.detail ?? err.message}`, id);
    try {
      this.update(id, (x) => {
        if (x.takenOver || (x.chat?.open && !x.chat.beside)) return;
        // The step goes on where the problem cut it off, and the try it cut off does not count.
        let next = phase;
        if (phase === 'review' && x.reviewNotes?.length) next = 'review-fix';
        else if (phase === 'review' && x.reviewRound) x.reviewRound -= 1;
        if (phase === 'test') {
          x.tries = Math.max(0, (x.tries ?? 0) - 1);
          x.fails = Math.max(0, (x.fails ?? 0) - 1);
        }
        x.blips = tries + 1;
        x.live = false;
        x.squad = { ...(x.squad ?? {}), phase: next, nextAt: new Date(Date.now() + minutes * 60_000).toISOString() };
        x.status = `Waiting for the connection. Tries again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
        delete x.quiet;
        if (!tries) addActivity(x, 'squad', 'The connection or the AI service had a problem, so squad-kit tries again by itself. Not a failed try');
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  },

  /** The computer slept during the step and its run did not get through: the same step runs again, from where it was. */
  carryOnAfterSleep(this: LiveSquad, id: string, phase: string): void {
    try {
      this.update(id, (x) => {
        if (x.takenOver || (x.chat?.open && !x.chat.beside)) return;
        const next = markInterrupted(x, phase, 'sleep');
        x.live = true;
        delete x.quiet;
        x.squad = { ...(x.squad ?? {}), phase: next, nextAt: now() };
        addActivity(x, 'squad', 'The computer slept and cut off the step, so it carries on from where it was. Not a failed try');
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  },
};
