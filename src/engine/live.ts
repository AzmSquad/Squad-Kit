import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  addActivity,
  boardExists,
  listDecisions,
  listReleases,
  listTickets,
  now,
  readMeta,
  readTicket,
  updateTicket,
  writeDecision,
  writeMeta,
  type BoardPaths,
} from '../board/store.js';
import {
  CHAT_SESSION,
  applyPlanEdits,
  approveExpress,
  buildStarted,
  changeParts,
  changeSummary,
  changeWork,
  endSaves,
  needsSpec,
  openChange,
  planSnapshot,
  pullRequestClashed,
  shipped,
  wayOptions,
  type ChangeAnswer,
  saveTestCommand,
} from '../board/actions.js';
import { scheduleSquad } from '../board/schedule.js';
import { releaseGoingOut } from '../board/lock.js';
import { TECH_ROLES, type BoardMeta, type ChangeStep, type DecisionArea, type ImpactCheck, type OffScreen, type PatternNote, type PortAsk, type ProjectCommands, type ProofPicture, type ProofShot, type Question, type Role, type SpecChange, type StackNote, type TechDraft, type Ticket } from '../board/types.js';
import { detectStack } from '../board/stack.js';
import { AI_TOOLS, aiTool, describeToolEvent } from '../modules/registry.js';
import { CHECK_DOING, DOING, plainToolLine } from './plain-doing.js';
import type { AgentResult, AgentRun, AiTool, BlockedAction, ToolEvent } from '../modules/ai-tool/types.js';
import { CHECK_SILENT_MS, failedOnceLine, runChecks, runCommand, startApp, tail, testCount, type CheckResult, type RunningApp } from './checks.js';
import { forgetKnownFailure, knownFailures } from './known-failures.js';
import { alsoChangedLine, cleanAlsoChanged } from '../board/also-changed.js';
import { weakenedChecks, type Weakening } from './weakened.js';
import { checkWords, holdTestCommand, noTestsDetail, noTestsQuestion, noTestsRan, notCheckedText, ranOf } from './not-checked.js';
import { findCommands } from './find-commands.js';
import { samePicture, shotProblem, shotSizeOf } from './proof-check.js';
import { ShotsUnavailable, isPlain, plainParts, prepareShots, shotsErrorDetail, takeOne, type ShotSize } from './shots.js';
import { ALL_TOOLS, AgentWindow, toolsFor, tooManyMistakesWords, tooManyWords, type WindowChecks, type WindowSetup } from './window.js';
import { closeWindow, openWindow, windowAccess } from './window-server.js';
import { TECHNICAL_TRIES, askText, judgeQuestion, judgeReply, questionBackPrompt, refusedAskLine, refusedReplyLine, stoppedQuestion } from './question-filter.js';
import { TECHNICAL_STOP, ownRunWords, ownWords } from './plain-stop.js';
import { addSnapshot, addWorktree, changedTracked, commitAll, conventionalWords, cutOffWords, dropSnapshot, git, isAncestor, isLockFile, latestBase, putBackTracked, repairCopyLink, settleCopy } from './git.js';
import * as P from './prompts.js';
import { baseCommits, repoFor, rulesFiles, workspaceRepos } from './repos.js';
import { flushTracker, publishTicket, recheckMerge, syncWiki, trackerDue } from './sync.js';
import { AGENTS, agentInstructions, readAgent, type AgentRole } from './agents.js';
import { Watchdog, processTable, type Quiet } from './watchdog.js';
import { isMediaNote, prepareMedia } from './media.js';
import { allowedFile, ticketFolders } from './conversations.js';
import { DEFAULT_QUALITY, builderLevel, describeLevel, effortOn, personLevels, resolveLevel, stepCaps } from './levels.js';
import { CapReached, capCard } from './caps.js';
import { blockedLine, packageCacheEnv, sandboxAsk, sandboxOf, ticketCacheDir } from './sandbox.js';
import { hiddenFiles, placeStoryFiles } from './local-files.js';
import { offLimits } from '../board/project-files.js';
import { GUARD_BLOCKED, GUARD_BLOCKED_DOCKER, blockedDocker, dockerBlockedWords, guardBlockedDetail, guardBlockedPath, guardSupport, ticketGuard, type GuardSpec } from './project-guard.js';
import { ticketDir } from '../board/store.js';
import { commitTicketDocs, leaveProjectFiles } from './project-git.js';
import { carryOn, fetchBase, fetchPushed, workSoFar } from './handover.js';
import { isMine } from '../board/owner.js';
import { recordUsage } from '../board/usage.js';
import { budgetStop } from '../board/budget.js';
import { howPaid } from '../board/payment.js';
import { parallelLimit } from '../core/settings.js';
import { answerProblem, dependsProblem, scanProblem } from './answers.js';
import { checkLane, watchLane, type Lane } from './lane.js';
import { hookFiles, isHookFile } from './hook-files.js';
import { endStep, nextPart, pauseClock, resumeClock, slowStep, startStep, stepDoing, timedStep } from '../board/clock.js';
import { readUsual } from '../board/usual.js';
import { QUEUED, queuedLine } from '../board/now.js';
import { watchPort } from './free-port.js';
import { LimitReached, activePause, chatWaitNote, isLimitText, limitText, startPause, type LimitPause } from './usage-limit.js';
import { forgetSaveTrouble, isSaveTrouble, noteSaveTrouble, stillHeld, endTurnTrouble, noteTurnTrouble } from './save-trouble.js';
import { fileTroubleWords, isDiskTrouble } from '../core/file-trouble.js';
import { explainError, StepError } from '../board/problem.js';
import { readAgainDone, readIdea, readSaid, saveBlueprintParts, talkReply } from './onboard-live.js';
import { readFailed, readStarted, readingNow, resumeSetup, runSetupProof, saveScan, settleSetupStop, type ScanAnswer } from './onboard.js';
import { nextProofStep } from '../board/setup-state.js';
import { writeLog, type LogLevel } from '../core/app-log.js';
import { designDepends, holdBuild, wakeIfReady } from '../board/depends.js';
import { resumeCutRelease } from '../board/release-tidy.js';
import { addWorktreeOn, catchUp, dependencyToStartFrom, openTicketsFor } from './depends.js';
import { copyWords, endProcess, folderOf, listenerOn, ownedBySquadKit, processes, projectCopies, runsEnded, stopLeftovers, stoppedLines, ticketCopies, workingFolders, type Leftover, type LookOptions } from './leftovers.js';
import { CutOff, carriesOn, carryOnLine, carryOnPrompt, markInterrupted, sleepMark, sleptSince, type SleepMark } from './interrupt.js';
import { STOP_IT, cardAnswer, goAroundAnswer, inTheWay, ownWorkAnswer, portCard, settledAnswer, type AroundIt } from './port-ask.js';
import { appPortVariables } from './port-vars.js';
import { judgeTestChange } from './test-change.js';
import { trackTask } from './process-group.js';
import { endPid, nextFreePort, portTaken, squadKitOn } from './run-app.js';
import { APPROVING, NO_QUESTIONS, acceptByItselfBeside, acceptNext, addDecided, afterPullRequest, askWords, cleanSources, mergeWait, mergesByItself, resumeAccept, waitForLanding } from '../board/auto.js';
import * as A from './auto-prompts.js';
import type { DecidedBy } from '../board/requirements-types.js';
import { breakdownJobs, holdBreakdownJob } from '../board/requirements.js';
import { breakdownStopped } from '../board/requirements-actions.js';
import { breakdownDir } from '../board/requirements-paths.js';
import { proofPages, rowPictures, squadWorks, waitsAtReview, whereItStands } from '../board/at-review.js';
import { reviewLook } from './review-look.js';
import { runBreakdownJob } from './breakdown-job.js';
import { fillBuildQueue, placesLeft } from '../board/requirements-build.js';
import { startSends } from '../board/requirements-send.js';
import { clearStaleStop } from '../board/stale-stop.js';
import { CHECK_FAILED, MAX_PICTURES_PER_DONE_WHEN, MAX_PROOF_ROUNDS, MAX_RETAKES, addPictures, afterLastRetake, brokenRows, brokenStop, cannotShowLine, checkVerdicts, criterionText, doneWhenCount, fixLine, fromReason, makeMain, notShownStop, offScreenNumbers, reasonRefusedLine, retakeLine, together, verdictOf, type CheckVerdict, type Judged, type OpenRow } from './proof-verdict.js';

/**
 * The live squad. Each step of a ticket is one real run of the role's AI tool in the project (or the
 * ticket's own worktree). Every step reads the ticket file, does its work, and writes the result
 * back, so the board and the terminal always show the true state.
 */

const MAX_CHECK_TRIES = 3;
const MAX_REVIEW_ROUNDS = 2;
/** How often the board looks for tickets teammates pushed: handed to you, or moved on by their owner. */
const PICK_UP_MS = 2 * 60_000;
/** The "before" screenshots run beside the build and stop after this long, so they never hold anything up. */
const BEFORE_SHOTS_MS = 8 * 60_000;
const STOPPED = 'You stopped the squad.';

/** The steps in which the Builder works. A small change goes into the next one of these as it starts. */
const BUILDER_PHASES = new Set(['build', 'unstick', 'fix', 'answered-builder', 'chat-carry-builder', 'review-fix', 'restore-tests', 'update-base', 'change-build']);


export function projectRoot(bp: BoardPaths): string {
  return bp.root;
}

/** The plan in one short key: the story, the done-when items, the decision and the steps. */
function planKey(t: Ticket): string {
  return createHash('sha1').update(JSON.stringify(planSnapshot(t))).digest('hex').slice(0, 12);
}

/** squad-kit's own keys (tracker token, speech key): no agent may read them, whichever folder it works in. */
export function secretFiles(bp: BoardPaths, cwd?: string): string[] {
  return [bp.secretsFile, path.join(bp.squadDir, 'secrets.yaml'), ...hiddenFiles(bp, cwd)];
}

/**
 * Every squad running in this app, one per project. They share the person's AI accounts, so one limit of tickets at
 * once holds across all of them (ADR-001). The Architect's reads beside the tickets don't count.
 */
const squads = new Set<LiveSquad>();
/** Squads with a ticket ready to start but no free place, at their last look. */
const waiting = new Set<LiveSquad>();

/** Tickets the squads of every project in this app work on right now. */
export function ticketsRunning(): number {
  let n = 0;
  for (const s of squads) n += s.ticketsRunning();
  return n;
}

/** While an update waits for a safe moment, no new run starts; the running ones finish their step. */
let holding = false;

export function holdNewRuns(on: boolean): void {
  holding = on;
}

/** The end of the last usage-limit wait the squads saw, so its end is logged once. */
let limitSeen: string | null = null;

/** Every agent run going on now, by project folder: ticket steps, and the Architect's reads and chat answers beside them. */
export function agentRuns(): { root: string; keys: string[] }[] {
  return [...squads].map((s) => s.runs()).filter((r) => r.keys.length > 0);
}

/** The card of a ticket ready for its next step while every place is taken: "Next in line: starts when a slot is free (2 of 2 busy)". */
export function queuedText(running: string[], limit: number): string {
  return queuedLine(running.length, limit);
}

/** A step stopped on a network or service problem that usually passes by itself. */
class PassingTrouble extends StepError {}

/** How long a step waits before each new try after such a problem: about 15 minutes in all, then a plain stop. */
const BLIP_WAITS_MIN = [1, 2, 4, 8];

/** Turns of a squad that failed in a row before the board says so: one can be bad luck, a few mean nothing moves. */
export const TURNS_BEFORE_BANNER = 3;

export class LiveSquad {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stops = new Map<string, AbortController>();
  private syncing = new Set<string>();
  private localRuns = new Set<string>();
  /** Builds by itself: merges that wait (a pull request's approver, the person's checkout), and when each was looked at. */
  private mergeLooks = new Map<string, number>();
  private closing = false;
  /** Turns of the squad in a row that failed. */
  private turnsFailed = 0;
  private dog = new Watchdog();
  private lastWatch = 0;
  private lastPickUp = 0;
  private pickingUp = false;
  /** A turn of Build continuously is running. */
  private queueing = false;
  /** What a waiting ticket's card said before it waited for a free place, to say again when its step starts. */
  private beforeQueue = new Map<string, string>();
  /** "Before" screenshots running beside a ticket's build, until they end. */
  private beforeShotsOf = new Map<string, Promise<void>>();
  /** What the last board left running in squad-kit's copies, being stopped as this one starts: steps wait for it. */
  private swept: Promise<unknown> | null = null;
  /** When each ticket's step started, on both clocks, to tell a run the computer's sleep cut off. */
  private marks = new Map<string, SleepMark>();

  constructor(private bp: BoardPaths) {}

  start(intervalMs = 1000): () => void {
    this.resumeAfterRestart();
    squads.add(this);
    this.timer = setInterval(() => this.safeTick(), intervalMs);
    return () => {
      // Closing the board: stop running steps quietly; they resume when the board opens again.
      forgetSaveTrouble(this.bp);
      squads.delete(this);
      waiting.delete(this);
      this.closing = true;
      if (this.timer) clearInterval(this.timer);
      // Cut off, not failed: each step carries on from where it was when the board opens again (engine/interrupt.ts).
      for (const id of this.ticketIds()) this.cutOff(id, 'restart');
      for (const c of this.stops.values()) c.abort();
      endSaves(this.bp);
      // What their runs leave behind in squad-kit's copies stops too, once they have ended. A restart waits for it.
      if (this.isLive()) trackTask(this.clearAfterClose());
    };
  }

  private isLive(): boolean {
    try {
      return boardExists(this.bp) && readMeta(this.bp).engine === 'live';
    } catch {
      return false;
    }
  }

  /** The step running on a ticket was cut off: kept as such on the ticket, never as a failed try. */
  private cutOff(id: string, by: 'restart' | 'stop' | 'sleep'): void {
    try {
      this.update(id, (x) => {
        if (!x.squad) return;
        x.squad.phase = markInterrupted(x, x.squad.phase, by);
        // Nothing runs now, so its clock stands still until the step carries on.
        pauseClock(x);
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  }

  private async clearAfterClose(): Promise<void> {
    await runsEnded(projectCopies(this.bp), 6000);
    // Every run was stopped: only a ticket the person took over keeps what runs in its copy.
    await this.clearCopies(projectCopies(this.bp), { busy: this.busyCopies(undefined, false), graceMs: 2500 }).catch(() => undefined);
  }

  ticketsRunning(): number {
    return this.ticketIds().length;
  }

  /** The tickets this squad runs a step of right now. */
  ticketIds(): string[] {
    return [...this.running].filter((k) => !k.startsWith('__'));
  }

  runs(): { root: string; keys: string[] } {
    return { root: this.bp.root, keys: [...this.running] };
  }

  /** A free place in the app's one limit. While squads wait for one, it goes to the squad with fewer tickets running. */
  private mayStart(limit: number): boolean {
    const mine = this.ticketsRunning();
    const busy = ticketsRunning() + (squads.has(this) ? 0 : mine);
    if (busy < limit && ![...waiting].some((s) => s !== this && s.ticketsRunning() < mine)) {
      waiting.delete(this);
      return true;
    }
    waiting.add(this);
    return false;
  }

  /** The project's folder moved: an open ticket's copy gets its link to the repo back, so its work stays in reach. */
  private mendCopy(t: Ticket): boolean {
    if (!t.worktree || t.stage === 'done' || !fs.existsSync(t.worktree)) return false;
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
  }

  /** A step that was running when the console stopped is picked up again right away. */
  private resumeAfterRestart(): void {
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
    } catch {
      // Unreadable board; the tick will report it.
    }
  }

  /** One turn. Whatever it finds wrong stays inside this project: nothing above a timer would catch it. */
  private safeTick(): void {
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
  }

  /**
   * True when saving does not work right now, so a failure says nothing about the work: the squad holds this project
   * until a test write gets through, with one line in the log and one banner on every page.
   */
  private holdForSaving(err: unknown): boolean {
    if (!isSaveTrouble(this.bp, err)) return false;
    if (noteSaveTrouble(this.bp, err)) this.log('error', `squad-kit cannot save its files for this project, so its squad waits: ${(err as Error).message}`);
    return true;
  }

  /** A held squad starts nothing. When saving works again, what the trouble cut off carries on. */
  private savingHeld(): boolean {
    const { held, fixed } = stillHeld(this.bp);
    if (fixed) this.carryOnAfterTrouble();
    return held;
  }

  private carryOnAfterTrouble(): void {
    this.log('info', 'squad-kit can save its files again, so the squad carries on');
    for (const t of listTickets(this.bp)) {
      if (t.squad && !this.running.has(t.id) && Date.parse(t.squad.nextAt) > Date.now()) {
        this.update(t.id, (x) => {
          if (x.squad) x.squad.nextAt = now();
        });
      }
    }
  }

  private tick(): void {
    // A squad that starts nothing right now never holds a free place back from the others.
    waiting.delete(this);
    if (this.savingHeld()) return;
    if (!boardExists(this.bp)) return;
    let meta: BoardMeta;
    try {
      meta = readMeta(this.bp);
    } catch {
      return;
    }
    if (meta.engine !== 'live') return;
    this.watch();
    this.pickUp();
    const limit = parallelLimit(meta.parallel);
    // The AI account's usage limit: nothing new starts in any project until it resets (E5).
    const pause = activePause();
    if (pause) limitSeen = pause.until;
    else if (limitSeen) {
      limitSeen = null;
      this.log('info', 'The usage limit wait is over: the queue carries on');
    }
    // Stop on the setup: the read or the step running ends; the setup waits until Start again.
    if (meta.setup?.stopping) {
      this.stops.get('__scan')?.abort();
      this.stops.get('__setup')?.abort();
      // Nothing runs, so nothing would answer the Stop (the usage limit holds the read).
      if (!this.running.has('__scan') && !this.running.has('__setup')) {
        settleSetupStop(this.bp);
        return;
      }
    }
    // "Something is wrong": the Architect answers the person beside everything else.
    this.talk();
    if (meta.scan?.status === 'pending' && !this.running.has('__scan')) {
      this.launch('__scan', () => this.scan());
      return;
    }
    // After the read, squad-kit proves it can work here: its own copy, the tests, the app once.
    if (meta.scan?.status === 'done' && nextProofStep(meta.setup) && !this.running.has('__setup')) {
      this.launch('__setup', () => runSetupProof(this.bp, { shoot: (o) => this.setupShot(o), signal: this.stops.get('__setup')!.signal }));
    }
    if (meta.scan?.status === 'running' && !this.running.has('__scan')) {
      // The console restarted mid-scan; read the project again.
      this.launch('__scan', () => this.scan());
      return;
    }
    // Pending, or cut off by a restart: the Architect reads the code for the architecture page, beside the tickets.
    if ((meta.blueprint?.status === 'pending' || meta.blueprint?.status === 'running') && !this.running.has('__blueprint')) {
      this.launch('__blueprint', () => this.readBlueprint());
    }
    for (const c of meta.impactChecks ?? []) {
      const key = `__impact:${c.adr}`;
      if ((c.status === 'pending' || c.status === 'running') && !this.running.has(key)) this.launch(key, () => this.checkImpact(c.adr));
    }
    for (const d of meta.techDrafts ?? []) {
      const key = `__tech:${d.tech}`;
      if (d.status === 'writing' && !this.running.has(key)) this.launch(key, () => this.writeTechDecision(d.tech));
    }
    // The Analyst's work on my breakdowns, beside the tickets. A step cut off by a restart starts again; the usage limit holds it.
    for (const j of breakdownJobs(this.bp, meta)) {
      const key = `__breakdown:${j.id}`;
      if (j.job.status === 'stopping') {
        this.stops.get(key)?.abort();
        if (!this.running.has(key)) breakdownStopped(this.bp, j.id);
      } else if (this.running.has(key)) continue;
      else if (pause) holdBreakdownJob(this.bp, j.id, limitText(pause));
      else this.launch(key, () => this.breakdownJob(j.id));
    }
    // Sending a breakdown to the tracker (`__send:<id>`): no AI runs, so neither limit holds it (board/requirements-send.ts).
    startSends(this.bp, meta, { running: this.running, stops: this.stops });
    for (const t of listTickets(this.bp)) {
      // Being deleted (src/engine/delete.ts): nothing starts on it again, its tracker updates are not sent, and what
      // runs stops.
      if (t.deleting) {
        this.letGo(t);
        continue;
      }
      // Tracker updates run beside the squad's work and never count against the parallel limit. One that failed waits
      // a little longer before each new try.
      if (trackerDue(t) && !this.syncing.has(t.id)) {
        this.syncing.add(t.id);
        flushTracker(this.bp, t.id)
          .catch(() => undefined)
          .finally(() => this.syncing.delete(t.id));
      }
      // Setting up the person's own checkout after a merge runs beside the squad too, one at a time per folder.
      const ls = t.localSetup;
      if ((ls?.status === 'pending' || ls?.status === 'running') && !this.localRuns.has(ls.dir)) {
        this.localRuns.add(ls.dir);
        this.localSetup(t.id)
          .catch(() => undefined)
          .finally(() => this.localRuns.delete(ls.dir));
      }
      // Asking never stops the work: a chat reply and the Analyst writing a proposed change run beside the ticket's
      // step. They never wait for it, never stop it and never count against the limit. Stop on a chat answer ends that
      // answer only, never the ticket's step. A question on someone else's ticket is answered here too.
      const chatKey = `__chat:${t.id}`;
      if (t.chat?.stopping) {
        this.stops.get(chatKey)?.abort();
        if (!this.running.has(chatKey)) this.chatStopped(t.id);
      } else if (t.chat?.open && t.chat.thinking && !this.running.has(chatKey)) {
        // During the usage limit the answer waits, and comes when the squad carries on.
        if (pause) this.chatWaits(t, pause);
        else this.launch(chatKey, () => this.chatReply(t.id));
      }
      // Someone else's ticket: their squad works on it, on their computer (ADR-001).
      if (!isMine(t, meta)) continue;
      // It waited for a ticket it depends on, and that one is merged now: its build starts.
      if (wakeIfReady(this.bp, t)) continue;
      // Builds by itself: the change it waited for is settled, so it is accepted now (board/auto.ts).
      if (resumeAccept(this.bp, t)) continue;
      // Builds by itself: a merge that waits for a pull request's approver or the person's checkout is looked at again.
      if (mergeWait(t)) this.lookAtMerge(t.id);
      if (openChange(t)?.status === 'writing' && !this.running.has(`__change:${t.id}`)) this.launch(`__change:${t.id}`, () => this.writeChange(t.id));
      if (t.stopRequested) {
        this.stops.get(t.id)?.abort();
        this.stops.get(`__before:${t.id}`)?.abort();
        if (!this.running.has(t.id)) this.stopped(t.id);
        continue;
      }
      if (this.running.has(t.id)) continue;
      const q = t.questions?.find((x) => x.thinking);
      if (q) {
        if (pause) this.hold(t, limitText(pause));
        else if (this.mayStart(limit)) this.launch(t.id, () => this.reply(t.id, q.id));
        else this.queue(t, limit);
        continue;
      }
      if (t.squad && Date.parse(t.squad.nextAt) <= Date.now()) {
        if (pause) this.hold(t, limitText(pause));
        else if (this.mayStart(limit)) {
          // The base comes in first when it was asked for, or the ticket this one was built on is merged now.
          const phase = catchUp(this.bp, t, this.phaseFor(t));
          this.launch(t.id, () => this.step(t.id, phase));
        } else this.queue(t, limit);
      } else if (!t.squad) this.pickUpChange(t);
    }
    // Build continuously: the next stories of my breakdowns start while a place is free (board/requirements-build.ts).
    this.buildQueue(limit, meta, pause);
  }

  /**
   * A merge that waits is looked at again every 2 minutes, beside the work and never counted against the limit: merged
   * on the code host (or the person's copy free again) merges it here; a clash gives the clash card, and on this
   * track brings in the base again (board/auto.ts).
   */
  private lookAtMerge(id: string): void {
    const last = this.mergeLooks.get(id);
    if (last !== undefined && (last < 0 || Date.now() - last < 2 * 60_000)) return;
    this.mergeLooks.set(id, -1);
    recheckMerge(this.bp, id)
      .then((r) => (r === 'clash' ? this.pullRequestClash(id) : undefined))
      .catch(() => undefined)
      .finally(() => this.mergeLooks.set(id, Date.now()));
  }

  /**
   * The change clashes with newer work on the code host or here: the clash card, and on a track that merges by itself
   * the latest base comes in again. The base is fetched first, so "has it moved" is about the team's base.
   */
  private async pullRequestClash(id: string): Promise<void> {
    const t = pullRequestClashed(this.bp, id);
    if (mergesByItself(t)) await fetchBase(this.bp, t);
    afterPullRequest(this.bp, id, true);
  }

  /** One turn of the breakdowns' queue at a time. A place is free when the app's one limit has room for one more. */
  private buildQueue(limit: number, meta: BoardMeta, pause: LimitPause | null): void {
    if (this.queueing || holding) return;
    this.queueing = true;
    const free = () => {
      let others = 0;
      for (const s of squads) if (s !== this) others += s.ticketsRunning();
      return placesLeft(limit, listTickets(this.bp), meta, others, [...waiting].some((s) => s !== this));
    };
    void fillBuildQueue(this.bp, { free, pause, payment: async () => (await howPaid(this.bp)).payment })
      .then((turns) => turns.forEach((x) => x.started.length && this.log('info', `Build continuously started ${x.started.join(', ')} from ${x.id}`)))
      .catch((err: Error) => this.log('warn', `Build continuously could not start a story: ${err.message}`))
      .finally(() => (this.queueing = false));
  }

  /**
   * Every place is taken: the card says the ticket waits and for whom, instead of showing its last step as if it
   * still ran. Nothing runs for it, so the watchdog has nothing to say about it.
   */
  private queue(t: Ticket, limit: number): void {
    const running: string[] = [];
    for (const s of squads) running.push(...s.ticketIds());
    this.hold(t, queuedText(running, limit));
  }

  /** The card says why a ready ticket waits: for a free place, or for the usage limit to reset. */
  private hold(t: Ticket, text: string): void {
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
  }

  /** The ticket got its place: its card says what it said before it waited. */
  private unqueue(id: string): void {
    const said = this.beforeQueue.get(id);
    this.beforeQueue.delete(id);
    try {
      if (!held(readTicket(this.bp, id)?.status)) return;
      this.update(id, (x) => (x.status = said ?? 'Carrying on'));
    } catch {
      // The ticket was removed meanwhile.
    }
  }

  /**
   * The network or the AI service had a problem: it says nothing about the work and usually passes by itself, so the
   * step runs again a little later, with no stop card and no failed try. Only when it does not pass is it a stop.
   */
  private waitOutBlip(id: string, phase: string, err: PassingTrouble): void {
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
  }

  private launch(key: string, job: () => Promise<void>): void {
    if (holding) return;
    // The Architect's reads beside the tickets, the chat answers and the overview's talk wait for the usage limit too.
    if (key.startsWith('__') && activePause()) return;
    if (!key.startsWith('__')) this.unqueue(key);
    this.running.add(key);
    this.stops.set(key, new AbortController());
    this.dog.beat(key);
    const phase = readTicket(this.bp, key)?.squad?.phase;
    const mark = sleepMark();
    if (!key.startsWith('__')) this.marks.set(key, mark);
    job()
      .then(() => {
        // The step got through: an interruption of it is over.
        try {
          if (!key.startsWith('__') && phase && carriesOn(readTicket(this.bp, key) ?? {}, phase)) updateTicket(this.bp, key, (x) => delete x.interrupted);
          if (!key.startsWith('__') && readTicket(this.bp, key)?.blips) updateTicket(this.bp, key, (x) => delete x.blips);
        } catch {
          // The ticket was removed meanwhile.
        }
      })
      .catch((err: Error) => {
        if (this.closing) return;
        // A full disk or a folder that moved: the stop card could not be saved either, and the next turn would start
        // the same step again. The squad holds this project and the step carries on when saving works again.
        if (this.holdForSaving(err)) return;
        if (key.startsWith('__')) return;
        // Stopped for a delete: no stuck card on a ticket that is going.
        if (readTicket(this.bp, key)?.deleting) return;
        if (readTicket(this.bp, key)?.stopRequested) return this.stopped(key, phase);
        if (err instanceof WaitingForYou) return;
        if (err instanceof LimitReached) return this.waitForLimit(key, phase ?? 'analyst-read', err.pause);
        if (err instanceof CapReached) return this.capPause(key, phase ?? 'analyst-read', err);
        if (err instanceof PassingTrouble) return this.waitOutBlip(key, phase ?? 'analyst-read', err);
        // The computer slept and the run did not get through: that says nothing about the work, so the step carries on.
        if (err instanceof CutOff || sleptSince(mark)) return this.carryOnAfterSleep(key, phase ?? 'analyst-read');
        const { what, detail } = explainError(err);
        // Only squad-kit's own plain words reach the person (engine/plain-stop.ts): anything else is one plain
        // sentence, with the exact words for engineers.
        const own = isDiskTrouble(err) ? fileTroubleWords(err) : ownWords(err);
        if (own) this.fail(key, own, phase ?? 'analyst-read', detail);
        else this.fail(key, TECHNICAL_STOP, phase ?? 'analyst-read', [what, detail].filter(Boolean).join('\n'));
      })
      .finally(async () => {
        // Nothing the step started is left running in the ticket's copy once it ends, however it ended.
        if (!key.startsWith('__')) await this.clearAfterStep(key).catch(() => undefined);
        this.running.delete(key);
        this.stops.delete(key);
        this.marks.delete(key);
        this.dog.forget(key);
        if (!key.startsWith('__')) this.setQuiet(key, null);
      });
  }

  /** The computer slept during the step and its run did not get through: the same step runs again, from where it was. */
  private carryOnAfterSleep(id: string, phase: string): void {
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
  }

  /* ── what squad-kit's copies leave running ──────────── */

  /**
   * Copies to leave alone while sweeping: those of steps running now (other than `except`), the copy the before
   * screenshots or the setup work in, and a ticket the person took over.
   */
  private busyCopies(except?: string, runs = true): string[] {
    const tickets = listTickets(this.bp);
    const out: string[] = tickets.filter((t) => t.takenOver).flatMap((t) => [t.takenOver!.cwd, ...ticketCopies(this.bp, t)]);
    for (const k of runs ? this.running : []) {
      if (k === '__setup') out.push(...projectCopies(this.bp).map((r) => path.join(r, 'setup-copy')));
      if (k.startsWith('__before:')) {
        const t = tickets.find((x) => x.id === k.slice(9));
        if (t) out.push(...ticketCopies(this.bp, t).filter((d) => d !== t.worktree));
      }
      const t = !k.startsWith('__') && k !== except ? tickets.find((x) => x.id === k) : undefined;
      if (t) out.push(...ticketCopies(this.bp, t));
    }
    return out;
  }

  /**
   * Stops what squad-kit's copies `dirs` have left running, and says so in one plain line each: on ticket `forId`
   * when it is for that ticket's next step, else on the ticket whose copy it was in.
   */
  private async clearCopies(dirs: string[], opts: LookOptions & { graceMs?: number; only?: number[] }, forId?: string): Promise<Leftover[]> {
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
  }

  /** A step ended: once its runs have ended, what they left running in the ticket's copy stops. */
  private async clearAfterStep(id: string): Promise<void> {
    if (this.closing) return;
    const t = readTicket(this.bp, id);
    if (!t?.worktree || t.takenOver || !fs.existsSync(t.worktree)) return;
    await runsEnded([t.worktree], 6000);
    await this.clearCopies([t.worktree], {}, id);
  }

  /**
   * Before the checks, and before squad-kit starts the app for the Tester: nothing left running in the ticket's copy,
   * and no port held by a server another of squad-kit's copies of this project left behind.
   */
  private async clearBeforeApp(id: string): Promise<void> {
    const t = readTicket(this.bp, id);
    if (!t?.worktree) return;
    await this.clearCopies([t.worktree], {}, id);
    await this.clearCopies(projectCopies(this.bp), { busy: [t.worktree, ...this.busyCopies(id)], listening: true }, id);
  }

  /**
   * Every 15 seconds: is any running step quiet? Then say so on the ticket, with what it waits on, so nothing hangs
   * without the person knowing.
   */
  private watch(): void {
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
    for (const id of keys) {
      const t = readTicket(this.bp, id);
      if (!t) continue;
      const snoozed = t.quietSnoozedUntil && Date.parse(t.quietSnoozedUntil) > Date.now();
      // Quiet, or past twice its usual time: either way the person sees a card with what it is doing.
      this.setQuiet(id, snoozed ? null : (this.dog.check(id, Date.now(), rows) ?? slowStep(t, usual)));
      // A step that needs the app may wait on a busy port: the card says what holds it (src/engine/free-port.ts).
      watchPort(this.bp, id);
    }
  }

  /** Now and then, beside the squad's work: fetch, and bring in the tickets teammates pushed. */
  private pickUp(): void {
    if (this.pickingUp || Date.now() - this.lastPickUp < PICK_UP_MS) return;
    this.pickingUp = true;
    this.lastPickUp = Date.now();
    fetchPushed(this.bp)
      .catch(() => undefined)
      .finally(() => (this.pickingUp = false));
  }

  private setQuiet(id: string, q: Quiet | null): void {
    try {
      const t = readTicket(this.bp, id);
      if (!t || (!q && !t.quiet)) return;
      if (q && t.quiet && q.kind === t.quiet.kind && q.detail === t.quiet.detail) return;
      this.update(id, (x) => {
        if (q && x.quiet?.kind !== q.kind) addActivity(x, 'squad', q.kind === 'stuck' ? `Looks stuck: ${q.detail}` : `Taking long: ${q.detail}`);
        // What the last look found on the app's port stays until the next look.
        if (q) x.quiet = { ...q, ...(x.quiet?.port && q.kind === x.quiet.kind ? { port: x.quiet.port } : {}) };
        else delete x.quiet;
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  }

  /**
   * A ticket being deleted: its step, chat answer, change and before shots stop. Once none of them runs (and no
   * tracker update is on its way), the ticket says so, for a delete started in another window.
   */
  private letGo(t: Ticket): void {
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
  }

  /** The person pressed Stop: park the ticket with a way to pick it up again. */
  private stopped(id: string, phase?: string): void {
    // Taken over, or talking it through: the person has the ticket now, so no stuck card, just quiet.
    const held = readTicket(this.bp, id);
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
    });
  }

  /* ── helpers ─────────────────────────────────────────── */

  /** Commands squad-kit runs itself (setup, checks) report to the watchdog too, and end on the ticket's Stop. */
  private commandWatch(id: string) {
    const signal = this.stops.get(id)?.signal;
    return { onSpawn: (pid: number) => this.dog.track(id, pid), onOutput: () => this.dog.beat(id), ...(signal ? { signal } : {}) };
  }

  /**
   * squad-kit's own guard for a project command run in a copy (engine/project-guard.ts): its tests, setup and app
   * cannot read the person's keys, squad-kit's own folder or the project's .env outside the copy. Null where this
   * computer has no guard (Windows): the command runs as before, and Settings says "less protected".
   */
  private guardFor(cwd: string, id: string): GuardSpec | undefined {
    if (!guardSupport().on) return undefined;
    const allow = this.meta().guard;
    return ticketGuard(this.bp, { cwd, id, ...(allow ? { allow } : {}) });
  }

  /** The watchdog hooks and the guard together, for a command run in a ticket's copy. */
  private guardedWatch(id: string, cwd: string) {
    const guard = this.guardFor(cwd, id);
    return { ...this.commandWatch(id), ...(guard ? { guard } : {}) };
  }

  /** Between the parts of a step: once the person pressed Stop, nothing new starts. */
  private goOn(id: string): void {
    if (this.stops.get(id)?.signal.aborted) throw new Error(STOPPED);
  }

  private meta(): BoardMeta {
    return readMeta(this.bp);
  }

  private ctx(t?: Ticket): P.PromptContext {
    const meta = this.meta();
    return { rules: this.ruleCopies().files, ...(t ? { repo: repoFor(meta, t) } : {}) };
  }

  /** Roles working in a worktree still need to read the project's rule files: they get copies, never the person's own checkout. */
  private extraDirs(t: Ticket): string[] {
    const rules = this.ruleCopies();
    return [...attachmentDirs(t), ...(rules.files.length ? [rules.dir] : [])];
  }

  /** The project's rule files, copied into this computer's folder for the project, where an agent may read them freely. */
  private ruleCopies(): { dir: string; files: string[] } {
    const root = projectRoot(this.bp);
    const dir = path.join(this.bp.localDir, 'rules-read');
    const files = rulesFiles(root).map((from) => {
      const to = path.join(dir, path.relative(root, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return to;
    });
    return { dir, files };
  }

  private update(id: string, change: (t: Ticket) => void): Ticket {
    return updateTicket(this.bp, id, (t) => {
      change(t);
      // A step that ends after you took the ticket over must not move it on: it stays yours until you give it back.
      if (t.takenOver) {
        t.waiting = { kind: 'yours', summary: 'You took it over. Give it back when you are done' };
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
  }

  /** Show live progress: the latest tool line on the ticket, a few of them in its activity. */
  private watcher(id: string, role: Role, cwd: string, onLine?: (line: string, t: Ticket) => void) {
    let last = 0;
    let logged = 0;
    return (e: ToolEvent) => {
      const line = describeToolEvent(e, cwd);
      if (!line || Date.now() - last < 700) return;
      last = Date.now();
      // The status and the card get plain words; the exact command stays in the Conversation tab's full log.
      const plain = plainToolLine(e, cwd) ?? DOING.other;
      this.update(id, (t) => {
        t.status = plain;
        t.live = true;
        stepDoing(t, plain);
        // The activity list keeps the changes to project files; commands only show as the live line.
        if (logged < 40 && /^(Editing|Writing) /.test(line) && e.name !== 'Bash' && isInside(cwd, e.input.file_path)) {
          addActivity(t, role, line);
          logged += 1;
        }
        onLine?.(plain, t);
      });
    };
  }

  /** The AI tool a role runs on, in words: "Claude Code". */
  private toolLabel(role: AgentRole): string {
    return aiTool(readAgent(this.bp, role).tool)?.label ?? 'its AI tool';
  }

  /**
   * `job` names a run beside the ticket's step (a chat reply, a proposed change): its own Stop and watchdog, not the
   * step's. `box` keeps the run's shell commands in its AI tool's sandbox, where it has one.
   * `check` finds what the answer's shape cannot say (a name that is not an open ticket): the run is asked once more.
   * `window` is squad-kit's own tools for the run (engine/window.ts), when the caller made them; a ticket's run gets
   * its own otherwise. Their key works for this run only, and they close with it. A question in the answer that may
   * not reach the person goes back to the agent first (engine/question-filter.ts). `reply` marks a reply in a talk
   * with the person (a chat answer is one too): one that asks for what is not allowed is replaced with a plain line.
   */
  private async runAgent(opts: AgentRun & { ticket?: string; job?: string; role: AgentRole; step?: string; levelStep?: string; box?: object; check?: (answer: unknown) => string | null; checkHelp?: () => string; win?: AgentWindow; reply?: boolean }): Promise<AgentResult> {
    const job = opts.job ?? opts.ticket;
    const jobSignal = job ? this.stops.get(job)?.signal : undefined;
    // The run's own Stop: the job's Stop, or squad-kit stopping an agent that kept asking for what it may not do.
    const runStop = new AbortController();
    const onJobStop = () => runStop.abort();
    if (jobSignal?.aborted) runStop.abort();
    jobSignal?.addEventListener('abort', onJobStop, { once: true });
    const signal = runStop.signal;
    const mine = !opts.win && opts.ticket ? this.windowFor(opts as AgentRun & { ticket: string; role: AgentRole; step?: string }, signal) : undefined;
    const win = opts.win ?? mine;
    win?.whenTooMany(() => runStop.abort());
    if (mine) openWindow(mine);
    try {
      return await this.runWith({ ...opts, ...(win ? { win } : {}) }, signal);
    } finally {
      jobSignal?.removeEventListener('abort', onJobStop);
      if (mine) await closeWindow(mine);
    }
  }

  /**
   * squad-kit's own tools for a ticket's run: every tool for the Builder in the ticket's copy of an app, Look at a page
   * for the Reviewer's review there (read only: squad-kit starts the app for it), else I am stuck.
   */
  private windowFor(opts: AgentRun & { ticket: string; role: AgentRole; step?: string }, signal: AbortSignal): AgentWindow {
    const id = opts.ticket;
    const t = readTicket(this.bp, id);
    const rc = t ? repoFor(this.meta(), t).commands : {};
    const inCopy = Boolean(t?.worktree && opts.cwd === t.worktree);
    const here = inCopy && Boolean(rc.start?.trim() && rc.url?.trim());
    const builds = inCopy && opts.permissions.includes('edit');
    const app = here && builds;
    const look = here && opts.role === 'reviewer' && opts.step === 'review';
    const who = AGENTS.find((a) => a.role === opts.role)?.name ?? opts.role;
    return new AgentWindow({
      ...this.windowBase(id, opts.role, opts.cwd, (opts as { job?: string }).job ?? id),
      step: opts.step ?? 'chat',
      who,
      tools: toolsFor({ app, look, checks: builds }),
      ...(app || look ? { app: { cwd: opts.cwd, start: rc.start!.trim(), url: rc.url!.trim(), ...(this.guardFor(opts.cwd, id) ? { guard: this.guardFor(opts.cwd, id)! } : {}) } } : {}),
      ...(builds ? { checks: this.windowChecks(id, opts.cwd) } : {}),
      prefix: `${id.toLowerCase()}-${opts.role}`,
      signal,
    });
  }

  /** The project's own saved checks for an agent's run_checks, in the ticket's copy, inside squad-kit's guard. */
  private windowChecks(id: string, cwd: string): WindowChecks {
    const guard = this.guardFor(cwd, id);
    return {
      cwd,
      // A project the Builder is setting up may say how by now.
      commands: () => this.saveFoundCommands(id, cwd),
      ...(guard ? { guard } : {}),
      onStart: (name) =>
        this.update(id, (x) => {
          x.status = CHECK_DOING[name]!;
          stepDoing(x, x.status);
        }),
    };
  }

  /** What every window of a ticket shares: its lines on the ticket, the app log, and squad-kit's own fixes. */
  private windowBase(id: string, role: AgentRole, cwd: string, job = id): Pick<WindowSetup, 'ticket' | 'proofDir' | 'say' | 'log' | 'beat' | 'beforeStart' | 'inTheWay'> {
    return {
      ticket: id,
      proofDir: this.bp.proofDir,
      // A long call (the app starting, ten pictures) is the step working, not hanging.
      beat: () => this.dog.beat(job),
      say: (text) => {
        try {
          this.update(id, (x) => addActivity(x, role, text));
        } catch {
          // The ticket was removed meanwhile.
        }
      },
      log: (text) => this.log('warn', text, id),
      // Nothing squad-kit left running in its other copies may hold the app's address.
      beforeStart: async () => {
        await this.clearCopies(projectCopies(this.bp), { busy: [cwd, ...this.busyCopies(id)], listening: true }, id);
      },
      inTheWay: async (text) => (await this.inTheWay(id, { text }))?.answer ?? null,
    };
  }

  private async runWith(opts: AgentRun & { ticket?: string; job?: string; role: AgentRole; step?: string; levelStep?: string; box?: object; check?: (answer: unknown) => string | null; checkHelp?: () => string; win?: AgentWindow; reply?: boolean }, signal: AbortSignal): Promise<AgentResult> {
    const job = opts.job ?? opts.ticket;
    // Each role runs as its own agent: the team's file for it sets the tool, the model and extra instructions.
    const agent = readAgent(this.bp, opts.role);
    const tool = aiTool(agent.tool);
    if (!tool?.canRun) {
      const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
      throw new StepError(`The ${opts.role} agent is set to ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} in Squad and AI.`);
    }
    const extra = agentInstructions(agent, opts.step);
    const win = opts.win;
    const instructions = [opts.instructions, extra, win ? P.windowRule(win.tools) : ''].filter(Boolean).join('\n\n') || undefined;
    const access = win ? await windowAccess(win) : undefined;
    const key = opts.ticket;
    // The model level for this step: squad-kit's default, the project's choice, then this person's own.
    const ticket = key ? readTicket(this.bp, key) : null;
    const levelStep = opts.levelStep ?? opts.step ?? 'chat';
    const on = { quality: this.meta().quality, express: ticket?.track === 'express', fails: ticket?.fails };
    // The Reviewer is never on a weaker level than the Builder whose work it checks.
    const floor = opts.role === 'reviewer' ? { builder: builderLevel(on, readAgent(this.bp, 'builder').levels, personLevels()) } : {};
    const lv = resolveLevel({ role: opts.role, step: levelStep, ...on, ...floor }, agent.levels, personLevels());
    const effort = effortOn(tool, lv.effort);
    if (key && levelStep !== 'chat') this.update(key, (x) => addActivity(x, opts.role, `Runs on ${describeLevel(lv, tool)}`));
    opts = this.withNewNotes(opts);
    // The step's clock. A run beside the step (a chat answer, a change being written) has a job of its own and no clock.
    const timed = key && job === key ? timedStep(opts.step ?? levelStep) : null;
    if (timed) this.update(key!, (x) => startStep(x, { who: opts.role, step: timed, limit: Math.round((opts.timeoutMs ?? 20 * 60_000) / 60_000) }));
    const ended = (res: AgentResult): AgentResult => {
      if (timed) this.update(key!, (x) => endStep(this.bp, x));
      return res;
    };
    const watch = job ? { onActivity: () => this.dog.beat(job), onSpawn: (pid: number) => this.dog.track(job, pid) } : {};
    // The step's caps from the Quality setting, doubled for each Give it more on this same step.
    const raise = ticket?.capRaise?.role === opts.role && ticket.capRaise.step === levelStep ? ticket.capRaise.times : 0;
    const quality = this.meta().quality ?? DEFAULT_QUALITY;
    const caps = stepCaps({ role: opts.role, step: levelStep, quality }, raise);
    // Only the caps the tool keeps: a tool without a spend cap is held by its turns alone.
    const runCaps = { ...(tool.caps?.turns ? { turns: caps.turns } : {}), ...(tool.caps?.spend ? { spendUsd: caps.spendUsd } : {}) };
    const boxed = Boolean(opts.box && sandboxOf(tool).available);
    // A sandboxed step of a ticket gets the ticket's own package cache for the tools whose shared caches stay read only.
    const cache = boxed && key ? ticketCacheDir(this.bp, key) : undefined;
    if (cache) fs.mkdirSync(cache, { recursive: true });
    const sandbox = boxed ? this.sandboxFor(opts.cwd, opts.addDirs ?? [], cache) : undefined;
    // What the sandbox refused shows on the ticket in plain words, each thing once a run.
    const refused = new Set<string>();
    const onBlocked = (b: BlockedAction) => {
      if (!key || refused.has(`${b.kind}:${b.target}`) || refused.size >= 10) return;
      refused.add(`${b.kind}:${b.target}`);
      this.update(key, (x) => addActivity(x, opts.role, blockedLine(b)));
    };
    // Every role runs through the Agent Client Protocol unless the board says to run tools directly.
    const run = ({ win: _own, reply: _reply, check: _check, checkHelp: _help, ...o }: AgentRun & { win?: unknown; reply?: unknown; check?: unknown; checkHelp?: unknown }) => tool.run({
      ...o,
      ...watch,
      secretFiles: secretFiles(this.bp, opts.cwd),
      protectedFiles: this.protectedFiles(opts.cwd),
      ...(Object.keys(runCaps).length ? { caps: runCaps } : {}),
      ...(sandbox ? { sandbox, onBlocked } : {}),
      ...(sandbox && cache ? { env: packageCacheEnv(cache) } : {}),
      ...(instructions ? { instructions } : {}),
      level: lv.level,
      ...(effort ? { effort } : {}),
      ...(lv.model ? { model: lv.model } : {}),
      signal,
      ...(access ? { window: access } : {}),
      logDir: this.bp.chatsDir,
      direct: this.meta().runner === 'direct',
      onFallback: (why) => {
        this.log('warn', `ACP did not start, so the ${opts.role} runs ${tool.label} directly: ${why}`, key);
        if (key) this.update(key, (x) => addActivity(x, 'squad', 'squad-kit runs this step another way, as the usual way did not start'));
      },
    });
    const r = await run(opts);
    // What the run used, counted on the ticket (or the project's own line) even when the run failed.
    const used = { role: opts.role, step: levelStep, level: lv.level, model: lv.model || tool.modelFor(lv.level) };
    recordUsage(this.bp, key, used, r.usage);
    // ACP picks the id of a new conversation; keep the ticket pointing at it for follow-ups.
    const asked = opts.resume ?? opts.sessionId;
    if (key && asked && r.sessionId && r.sessionId !== asked) {
      this.update(key, (x) => {
        for (const k of Object.keys(x.sessions ?? {}) as (keyof NonNullable<Ticket['sessions']>)[]) {
          if (x.sessions?.[k] === asked) x.sessions[k] = r.sessionId;
        }
        if (x.chat?.side === asked) x.chat.side = r.sessionId;
        if (x.notesSeen?.[asked] !== undefined) x.notesSeen[r.sessionId!] = x.notesSeen[asked];
      });
    }
    const capped = (res: AgentResult) => new CapReached(opts.role, levelStep, res.capped!.by, caps, quality, AGENTS.find((a) => a.role === opts.role)?.name ?? opts.role);
    const who = AGENTS.find((a) => a.role === opts.role)?.name ?? opts.role;
    // squad-kit stopped an agent that kept asking for things it may not do: a plain stop, the details for engineers.
    // Or kept calling squad-kit's tools in the wrong shape: a plain stop of its own, not "may not do".
    const tooMany = () => (win?.tooMany ? new StepError(tooManyWords(who), win.refusalDetail()) : win?.tooManyMistakes ? new StepError(tooManyMistakesWords(who), win.mistakeDetail()) : null);
    if (tooMany()) throw tooMany();
    if (r.capped) throw capped(r);
    if (!r.ok) throw this.runFailed(r, tool, key, opts.role);
    if (raise && key) this.update(key, (x) => delete x.capRaise);
    // The answer is checked against its shape before anything uses it. A missing or broken one is asked for once more,
    // in the same conversation; then the step stops in words instead of failing on it further on.
    // `check` covers what the shape cannot say (a ticket name that is not on the board): asked once more, then let be.
    const problem = opts.schema ? (answerProblem(opts.schema, r.structured) ?? opts.check?.(r.structured) ?? null) : null;
    let done = r;
    if (opts.schema && problem) {
      if (key && levelStep !== 'chat') this.update(key, (x) => addActivity(x, opts.role, `The answer was not complete (${problem}), so squad-kit asked for it again`));
      const again = await run(r.sessionId ? { ...opts, sessionId: undefined, resume: r.sessionId, prompt: P.answerAgainPrompt(problem, opts.checkHelp?.()) } : opts);
      recordUsage(this.bp, key, used, again.usage);
      if (tooMany()) throw tooMany();
      if (again.capped) throw capped(again);
      if (!again.ok) throw this.runFailed(again, tool, key, opts.role);
      const broken = answerProblem(opts.schema, again.structured);
      if (broken) throw new StepError(`The ${who} did not hand in a complete answer.`, broken);
      done = again;
    }
    // A question for the person passes squad-kit's filter first: a technical one goes back to the agent (twice at
    // most), one that is not allowed is refused and counted (by the window; with none, it goes back twice at most
    // too). Neither ever reaches the person, and no run asks again without end.
    // A busy port in the Builder's way is squad-kit's to settle first (runBuilder): it never reaches the person as the
    // Builder wrote it, only as squad-kit's own plain card when another program holds it.
    const settles = opts.role === 'builder' ? (q: { text: string; options?: string[]; why?: string }) => Boolean(inTheWay(askText(q))) : undefined;
    for (let back = 0; ; ) {
      const found = opts.schema ? stoppedQuestion(done.structured, settles) : null;
      if (!found) return ended(opts.reply || opts.schema === P.CHAT_SCHEMA ? this.plainReply(done, who, opts.role, key) : done);
      const say = (text: string) => key && this.update(key, (x) => addActivity(x, opts.role, text));
      if (found.verdict.kind === 'not-allowed') {
        const line = refusedAskLine(who, found.verdict.what);
        if (win) win.refuse('question', `${found.verdict.why}: "${found.q.text.slice(0, 200)}"`, line);
        else {
          say(line);
          this.log('warn', `Refused the ${who}'s question in ${job ?? 'a run'}: ${found.verdict.why}: "${found.q.text.slice(0, 200)}"`, key);
          if (back >= TECHNICAL_TRIES) throw new StepError(tooManyWords(who), `${found.verdict.why}\n${found.q.text}`);
          back += 1;
        }
        if (tooMany()) throw tooMany();
      } else {
        if (back >= TECHNICAL_TRIES) {
          throw new StepError(`The ${who} kept asking a technical question, which squad-kit does not pass on to you, so it stopped this step. Press Try again.`, `${found.verdict.why}\n${found.q.text}`);
        }
        back += 1;
        say(`The ${who} asked a technical question, so squad-kit sent it back to it to decide: ${found.q.text.slice(0, 300)}`);
      }
      if (!done.sessionId) throw new StepError(`The ${who} stopped on a question squad-kit does not pass on to you. Press Try again.`, found.q.text);
      const next = await run({ ...opts, sessionId: undefined, resume: done.sessionId, prompt: questionBackPrompt(found) });
      recordUsage(this.bp, key, used, next.usage);
      if (tooMany()) throw tooMany();
      if (next.capped) throw capped(next);
      if (!next.ok) throw this.runFailed(next, tool, key, opts.role);
      const broken = answerProblem(opts.schema!, next.structured);
      if (broken) throw new StepError(`The ${who} did not hand in a complete answer.`, broken);
      done = next;
    }
  }

  /**
   * A run that did not finish. On the usage limit the whole queue waits for the reset; anything else stops the step,
   * with the tool's exact words kept for engineers.
   */
  private runFailed(r: AgentResult, tool: AiTool, ticket: string | undefined, role: AgentRole): Error {
    // What the run reported could not be saved: the exact error goes on, so the step can tell a full disk from a stop.
    if (r.saveError) return r.saveError;
    if (r.limit) {
      const pause = startPause(r.limit, { project: this.projectName(), ...(ticket ? { ticket } : {}) });
      this.log('warn', `${r.limit.name}'s usage limit is reached${pause.resetsAt ? ` until ${pause.resetsAt}` : ''}. The queue waits until ${pause.until}`, ticket);
      return new LimitReached(pause);
    }
    const said = r.error ?? `${tool.label} did not finish.`;
    this.log(said === STOPPED ? 'info' : 'error', `The ${role} run did not finish: ${r.detail ?? said}`, ticket);
    // Only squad-kit's own sentences reach the person as they are; the tool's own words stay for engineers.
    const who = AGENTS.find((a) => a.role === role)?.name ?? role;
    const plain = ownRunWords(said, tool) ? said : `The ${who} stopped before it finished, on something technical. Press Try again.`;
    const detail = plain === said ? r.detail : [said, r.detail].filter(Boolean).join('\n');
    if (tool.passing?.(said)) return new PassingTrouble(plain, detail);
    return new StepError(plain, detail);
  }

  /**
   * A reply in a talk with the person that asks them for what is not allowed (a secret, a change to squad-kit's
   * settings, to git history) is replaced with one plain line and logged. Technical words stay: the person asked.
   */
  private plainReply(r: AgentResult, who: string, role: AgentRole, ticket?: string): AgentResult {
    const out = r.structured && typeof r.structured === 'object' ? (r.structured as { reply?: unknown; options?: unknown }) : null;
    const said = [typeof out?.reply === 'string' ? out.reply : r.text, ...(Array.isArray(out?.options) ? out.options : [])].filter((x): x is string => typeof x === 'string').join('\n');
    const verdict = judgeReply(said);
    if (verdict.pass) return r;
    const line = refusedReplyLine(who, verdict.what);
    this.log('warn', `Left out the ${who}'s reply: ${verdict.why}: "${said.slice(0, 400)}"`, ticket);
    if (ticket) {
      try {
        this.update(ticket, (x) => addActivity(x, role, refusedAskLine(who, verdict.what)));
      } catch {
        // The ticket was removed meanwhile.
      }
    }
    return { ...r, text: line, ...(out ? { structured: { ...out, reply: line, options: [] } } : {}) };
  }

  /** What the person reads when an answer in a talk did not come: squad-kit's own words, or one plain line. */
  private couldNotAnswer(err: unknown, ticket: string, line: string): string {
    const own = ownWords(err);
    const { what, detail } = explainError(err);
    this.log('warn', `Could not answer: ${[what, detail].filter(Boolean).join('\n')}`, ticket);
    return own ? `Could not answer: ${own}` : line;
  }

  private projectName(): string {
    try {
      return readMeta(this.bp).project || this.bp.projectId;
    } catch {
      return this.bp.projectId;
    }
  }

  /** One line in the app log, with this project and the ticket. */
  private log(level: LogLevel, text: string, ticket?: string): void {
    writeLog({ level, project: this.projectName(), ...(ticket && !ticket.startsWith('__') ? { ticket } : {}), text });
  }

  /**
   * What no agent may change: squad-kit's own folder, the instructions and settings every AI tool loads, the project's
   * commit hooks with their settings, wherever `cwd`'s repo keeps them, and the copy's link to git's folder.
   */
  private protectedFiles(cwd?: string): string[] {
    return [...new Set([`${path.basename(this.bp.squadDir)}/`, '.git', ...AI_TOOLS.flatMap((t) => t.instructionFiles ?? []), ...hookFiles(cwd ?? projectRoot(this.bp)), ...offLimits(this.meta()).map((f) => `/${f}`)])];
  }

  /**
   * After a Builder, Tester or Reviewer step, in the ticket's copy: what the step may not change goes back, with a
   * line saying so, and a branch or commit that moved stops the ticket. `skip` holds folders the step may write in.
   */
  private keepLane(id: string, role: 'builder' | 'tester' | 'reviewer', lane: Lane, skip: string[] = []): void {
    const who = role === 'builder' ? 'Builder' : role === 'tester' ? 'Tester' : 'Reviewer';
    const c = checkLane(lane, skip);
    const some = (files: string[]) => `${files.slice(0, 6).join(', ')}${files.length > 6 ? ` and ${files.length - 6} more` : ''}`;
    // The Reviewer only reads: what changed there is the app's work, while the Reviewer looked at it.
    if (c.putBack.length) this.update(id, (x) => addActivity(x, role, `${role === 'reviewer' ? 'The app changed files while the Reviewer looked at it' : `The ${who} changed files`}; squad-kit put them back: ${some(c.putBack)}`));
    const hookNames = hookFiles(lane.dir);
    const hooks = c.restored.filter((f) => isHookFile(f, hookNames));
    const named = new Set(offLimits(this.meta()));
    const engineers = c.restored.filter((f) => named.has(f) && !hooks.includes(f));
    const instructions = c.restored.filter((f) => !hooks.includes(f) && !engineers.includes(f));
    if (engineers.length) {
      this.update(id, (x) => addActivity(x, role, `The ${who} changed ${some(engineers)}, which only an engineer changes; squad-kit put ${engineers.length === 1 ? 'it' : 'them'} back`));
    }
    if (instructions.length) {
      this.update(id, (x) => addActivity(x, role, `The ${who} changed ${some(instructions)}, which later steps read as instructions; squad-kit put ${instructions.length === 1 ? 'it' : 'them'} back`));
    }
    if (hooks.length) {
      this.update(id, (x) => addActivity(x, role, `The ${who} changed the project's own check (${some(hooks)}); squad-kit put it back. Changing that check stays with you or an engineer`));
    }
    if (c.moved) {
      this.update(id, (x) => addActivity(x, 'squad', `Stopped the ${who}: ${c.moved}`));
      throw new StepError(`The ${who} changed git history; squad-kit stopped it.`, c.moved);
    }
  }

  /**
   * Notes reach a running agent at a safe moment: the start of its next step. A fresh session reads every note in
   * its ticket context; a session that goes on gets only the ones added since its last step.
   */
  private withNewNotes<T extends { prompt: string; resume?: string; sessionId?: string; ticket?: string }>(opts: T): T {
    const session = opts.resume ?? opts.sessionId;
    if (!opts.ticket || !session) return opts;
    const t = readTicket(this.bp, opts.ticket);
    const notes = t?.notes ?? [];
    if (!t || !notes.length) return opts;
    const seen = opts.resume ? (t.notesSeen?.[session] ?? 0) : notes.length;
    this.update(t.id, (x) => (x.notesSeen = { ...x.notesSeen, [session]: notes.length }));
    const fresh = notes.slice(seen);
    return fresh.length ? { ...opts, prompt: `${opts.prompt}\n${P.notesText(fresh, true)}` } : opts;
  }

  /**
   * squad-kit's own guard blocked a file a project command needed outside its copy. The person sees one plain
   * sentence (never the path, never "sandbox") and Try again; Ask a question is at the top of the story as always.
   * Engineers get the exact path and the command. An engineer allows the file in Settings or with a terminal command.
   */
  private guardStop(id: string, retryPhase: string, target: string, command: string, output: string, guard: GuardSpec): void {
    this.log('warn', `Guard blocked ${target} at ${retryPhase}: ${command}`, id);
    const docker = blockedDocker(target, guard);
    try {
      this.update(id, (x) => {
        if (x.takenOver || (x.chat?.open && !x.chat.beside)) return;
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.retryPhase = retryPhase;
        x.status = docker ? 'Stopped: Docker was blocked' : 'Stopped: a file was blocked';
        x.stuck = {
          gate: 'checks',
          kind: 'guard',
          question: docker ? GUARD_BLOCKED_DOCKER : GUARD_BLOCKED,
          detail: `${guardBlockedDetail(target, command, guard)}\n\n${tail(output, 20)}`,
          options: [
            { do: 'retry', name: 'Try again', note: `After an engineer allows ${docker ? 'Docker' : 'the file'} in Settings.` },
            { do: 'plan', name: 'Send it back to the plan', note: `The Spec writer rewrites the plan so it does not need ${docker ? 'Docker' : 'that file'}.` },
          ],
        };
        x.waiting = { kind: 'stuck', summary: docker ? 'Docker was blocked; an engineer can allow it' : 'A file was blocked; an engineer can allow it' };
        addActivity(x, 'squad', docker ? "A check tried to use Docker, which is not open to the project's own commands" : 'A check needed a file outside its copy, and squad-kit blocked it');
      });
    } catch {
      // The ticket was removed while it ran.
    }
  }

  /** Something went wrong: stop and ask the person, with a way to try again. The exact error stays for engineers. */
  private fail(id: string, error: string, retryPhase: string, detail?: string): void {
    this.log(error.startsWith(STOPPED) ? 'info' : 'error', `Stopped at ${retryPhase}: ${error}${detail ? ` (${detail})` : ''}`, id);
    try {
      this.update(id, (t) => {
        if (t.takenOver || (t.chat?.open && !t.chat.beside)) return;
        t.live = false;
        t.squad = null;
        delete t.clock;
        t.retryPhase = retryPhase;
        t.status = 'Stopped, needs you';
        t.stuck = {
          question: error,
          ...(detail ? { detail } : {}),
          options: wayOptions({
            publish: retryPhase === 'publish',
            copy: Boolean(t.worktree && fs.existsSync(t.worktree)) && ['implement', 'test', 'review'].includes(t.stage),
          }),
        };
        t.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
        addActivity(t, 'squad', `Stopped: ${error}`);
      });
    } catch {
      // The ticket was removed while it ran.
    }
  }

  /**
   * A step reached one of its caps. The work so far is kept and it is not a failed try: the card offers Give it more
   * (the same step goes on, with twice the caps) or Stop.
   */
  private capPause(id: string, phase: string, cap: CapReached): void {
    this.log('warn', `Paused at ${phase}: ${cap.message}`, id);
    try {
      this.update(id, (x) => {
        // Like the usage limit: the step runs again from where it was, and the try it cut off does not count.
        let next = phase;
        if (phase === 'review' && x.reviewNotes?.length) next = 'review-fix';
        else if (phase === 'review' && x.reviewRound) x.reviewRound -= 1;
        if (phase === 'test') {
          x.tries = Math.max(0, (x.tries ?? 0) - 1);
          x.fails = Math.max(0, (x.fails ?? 0) - 1);
        }
        const same = x.capRaise?.role === cap.role && x.capRaise.step === cap.step;
        x.capRaise = { role: cap.role, step: cap.step, times: same ? x.capRaise!.times : 0 };
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.retryPhase = next;
        x.status = 'Paused at its limit, needs you';
        x.stuck = capCard(cap);
        x.waiting = { kind: 'stuck', summary: `The ${cap.who} reached its limit for this step` };
        addActivity(x, 'squad', `Paused: ${cap.message}`);
      });
    } catch {
      // The ticket was removed while it ran.
    }
  }

  /**
   * What a Builder or Tester step's commands may reach in the sandbox: its copy, the proof folder, the ticket's own
   * package cache and the registries.
   */
  private sandboxFor(cwd: string, read: string[], cache?: string) {
    return sandboxAsk({
      cwd,
      root: projectRoot(this.bp),
      read,
      proof: this.bp.proofDir,
      secrets: secretFiles(this.bp, cwd),
      hosts: this.meta().allowedHosts ?? [],
      ...(cache ? { cache } : {}),
    });
  }

  /**
   * The AI account hit its usage limit. The ticket waits with the whole queue and runs the same step again by itself
   * once the limit resets. Nothing failed, so it is not a failed try.
   */
  private waitForLimit(id: string, phase: string, pause: LimitPause): void {
    try {
      const t = readTicket(this.bp, id);
      if (!t) return;
      if (!held(t.status)) this.beforeQueue.set(id, t.status);
      const text = limitText(pause);
      const again = isLimitText(t.status);
      this.update(id, (x) => {
        // The step goes on where the limit cut it off, and the try it cut off does not count.
        let next = phase;
        if (phase === 'review' && x.reviewNotes?.length) next = 'review-fix';
        else if (phase === 'review' && x.reviewRound) x.reviewRound -= 1;
        if (phase === 'test') {
          x.tries = Math.max(0, (x.tries ?? 0) - 1);
          x.fails = Math.max(0, (x.fails ?? 0) - 1);
        }
        x.live = false;
        x.squad = { ...(x.squad ?? {}), phase: next, nextAt: now() };
        x.status = text;
        delete x.quiet;
        if (!again) addActivity(x, 'squad', `${text}, from this same step`);
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  }

  /* ── the project scan ────────────────────────────────── */

  private async scan(): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    meta.scan = { status: 'running', at: now() };
    // An AI tool installed since the board opened shows as ready now.
    meta.tools = AI_TOOLS.map((t) => ({ name: t.label, ready: t.ready() }));
    writeMeta(this.bp, meta);
    const architect = aiTool(readAgent(this.bp, 'architect').tool);
    readStarted(this.bp, { label: architect?.label ?? 'The AI tool', ready: Boolean(architect?.ready()) });
    const nested = workspaceRepos(root);
    await syncWiki(this.bp, undefined, true);
    // What the Architect is reading right now, for the setup page and the board's setup card.
    let last = 0;
    const opened = new Set<string>();
    const onTool = (e: ToolEvent) => {
      const line = describeToolEvent(e, root);
      if (line?.startsWith('Reading ')) opened.add(line.slice(8));
      if (!line || Date.now() - last < 700) return;
      last = Date.now();
      const m = this.meta();
      if (m.scan?.status !== 'running') return;
      // Plain words on the setup page and the board; what it opened stays behind "See what the Architect is reading".
      const shown = DOING.read;
      m.scan = { ...m.scan, now: shown };
      writeMeta(this.bp, m);
      readingNow(this.bp, shown, opened.size, line.startsWith('Running ') ? shown : line);
    };
    // Read again after "Something is wrong": what the person said goes with it. On a project with no code, what they want to build.
    const idea = readIdea(this.bp);
    const said = idea ? '' : readSaid(this.bp);
    try {
      const r = await this.runAgent({
        role: 'architect',
        step: 'scan',
        job: '__scan',
        cwd: root,
        prompt: P.scanPrompt(meta, nested, this.ctx(), said, idea),
        permissions: ['read'],
        schema: P.SCAN_SCHEMA,
        check: scanProblem,
        timeoutMs: 10 * 60_000,
        onTool,
      });
      if (opened.size) readingNow(this.bp, 'Handing in what it found', opened.size);
      saveScan(this.bp, r.structured as ScanAnswer, nested, undefined, idea);
      if (said || idea) readAgainDone(this.bp);
    } catch (err) {
      const fresh = this.meta();
      // The usage limit: the read starts again by itself once it resets.
      if (err instanceof LimitReached) {
        fresh.scan = { status: 'pending', at: now() };
        writeMeta(this.bp, fresh);
        return;
      }
      // The usual reason on a new computer, said plainly.
      const tool = aiTool(readAgent(this.bp, 'architect').tool);
      const missing = tool && !tool.ready() ? `${tool.label} is not installed on this computer. Install it and sign in once, then press Try again.` : null;
      const stopped = Boolean(fresh.setup?.stopping) || (err as Error).message === STOPPED;
      fresh.scan = { status: 'failed', at: now(), error: stopped ? 'You stopped it. Press Start again when you are ready.' : (missing ?? (err as Error).message) };
      writeMeta(this.bp, fresh);
      readFailed(this.bp, stopped ? STOPPED : (missing ?? (err as Error).message));
    }
  }

  /** The first run's proof: squad-kit takes one picture of the app it opened, with its own browser. No agent runs. */
  private async setupShot(o: { cwd: string; url: string; file: string; onLine?: (text: string) => void }): Promise<{ file?: string; why?: string }> {
    const signal = this.stops.get('__setup')?.signal;
    try {
      await takeOne(o.url, o.file, { ...(signal ? { signal } : {}), ...(o.onLine ? { onLine: o.onLine } : {}) });
      return { file: o.file };
    } catch (err) {
      if (signal?.aborted) throw err;
      this.log('warn', `The first run's screenshot did not work: ${shotsErrorDetail(err)}`);
      // The person reads squad-kit's own plain words; the exact error is in the app log.
      return { why: err instanceof ShotsUnavailable ? err.message : 'squad-kit could not take the picture this time' };
    }
  }

  /** "Something is wrong" on the overview: the Architect's answer, or its Stop. */
  private talk(): void {
    talkReply(this.bp, {
      running: this.running.has('__talk'),
      stop: () => this.stops.get('__talk')?.abort(),
      launch: (job) => this.launch('__talk', job),
      run: (o) => this.runAgent({ role: 'architect', step: 'chat', levelStep: 'chat', job: '__talk', cwd: projectRoot(this.bp), permissions: ['read'], schema: P.CHAT_SCHEMA, timeoutMs: 10 * 60_000, prompt: o.prompt }),
    });
  }

  /* ── the person's own checkout, after a merge ─────────── */

  private async localSetup(id: string): Promise<void> {
    const ls = readTicket(this.bp, id)?.localSetup;
    if (!ls) return;
    this.update(id, (x) => (x.localSetup = { dir: ls.dir, command: ls.command, status: 'running', at: now() }));
    // The person's own changes stay: what differed before the setup ran is theirs.
    const theirs = changedTracked(ls.dir);
    const r = await runCommand(ls.dir, ls.command, 20 * 60_000, this.guardFor(ls.dir, id) ? { guard: this.guardFor(ls.dir, id)! } : {});
    const seconds = Math.round(r.seconds);
    this.putBackLockFiles(id, ls.dir, theirs);
    this.update(id, (x) => {
      x.localSetup = { dir: ls.dir, command: ls.command, status: r.ok ? 'done' : 'failed', at: now(), seconds, ...(r.ok ? {} : { output: tail(r.output, 12) }) };
      addActivity(x, 'release', r.ok ? 'Your copy is ready' : 'Your copy could not be set up');
    });
    // The exact command is for engineers: here, and in the ticket's Developer tab.
    this.log(r.ok ? 'info' : 'warn', r.ok ? `Your copy is ready: ran ${ls.command} (${seconds} s)` : `Setting up your copy failed (${ls.command}): ${tail(r.output, 2)}`, id);
  }

  /**
   * A lock file the setup rewrote goes back, as in a story's copy, so the person's folder shows no change they did not
   * make. Only lock files here: this folder is the person's, so a file they saved while the setup ran looks just the
   * same as one the setup wrote, and a database the setup moved on must stay. The rest is said to engineers.
   */
  private putBackLockFiles(id: string, dir: string, theirs: string[]): void {
    const back = putBackTracked(dir, { keep: theirs, only: isLockFile });
    if (back.length) this.log('info', `The setup command changed ${back.join(', ')} in your folder; squad-kit put ${back.length === 1 ? 'it' : 'them'} back`, id);
    const left = changedTracked(dir).filter((f) => !theirs.includes(f));
    if (left.length) this.log('info', `${left.join(', ')} changed in your folder while the setup command ran; squad-kit left ${left.length === 1 ? 'it' : 'them'} as they are`, id);
  }

  /* ── stack and patterns, for the architecture page ──── */

  private async readBlueprint(): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    const decisions = listDecisions(this.bp);
    meta.blueprint = { stack: [], patterns: [], ...meta.blueprint, status: 'running' };
    writeMeta(this.bp, meta);
    // The code this read sees, so the next merge can tell whether files came, went or moved since.
    const commits = baseCommits(root, meta);
    try {
      const r = await this.runAgent({
        role: 'architect',
        step: 'blueprint',
        cwd: root,
        prompt: P.blueprintPrompt(meta, decisions, detectStack(root, meta).map((x) => x.name)),
        permissions: ['read'],
        schema: P.BLUEPRINT_SCHEMA,
        timeoutMs: 10 * 60_000,
      });
      const out = r.structured as { map: BoardMeta['map']; stack: StackNote[]; patterns: PatternNote[] };
      // Only links to decisions that exist, so a made-up id never shows on the page.
      const known = new Set(decisions.map((d) => d.id));
      const link = (id?: string) => (id && known.has(id) ? { decision: id } : {});
      const role = (r?: string) => TECH_ROLES.find((x) => x === r);
      const fresh = this.meta();
      if (out.map.length) fresh.map = out.map;
      fresh.blueprint = {
        status: 'done',
        at: now(),
        commits,
        stack: out.stack.map((x) => ({ name: x.name, why: x.why, ...(role(x.role) ? { role: role(x.role) } : {}), ...link(x.decision) })),
        patterns: out.patterns.map((x) => ({ name: x.name, what: x.what, where: x.where ?? [], ...link(x.decision) })),
      };
      writeMeta(this.bp, fresh);
      // The overview's picture of the parts follows the code.
      saveBlueprintParts(this.bp, r.structured);
    } catch (err) {
      const fresh = this.meta();
      fresh.blueprint = { stack: [], patterns: [], ...fresh.blueprint, status: 'failed', error: (err as Error).message };
      writeMeta(this.bp, fresh);
    }
  }

  /** A decision was approved: which tickets planned before it does it change? The person decides on each one. */
  private async checkImpact(adr: string): Promise<void> {
    const set = (change: (c: ImpactCheck) => void) => {
      const fresh = this.meta();
      const c = fresh.impactChecks?.find((x) => x.adr === adr);
      if (!c) return;
      change(c);
      writeMeta(this.bp, fresh);
    };
    const d = listDecisions(this.bp).find((x) => x.id === adr);
    if (!d) return set((c) => Object.assign(c, { status: 'failed', error: `${adr} is not saved.` }));
    const shipped = new Set(listReleases(this.bp).filter((r) => r.status === 'released').flatMap((r) => r.tickets));
    const open = listTickets(this.bp).filter(
      (t) =>
        t.id !== d.from &&
        !d.tickets.includes(t.id) &&
        !(t.follows ?? []).includes(adr) &&
        !t.outdated?.some((o) => o.adr === adr) &&
        t.stage !== 'done' &&
        !shipped.has(t.id) &&
        Boolean(t.steps?.length || t.work),
    );
    set((c) => Object.assign(c, { status: 'running', at: now() }));
    if (!open.length) return set((c) => Object.assign(c, { status: 'done', at: now(), checked: [], affected: [] }));
    try {
      const r = await this.runAgent({
        role: 'architect',
        step: 'blueprint',
        cwd: projectRoot(this.bp),
        prompt: P.impactPrompt(d, open),
        permissions: ['read'],
        schema: P.IMPACT_SCHEMA,
        timeoutMs: 10 * 60_000,
      });
      const out = (r.structured as { tickets: { id: string; affected: boolean; why: string; change: string }[] }).tickets;
      const affected = out.filter((x) => x.affected && x.change.trim() && open.some((t) => t.id === x.id));
      for (const x of affected) {
        this.update(x.id, (t) => {
          t.outdated = [...(t.outdated ?? []).filter((o) => o.adr !== adr), { adr, why: x.why, change: x.change, at: now() }];
          addActivity(t, 'architect', `${adr} came after this plan and changes it: ${x.why}`);
        });
      }
      set((c) => Object.assign(c, { status: 'done', at: now(), checked: open.map((t) => t.id), affected: affected.map((x) => x.id) }));
    } catch (err) {
      set((c) => Object.assign(c, { status: 'failed', at: now(), error: (err as Error).message }));
    }
  }

  private async writeTechDecision(tech: string): Promise<void> {
    const set = (change: (d: TechDraft) => void) => {
      const fresh = this.meta();
      const d = fresh.techDrafts?.find((x) => x.tech === tech);
      if (!d) return;
      change(d);
      writeMeta(this.bp, fresh);
    };
    try {
      const r = await this.runAgent({
        role: 'architect',
        step: 'blueprint',
        cwd: projectRoot(this.bp),
        prompt: P.techDecisionPrompt(listDecisions(this.bp), tech, this.meta().blueprint?.stack.find((s) => s.name === tech)?.why),
        permissions: ['read'],
        schema: P.TECH_DECISION_SCHEMA,
        timeoutMs: 10 * 60_000,
      });
      const out = r.structured as NonNullable<TechDraft['decision']>;
      set((d) => {
        d.status = 'ready';
        d.decision = { ...out, buildsOn: out.buildsOn ?? [] };
      });
    } catch (err) {
      set((d) => {
        d.status = 'failed';
        d.error = (err as Error).message;
      });
    }
  }

  /** One step of the Analyst's work on a breakdown: read only, in the project, with the breakdown's folder beside it. */
  private breakdownJob(id: string): Promise<void> {
    const key = `__breakdown:${id}`;
    const signal = this.stops.get(key)?.signal;
    return runBreakdownJob(this.bp, id, {
      ...(signal ? { signal } : {}),
      run: (o) =>
        this.runAgent({
          role: 'analyst',
          job: key,
          step: o.step,
          cwd: projectRoot(this.bp),
          prompt: o.prompt,
          permissions: ['read'],
          addDirs: [breakdownDir(this.bp, id)],
          timeoutMs: o.timeoutMs,
          ...(o.schema ? { schema: o.schema } : { reply: true }),
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          ...(o.resume ? { resume: o.resume } : {}),
          ...(o.onTool ? { onTool: o.onTool } : {}),
          ...(o.onText ? { onText: o.onText } : {}),
        }),
    });
  }

  /* ── one step of a ticket ────────────────────────────── */

  private async step(id: string, phase: string): Promise<void> {
    this.update(id, (t) => {
      if (t.squad) t.squad.nextAt = new Date(Date.now() + 3_600_000).toISOString();
      // Another step than the one cut off: that interruption is over.
      if (t.interrupted && !carriesOn(t, phase)) delete t.interrupted;
    });
    // What the last board left running in squad-kit's copies is stopped first.
    await this.swept;
    // On an API key past a budget, the ticket waits for the person here, between two steps.
    if (await budgetStop(this.bp, id, phase, async () => (await howPaid(this.bp)).payment)) return;
    this.log('info', `Step ${phase} started`, id);
    switch (phase) {
      case 'analyst-read':
        return this.intake(id);
      case 'triage':
        return this.triage(id);
      case 'plan-write':
        return needsSpec(readTicket(this.bp, id)!) ? this.spec(id) : this.plan(id);
      case 'spec-rewrite':
        return this.spec(id, readTicket(this.bp, id)?.changeRequest);
      case 'plan-rewrite':
        return this.plan(id, readTicket(this.bp, id)?.changeRequest);
      case 'express-approve':
        approveExpress(this.bp, id);
        return;
      case 'accept':
        // Builds by itself: the squad's own Looks right, once the checks, the review and the proof passed.
        await acceptByItselfBeside(this.bp, id, this.stops.get(id)?.signal);
        return;
      case 'build':
      case 'unstick':
        return this.build(id);
      case 'pick-up':
        return this.pickedUp(id);
      case 'fix':
        return this.fixFromPerson(id);
      case 'answered-builder':
        return this.builderAnswered(id);
      case 'answered-reviewer':
        return this.review(id, true);
      case 'answered-architect':
        return this.plan(id, undefined, true);
      case 'chat-spec':
        return this.spec(id, undefined, true);
      case 'chat-design':
        return this.plan(id, undefined, false, true);
      case 'chat-carry-builder':
        return this.carryOnBuilder(id);
      case 'chat-carry-reviewer':
        return this.review(id, true, true);
      case 'chat-carry-tester':
        return this.proof(id);
      case 'change-design':
        return this.changeDesign(id);
      case 'change-build':
        return this.changeBuild(id);
      case 'test':
        return this.checks(id);
      case 'review':
        return this.review(id);
      case 'review-fix':
        return this.reviewFix(id);
      case 'restore-tests':
        return this.restoreTests(id);
      case 'update-base':
        // Builds by itself: a story landing right now goes first, so the base comes in once, with its work too.
        if (waitForLanding(this.bp, id)) return;
        return this.updateBase(id);
      case 'proof':
        return this.proof(id);
      case 'proof-fix':
        return this.proofFix(id);
      case 'publish': {
        // A release going out moves the base on the code host: the pull request merges once it is out (one lock).
        const going = releaseGoingOut(this.bp);
        if (going) {
          this.update(id, (t) => {
            t.status = `Merges once ${going} is out`;
            if (t.squad) t.squad.nextAt = new Date(Date.now() + 15_000).toISOString();
          });
          return;
        }
        const { clash } = await publishTicket(this.bp, id);
        // Builds by itself: a clash brings in the base again; a pull request waiting for its approver is a normal wait.
        if (clash) return this.pullRequestClash(id);
        afterPullRequest(this.bp, id, false);
        return;
      }
      default:
        this.update(id, (t) => (t.squad = null));
    }
  }

  /** Voice and video notes become text and pictures before any agent reads the ticket (agents cannot listen). */
  private async hearNotes(id: string): Promise<void> {
    const files = readTicket(this.bp, id)?.attachments ?? [];
    if (!files.some((f) => isMediaNote(f))) return;
    this.update(id, (t) => (t.status = 'Writing out the voice and video notes'));
    const r = await prepareMedia(this.bp, files);
    if (!r.notes.length) return;
    this.update(id, (t) => {
      t.attachments = [...new Set([...(t.attachments ?? []), ...r.added])];
      for (const n of r.notes) addActivity(t, 'squad', n);
    });
  }

  private async triage(id: string): Promise<void> {
    this.update(id, (t) => {
      const priority = t.severity === 'stops-work' ? 'high' : t.severity === 'small' ? 'low' : 'normal';
      t.priority = priority;
      const label = priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium';
      addActivity(t, 'triage', `Sorted the bug. Priority: ${label}${t.foundIn ? `. Linked to ${t.foundIn}` : ''}`);
      t.status = `Sorted as ${label.toLowerCase()} priority`;
      t.stage = 'tickets';
      scheduleSquad(t, 'analyst-read', 1, 1, 0);
    });
  }

  private async intake(id: string): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    await this.hearNotes(id);
    const track = readTicket(this.bp, id)?.track;
    if (track === 'express' || track === 'auto') {
      this.update(id, (t) => {
        t.questions = [];
        t.stage = 'specs';
        t.live = true;
        t.status = track === 'auto' ? 'Architect is choosing the design' : 'Spec writer is writing the plan';
        addActivity(t, 'squad', track === 'auto' ? NO_QUESTIONS : 'Express track: no questions, straight to the plan');
        scheduleSquad(t, 'plan-write', 0.2, 1);
      });
      return;
    }
    // After a talk with the Analyst its session exists already: go on in it, so it remembers what you said.
    const had = readTicket(this.bp, id)?.sessions?.intake;
    const t0 = this.update(id, (t) => {
      t.stage = 'tickets';
      t.live = true;
      t.status = 'Analyst is reading the ticket';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const r = await this.runAgent({
      role: 'analyst',
      step: 'questions',
      ticket: id,
      cwd: root,
      ...(had ? { resume: had } : { sessionId: t0.sessions!.intake }),
      prompt: P.intakePrompt(meta, listDecisions(this.bp), t0, this.ctx()),
      permissions: ['read'],
      schema: P.QUESTIONS_SCHEMA,
      timeoutMs: 10 * 60_000,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'analyst', root),
    });
    const out = r.structured as { summary: string; questions: { from: 'analyst' | 'architect'; text: string; options: string[]; typedOption?: string }[] };
    this.update(id, (t) => {
      addActivity(t, 'analyst', out.summary);
      if (!out.questions.length) {
        t.questions = [];
        t.stage = 'specs';
        t.status = 'Spec writer is writing the plan';
        scheduleSquad(t, 'plan-write', 0.5, 1);
        return;
      }
      t.questions = out.questions.map((q, i): Question => {
        const options = [...q.options];
        // An option ending in ":" asks for a typed value, even when the model forgets to say so.
        const typed =
          (q.typedOption && options.find((o) => o.replace(/:$/, '') === q.typedOption!.replace(/:$/, ''))) ||
          options.find((o) => o.trim().endsWith(':'));
        return { id: `q${i + 1}`, from: q.from, text: q.text, options, ...(typed ? { inputOption: typed } : {}) };
      });
      t.stage = 'specs';
      t.live = false;
      t.status = `${t.questions.length} questions for you`;
      t.waiting = { kind: 'questions', summary: `${t.questions.length} questions from the Analyst and Architect` };
      t.squad = null;
      addActivity(t, 'analyst', `Asked ${t.questions.length} questions`);
    });
  }

  private async reply(id: string, qid: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const q = t.questions!.find((x) => x.id === qid)!;
    const ask = [...(q.thread ?? [])].reverse().find((m) => m.who === 'you')?.text ?? '';
    const n = t.questions!.indexOf(q) + 1;
    try {
      const r = await this.runAgent({
        role: 'analyst',
        step: 'questions',
        ticket: id,
        cwd: projectRoot(this.bp),
        resume: t.sessions?.intake,
        prompt: P.replyPrompt(q, n, ask),
        permissions: ['read'],
        timeoutMs: 5 * 60_000,
        reply: true,
      });
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: qq.from, text: r.text.trim(), at: now() }];
        qq.thinking = false;
      });
    } catch (err) {
      // The usage limit: the answer comes once it resets.
      if (err instanceof LimitReached) return;
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: 'squad', text: this.couldNotAnswer(err, id, 'Could not answer this time. Ask again in a moment.'), at: now() }];
        qq.thinking = false;
      });
    }
  }

  /**
   * One reply in a talk with the person, in the agent's own session (a new one for the Analyst when you talk first).
   * Beside the work the agent talks in a side session of its own, so the session that works is never touched.
   * The agent only talks and reads; it never moves the ticket on.
   */
  private async chatReply(id: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const c = t.chat!;
    const beside = Boolean(c.beside);
    const key = CHAT_SESSION[c.with];
    const had = beside ? c.side : t.sessions?.[key];
    const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
    const cwd = later && t.worktree && fs.existsSync(t.worktree) ? t.worktree : projectRoot(this.bp);
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
    const look = beside && (review || (t.worktree && fs.existsSync(t.worktree)) || proofPages(t).length) ? reviewLook(this.bp, t) : undefined;
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
        timeoutMs: 10 * 60_000,
        // Beside the work, the Analyst and the Architect may read the code built so far to answer.
        addDirs: [...attachmentDirs(t), ...(beside && t.worktree && cwd !== t.worktree && fs.existsSync(t.worktree) ? [t.worktree] : [])],
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
      });
    } catch (err) {
      const after = readTicket(this.bp, id);
      if (after?.chat?.stopping) return this.chatStopped(id);
      if (err instanceof LimitReached && after) return this.chatWaits(after, err.pause);
      this.update(id, (x) => {
        if (!x.chat) return;
        x.chat.messages.push({ who: 'squad', text: this.couldNotAnswer(err, id, 'Could not answer this time. Press Try again.'), at: now(), note: 'failed' });
        x.chat.thinking = false;
      });
    }
  }

  /** The chat's answer waits for the usage limit to reset; the chat says until when. */
  private chatWaits(t: Ticket, pause: LimitPause): void {
    if (!t.chat || !chatWaitNote(t.chat, pause)) return;
    this.update(t.id, (x) => {
      const n = x.chat && chatWaitNote(x.chat, pause);
      if (!n || !x.chat) return;
      if (n.replace) x.chat.messages[x.chat.messages.length - 1] = n.message;
      else x.chat.messages.push(n.message);
      x.chat.thinking = true;
    });
  }

  /** You pressed Stop on an answer: the talk stays open, with a way on. */
  private chatStopped(id: string): void {
    this.update(id, (x) => {
      const c = x.chat;
      if (!c) return;
      if (c.thinking && c.open) c.messages.push({ who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' });
      c.thinking = false;
      c.stopping = undefined;
    });
  }

  /** Done talking with the Builder: it carries on in the same session with what you agreed, then the checks run. */
  private async carryOnBuilder(id: string): Promise<void> {
    await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
    });
    await this.runBuilder(id, P.chatCarryOnPrompt('builder'), true, 'build');
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Carried on with what you agreed');
      x.stage = 'test';
      x.status = 'Running the project checks';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.reviewRound = 0;
      x.proof = undefined;
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /* ── a change goes through the spec ──────────────────── */

  /**
   * An approved change comes in between steps. A big one sends the ticket to the Architect first; a small one goes to
   * the Builder: inside its next step when that is the Builder's, or as a step of its own before anything else.
   */
  private phaseFor(t: Ticket): string {
    const phase = t.squad!.phase;
    const work = changeWork(t);
    if (!work || phase.startsWith('change-')) return phase;
    if (work === 'design') return 'change-design';
    return openChange(t)!.size === 'big' || !BUILDER_PHASES.has(phase) ? 'change-build' : phase;
  }

  /** An approved change on a ticket where nothing runs starts now, unless the ticket waits on you for something else. */
  private pickUpChange(t: Ticket): void {
    const work = changeWork(t);
    if (!work || t.takenOver || (t.waiting && t.waiting.kind !== 'proof')) return;
    this.update(t.id, (x) => {
      const c = openChange(x);
      if (!c) return;
      // The proof waiting for you does not show the change: it comes again after. Kept, so a withdrawn change gives it back.
      if (x.waiting) c.paused = { waiting: x.waiting };
      x.waiting = null;
      x.live = true;
      scheduleSquad(x, work === 'design' ? 'change-design' : 'change-build', 0.2, 1);
    });
  }

  /**
   * The Analyst writes a proposed change into the spec, beside the work, in a conversation of its own: the old and new
   * words of each part it touches, and whether it is small or big. The old words come from the ticket itself.
   */
  private async writeChange(id: string): Promise<void> {
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
        timeoutMs: 10 * 60_000,
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
  }

  /**
   * A big change: the Builder's step has ended, so it pauses here while the Architect updates the design. The update
   * waits for you; on approval the Builder redoes only the steps it touches.
   */
  private async changeDesign(id: string): Promise<void> {
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
      timeoutMs: 10 * 60_000,
      addDirs: this.extraDirs(t0).concat(t0.worktree && fs.existsSync(t0.worktree) ? [t0.worktree] : []),
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
  }

  /** The Builder makes an approved change: a small one as a step of its own, a big one by redoing only what it touches. */
  private async changeBuild(id: string): Promise<void> {
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
  }

  /** Full track, step one: the Analyst writes the what (story, done when). You approve it before any design. */
  private async spec(id: string, change?: string, fromChat = false): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.stage = 'specs';
      t.live = true;
      t.status = change ? 'Analyst is updating the spec' : 'Analyst is writing the spec';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const resume = fromChat || Boolean(t0.activity.some((a) => a.who === 'analyst'));
    // The other open tickets, so the spec does not do what one of them already does (E5).
    const others = openTicketsFor(this.bp, t0);
    const r = await this.runAgent({
      role: 'analyst',
      step: 'spec',
      ticket: id,
      cwd: root,
      ...(resume ? { resume: t0.sessions!.intake } : { sessionId: t0.sessions!.intake }),
      prompt: resume
        ? P.specPrompt(t0, change, fromChat, others)
        : `${P.intakePrompt(this.meta(), listDecisions(this.bp), t0, this.ctx())}\n\n${P.specPrompt(t0, change, false, others)}`,
      permissions: ['read'],
      schema: P.SPEC_SCHEMA,
      timeoutMs: 10 * 60_000,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'analyst', root),
    });
    const out = r.structured as { story: string; criteria: { given: string; when: string; then: string }[]; releaseNote: string };
    this.update(id, (t) => {
      t.story = out.story;
      t.criteria = out.criteria;
      t.releaseNote = out.releaseNote;
      applyPlanEdits(t);
      delete t.decision;
      delete t.steps;
      delete t.work;
      addActivity(t, 'analyst', fromChat ? (t.planReview?.before ? 'Updated the spec from your talk' : 'Wrote the spec from your talk') : change ? `Updated the spec: ${changeSummary(change)}` : 'Wrote the spec');
      t.changeRequest = undefined;
      t.live = false;
      t.status = 'Spec ready for you';
      t.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
      t.squad = null;
    });
  }

  private async plan(id: string, change?: string, answered = false, fromChat = false): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.stage = 'specs';
      t.live = true;
      t.status = change ? (t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan') : 'Architect is choosing the design';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    // An answer to the Architect's own question goes on in its conversation (Builds by itself has no Analyst lines).
    const resume = fromChat || answered || Boolean(readTicket(this.bp, id)?.activity.some((a) => a.who === 'analyst'));
    // Full track: the spec is approved, so the Architect writes only the design. Express writes both at once.
    const design = Boolean(t0.specApproved);
    const asked = answered ? t0.agentQuestion : undefined;
    // The other open tickets and the files their branches changed: the design names the ones it needs (E5).
    const others = openTicketsFor(this.bp, t0);
    const ask = `${asked ? `${P.answerPrompt(asked, 'architect')}\n\n` : ''}${design ? P.designPrompt(t0, change, this.meta(), fromChat, others) : P.planPrompt(t0, change, this.meta(), others)}`;
    // Builds by itself: the Architect plans with the breakdown in view, and may read the document's text and pictures.
    const brd = t0.track === 'auto' ? A.breakdownFor(this.bp, t0) : null;
    const brief = brd ? A.autoArchitectPrompt(this.meta(), listDecisions(this.bp), t0, this.ctx(), brd.text) : P.intakePrompt(this.meta(), listDecisions(this.bp), t0, this.ctx());
    const r = await this.runAgent({
      role: 'architect',
      step: 'design',
      ticket: id,
      cwd: root,
      ...(resume ? { resume: t0.sessions!.intake } : { sessionId: t0.sessions!.intake }),
      prompt: resume ? ask : `${brief}\n\n${ask}`,
      permissions: ['read'],
      schema: design ? P.DESIGN_SCHEMA : P.PLAN_SCHEMA,
      check: (a) => dependsProblem(a, others.map((o) => o.id), id),
      timeoutMs: 10 * 60_000,
      addDirs: [...attachmentDirs(t0), ...(brd?.dirs ?? [])],
      onTool: this.watcher(id, 'architect', root),
    });
    const out = r.structured as {
      question?: AgentAsk;
      mockup?: string;
      story?: string;
      criteria?: { given: string; when: string; then: string }[];
      decision?: { title: string; options: { name: string; note: string; chosen: boolean }[]; why: string; clientCheck?: string; replaces?: string; area?: DecisionArea };
      follows?: string[];
      dependsOn?: string[];
      steps: string[];
      tests: number;
      screens: number;
      releaseNote?: string;
      commands?: ProjectCommands;
      repo?: string;
      decided?: string[];
    };
    if (design) this.askIfNeeded(id, 'architect', out.question);
    const mockup = out.mockup?.trim() && out.screens > 0 ? this.saveMockup(id, out.mockup) : undefined;
    const meta = this.meta();
    const repo = meta.repos?.length ? (meta.repos.find((r) => r.path === out.repo?.replace(/\/$/, ''))?.path ?? meta.repos[0]!.path) : undefined;
    // A new test command waits for the checks to want it, a different one for squad-kit to try it (see not-checked.ts);
    // the others apply at once.
    const held = holdTestCommand((repo && meta.repos ? meta.repos.find((r) => r.path === repo)?.commands : meta.commands) ?? {}, clean(out.commands ?? {}));
    if (Object.values(held.apply).some(Boolean)) {
      if (repo && meta.repos) {
        meta.repos = meta.repos.map((r) => (r.path === repo ? { ...r, commands: { ...r.commands, ...held.apply } } : r));
      } else {
        meta.commands = { ...(meta.commands ?? {}), ...held.apply };
      }
      writeMeta(this.bp, meta);
    }
    if (held.change) this.log('info', `The design changes the test command from "${held.change.from}" to "${held.change.to}"`, id);
    this.update(id, (t) => {
      if (repo) t.repo = repo;
      if (held.suggest) t.testSuggestion = held.suggest;
      // A different test command is tried at the checks, after the build; until then the checks keep the current one.
      if (held.change) {
        t.testChange = { ...held.change, ...(repo ? { repo } : {}), at: now() };
        addActivity(t, 'architect', 'The design changes how the tests run. squad-kit tries the new way after the build');
      } else delete t.testChange;
      if (!design) {
        t.story = out.story;
        t.criteria = out.criteria;
        t.releaseNote = out.releaseNote;
      }
      t.agentQuestion = undefined;
      if (mockup) {
        t.mockup = mockup;
        addActivity(t, 'architect', 'Made a mockup of how the screen will look');
      } else if (!out.screens) delete t.mockup;
      if (out.decision) t.decision = { ...out.decision };
      else delete t.decision;
      const known = new Set(listDecisions(this.bp).map((d) => d.id));
      t.follows = [...new Set(out.follows ?? [])].filter((x) => known.has(x));
      t.dependsOn = designDepends(this.bp, t, out.dependsOn);
      if (t.decision?.replaces && !known.has(t.decision.replaces)) delete t.decision.replaces;
      t.steps = out.steps.map((s) => ({ title: s, status: 'todo' }));
      applyPlanEdits(t);
      t.work = { steps: out.steps.length, tests: Math.max(0, out.tests), screens: Math.max(0, out.screens) };
      addActivity(t, design ? 'architect' : 'spec', change ? `Updated the ${design ? 'design' : 'plan'}: ${changeSummary(change)}` : design ? 'Wrote the design' : 'Wrote the plan');
      if (design) addDecided(t, 'architect', out.decided);
      if ((t.track === 'express' || t.track === 'auto') && !change) {
        t.status = t.track === 'auto' ? APPROVING : 'Express track: approving the plan';
        scheduleSquad(t, 'express-approve', 0.2, 1);
        return;
      }
      t.live = false;
      t.status = design ? 'Design ready for you' : 'Plan ready for you';
      t.waiting = { kind: 'plan', summary: design ? 'The design is ready: is this how to build it?' : 'The plan is ready for your approval' };
      t.squad = null;
    });
  }

  /** Make (or reuse) the ticket's worktree and set it up once. */
  private async workspace(id: string): Promise<Ticket> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    let t = readTicket(this.bp, id)!;
    const repo = repoFor(meta, t);
    if (t.worktree && fs.existsSync(t.worktree)) {
      this.mendCopy(t);
      this.placeLocalFiles(id, t.worktree, repo.path);
      return t;
    }
    // A new copy starts from the newest base, the remote's when the team moved it on; or from the work of the ticket
    // it depends on, when the person chose to build on that ticket's branch.
    const dep = dependencyToStartFrom(this.bp, t);
    const wt: { dir: string; branch: string; baseCommit: string; pushed?: string; from?: string } = dep
      ? addWorktreeOn(this.bp, t, dep)
      : addWorktree(path.join(root, repo.path), id, repo.base, await fetchBase(this.bp, t));
    t = this.update(id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = x.baseCommit ?? wt.baseCommit;
      addActivity(
        x,
        'builder',
        wt.from
          ? `Made a copy of ${repo.path === '.' ? 'the project' : repo.path} from ${wt.from}, on branch ${wt.branch}`
          : wt.pushed
          ? `Made a copy of ${repo.path === '.' ? 'the project' : repo.path} from the pushed branch ${wt.pushed}, with the work so far`
          : `Made a clean copy of ${repo.path === '.' ? 'the project' : repo.path} on branch ${wt.branch}`,
      );
    });
    // The ticket's documents so far go on its branch first (ADR-001), when the project keeps them in git.
    const saved = commitTicketDocs(this.bp, t, wt.pushed ? 'picked up from the pushed branch' : t.specApproved ? 'spec and design approved' : 'plan approved');
    if (saved) t = this.update(id, (x) => addActivity(x, 'squad', `Saved the spec and design on ${wt.branch} as commit ${saved}`));
    this.placeLocalFiles(id, wt.dir, repo.path);
    const setup = repo.commands.setup?.trim();
    if (setup) {
      this.update(id, (x) => (x.status = DOING.setup));
      this.log('info', `Setting up the copy: ${setup}`, id);
      const r = await runCommand(wt.dir, setup, 20 * 60_000, this.guardedWatch(id, wt.dir));
      this.goOn(id);
      // A new project has nothing to set up yet; the Builder creates it in this ticket.
      if (!r.ok && !meta.scan?.empty) {
        // Only an engineer can allow Docker. Anything else is technical, so it never stops the story for the person.
        const docker = dockerBlockedWords(r.output, this.guardFor(wt.dir, id));
        if (docker) throw new StepError(docker, `${setup}:\n${tail(r.output, 30)}`);
        this.update(id, (x) => {
          x.setupTrouble = { command: setup, output: tail(r.output, 30) };
          addActivity(x, 'squad', 'Setting up the copy did not work on this computer. The Builder sorts that out first.');
        });
      }
      // What the setup rewrote (a lock file, often) is not the story's work: it goes back before anyone reads the copy.
      const back = putBackTracked(wt.dir);
      if (back.length) this.log('info', `The setup command changed ${back.join(', ')}; squad-kit put ${back.length === 1 ? 'it' : 'them'} back`, id);
    }
    return readTicket(this.bp, id)!;
  }

  /** A repo's local files go in the story's copy. One with no values yet is said once: the app may not start without it. */
  private placeLocalFiles(id: string, dir: string, repo: string): void {
    const { missing } = placeStoryFiles(this.bp, repo, dir);
    if (!missing.length) return;
    const line = `An engineer has not given stories their values for ${missing.join(', ')} yet, so the app may not start here.`;
    if (!readTicket(this.bp, id)?.activity.some((a) => a.text === line)) this.update(id, (x) => addActivity(x, 'squad', line));
  }

  /** A ticket that came from a pushed branch: its copy of the code comes from that branch, then it carries on. */
  private async pickedUp(id: string): Promise<void> {
    const t = await this.workspace(id);
    const next = carryOn(t, true);
    this.update(id, (x) => {
      x.status = next.status;
      x.waiting = next.waiting ?? null;
      x.live = Boolean(next.phase);
      if (next.phase) scheduleSquad(x, next.phase, 0.2, 1);
      else x.squad = null;
    });
  }

  private async build(id: string): Promise<void> {
    // A ticket it depends on is not merged, and nobody chose how to build yet: it waits for the person.
    if (holdBuild(this.bp, id)) return;
    const t0 = await this.workspace(id);
    this.goOn(id);
    if (t0.replanFor) return this.rebuild(id, t0.replanFor);
    const meta = this.meta();
    const rc = repoFor(meta, t0).commands;
    // Work already in the copy (it came with a pushed branch): no "before" screens of it, and a fresh Builder reads it.
    const sofar = t0.baseCommit ? workSoFar(t0.worktree!, t0.baseCommit) : [];
    if (!sofar.length && !t0.proof?.length && t0.baseCommit && rc.start && rc.url && (t0.work?.screens ?? 0) > 0 && !meta.scan?.empty) {
      // Beside the build, never before it: the Builder starts now.
      this.shootBefore(id);
    }
    const had = t0.sessions?.build;
    const t = this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = `Step ${openStep(x)} of ${x.steps?.length ?? 1}`;
      x.sessions = { ...x.sessions, build: x.sessions?.build ?? randomUUID() };
      x.tries = 0;
      x.reviewRound = 0;
    });
    // Only a conversation saved on this computer can go on; a ticket picked up from a branch starts a fresh one.
    const resume = Boolean(had) && t.activity.some((a) => a.who === 'builder' && a.text.startsWith('Started'));
    // Cut off by a restart, a Stop or sleep: it carries on with the step it was on, and says why, once.
    const cut = resume ? carriesOn(t, 'build') : undefined;
    this.update(id, (x) => addActivity(x, 'builder', cut ? carryOnLine(x, cut.by) : resume ? 'Picked up where it stopped' : sofar.length ? 'Started again from the spec, the design and the work so far' : 'Started building'));
    const base = repoFor(meta, t).base;
    const intro = `This ticket is partly built already: the work so far is in this copy, on ${t.branch}. It was done in another session, maybe on another computer, so you have no conversation about it. Files changed so far: ${sofar.slice(0, 30).join(', ')}. Read the spec, the design and that code first (git log and git diff against ${base} show it). Keep what is done and right, then finish the steps that are not done yet. squad-kit does all the git.`;
    // The plan changed since this conversation got it (sent back to the plan, a new design): it gets the new one.
    const plan = planKey(t);
    const replanned = resume && t.builtPlan !== undefined && t.builtPlan !== plan;
    const changed = 'The plan changed since you last worked on this ticket. From now on follow the plan below, not the earlier one: keep the work that still fits it, change what does not, then finish the steps that are not done yet.';
    const prompt =
      resume && !replanned
        ? cut ? carryOnPrompt(t, cut.by) : 'Continue the steps that are not done yet, then run the tests.'
        : `${replanned ? `${changed}\n\n` : sofar.length ? `${intro}\n\n` : ''}${P.buildPrompt(meta, listDecisions(this.bp), t, this.ctx(t))}`;
    this.update(id, (x) => {
      x.builtPlan = plan;
      if (replanned) addActivity(x, 'builder', 'Got the new plan');
    });
    await this.runBuilder(id, prompt, resume, 'build');
    this.update(id, (x) => {
      for (const s of x.steps ?? []) {
        s.status = 'done';
        s.live = undefined;
      }
      x.progress = 100;
      addActivity(x, 'builder', 'Finished all steps');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * Runs (or continues) the Builder's conversation and maps its ">> step N" lines to the plan. An approved small change
   * reaches the Builder here, at a safe moment: the start of a step, before that step's own work.
   */
  private async runBuilder(id: string, prompt: string, resume: boolean, step: 'build' | 'fix' = 'fix', settled = 0, told = new Set<string>()): Promise<void> {
    const change = this.handChange(id);
    const t = readTicket(this.bp, id)!;
    const cwd = t.worktree!;
    const started = Date.now();
    let current = -1;
    const lane = watchLane(cwd, this.protectedFiles(cwd));
    const r = await this.runAgent({
        role: 'builder',
        step,
      ticket: id,
      cwd,
      ...(resume ? { resume: t.sessions!.build } : { sessionId: t.sessions!.build }),
      prompt: change ? [P.smallChangePrompt(change), prompt].filter(Boolean).join('\n\n') : prompt,
      permissions: ['edit'],
      schema: P.BUILD_SCHEMA,
      timeoutMs: 60 * 60_000,
      addDirs: this.extraDirs(t),
      box: {},
      onText: (text) => {
        const m = [...text.matchAll(/>>\s*step\s+(\d+)/gi)].pop();
        if (!m) return;
        const n = Number(m[1]) - 1;
        if (n === current) return;
        current = n;
        this.update(id, (x) => {
          const steps = x.steps ?? [];
          steps.forEach((s, i) => {
            if (i < n && s.status !== 'done') {
              s.status = 'done';
              s.live = undefined;
              s.minutes = Math.max(1, Math.round((Date.now() - started) / 60000 / Math.max(1, n)));
              addActivity(x, 'builder', `Finished step ${i + 1}: ${s.title}`);
            }
          });
          const s = steps[n];
          if (s && s.status !== 'doing') {
            s.status = 'doing';
            addActivity(x, 'builder', `Started step ${n + 1}: ${s.title}`);
          }
          x.progress = Math.round((n / Math.max(1, steps.length)) * 100);
          x.status = `Step ${n + 1} of ${steps.length}`;
          nextPart(this.bp, x, n + 1);
        });
      },
      onTool: this.watcher(id, 'builder', cwd, (line, x) => {
        const doing = x.steps?.find((s) => s.status === 'doing');
        if (doing) doing.live = line;
      }),
    })
      .finally(() => this.keepLane(id, 'builder', lane))
      .catch((err: unknown) => this.builderFailed(id, err));
    if (change) {
      this.update(id, (x) => {
        const c = x.changes?.find((y) => y.id === change.id);
        if (c?.status === 'building') {
          c.status = 'done';
          delete c.paused;
          delete c.specBefore;
        }
        addActivity(x, 'builder', `Made change ${change.id}: ${change.summary ?? change.ask}`);
      });
    }
    const asked = (r.structured as { question?: AgentAsk } | undefined)?.question;
    // A busy port or a program in the way is the engine's to settle first, twice a step at most; the person only
    // sees it when the program is not squad-kit's and going around it did not work. Never in the Builder's own words.
    const way = asked?.text?.trim() ? await this.inTheWay(id, asked, told) : null;
    if (way?.answer && settled >= 2) throw new StepError('The Builder kept asking a technical question, which squad-kit does not pass on to you, so it stopped this step. Press Try again.', asked!.text);
    if (way?.answer) return this.runBuilder(id, way.answer, true, step, settled + 1, told);
    this.askIfNeeded(id, 'builder', way?.ask ?? asked);
    this.saveDecided(id, 'builder', r.structured);
    // Approved while this step ran: it reaches the Builder now, at the end of the step, before anything else runs.
    const late = openChange(readTicket(this.bp, id)!);
    if (late && late.size !== 'big' && late.status === 'approved') await this.runBuilder(id, '', true, step);
  }

  /**
   * The Builder's run itself failed (an error, a time limit): it counts like failed checks. A run that was cut off
   * never counts (engine/interrupt.ts): the board closing or restarting, a Stop or a delete (squad-kit ended it), or
   * the computer sleeping under it.
   */
  private builderFailed(id: string, err: unknown): never {
    // A network or service problem says nothing about the work: no failed try, so no higher level either.
    if (err instanceof PassingTrouble) throw err;
    if (err instanceof WaitingForYou || err instanceof LimitReached || err instanceof CapReached) throw err;
    const ended = this.closing || Boolean(this.stops.get(id)?.signal.aborted) || Boolean(readTicket(this.bp, id)?.stopRequested);
    if (ended) throw err;
    if (sleptSince(this.marks.get(id))) throw new CutOff('sleep');
    this.update(id, (x) => (x.fails = (x.fails ?? 0) + 1));
    throw err;
  }

  /** An approved small change the Builder has not had yet: it goes into the step that starts now. */
  private handChange(id: string): SpecChange | undefined {
    const t = readTicket(this.bp, id);
    const c = t ? openChange(t) : undefined;
    if (!t || !c || c.size === 'big' || changeWork(t) !== 'build') return undefined;
    this.update(id, (x) => {
      const y = openChange(x);
      if (y) y.status = 'building';
      addActivity(x, 'builder', `Took change ${c.id} into this step`);
    });
    return c;
  }

  /**
   * The Builder asked about a busy port or a program in its way (engine/port-ask.ts). A squad-kit leftover holds it:
   * squad-kit stops it and answers the Builder itself. squad-kit's work on another ticket holds it: the Builder is told
   * to leave it alone. Another program holds it: the Builder is told to go around it, with a free port. Only when it asks
   * again about that same program does the person get one plain choice, with the details for engineers. `told` keeps
   * what the Builder was told to go around in this step; left out, the agent is always told (it cannot ask the person).
   * Null when the question is about something else.
   */
  private async inTheWay(id: string, q: AgentAsk, told?: Set<string>): Promise<{ answer?: string; ask?: AgentAsk } | null> {
    const hit = inTheWay([q.text, q.why, ...(q.options ?? [])].filter(Boolean).join('\n'));
    if (!hit) return null;
    const copies = projectCopies(this.bp);
    const busy = this.busyCopies(id);
    const outside: PortAsk[] = [];
    const settled: string[] = [];
    const holders = hit.ports.length
      ? hit.ports.map((port) => ({ port, holder: listenerOn(port) }))
      : hit.pids.map((pid) => ({ port: undefined, holder: processes().find((r) => r.pid === pid) ? { pid, program: '' } : null }));
    for (const { port, holder } of holders) {
      if (!holder) {
        // Taken, by a program the system will not name (another user's): only the person can do something about it.
        if (port && (await portTaken(port))) outside.push({ port, pid: 0, asked: q.text.trim() });
        else settled.push(port ? `Port ${port} is free now; carry on. Run what you needed it for again, then go on with the work.` : 'That program has ended; carry on with the work.');
        continue;
      }
      if ((await this.clearCopies(copies, { busy, only: [holder.pid] }, id)).length) {
        settled.push(settledAnswer({ ...(port ? { port } : {}) }));
        continue;
      }
      // One of the project's apps squad-kit runs from Your apps: the person's to stop, from the card.
      const app = port ? squadKitOn(this.bp, port)?.app : undefined;
      const cwd = workingFolders([holder.pid]).get(holder.pid);
      if (!app && (ownedBySquadKit(holder.pid) || (cwd && folderOf(cwd, copies)))) {
        settled.push(ownWorkAnswer(await this.aroundIt(id, port)));
        continue;
      }
      outside.push({ ...(port ? { port } : {}), pid: holder.pid, ...(holder.program ? { program: holder.program } : {}), ...(app ? { app } : {}), asked: q.text.trim() });
    }
    const key = (p: PortAsk) => (p.port ? `port ${p.port}` : `process ${p.pid}`);
    const again = outside.find((p) => told?.has(key(p)));
    if (again) {
      const card = portCard(again);
      this.log('info', `The Builder asked again about ${key(again)}, held by ${again.program || 'a program'}${again.pid ? ` (process ${again.pid})` : ''}: it asks the person`, id);
      return { ask: { text: card.text, options: card.options, why: card.why, port: again } };
    }
    // First the way around it: another port. Nothing that is not squad-kit's is stopped without the person's press.
    for (const p of outside) {
      told?.add(key(p));
      settled.push(goAroundAnswer(await this.aroundIt(id, p.port)));
    }
    this.log('info', `Asked about ${[...hit.ports.map((p) => `port ${p}`), ...hit.pids.map((p) => `process ${p}`)].join(', ')}: ${settled.join(' ')}`, id);
    this.update(id, (x) =>
      addActivity(x, 'squad', outside.length ? 'Another program on this computer was in the way, so squad-kit showed how to go around it. The work carries on' : 'Something squad-kit left running was in the way. squad-kit dealt with it, and the work carries on'),
    );
    return { answer: settled.join('\n') };
  }

  /** The busy port, a free one near it, and the app's own port settings to set it in, for the agent to run on. */
  private async aroundIt(id: string, port?: number): Promise<AroundIt> {
    if (!port) return {};
    const free = await nextFreePort(port);
    const cwd = readTicket(this.bp, id)?.worktree;
    const vars = cwd && fs.existsSync(cwd) ? appPortVariables(cwd, port) : [];
    return { port, ...(free ? { free } : {}), ...(vars.length ? { vars } : {}) };
  }

  /** The person chose on the plain card about a program in the way. "Stop it" stops that program, checked again first. */
  private async portAnswer(id: string, p: PortAsk, choice: string): Promise<string> {
    if (choice !== STOP_IT) return cardAnswer(p, choice, null);
    // Checked again now, never from what the card said: only the very program the person saw is stopped.
    const now = p.port ? listenerOn(p.port) : processes().find((r) => r.pid === p.pid) ?? null;
    let stopped = !now && !(p.port && (await portTaken(p.port)));
    const app = p.port ? squadKitOn(this.bp, p.port) : null;
    // squad-kit itself and what it runs now are never stopped this way; one of Your apps stops as a whole.
    if (p.pid > 0 && now?.pid === p.pid && (app?.app || !ownedBySquadKit(p.pid))) {
      if (app?.app) await endPid(app.group);
      else await endProcess(p.pid);
      stopped = p.port ? !(await portTaken(p.port)) : !processes().some((r) => r.pid === p.pid);
    }
    // The port and the process are for engineers: on the card's details, and here.
    this.log('info', `${stopped ? 'Stopped' : 'Could not stop'} ${p.port ? `the program on port ${p.port}` : 'the program in the way'} (process ${p.pid}), as the person asked`, id);
    this.update(id, (x) => addActivity(x, 'squad', stopped ? 'Stopped the other program, as you asked' : 'Could not stop the other program, so the Builder goes on without it'));
    return cardAnswer(p, choice, stopped);
  }

  /** The person answered the Builder: the same conversation carries on, then the checks run as after any build. */
  private async builderAnswered(id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
    });
    const q = t.agentQuestion;
    await this.runBuilder(id, q?.port ? await this.portAnswer(id, q.port, q.answer ?? '') : P.answerPrompt(q ?? { text: '' }, 'builder'), true, 'build');
    this.update(id, (x) => {
      for (const s of x.steps ?? []) {
        s.status = 'done';
        s.live = undefined;
      }
      x.progress = 100;
      x.agentQuestion = undefined;
      addActivity(x, 'builder', 'Carried on with your answer and finished');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * An agent filled "question" in its answer: pause the ticket in Waiting for you. The answer goes back into the same
   * session. Throws WaitingForYou so the step stops here without counting as a failure.
   */
  private askIfNeeded(id: string, from: 'architect' | 'builder' | 'reviewer', q: AgentAsk | undefined): void {
    if (!q?.text?.trim()) return;
    const who = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' }[from];
    this.update(id, (x) => {
      // Only files the board may show: inside the ticket's copy, its proof or its attachments.
      const folders = ticketFolders(x, this.bp);
      const files = (q.files ?? []).map((f) => allowedFile(f.replace(/^file:\/\//, ''), folders)).filter((f): f is string => Boolean(f)).slice(0, 6);
      // Builds by itself: why it stops, a gap or a clash, and where that comes from. Other tracks keep their usual words.
      const kind = x.track === 'auto' && (q.kind === 'gap' || q.kind === 'clash') ? q.kind : undefined;
      const sources = kind ? cleanSources(q.sources) : [];
      x.agentQuestion = {
        from,
        text: q.text.trim(),
        options: (q.options ?? []).filter((o) => o.trim()).slice(0, 4),
        ...(q.why ? { why: q.why } : {}),
        ...(files.length ? { files } : {}),
        ...(q.port ? { port: q.port } : {}),
        ...(kind ? { kind } : {}),
        ...(sources.length ? { sources } : {}),
        at: now(),
      };
      const words = askWords(who, kind);
      x.live = false;
      x.squad = null;
      x.status = words.status;
      x.waiting = { kind: 'ask', summary: words.summary };
      addActivity(x, from, `Asked you: ${q.text.trim()}${files.length ? ` (with ${files.length} ${files.length === 1 ? 'file' : 'files'})` : ''}`);
    });
    throw new WaitingForYou();
  }

  /** Builds by itself: the small choices an agent made instead of asking go on the ticket as "Decided for you". */
  private saveDecided(id: string, by: DecidedBy, out: unknown): void {
    const decided = (out as { decided?: unknown } | undefined)?.decided;
    if (!Array.isArray(decided) || !decided.length || readTicket(this.bp, id)?.track !== 'auto') return;
    this.update(id, (x) => addDecided(x, by, decided));
  }

  /** The Architect's mockup is text in its answer (it only reads); squad-kit saves it with the ticket's files. */
  private saveMockup(id: string, html: string): string {
    const dir = ticketDir(this.bp, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mockup.html');
    fs.writeFileSync(file, html);
    return file;
  }

  /** "Let the Builder fix the notes" after the last review round: fix them, then the checks and two more rounds. */
  private async reviewFix(id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing the review notes';
      x.tries = 0;
      x.reviewRound = 0;
    });
    await this.runBuilder(id, P.reviewFixPrompt(t.reviewNotes ?? []), Boolean(t.sessions?.build));
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the review notes');
      x.reviewNotes = undefined;
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * The accepted change clashes with newer work in the base. squad-kit starts the merge in the ticket's copy (agents
   * never write to git), the Builder settles each clash, and the checks, review and proof run again.
   */
  /**
   * The plan was redone to follow a newer decision, after the Builder had started. The latest base comes in first, so
   * the work builds on what that decision already changed, then the Builder redoes the work to the new plan.
   */
  /**
   * Brings the latest base into the ticket's copy. Work not saved yet is committed first, or git refuses to merge over
   * it; if the base still is not in the copy, the step fails with git's reason instead of saying it worked.
   */
  private async bringInBase(t: Ticket, base: string, remote?: string): Promise<{ baseSha: string; clashes: string[]; from: string }> {
    const dir = t.worktree!;
    const unmerged = () => git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    const merging = () => git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }) !== '';
    // The newest base: the remote's when the team moved it on (fetched just before), with work accepted here kept.
    const latest = latestBase(dir, base, remote);
    // Clashes from last time that are not fixed yet: the Builder fixes those first.
    if (merging() && unmerged().length) return { baseSha: git(dir, ['rev-parse', 'MERGE_HEAD']), clashes: unmerged(), from: latest.ref };
    const baseSha = latest.sha;
    leaveProjectFiles(this.bp, t, base);
    const guard = this.guardFor(dir, t.id);
    const signal = this.stops.get(t.id)?.signal;
    const saved = await commitAll(dir, `Work so far on ${t.title} (${t.id})`, conventionalWords('chore', `work so far on ${t.title}`, t.id), { ...(guard ? { guard } : {}), ...(signal ? { signal } : {}) });
    if (saved.hookSaid !== undefined) {
      this.log('warn', `The project's own check said no to the work so far: ${saved.hookSaid}`, t.id);
      this.update(t.id, (x) => {
        x.hookOwed = true;
        addActivity(x, 'squad', "Saved the work so far without the project's own check, as it is not finished. The check runs on the whole change before it goes in");
      });
    }
    let why = 'git did not merge it';
    try {
      git(dir, ['merge', '--no-commit', '--no-ff', '-m', `Merge ${latest.ref} into ${t.branch ?? 'this ticket'}`, baseSha]);
    } catch (err) {
      why = (err as Error).message;
    }
    const clashes = unmerged();
    if (!merging() && !isAncestor(dir, baseSha, 'HEAD')) throw new StepError(`squad-kit could not bring the latest ${latest.ref} into this ticket. Press Try again.`, why);
    return { baseSha, clashes, from: latest.ref };
  }

  private async rebuild(id: string, adr: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const base = repoFor(this.meta(), t).base;
    const remote = await fetchBase(this.bp, t);
    // The redo was handed to the Builder already (its conversation has this plan) and a restart, a Stop or sleep cut
    // it off: it carries on where it was. The base comes in again only when something new arrived on it since.
    const cut = t.builtPlan === planKey(t) && t.sessions?.build ? carriesOn(t, 'build') : undefined;
    const moved = !cut || this.baseMoved(t, base, remote);
    const { baseSha, clashes, from } = moved ? await this.bringInBase(t, base, remote) : { baseSha: t.baseCommit!, clashes: [] as string[], from: base };
    const t1 = this.update(id, (x) => {
      x.baseCommit = baseSha;
      x.stage = 'implement';
      x.live = true;
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.sessions = { ...x.sessions, build: x.sessions?.build ?? randomUUID() };
      x.status = cut ? `Step ${openStep(x)} of ${x.steps?.length ?? 1}` : `Redoing the work to follow ${adr}`;
      if (moved) addActivity(x, 'squad', `Brought the latest ${from} into this ticket${clashes.length ? `. Clashes in ${clashes.join(', ')}` : ''}`);
      addActivity(x, 'builder', cut ? carryOnLine(x, cut.by) : `Started redoing the work to follow ${adr}`);
    });
    const meta = this.meta();
    this.update(id, (x) => (x.builtPlan = planKey(t1)));
    const intro = `The plan changed to follow ${adr}, a decision approved after you started. The latest ${base} is now in this copy${clashes.length ? `, with clashes in ${clashes.join(', ')} to fix first` : ''}. Stay on this branch: it already has the latest ${base}, so a plan that says to start from ${base} is met, and squad-kit does all the git. Redo the work to the new plan below: keep what still fits, change what does not.`;
    const newer = moved && cut ? ` squad-kit brought the latest ${base} into this copy meanwhile${clashes.length ? `, with clashes in ${clashes.join(', ')} to fix first` : ''}.` : '';
    await this.runBuilder(id, cut ? `${carryOnPrompt(t1, cut.by)}${newer}` : `${intro}\n\n${P.buildPrompt(meta, listDecisions(this.bp), t1, this.ctx(t1))}`, Boolean(t.sessions?.build), 'build');
    this.update(id, (x) => {
      for (const s of x.steps ?? []) {
        s.status = 'done';
        s.live = undefined;
      }
      x.replanFor = undefined;
      x.progress = 100;
      addActivity(x, 'builder', 'Finished all steps');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /** Something new arrived on the base since the ticket's copy last took it in. */
  private baseMoved(t: Ticket, base: string, remote?: string): boolean {
    try {
      const latest = latestBase(t.worktree!, base, remote).sha;
      return latest !== t.baseCommit && !isAncestor(t.worktree!, latest, 'HEAD');
    } catch {
      return true;
    }
  }

  private async updateBase(id: string): Promise<void> {
    const t = await this.workspace(id);
    const base = repoFor(this.meta(), t).base;
    const { baseSha, clashes, from } = await this.bringInBase(t, base, await fetchBase(this.bp, t));
    this.update(id, (x) => {
      x.baseCommit = baseSha;
      x.stage = 'implement';
      x.live = true;
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.status = clashes.length ? `Builder is fixing ${clashes.length} clashing ${clashes.length === 1 ? 'file' : 'files'}` : 'Running the project checks';
      addActivity(x, 'squad', `Brought the latest ${from} into this ticket${clashes.length ? `. Clashes in ${clashes.join(', ')}` : ''}`);
    });
    if (clashes.length) {
      await this.runBuilder(id, P.clashPrompt(base, clashes), Boolean(t.sessions?.build));
      this.update(id, (x) => addActivity(x, 'builder', `Fixed the clash with ${base}`));
    }
    this.update(id, (x) => {
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  private async fixFromPerson(id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what you found';
      x.tries = 0;
      x.fails = 0;
      x.reviewRound = 0;
      x.steps = [...(x.steps ?? []), { title: `Fix: ${x.changeRequest?.split('\n')[0] ?? 'what you found'}`, status: 'doing' }];
    });
    await this.runBuilder(id, P.changeFixPrompt(t.changeRequest ?? ''), Boolean(t.sessions?.build));
    this.update(id, (x) => {
      const last = x.steps?.[x.steps.length - 1];
      if (last) {
        last.status = 'done';
        last.live = undefined;
      }
      addActivity(x, 'builder', 'Fixed what you found');
      x.changeRequest = undefined;
      x.stage = 'test';
      x.status = 'Running the project checks';
      x.proof = undefined;
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * How to test and run the project, found in the story's copy and saved, with a line on the story. It asks nobody. A
   * project that started empty, or has nothing saved at all, gets every command it lacks. Any other only gets a test
   * command when it has none, as the Builder may have written the project's first tests. The person's choice to go on
   * without tests stands. The commands saved now.
   */
  private saveFoundCommands(id: string, cwd: string): ProjectCommands {
    const meta = this.meta();
    const t = readTicket(this.bp, id)!;
    const repo = repoFor(meta, t);
    const has = (k: keyof ProjectCommands) => Boolean(repo.commands[k]?.trim());
    const fresh = Boolean(meta.scan?.empty) || !(['test', 'lint', 'build', 'start', 'url'] as const).some(has);
    const wanted = (fresh ? (['setup', 'test', 'lint', 'build', 'start', 'url'] as const) : (['test'] as const)).filter((k) => !has(k) && !(k === 'test' && meta.noTests));
    if (!wanted.length || !fs.existsSync(cwd)) return repo.commands;
    const found = findCommands(cwd);
    const add = Object.fromEntries(wanted.filter((k) => found[k]?.trim()).map((k) => [k, found[k]!.trim()])) as ProjectCommands;
    if (!Object.keys(add).length) return repo.commands;
    if (meta.repos?.length) meta.repos = meta.repos.map((r) => (r.path === repo.path ? { ...r, commands: { ...r.commands, ...add } } : r));
    else meta.commands = { ...(meta.commands ?? {}), ...add };
    writeMeta(this.bp, meta);
    // The exact commands are for engineers: in the log and in Settings.
    this.log('info', `Found and saved: ${Object.entries(add).map(([k, v]) => `${k}: ${v}`).join(', ')}`, id);
    this.update(id, (x) => {
      if (add.test) delete x.testSuggestion;
      addActivity(x, 'squad', add.test && Object.keys(add).length === 1 ? 'squad-kit found the tests in the project, and runs them from now on' : 'squad-kit found how to test and run the project, and saved it');
    });
    return { ...repo.commands, ...add };
  }

  private async checks(id: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    // A project the Builder just set up says now how it is tested and run.
    if (t.worktree) this.saveFoundCommands(id, t.worktree);
    const meta = this.meta();
    const repo = repoFor(meta, t);
    let commands = repo.commands;
    // Tests made weaker first: passing them would prove little, and only you can go past it.
    const weak = t.worktree && t.baseCommit ? weakenedChecks(t.worktree, t.baseCommit, { skip: [`${path.basename(this.bp.squadDir)}/`], testCommand: commands.test }) : [];
    const fresh = weak.filter((w) => !(t.weakenedContinued ?? []).includes(w.key));
    if (fresh.length) return this.weakenedStop(id, fresh, repo.base);
    // No old server of squad-kit's own copies may hold a port the checks need.
    await this.clearBeforeApp(id);
    this.goOn(id);
    this.update(id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.gates = { checks: 'pending', review: x.gates?.review ?? 'pending', proof: 'pending' };
      addActivity(x, 'tester', 'squad-kit is running the project checks');
      startStep(x, { who: 'squad', step: 'checks', limit: 15 });
    });
    const onStart = (name: string) => {
      // The exact command is for engineers: here, and in the ticket's Developer tab once it ran.
      this.log('info', `Running ${name}: ${commands[name as 'test' | 'start']}`, id);
      this.update(id, (x) => {
        x.status = CHECK_DOING[name] ?? DOING.check;
        stepDoing(x, x.status);
      });
    };
    const mark = sleepMark();
    const guard = this.guardFor(t.worktree!, id);
    // The checks run the Builder's code, which may write in its copy: never in the project's own check.
    const hookLane = watchLane(t.worktree!, hookFiles(t.worktree!));
    commands = await this.tryTestChange(id, t.worktree!, commands, guard, mark);
    const results = await runChecks(t.worktree!, commands, onStart, { ...this.commandWatch(id), ...(guard ? { guard } : {}) });
    const hooksBack = checkLane(hookLane).restored;
    if (hooksBack.length) this.update(id, (x) => addActivity(x, 'squad', `The project's checks changed the check that runs on every save (${hooksBack.slice(0, 6).join(', ')}); squad-kit put it back`));
    // A check that needed a file outside its copy, which the guard blocked: one plain sentence, not a failed try.
    if (guard && !this.stops.get(id)?.signal.aborted) {
      const hit = results.find((r) => !r.ok && guardBlockedPath(r.output, guard));
      if (hit) return this.guardStop(id, 'test', guardBlockedPath(hit.output, guard)!, hit.command, hit.output, guard);
    }
    // Stopped while a check ran: its result says nothing about the code, so it is no failed try.
    this.goOn(id);
    // Nor when the computer slept under them: they run again, and no try is counted.
    if (sleptSince(mark)) {
      this.update(id, (x) => {
        delete x.clock;
        addActivity(x, 'squad', 'The computer slept while the checks ran, so squad-kit runs them again. Not a failed try');
        scheduleSquad(x, 'test', 0.2, 1);
      });
      return;
    }
    this.update(id, (x) => endStep(this.bp, x));
    // Failed once, then passed: no failed try and no Builder. One plain line here; the Developer tab and the log say more.
    for (const r of results.filter((x) => x.failedFirst !== undefined)) {
      this.log('warn', `${r.name} failed once and passed when run again (${r.command}):\n${r.failedFirst}`, id);
      this.update(id, (x) => addActivity(x, 'tester', failedOnceLine(r.name)));
    }
    const test = results.find((r) => r.name === 'test');
    if (test?.ok && test.failedFirst === undefined) forgetKnownFailure(this.bp, t, test.command);
    const failed = results.filter((r) => !r.ok);
    const ran = ranOf(results);
    // Weakened tests you continued past are still there: the gate is never a plain pass.
    const around = weak.length > 0;
    if (failed.length === 0 && noTestsRan(results)) return this.notChecked(id, results, around);
    if (failed.length === 0) {
      const tests = test ? testCount(test.output) : null;
      const names = results.map((r) => checkWords(r.name)).join(', ');
      const text = tests ? `${tests} ${tests === 1 ? 'test passes' : 'tests pass'}, ${names} OK` : `${names} pass`;
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: around ? 'skipped' : 'pass', checksText: around ? `${text}; tests weakened, you continued` : text, ran };
        // A pass starts the count again: a later round that fails has its own tries, and nothing is continued past.
        x.tries = 0;
        clearStaleStop(x);
        x.checksContinued = undefined;
        addActivity(x, 'tester', `All checks pass: ${names}`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      for (const d of listDecisions(this.bp)) {
        if (d.from === id && d.checkedBy && !d.checkedBy.passing) writeDecision(this.bp, { ...d, checkedBy: { ...d.checkedBy, passing: true } });
      }
      return;
    }
    // You chose to continue past these very checks: they still fail, so the work goes on as you decided. A check
    // that failed only now is new, and goes through the fixes as usual.
    const past = t.checksContinued;
    if (past?.length && failed.every((f) => past.includes(f.name))) {
      const names = failed.map((f) => f.name).join(', ');
      this.update(id, (x) => {
        x.tries = 0;
        x.gates = { ...x.gates!, checks: 'skipped', checksText: `${names} still failed, continued anyway`, ran };
        clearStaleStop(x);
        addActivity(x, 'tester', `Checks still fail: ${names}. You continued anyway past them, so the work goes on`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      return;
    }
    const tries = (t.tries ?? 0) + 1;
    this.update(id, (x) => {
      x.tries = tries;
      x.fails = (x.fails ?? 0) + 1;
      x.gates = { ...x.gates!, checks: 'fail', checksText: `${failed.map((f) => f.name).join(', ')} failed`, ran };
      addActivity(x, 'tester', `Checks failed: ${failed.map((f) => f.name).join(', ')} (try ${tries} of ${MAX_CHECK_TRIES})`);
    });
    if (tries >= MAX_CHECK_TRIES) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.retryPhase = 'test';
        x.status = `Stuck after ${tries} check runs`;
        // One plain sentence; what each check printed is for engineers.
        x.stuck = {
          gate: 'checks',
          checks: failed.map((f) => f.name),
          question: `The checks still fail after ${tries} tries: ${checkNames(failed.map((f) => f.name))} did not pass.`,
          detail: failed.map((f) => `${f.name} (${f.command}):\n${tail(f.output, 30)}`).join('\n\n').slice(-6000),
          options: wayOptions({ gate: 'checks', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The squad is stuck and needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.status = 'Builder is fixing the failed checks';
    });
    await this.runBuilder(id, P.fixChecksPrompt(failed.map((f) => ({ name: f.name, command: f.command, output: tail(f.output, 60) })), knownFailures(this.bp, t, failed)), true);
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the failed checks');
      x.stage = 'test';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * The design changes how the tests run (engine/test-change.ts): squad-kit tries the new way in the ticket's copy and
   * keeps what works, with one plain line on the story. The commands go to the log and the Developer tab. When it cannot
   * tell, the person gets one plain sentence and the checks keep the current one meanwhile. The commands the checks use now.
   */
  private async tryTestChange(id: string, cwd: string, commands: ProjectCommands, guard: GuardSpec | undefined, mark: SleepMark): Promise<ProjectCommands> {
    const c = readTicket(this.bp, id)?.testChange;
    if (!c || c.ask) return commands;
    const from = commands.test?.trim();
    // Another ticket changed it meanwhile: to this very command, or away from the one it was tried against.
    if (!from || from === c.to) {
      this.update(id, (x) => delete x.testChange);
      return commands;
    }
    const verdict = await judgeTestChange({ from, to: c.to }, (command) => {
      this.log('info', `Trying the test command: ${command}`, id);
      return runCommand(cwd, command, undefined, { silentMs: CHECK_SILENT_MS, ...this.commandWatch(id), ...(guard ? { guard } : {}) });
    });
    // Stopped, or the computer slept under it: the runs say nothing, so the next checks try again.
    this.goOn(id);
    if (sleptSince(mark)) return commands;
    this.log('info', `The test command: from "${from}" to "${c.to}": ${'ask' in verdict ? 'squad-kit cannot tell' : `squad-kit keeps the ${verdict.keep} one`} (${verdict.why}; ${verdict.ran})`, id);
    if ('ask' in verdict) {
      this.update(id, (x) => {
        x.testChange = { ...c, from, ask: true, ran: verdict.ran };
        addActivity(x, 'squad', 'squad-kit cannot tell which way of testing to keep, so it asks you. The checks keep the current way for now');
      });
      return commands;
    }
    const keepNew = verdict.keep === 'new';
    if (keepNew) saveTestCommand(this.bp, this.meta(), c.repo ?? readTicket(this.bp, id)?.repo, c.to);
    this.update(id, (x) => {
      delete x.testChange;
      x.testDecided = { from, to: c.to, kept: verdict.keep, by: 'squad', why: verdict.why, ran: verdict.ran, at: now() };
      addActivity(x, 'squad', keepNew ? `squad-kit keeps the new way of testing: ${verdict.why}` : `squad-kit keeps the current way of testing: ${verdict.why}`);
    });
    return keepNew ? { ...commands, test: c.to } : commands;
  }

  /**
   * The checks passed, but no tests ran. Once you said to go on without tests in this project, the gate says
   * "Not checked" and the review goes on. Until then the ticket waits for one decision: use the test command the
   * Architect suggested so the Builder adds tests, go on without tests, or add one in Settings and check again.
   */
  private notChecked(id: string, results: CheckResult[], around: boolean): void {
    const meta = this.meta();
    const text = `${notCheckedText(results)}${around ? '; tests weakened, you continued' : ''}`;
    const ran = ranOf(results);
    if (meta.noTests) {
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: 'unchecked', checksText: text, ran };
        x.tries = 0;
        x.checksContinued = undefined;
        clearStaleStop(x);
        addActivity(x, 'tester', `Not checked: ${text}. You chose to go on without tests in this project`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      return;
    }
    this.update(id, (x) => {
      x.gates = { ...x.gates!, checks: 'unchecked', checksText: text, ran };
      x.tries = 0;
      x.live = false;
      x.squad = null;
      x.retryPhase = 'test';
      x.status = 'No tests to check the work';
      x.stuck = {
        gate: 'checks',
        kind: 'no-tests',
        question: noTestsQuestion(results),
        detail: noTestsDetail(results, x.testSuggestion),
        options: wayOptions({ gate: 'checks', kind: 'no-tests', test: x.testSuggestion }),
      };
      x.waiting = { kind: 'stuck', summary: 'No tests to check the work: needs one decision' };
      addActivity(x, 'tester', `Not checked: ${text}. Asked you once for this project: add tests or go on without them`);
    });
  }

  /** The tests were made weaker: the ticket stops with what was weakened. Send it back, fix it, or continue with a reason. */
  private weakenedStop(id: string, found: Weakening[], base: string): void {
    this.update(id, (x) => {
      x.stage = 'test';
      x.live = false;
      x.squad = null;
      delete x.clock;
      // Weakening the tests is a run that did not get through, as failed checks are.
      x.fails = (x.fails ?? 0) + 1;
      x.retryPhase = 'restore-tests';
      x.gates = { checks: 'fail', checksText: 'Tests were weakened', review: x.gates?.review ?? 'pending', proof: 'pending' };
      x.status = 'The tests were made weaker';
      x.stuck = {
        gate: 'checks',
        kind: 'weakened',
        question: `This change makes the tests weaker than on ${base}, so passing checks would prove little.`,
        points: found.map((w) => w.text),
        checks: found.map((w) => w.key),
        detail: found.map((w) => `${w.kind}: ${w.file}`).join('\n'),
        options: wayOptions({ gate: 'checks', kind: 'weakened', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
      };
      x.waiting = { kind: 'stuck', summary: 'The tests were made weaker: needs one decision' };
      addActivity(x, 'tester', `Stopped before the checks: the tests were made weaker. ${found.map((w) => w.text).join(' ')}`);
    });
  }

  /** "Send it back to the Builder" after weakened tests: it puts them back, then the checks run again. */
  private async restoreTests(id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is putting the tests back';
    });
    await this.runBuilder(id, P.weakenedFixPrompt(t.stuck?.points ?? []), Boolean(t.sessions?.build));
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Put the tests back');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  private async review(id: string, answered = false, carry = false): Promise<void> {
    this.goOn(id);
    const meta = this.meta();
    const t0 = this.update(id, (x) => {
      x.stage = 'review';
      x.live = true;
      if (answered && x.sessions?.review) return;
      x.reviewRound = (x.reviewRound ?? 0) + 1;
      x.sessions = { ...x.sessions, review: x.reviewRound === 1 || !x.sessions?.review ? randomUUID() : x.sessions.review };
      addActivity(x, 'reviewer', `Reading the changes (round ${x.reviewRound} of ${MAX_REVIEW_ROUNDS})`);
    });
    const round = t0.reviewRound!;
    const goOn = answered && Boolean(t0.sessions?.review);
    // The Reviewer may look at the app's pages, and the app runs in the ticket's copy: what it changes there goes back.
    const rc = repoFor(meta, t0).commands;
    const lane = rc.start?.trim() && rc.url?.trim() ? watchLane(t0.worktree!, this.protectedFiles(t0.worktree!), true) : null;
    const r = await this.runAgent({
        role: 'reviewer',
        step: 'review',
      ticket: id,
      cwd: t0.worktree!,
      ...(round > 1 || goOn ? { resume: t0.sessions!.review } : { sessionId: t0.sessions!.review }),
      prompt: goOn
        ? carry
          ? P.chatCarryOnPrompt('reviewer')
          : P.answerPrompt(t0.agentQuestion ?? { text: '' }, 'reviewer')
        : P.reviewPrompt(meta, listDecisions(this.bp), t0, round, this.ctx(t0), t0.baseCommit ? workSoFar(t0.worktree!, t0.baseCommit) : []),
      addDirs: this.extraDirs(t0),
      permissions: ['read', 'git-read'],
      schema: P.REVIEW_SCHEMA,
      timeoutMs: 15 * 60_000,
      onTool: this.watcher(id, 'reviewer', t0.worktree!),
    }).finally(() => lane && this.keepLane(id, 'reviewer', lane));
    const out = r.structured as { approved: boolean; summary: string; comments: string[]; alsoChanged?: string[]; question?: AgentAsk };
    this.askIfNeeded(id, 'reviewer', out.question);
    this.saveDecided(id, 'reviewer', out);
    if (goOn) this.update(id, (x) => (x.agentQuestion = undefined));
    // Each round reads the whole change, so its list replaces the last one.
    const also = cleanAlsoChanged(out.alsoChanged);
    this.update(id, (x) => {
      if (also.length) {
        x.alsoChanged = also;
        addActivity(x, 'reviewer', alsoChangedLine(also));
      } else delete x.alsoChanged;
    });
    if (out.approved) {
      this.update(id, (x) => {
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'pass', reviewBy: `a second ${this.toolLabel('reviewer')} session` } as Ticket['gates'];
        x.reviewAsked = undefined;
        clearStaleStop(x);
        addActivity(x, 'reviewer', `Approved: ${out.summary}`);
        x.status = 'Recording the proof';
        scheduleSquad(x, 'proof', 0.2, 1);
      });
      return;
    }
    // Review notes count as a failed Builder run: in a project with no tests they are the only sign of one.
    this.update(id, (x) => (x.fails = (x.fails ?? 0) + 1));
    // The engine never waves a review through: after the last round, you decide.
    if (round >= MAX_REVIEW_ROUNDS) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.reviewNotes = out.comments;
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'fail', reviewBy: `a second ${this.toolLabel('reviewer')} session` } as Ticket['gates'];
        x.retryPhase = 'review-fix';
        x.status = `Review still open after ${round} rounds`;
        addActivity(x, 'reviewer', `Still asks for ${out.comments.length} ${out.comments.length === 1 ? 'fix' : 'fixes'} after ${round} rounds: ${out.comments.join(' ')}`);
        // Its notes are the Reviewer's own words, often about code: they are in the activity and the details.
        x.stuck = {
          gate: 'review',
          question: `The Reviewer still asks for ${out.comments.length === 1 ? 'a change' : `${out.comments.length} changes`} after ${round} rounds.`,
          ...(out.comments.length ? { detail: out.comments.map((c) => `- ${c}`).join('\n') } : {}),
          options: wayOptions({ gate: 'review', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The review is still open and needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      x.reviewNotes = out.comments;
      // The next round sees these again, with the whole change.
      x.reviewAsked = out.comments;
      addActivity(x, 'reviewer', `Asked for ${out.comments.length} ${out.comments.length === 1 ? 'fix' : 'fixes'}: ${out.comments.join(' ')}`);
      x.stage = 'implement';
      x.status = `Builder is fixing ${out.comments.length} review comments`;
    });
    await this.runBuilder(id, P.reviewFixPrompt(out.comments), true);
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the review comments');
      x.reviewNotes = undefined;
      x.stage = 'test';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * The proof: the Tester's screenshots, squad-kit's own checks of each picture, then squad-kit's check of what the
   * pictures of each "done when" show together. It passes only when every "done when" that shows on a screen is judged
   * met; one the Tester and the check agree cannot be shown does not fail it, unless every one ends that way. Not shown:
   * the Tester adds what is missing, told what to show (judge), then a plain stop (cannotShow). Broken: back to the
   * Builder once, then a plain stop (notWorking).
   */
  private async proof(id: string): Promise<void> {
    const meta = this.meta();
    const t = readTicket(this.bp, id)!;
    const rc = repoFor(meta, t).commands;
    const canShow = Boolean(rc.start && rc.url) && (t.work?.screens ?? 0) > 0;
    // Why no picture was taken, in the person's words, and the exact error for engineers.
    let why = '';
    let detail = '';
    let bad: ShotProblem[] = [];
    let round: ShotRound | null = null;
    // The "before" screenshots still running beside the build end first (8 minutes at most), so both sets pair up.
    await this.beforeShotsOf.get(id);
    this.goOn(id);
    if (canShow) {
      try {
        round = await this.screens(id, 'after');
        bad = round.problems;
        // squad-kit checks every picture itself. One that proves nothing goes back to the Tester once, with why.
        if (bad.length) {
          this.update(id, (x) => addActivity(x, 'tester', `The screenshots did not pass squad-kit's check, so the Tester takes them again: ${bad.map((b) => b.text).join(' ')}`));
          const again = await this.screens(id, 'after', undefined, bad.map((b) => b.text));
          round = { ...again, sizes: { ...round.sizes, ...again.sizes } };
          // A picture that failed and was not taken again still counts against the proof.
          const rows = readTicket(this.bp, id)?.proof ?? [];
          const still = bad.filter((b) => !rows.some((p) => p.criterion === b.criterion && p.after) && !again.problems.some((a) => a.criterion === b.criterion));
          bad = [...again.problems, ...still];
        }
      } catch (err) {
        if (err instanceof LimitReached || err instanceof CapReached || err instanceof CutOff || err instanceof PassingTrouble) throw err;
        if (this.stops.get(id)?.signal.aborted) throw err;
        const e = explainError(err);
        // Only squad-kit's own plain words reach the person; the rest is for engineers.
        why = ownWords(err) ?? NO_PICTURES;
        detail = [e.what === why ? '' : e.what, e.detail ?? ''].filter(Boolean).join('\n');
        // The exact words go to the app log and the stop's details, never to the activity.
        this.log('warn', `Could not take screenshots: ${detail || why}`, id);
        this.update(id, (x) => addActivity(x, 'tester', 'Could not take the screenshots this time'));
      }
    }
    // The ticket has screens but nothing was shot, or a picture failed the check: the gate does not pass on its own. You
    // decide. A plan with screens needs at least one picture, even when the Tester says each "done when" shows on none.
    const now = readTicket(this.bp, id)!;
    const shot = (now.proof ?? []).some((p) => p.after);
    if (canShow && (!shot || bad.length)) {
      this.update(id, (x) => {
        const named = (n: number) => criterionText(x, n) ?? `"Done when" ${n}`;
        const missing = round ? missingShots(x, round) : [];
        const stuck = round?.stuck.length ? round.stuck : [];
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.stage = 'review';
        x.retryPhase = 'proof';
        x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
        x.status = bad.length ? 'Screenshots did not pass the check' : 'No screenshots yet';
        const said = round?.said ? ` The Tester says: ${round.said}` : '';
        const technical = stuck.length ? stuck.map((s) => `${s.what}${s.why ? `: ${s.why}` : ''}`).join('\n') : '';
        x.stuck = bad.length
          ? {
              gate: 'proof',
              kind: 'bad-proof',
              question: "The screenshots did not pass squad-kit's check, even after the Tester took them again, so they do not prove the work yet.",
              points: bad.map((b) => b.text),
              options: wayOptions({ gate: 'proof', kind: 'bad-proof' }),
            }
          : {
              gate: 'proof',
              // Plain words for the person; the exact errors are in the activity and the engineer details.
              question: why || (stuck.length ? STUCK_PICTURES : `The Tester took no screenshots, so the proof is not ready yet.${said}`),
              ...(!why && missing.length ? { points: missing.map((m) => `${named(m.criterion)}: ${m.why}`) } : {}),
              ...(detail || technical ? { detail: [detail, technical].filter(Boolean).join('\n') } : {}),
              options: wayOptions({ gate: 'proof' }),
            };
        x.waiting = { kind: 'stuck', summary: bad.length ? 'The screenshots did not pass the check: needs one decision' : 'No screenshots yet: needs one decision' };
      });
      return;
    }
    // What each picture shows: the Tester's verdict and squad-kit's own look at it, together.
    if (canShow && round && doneWhenCount(now) > 0) {
      let judged: ProofJudged;
      try {
        judged = await this.judge(id, round);
      } catch (err) {
        if (err instanceof LimitReached || err instanceof CapReached || err instanceof CutOff || err instanceof PassingTrouble) throw err;
        if (this.stops.get(id)?.signal.aborted) throw err;
        return this.checkStop(id, err);
      }
      if (judged.broken.length) return this.notWorking(id, judged.broken, judged.notShown);
      if (judged.notShown.length) return this.cannotShow(id, judged.notShown);
      // Every "done when" ended as not on a screen: nothing shows the work, so the person decides.
      if (judged.offScreen.length === doneWhenCount(now)) return this.cannotShow(id, judged.offScreen, false);
    }
    this.update(id, (x) => {
      x.proof = (x.proof ?? []).filter((p) => p.after);
      const shots = x.proof;
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'pass' } as Ticket['gates'];
      x.proofRound = undefined;
      clearStaleStop(x);
      if (!shots.length) {
        const proof = x.gates?.checks === 'unchecked' ? 'and no tests ran, so read the changes yourself' : 'so the checks are the proof';
        addActivity(x, 'tester', canShow ? `No screenshots were taken, ${proof}` : `No screens to show, ${proof}`);
      }
      // Builds by itself: no Looks right to wait for, the squad accepts it as its next step (board/auto.ts).
      if (x.track === 'auto') return acceptNext(x, 0.2, 1);
      x.live = false;
      x.stage = 'review';
      x.status = 'Proof ready to check';
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      x.squad = null;
    });
  }

  /**
   * squad-kit's own look at the proof, in one short Reviewer run for all the pictures, and for what the Tester says cannot
   * be shown. Each row, over all its pictures, is met, broken, not shown or not on a screen (together, in
   * proof-verdict.ts). What is not shown, and a "done when" with no picture and no reason, go back to the Tester in its
   * own conversation, told exactly what to show, MAX_RETAKES times at most: its new pictures join the row's. Not on a
   * screen takes two voices: the check says it cannot be shown, and the Tester said so too or could not show it in its
   * last retake. Returns the rows broken, still not shown and not on a screen, in the order of the "done when" list.
   */
  private async judge(id: string, first: ShotRound): Promise<ProofJudged> {
    const sizes = { ...first.sizes };
    const rowOf = (x: Ticket, n: number) => (x.proof ?? []).find((p) => p.after && p.criterion === criterionText(x, n));
    const reasonOf = (x: Ticket, n: number) => x.offScreen?.find((o) => o.criterion === criterionText(x, n))?.why;
    const t = readTicket(this.bp, id)!;
    const numbers = Array.from({ length: doneWhenCount(t) }, (_, i) => i + 1);
    const toFile = (p: ProofPicture): P.PictureFile => ({ file: p.after, ...(p.page ? { page: p.page } : {}), ...(sizes[p.after] ? { size: sizes[p.after] } : {}), ...(p.note ? { note: p.note } : {}) });
    const toCheck = (x: Ticket, which: number[]): P.PictureToCheck[] =>
      which.flatMap((n) => {
        const row = rowOf(x, n);
        const reason = reasonOf(x, n);
        const off = reason ? { offScreen: reason } : {};
        if (!row) return reason ? [{ criterion: n, ...off }] : [];
        return [{ criterion: n, ...toFile(row), ...off, ...(row.shows ? { said: SAID[row.shows] } : {}), ...(this.sameAsBefore(row) ? { same: true } : {}), ...(row.more?.length ? { more: row.more.map(toFile) } : {}) }];
      });
    const verdicts = await this.checkPictures(id, toCheck(t, numbers));
    const verdict = (x: Ticket, n: number) => {
      const row = rowOf(x, n);
      if (row) return together(row, verdicts.get(n), this.sameAsBefore(row));
      const reason = reasonOf(x, n);
      return reason ? fromReason(reason, verdicts.get(n)) : null;
    };
    // Only the check says it cannot be shown: the Tester gets a retake first, and may say so too.
    const isOpen = (x: Ticket, n: number) => {
      const v = verdict(x, n);
      return !v || v.shows === 'not-shown' || (v.shows === 'off-screen' && !reasonOf(x, n));
    };
    for (let retake = 1; retake <= MAX_RETAKES; retake += 1) {
      const x = readTicket(this.bp, id)!;
      const open = numbers.filter((n) => isOpen(x, n));
      if (!open.length) break;
      const asks = open.map((n) => {
        const v = verdict(x, n);
        const text = criterionText(x, n)!;
        const reason = reasonOf(x, n);
        if (!v) return `"Done when" ${n} ("${text}") has no screenshot, and you did not say it shows on no screen. Take one, or put it in offScreen with why.`;
        if (v.shows === 'off-screen') return cannotShowLine(n, text, v.why);
        return reason ? reasonRefusedLine(n, text, reason, v.why, v.advice) : retakeLine(n, text, v.why, v.advice);
      });
      const which = open.length === 1 ? `"done when" ${open[0]}` : `${open.length} "done when"`;
      this.update(id, (y) => addActivity(y, 'tester', `The screenshots do not show ${which} clearly yet, so the Tester takes ${open.length === 1 ? 'it' : 'them'} again (try ${retake} of ${MAX_RETAKES})`));
      // What the check has seen of it: its pictures and the Tester's reason.
      const had = (z: Ticket, n: number) => `${rowOf(z, n) ? rowPictures(rowOf(z, n)!).map((p) => p.after).sort().join(' ') : ''}|${reasonOf(z, n) ?? ''}`;
      const before = new Map(numbers.map((n) => [n, had(x, n)]));
      const again = await this.screens(id, 'after', undefined, asks);
      Object.assign(sizes, again.sizes);
      const y = readTicket(this.bp, id)!;
      // A row with a new picture or a new reason is looked at again, all its pictures together; one with neither still does not show it.
      const fresh = [...before].filter(([n, seen]) => had(y, n) !== seen).map(([n]) => n);
      for (const [n, v] of await this.checkPictures(id, toCheck(y, fresh))) verdicts.set(n, v);
    }
    const out: ProofJudged = { broken: [], notShown: [], offScreen: [] };
    this.update(id, (x) => {
      const stays: OffScreen[] = [];
      for (const n of numbers) {
        const row = rowOf(x, n);
        const text = criterionText(x, n)!;
        // No retake is left: pictures of a part and the Tester's reason for the rest never stop the story.
        const v = row ? afterLastRetake(verdict(x, n)!, reasonOf(x, n)) : verdict(x, n);
        const said = v ? plainParts(v.why, technicalWords).kept : '';
        if (!row) {
          if (v?.shows === 'off-screen') {
            const why = (said || reasonOf(x, n)!).slice(0, 600);
            stays.push({ criterion: text, why });
            out.offScreen.push({ criterion: n, text, why });
          } else out.notShown.push({ criterion: n, text, why: (said || 'No screenshot shows it.').slice(0, 600) });
          continue;
        }
        row.shows = v!.shows;
        if (v!.shows === 'met') {
          delete row.why;
          continue;
        }
        row.why = (said || (v!.shows === 'broken' ? 'The screenshot shows it does not work as written.' : v!.shows === 'off-screen' ? 'The screenshots show a part of it. The rest cannot be shown on a screen.' : 'The screenshot does not show it clearly.')).slice(0, 600);
        (v!.shows === 'broken' ? out.broken : v!.shows === 'off-screen' ? out.offScreen : out.notShown).push({ criterion: n, text, why: row.why });
      }
      // Agreed on, and with no picture, it stays on the list; a row with pictures says it itself; the rest are not on a list.
      if (stays.length) x.offScreen = stays;
      else delete x.offScreen;
      const met = (x.proof ?? []).filter((p) => p.shows === 'met').length;
      const open = [out.broken.length ? `${out.broken.length} not working yet` : '', out.notShown.length ? `${out.notShown.length} not shown yet` : '', out.offScreen.length ? `${out.offScreen.length} not on a screen` : ''].filter(Boolean);
      addActivity(x, 'reviewer', open.length ? `Checked the screenshots: ${[`${met} met`, ...open].join(', ')}` : `Checked the screenshots: each "done when" on a screen is met`);
      for (const r of out.offScreen) addActivity(x, 'reviewer', `"Done when" ${r.criterion} is not on a screen: ${r.why}`);
    });
    return out;
  }

  /** The main after is the very same picture as the before, where both were taken of the screen. */
  private sameAsBefore(p: ProofShot): boolean {
    if (p.beforeLabel !== 'Before' || !p.before || !p.after || p.before === p.after) return false;
    try {
      return samePicture(fs.readFileSync(path.join(this.bp.proofDir, p.before)), fs.readFileSync(path.join(this.bp.proofDir, p.after)));
    } catch {
      // A picture removed meanwhile is missing from the proof, which says so on its own.
      return false;
    }
  }

  /**
   * The before pairs with the main picture, and an after the same as the before shows nothing: when the main one is the
   * same and another of the row's is not, that other one becomes the main one. No picture is lost, and a retake that
   * adds a real change is not held back by the old main picture.
   */
  private pairWithBefore(row: ProofShot): void {
    if (!row.more?.length || !this.sameAsBefore(row)) return;
    const at = row.more.findIndex((m) => !this.sameAsBefore({ ...row, after: m.after }));
    if (at >= 0) makeMain(row, at);
  }

  /** The size of each "done when"'s before picture, by its words, so the after picture it pairs with can match. */
  private beforeSizes(t: Ticket): Record<string, ShotSize> {
    const rows = (t.proof ?? []).filter((p) => p.before && p.beforeLabel !== 'New screen');
    return Object.fromEntries(rows.flatMap((p) => {
      const size = shotSizeOf(path.join(this.bp.proofDir, p.before));
      return size ? [[p.criterion, size]] : [];
    }));
  }

  /** True when two saved pictures are the same file, or have the very same bytes. */
  private sameFile(a: string, b: string): boolean {
    if (a === b) return true;
    try {
      return fs.readFileSync(path.join(this.bp.proofDir, a)).equals(fs.readFileSync(path.join(this.bp.proofDir, b)));
    } catch {
      return false;
    }
  }

  /** One short Reviewer run for all the pictures: met, broken or not shown once per "done when", in one plain sentence. */
  private async checkPictures(id: string, pictures: P.PictureToCheck[]): Promise<Map<number, CheckVerdict>> {
    if (!pictures.length) return new Map();
    const t = this.update(id, (x) => {
      x.status = 'Reviewer is checking the screenshots';
      x.live = true;
    });
    const asked = pictures.map((p) => p.criterion);
    const full = (file: string) => path.join(this.bp.proofDir, file);
    const r = await this.runAgent({
      role: 'reviewer',
      step: 'proof-check',
      // At the level the project's Quality setting gives a review.
      levelStep: 'review',
      ticket: id,
      cwd: t.worktree!,
      sessionId: randomUUID(),
      prompt: P.proofCheckPrompt(t, pictures.map((p) => ({ ...p, ...(p.file ? { file: full(p.file) } : {}), ...(p.more ? { more: p.more.map((m) => ({ ...m, file: full(m.file) })) } : {}) }))),
      // The pictures are in the proof folder, which the check may read.
      addDirs: [...this.extraDirs(t), this.bp.proofDir],
      permissions: ['read'],
      schema: P.PROOF_CHECK_SCHEMA,
      // Up to 40 pictures to open and read.
      timeoutMs: 15 * 60_000,
      check: (answer) => {
        const left = asked.filter((n) => !checkVerdicts(answer, asked, true).has(n));
        return left.length ? `checks has no verdict for "done when" ${left.join(', ')}` : null;
      },
      onTool: this.watcher(id, 'reviewer', t.worktree!),
    });
    return checkVerdicts(r.structured, asked);
  }

  /** squad-kit could not check the screenshots (the Reviewer's run did not get through): a plain stop with Try again. */
  private checkStop(id: string, err: unknown): void {
    const e = explainError(err);
    this.log('warn', `Could not check the screenshots: ${[e.what, e.detail].filter(Boolean).join(': ')}`, id);
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      delete x.clock;
      x.stage = 'review';
      x.retryPhase = 'proof';
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
      x.status = 'The screenshots are not checked yet';
      addActivity(x, 'reviewer', 'Could not check the screenshots this time');
      x.stuck = {
        gate: 'proof',
        question: ownWords(err) ?? CHECK_FAILED,
        detail: [e.what, e.detail].filter(Boolean).join('\n'),
        options: wayOptions({ gate: 'proof' }),
      };
      x.waiting = { kind: 'stuck', summary: 'The screenshots are not checked yet: needs one decision' };
    });
  }

  /**
   * The screenshots show a "done when" does not work. The first round goes back to the Builder with what they show,
   * like review notes, and the checks, the review and the proof run again; after the last round it is a plain stop
   * with its ways out (Let the Builder try again, Continue anyway, Send it back to the plan). Builds by itself never
   * accepts it: the proof did not pass. What is only not shown never reaches the Builder.
   */
  private async notWorking(id: string, rows: OpenRow[], notShown: OpenRow[]): Promise<void> {
    const t0 = this.update(id, (x) => {
      x.proofRound = (x.proofRound ?? 0) + 1;
      // A "done when" that does not work is a Builder run that did not get through, as review notes are.
      x.fails = (x.fails ?? 0) + 1;
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
    });
    const round = t0.proofRound!;
    if (round >= MAX_PROOF_ROUNDS) {
      const stop = brokenStop(rows);
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.stage = 'review';
        x.retryPhase = 'proof-fix';
        x.status = 'The screenshots show it is not working yet';
        addActivity(x, 'tester', `Still not working after ${round} rounds: ${rows.map((r) => `"done when" ${r.criterion}`).join(', ')}`);
        x.stuck = { gate: 'proof', kind: 'broken', question: stop.question, points: [...stop.points, ...notShown.map((r) => `"Done when" ${r.criterion}, ${r.text}: ${r.why}`)], options: wayOptions({ gate: 'proof', kind: 'broken' }) };
        x.waiting = { kind: 'stuck', summary: 'The screenshots show it is not working yet: needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      addActivity(x, 'tester', `The screenshots show ${rows.length === 1 ? 'one "done when"' : `${rows.length} "done when"`} not working yet, so the Builder fixes ${rows.length === 1 ? 'it' : 'them'}: ${rows.map((r) => `"done when" ${r.criterion}: ${r.why}`).join(' ')}`);
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what the screenshots show';
    });
    await this.runBuilder(id, P.proofFixPrompt(rows.map(fixLine)), true);
    this.afterProofFix(id);
  }

  /**
   * The Tester could not show a "done when" on a screen, after its last retake, or none of them can be shown (`retook`
   * false): a plain stop, and the product is not touched. The ways out are Take the screenshots again, Continue anyway
   * and Send it back to the plan.
   */
  private cannotShow(id: string, rows: OpenRow[], retook = true): void {
    const stop = notShownStop(rows);
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      delete x.clock;
      x.stage = 'review';
      x.retryPhase = 'proof';
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
      x.status = 'The screenshots do not show it yet';
      addActivity(x, 'tester', retook ? `Could not show ${rows.map((r) => `"done when" ${r.criterion}`).join(', ')} on a screen after ${MAX_RETAKES} more tries` : 'Every "done when" ended as not on a screen, so the screenshots do not show the work');
      x.stuck = { gate: 'proof', kind: 'not-shown', question: stop.question, points: stop.points, options: wayOptions({ gate: 'proof', kind: 'not-shown' }) };
      x.waiting = { kind: 'stuck', summary: 'The screenshots do not show it yet: needs one decision' };
    });
  }

  /** "Let the Builder try again" after the screenshots still showed a "done when" not working: it fixes them, two more rounds. */
  private async proofFix(id: string): Promise<void> {
    const t = await this.workspace(id);
    const rows = brokenRows(t);
    // Nothing is broken, only not shown (a stop from before the three verdicts): the Tester takes the pictures again.
    if (!rows.length) return this.proof(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what the screenshots show';
    });
    await this.runBuilder(id, P.proofFixPrompt(rows.map(fixLine)), Boolean(t.sessions?.build));
    this.afterProofFix(id);
  }

  /** After the Builder's fix for the proof: the checks, a fresh review and the proof run again. */
  private afterProofFix(id: string): void {
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed what the screenshots showed');
      // The review starts again: a fresh Reviewer reads the whole change, with its own rounds.
      x.reviewRound = 0;
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  /**
   * The "before" screenshots, beside the build: from a copy of the code at the ticket's base, so they show the app as
   * it was while the Builder changes the ticket's own copy. They stop after 8 minutes, or on the ticket's Stop, and
   * say so when they could not be taken. The copy is removed after.
   */
  private shootBefore(id: string): void {
    const key = `__before:${id}`;
    if (this.running.has(key)) return;
    let ended = () => {};
    this.beforeShotsOf.set(id, new Promise<void>((resolve) => (ended = resolve)));
    this.launch(key, () =>
      this.beforeShots(id, key).finally(() => {
        this.beforeShotsOf.delete(id);
        ended();
      }),
    );
  }

  private async beforeShots(id: string, key: string): Promise<void> {
    // Their own Stop: the ticket's Stop (whichever step runs then), the board closing, or the time running out.
    const own = this.stops.get(key)!;
    let cutOff = false;
    const timer = setTimeout(() => {
      cutOff = true;
      own.abort();
    }, BEFORE_SHOTS_MS);
    const t = readTicket(this.bp, id)!;
    const repo = repoFor(this.meta(), t);
    const root = path.join(projectRoot(this.bp), repo.path);
    let dir: string | null = null;
    try {
      dir = addSnapshot(root, `${id.toLowerCase()}-before`, t.baseCommit!);
      const setup = repo.commands.setup?.trim();
      if (setup) {
        const r = await runCommand(dir, setup, BEFORE_SHOTS_MS, { signal: own.signal, ...(this.guardFor(dir, id) ? { guard: this.guardFor(dir, id)! } : {}) });
        if (own.signal.aborted) throw new Error(STOPPED);
        if (!r.ok) throw new Error(`setting up a copy of the code as it was failed (${setup}): ${tail(r.output, 3)}`);
      }
      const left = (await this.screens(id, 'before', { cwd: dir, job: key, signal: own.signal })).problems;
      if (left.length) this.update(id, (x) => addActivity(x, 'tester', `Left out before screenshots that did not pass squad-kit's check: ${left.map((b) => b.text).join(' ')}`));
    } catch (err) {
      // A Stop, or the board closing, says so elsewhere.
      if (cutOff || !own.signal.aborted) {
        // The exact words go to the app log; the activity says it plainly.
        const e = explainError(err);
        if (!cutOff) this.log('warn', `Could not take the before screenshots: ${[e.what, e.detail].filter(Boolean).join(': ')}`, id);
        this.update(id, (x) =>
          addActivity(x, 'tester', cutOff ? 'Stopped the before screenshots after 8 minutes, so the proof shows the screens after the change only' : 'Could not take the before screenshots, so the proof shows the screens after the change only'),
        );
      }
    } finally {
      clearTimeout(timer);
      if (dir) {
        // Nothing the before screenshots started outlives their copy.
        await runsEnded([dir], 6000);
        await this.clearCopies([dir], {}, id).catch(() => undefined);
        dropSnapshot(root, dir);
      }
    }
  }

  /**
   * The Tester takes screenshots for each "done when", before or after the change, with squad-kit's own tools (the
   * window): squad-kit starts the app first and the Tester takes, looks at and retakes the pictures through it.
   * Before-shots run `beside` the build, in their own copy of the code, with their own Stop and conversation, and leave
   * the card's line to the Builder. An app that does not start stops here, in plain words: no agent is asked to.
   */
  private async screens(id: string, when: 'before' | 'after', beside?: { cwd: string; job: string; signal: AbortSignal }, again: string[] = []): Promise<ShotRound> {
    const meta = this.meta();
    // squad-kit's browser is on this computer before any clock starts: the first time, it is downloaded.
    await this.readyBrowser(id, beside?.signal ?? this.stops.get(id)?.signal, beside?.job ?? id);
    const t = this.update(id, (x) => {
      if (!beside) {
        x.sessions = { ...x.sessions, tester: x.sessions?.tester ?? randomUUID() };
        x.status = when === 'before' ? 'Tester is taking before screenshots' : again.length ? 'Tester is taking the screenshots again' : 'Tester is taking after screenshots';
        startStep(x, { who: 'tester', step: 'proof' });
      }
      // A new round of after-shots: the last round's no longer count (the before-shots stay). A retake adds to the rows.
      if (when === 'after' && !beside && !again.length && x.proof?.length) {
        x.proof = x.proof.filter((p) => p.beforeLabel !== 'New screen').map((p) => ({ criterion: p.criterion, before: p.before, after: '', beforeLabel: p.beforeLabel, afterLabel: p.afterLabel }));
      }
      if (when === 'after' && !beside && !again.length) delete x.offScreen;
      addActivity(x, 'tester', when === 'before' ? 'Taking screenshots before the change' : 'Taking screenshots after the change');
    });
    fs.mkdirSync(this.bp.proofDir, { recursive: true });
    const rc = repoFor(meta, t).commands;
    const cwd = beside?.cwd ?? t.worktree!;
    const signal = beside?.signal ?? this.stops.get(id)?.signal;
    const start = rc.start?.trim() ?? '';
    const url = rc.url?.trim() ?? '';
    // No old server of squad-kit's own copies may hold the app's port.
    if (!beside) await this.clearBeforeApp(id);
    if (!beside) this.update(id, (x) => (x.status = 'Starting the app'));
    let app: RunningApp;
    try {
      app = await startApp(cwd, start, url, undefined, signal, this.guardFor(cwd, id));
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new StepError(dockerBlockedWords((err as Error).message, this.guardFor(cwd, id)) ?? NO_APP, (err as Error).message);
    }
    const at = app.url;
    // The address goes to the log; the story gets one plain line.
    this.log('info', `squad-kit started the app at ${at}${at !== url ? ` (${url} was used by another program)` : ''}`, id);
    this.update(id, (x) => addActivity(x, 'tester', 'squad-kit started the app'));
    const win = new AgentWindow({
      ...this.windowBase(id, 'tester', cwd, beside?.job ?? id),
      step: 'proof',
      who: 'Tester',
      // A copy of the code as it was has nothing to check; the story's own copy does.
      tools: beside ? ALL_TOOLS.filter((x) => x !== 'run_checks') : ALL_TOOLS,
      app: { cwd, start, url, ...(this.guardFor(cwd, id) ? { guard: this.guardFor(cwd, id)! } : {}) },
      ...(beside ? {} : { checks: this.windowChecks(id, cwd) }),
      running: app,
      prefix: `${id.toLowerCase()}-${when}`,
      ...(signal ? { signal } : {}),
    });
    openWindow(win);
    try {
      return await this.shoot(id, t, when, meta, win, at, beside, again);
    } finally {
      // The app squad-kit started stops with the window, and the window's key stops working.
      await closeWindow(win);
    }
  }

  private async shoot(id: string, t: Ticket, when: 'before' | 'after', meta: BoardMeta, win: AgentWindow, appUrl: string, beside?: { cwd: string; job: string }, again: string[] = []): Promise<ShotRound> {
    // The Tester only reads the code: squad-kit takes the pictures. The lane still puts back anything changed.
    const lane = watchLane(beside?.cwd ?? t.worktree!, this.protectedFiles(beside?.cwd ?? t.worktree!), true);
    // A picture saved before this moment was not taken in this step.
    const since = Date.now();
    const prompt = P.proofPrompt(meta, t, when, this.ctx(t), appUrl, when === 'after' ? this.beforeSizes(t) : undefined);
    // A new round of after-shots names every "done when": a picture, or why it shows on no screen.
    const count = doneWhenCount(t);
    const complete = (answer: unknown): string | null => {
      const a = (answer ?? {}) as { shots?: { criterion?: unknown }[]; offScreen?: { criterion?: unknown }[] };
      const named = new Set([...(a.shots ?? []), ...(a.offScreen ?? [])].map((x) => Number(x?.criterion)));
      const left = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !named.has(n));
      return left.length ? `every "done when" must be in shots or in offScreen, and ${left.map((n) => `"done when" ${n}`).join(', ')} ${left.length === 1 ? 'is' : 'are'} in neither` : null;
    };
    // Only pictures taken in this step count: a file it names from outside them is asked for once more, with the list.
    const realFiles = (answer: unknown): string | null => {
      const wrong = [...new Set(((answer ?? {}) as { shots?: { file?: unknown }[] }).shots?.map((x) => path.basename(String(x?.file ?? ''))) ?? [])].filter((f) => !win.pictures.has(f));
      return wrong.length ? `it names ${wrong.join(', ')}, which squad-kit did not take in this step` : null;
    };
    // A "done when" gets one picture per part or case, so an answer may name it several times, up to a limit.
    const notTooMany = (answer: unknown): string | null => {
      const named = ((answer ?? {}) as { shots?: { criterion?: unknown }[] }).shots?.map((x) => Number(x?.criterion)) ?? [];
      const over = [...new Set(named)].filter((n) => named.filter((m) => m === n).length > MAX_PICTURES_PER_DONE_WHEN);
      return over.length ? `one "done when" takes at most ${MAX_PICTURES_PER_DONE_WHEN} pictures, one per part or case, and ${over.map((n) => `"done when" ${n}`).join(', ')} ${over.length === 1 ? 'has' : 'have'} more` : null;
    };
    const check = (answer: unknown): string | null => realFiles(answer) ?? notTooMany(answer) ?? (when === 'after' && !again.length && count ? complete(answer) : null);
    const r = await this.runAgent({
      role: 'tester',
      step: 'proof',
      ticket: id,
      // The before-shots ran in a copy that is gone now, so the after-shots have a conversation of their own.
      ...(beside ? { job: beside.job, cwd: beside.cwd, sessionId: randomUUID() } : { cwd: t.worktree!, sessionId: t.sessions!.tester }),
      prompt: again.length ? `${prompt}\n\n${P.proofAgainPrompt(again)}` : prompt,
      permissions: ['read'],
      schema: P.PROOF_SCHEMA,
      check,
      checkHelp: () => win.pictureList(),
      // Up to 40 pictures, with a look at each.
      timeoutMs: 30 * 60_000,
      addDirs: this.extraDirs(t),
      box: {},
      win,
      ...(beside ? {} : { onTool: this.watcher(id, 'tester', t.worktree!) }),
    }).finally(() => this.keepLane(id, 'tester', lane, [this.bp.proofDir]));
    const out = (r.structured ?? { shots: [] }) as {
      shots: { criterion: number; file: string; shows?: string; note?: string }[];
      offScreen?: { criterion: number; why?: string }[];
      /** Older answers: one line for what shows on no screen. */
      skipped?: string;
    };
    const say = (text: string) => this.update(id, (x) => addActivity(x, 'tester', text));
    // Only pictures squad-kit took in this step count, each with the page it was taken at and the Tester's verdict.
    const shots: { criterion: number; file: string; page: string; size: string; shows: Judged; note?: string }[] = [];
    for (const s of out.shots ?? []) {
      const file = path.basename(String(s.file ?? ''));
      const taken = win.pictures.get(file);
      if (!taken) {
        say(`The Tester named ${file || 'a picture'} for "done when" ${s.criterion}, which squad-kit did not take in this step, so it is left out`);
        continue;
      }
      // Asked once more already (notTooMany): the first ones stay.
      if (shots.filter((x) => x.criterion === s.criterion).length >= MAX_PICTURES_PER_DONE_WHEN) {
        say(`The Tester named more than ${MAX_PICTURES_PER_DONE_WHEN} pictures for "done when" ${s.criterion}, so squad-kit kept the first ${MAX_PICTURES_PER_DONE_WHEN}`);
        continue;
      }
      const note = s.note ? this.plainNote(win, s.note) : '';
      shots.push({ criterion: s.criterion, file, page: taken.page, size: taken.size, shows: verdictOf(s.shows) ?? 'not-shown', ...(note ? { note } : {}) });
    }
    // Each "done when" that shows on no screen, with why in plain words.
    const off: { criterion: number; why: string }[] = [];
    for (const o of when === 'after' ? (out.offScreen ?? []) : []) {
      const n = Number(o?.criterion);
      // Pictures of a part and a reason for the rest go together: squad-kit's check judges both.
      if (!criterionText(t, n) || off.some((x) => x.criterion === n)) continue;
      const refused = win.refusals.length;
      const why = this.plainNote(win, String(o.why ?? ''));
      // A reason that asked for what nobody may ask is no reason: that "done when" still needs a picture.
      if (win.refusals.length > refused) continue;
      off.push({ criterion: n, why });
    }
    const skipped = [...off.map((o) => o.why), this.plainNote(win, out.skipped ?? '')].filter(Boolean).join(' ');
    if (win.tooMany) throw new StepError(tooManyWords('Tester'), win.refusalDetail());
    if (win.tooManyMistakes) throw new StepError(tooManyMistakesWords('Tester'), win.mistakeDetail());
    const named = (n: number) => criterionText(t, n);
    // squad-kit looks at each picture itself: a real image, a sensible size, not blank, saved in this step.
    const problems: ShotProblem[] = [];
    const rejected = new Set<string>();
    for (const s of shots) {
      const full = path.join(this.bp.proofDir, s.file);
      const criterion = named(s.criterion);
      if (!criterion || !fs.existsSync(full)) continue;
      const bad = shotProblem(full, since);
      if (!bad) continue;
      rejected.add(s.file);
      problems.push({ criterion, text: `The ${when} screenshot for "${criterion}" (${s.file}): ${bad}.` });
    }
    this.update(id, (x) => {
      const proof = x.proof ?? [];
      const usable = shots.filter((s) => !rejected.has(s.file) && named(s.criterion) && fs.existsSync(path.join(this.bp.proofDir, s.file)));
      for (const n of new Set(usable.map((s) => s.criterion))) {
        const criterion = named(n)!;
        const own = usable.filter((s) => s.criterion === n);
        let row = proof.find((p) => p.criterion === criterion);
        if (!row) {
          row = { criterion, before: '', after: '', beforeLabel: 'Before', afterLabel: 'After' };
          proof.push(row);
        }
        // One before pairs with the main after. The Tester's own verdict stands until squad-kit's check of them (judge).
        if (when === 'before') row.before = own[0]!.file;
        else {
          addPictures(row, own, (a, b) => this.sameFile(a, b));
          this.pairWithBefore(row);
        }
      }
      x.proof = proof.map((p) => (p.before ? p : { ...p, before: p.after, beforeLabel: 'New screen', afterLabel: 'After' }));
      if (when === 'after') {
        // A new round says again what shows on no screen; a retake adds to it. squad-kit's check judges them next (judge).
        const kept = again.length ? (x.offScreen ?? []) : [];
        const added = off.map((o) => ({ criterion: named(o.criterion)!, why: o.why || 'The Tester says it does not show on a screen.' }));
        const all = [...kept.filter((k) => !added.some((a) => a.criterion === k.criterion)), ...added];
        if (all.length) x.offScreen = all;
        else delete x.offScreen;
        const notOn = off.length ? `. Not on a screen: ${off.map((o) => `"done when" ${o.criterion}`).join(', ')}` : skipped ? `. Skipped: ${skipped}` : '';
        addActivity(x, 'tester', `Saved ${shots.length - rejected.size} screenshots${notOn}`);
      }
    });
    return { problems, planned: shots.map((s) => s.criterion), said: skipped, stuck: win.stuck, sizes: Object.fromEntries(shots.map((s) => [s.file, s.size])) };
  }

  /** Sets up squad-kit's screenshot browser when this computer lacks it, on its own limit, saying so on the ticket. */
  private async readyBrowser(id: string, signal: AbortSignal | undefined, job: string): Promise<void> {
    // Setting it up the first time is the step working, not hanging.
    const beat = setInterval(() => this.dog.beat(job), 20_000);
    try {
      await prepareShots({ ...(signal ? { signal } : {}), onLine: (text) => this.update(id, (x) => addActivity(x, 'tester', text)) });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new StepError((err as Error).message, shotsErrorDetail(err));
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * The Tester's words for the person (a picture's note, why a "done when" shows on no screen): its plain sentences
   * stay, and each technical one goes to the app log (shots.ts plainParts), so "390 px" or "1280 wide" never hides a
   * note. A note with nothing plain left says so in the activity; an ask that is not allowed is refused and counted.
   */
  private plainNote(win: AgentWindow, text: string): string {
    const said = text.trim();
    if (!said) return '';
    const verdict = judgeQuestion({ text: said });
    if (!verdict.pass && verdict.kind === 'not-allowed') {
      win.refuse('note', `${verdict.why}: "${said.slice(0, 200)}"`, refusedAskLine('Tester', verdict.what));
      return '';
    }
    const { kept, left } = plainParts(said, technicalWords);
    // Its technical words go to the app log, not to the activity.
    if (left) this.log('info', `Left out of the Tester's note: ${left.slice(0, 600)}`, win.ticket);
    if (kept) return kept.slice(0, 600);
    this.update(win.ticket, (x) => addActivity(x, 'tester', 'The Tester wrote something technical, so it stays out of the proof.'));
    return '';
  }
}

/** The person's words when the app did not start for the screenshots. */
const NO_APP = 'squad-kit could not start the app, so it took no screenshots. Press Try again to try once more.';
/** When the Tester's run did not get through, for a reason only engineers need. */
const NO_PICTURES = 'squad-kit could not take the screenshots this time. Press Try again to try once more.';
/** When the Tester got stuck on something technical that squad-kit could not fix. */
const STUCK_PICTURES = 'The Tester got stuck on something technical that squad-kit could not fix, so there are no screenshots yet. Press Try again to try once more.';

/** What squad-kit's check of the proof ended with: the "done when" not working, not shown, and not on a screen. */
interface ProofJudged {
  broken: OpenRow[];
  notShown: OpenRow[];
  offScreen: OpenRow[];
}

/** One round of screenshots: the pictures that failed squad-kit's check, what was taken, the Tester's plain words and its technical trouble. */
interface ShotRound {
  problems: ShotProblem[];
  /** The "done when" numbers it handed a picture in for. */
  planned: number[];
  said: string;
  stuck: { what: string; why: string }[];
  /** Each picture's size ("phone", "desktop"), by file name, for squad-kit's check of what it shows. */
  sizes: Record<string, string>;
}

/** True when one sentence has the question filter's technical words: a port, a process, the sandbox. */
function technicalWords(sentence: string): boolean {
  const v = judgeQuestion({ text: sentence });
  return !v.pass && v.kind === 'technical';
}

/** "the tests and the build": the checks that failed, in words for people. */
function checkNames(names: string[]): string {
  const words: Record<string, string> = { test: 'the tests', lint: 'the lint check', build: 'the build', start: 'starting the app' };
  const w = [...new Set(names.map((n) => words[n] ?? `the ${n} check`))];
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : (w[0] ?? 'a check');
}

/** The "done when" with no picture after a round (and not said to show on no screen), each with why in plain words. */
function missingShots(t: Ticket, round: ShotRound): { criterion: number; why: string }[] {
  const count = doneWhenCount(t);
  const off = offScreenNumbers(t);
  const out: { criterion: number; why: string }[] = [];
  for (let n = 1; n <= count; n += 1) {
    const row = (t.proof ?? []).find((p) => p.criterion === criterionText(t, n));
    if (row?.after || off.has(n)) continue;
    out.push({ criterion: n, why: round.planned.includes(n) ? 'squad-kit could not use the picture the Tester took.' : 'The Tester took no picture of it.' });
  }
  return out;
}

/** A proof picture that failed squad-kit's check, for the row of one "done when". */
interface ShotProblem {
  criterion: string;
  text: string;
}

/** A row's verdict as the Tester said it, for squad-kit's check. */
const SAID: Record<NonNullable<ProofShot['shows']>, string> = { met: 'it is met', broken: 'it is broken', 'not-shown': 'it is not shown', 'off-screen': 'it is not on a screen' };

/** The first of the Builder's plan steps not done yet, from 1. */
function openStep(t: Ticket): number {
  const i = (t.steps ?? []).findIndex((s) => s.status !== 'done');
  return i >= 0 ? i + 1 : 1;
}

/** A card line that says the ticket waits: for a free place, or for the usage limit. */
function held(status: string | undefined): boolean {
  return Boolean(status && (status.startsWith(QUEUED) || isLimitText(status)));
}

function isInside(dir: string, file: unknown): boolean {
  return typeof file === 'string' && !path.relative(dir, file).startsWith('..');
}

function clean(c: ProjectCommands): ProjectCommands {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string' && v.trim())) as ProjectCommands;
}

function attachmentDirs(t: Ticket): string[] {
  return [...new Set((t.attachments ?? []).map((a) => path.dirname(a)))];
}

/** Thrown when a step pauses to ask the person. The ticket already shows the question; nothing failed. */
class WaitingForYou extends Error {
  constructor() {
    super('Waiting for your answer');
  }
}

interface AgentAsk {
  text: string;
  options?: string[];
  why?: string;
  files?: string[];
  /** Builds by itself: a critical gap or a clash, the only reasons it stops. */
  kind?: 'gap' | 'clash';
  /** Builds by itself: where the gap or the clash comes from. */
  sources?: unknown;
  /** Set by squad-kit, never by the agent: the plain card about a busy port (see inTheWay). */
  port?: PortAsk;
}
