import path from 'node:path';
import {
  addActivity,
  boardExists,
  listTickets,
  readMeta,
  readTicket,
  updateTicket,
  type BoardPaths,
} from '../../board/store.js';
import { endSaves, openChange } from '../../board/actions.js';
import type { BoardMeta, NetworkLevel, Role, Ticket } from '../../board/types.js';
import { describeToolEvent } from '../../modules/registry.js';
import { DOING, plainToolLine, stepWords } from '../plain-doing.js';
import type { ToolEvent } from '../../modules/ai-tool/types.js';
import type { CheckResult, RunningApp } from '../checks.js';
import { TECHNICAL_STOP, ownWords } from '../plain-stop.js';
import type { ListNo } from '../../board/additions.js';
import { flushTracker, trackerDue } from '../sync.js';
import { lookOutsideBeside, lookOutsideSoon } from '../merged-outside.js';
import { Watchdog } from '../watchdog.js';
import { CapReached } from '../caps.js';
import { sandboxAsk } from '../sandbox.js';
import { tidyStoryDbsBeside } from '../story-db.js';
import { isMine } from '../../board/owner.js';
import { howPaid } from '../../board/payment.js';
import { parallelLimit } from '../../core/settings.js';
import type { Lane } from '../lane.js';
import { pauseClock, stepDoing } from '../../board/clock.js';
import { queuedLine } from '../../board/now.js';
import { firstOpenTicket, waitsForFirstWords } from '../../board/first-story.js';
import { TOOLS_CHECKING, toolsHold, waitsForTools } from '../tools/index.js';
import { LimitReached, activePause, limitText, type LimitPause } from '../usage-limit.js';
import { forgetSaveTrouble } from '../save-trouble.js';
import { fileTroubleWords, isDiskTrouble } from '../../core/file-trouble.js';
import { explainError } from '../../board/problem.js';
import { firstSaveDue, firstSaveHolds, runFirstSave, runSetupProof, settleSetupStop } from '../onboard.js';
import { nextProofStep } from '../../board/setup-state.js';
import { wakeIfReady } from '../../board/depends.js';
import { catchUp } from '../depends.js';
import { projectCopies, runsEnded } from '../leftovers.js';
import { CutOff, carriesOn, markInterrupted, sleepMark, sleptSince, type SleepMark } from '../interrupt.js';
import { trackTask } from '../process-group.js';
import { mergeWait, resumeAccept } from '../../board/auto.js';
import { breakdownJobs, holdBreakdownJob } from '../../board/requirements.js';
import { breakdownStopped } from '../../board/requirements-actions.js';
import { analystOverBudget, fillBuildQueue, placesLeft } from '../../board/requirements-build.js';
import { startSends } from '../../board/requirements-send.js';
import { PassingTrouble, projectRoot, secretFiles, WaitingForYou } from './shared.js';
import { waitsPart } from './waits.js';
import { keptPart } from './kept.js';
import { watchPart } from './watch.js';
import { agentWindowPart } from './agent-window.js';
import { agentRunPart } from './agent-run.js';
import { stopsPart } from './stops.js';
import { projectPart } from './project.js';
import { stepPart } from './step.js';
import { questionsPart } from './questions.js';
import { chatPart } from './chat.js';
import { changePart } from './change.js';
import { planPart } from './plan.js';
import { workspacePart } from './workspace.js';
import { buildPart } from './build.js';
import { asksPart } from './asks.js';
import { basePart } from './base.js';
import { checksPart } from './checks.js';
import { checkStopsPart } from './check-stops.js';
import { reviewPart } from './review.js';
import { proofPart } from './proof.js';
import { pictureCheckPart } from './picture-check.js';
import { beforePart } from './before.js';
import { mainCopyPart } from './main-copy.js';
import { screensPart } from './screens.js';
import { shootPart } from './shoot.js';

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

export class LiveSquad {
  running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  stops = new Map<string, AbortController>();
  /** The Builder's lane checks while it runs: a copy it adds on the way joins them. */
  lanesOf = new Map<string, Lane[]>();
  syncing = new Set<string>();
  /** The breakdowns held at the budget whose way of paying is being looked at now. */
  paymentLooks = new Set<string>();
  private localRuns = new Set<string>();
  /** Builds by itself: merges that wait (a pull request's approver, the person's checkout), and when each was looked at. */
  mergeLooks = new Map<string, number>();
  closing = false;
  /** Turns of the squad in a row that failed. */
  turnsFailed = 0;
  dog = new Watchdog();
  lastWatch = 0;
  lastPickUp = 0;
  pickingUp = false;
  /** A turn of Build continuously is running. */
  private queueing = false;
  /** What a waiting ticket's card said before it waited for a free place, to say again when its step starts. */
  beforeQueue = new Map<string, string>();
  /** The Tester's noes on a team's list that is on, in this proof. */
  listNoes = new Map<string, ListNo[]>();
  /** "Before" screenshots running beside a ticket's build, until they end. */
  beforeShotsOf = new Map<string, Promise<void>>();
  /** What the last board left running in squad-kit's copies, being stopped as this one starts: steps wait for it. */
  swept: Promise<unknown> | null = null;
  /** When each ticket's step started, on both clocks, to tell a run the computer's sleep cut off. */
  marks = new Map<string, SleepMark>();
  /**
   * The app squad-kit started for a ticket's review, kept running into its proof, and between the proof's rounds of
   * pictures: a big app takes 30 to 60 seconds to start. `tree` is the copy's code it started from (none yet while the
   * review decides), `at` when it was last handed back.
   */
  kept = new Map<string, { app: RunningApp; cwd: string; tree?: string; at: number; leave: () => void }>();
  /**
   * The Builder's last passing run_checks of each saved check in a ticket's copy, in its current round, by the copy's
   * folder and the check's name: the copy's code as the run started (`tree`), and what the check printed. The checks
   * step may use each instead of running that check again (builderPassed). Kept in memory only: after a restart the
   * checks step simply runs them.
   */
  builderRuns = new Map<string, Map<string, Map<string, { tree: string; run: CheckResult; at: number }>>>();

  constructor(public bp: BoardPaths) {}

  start(intervalMs = 1000): () => void {
    this.resumeAfterRestart();
    // A pull request merged on the code host while the board was closed is noticed a few seconds after it opens.
    lookOutsideSoon(this.bp);
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
      for (const id of [...this.kept.keys()]) void this.dropKept(id);
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
    // A heavy product takes fewer at once than the app allows. That place is no one else's to give up.
    const own = this.meta().atOnce;
    if (own && mine >= own) return false;
    const busy = ticketsRunning() + (squads.has(this) ? 0 : mine);
    if (busy < limit && ![...waiting].some((s) => s !== this && s.ticketsRunning() < mine)) {
      waiting.delete(this);
      return true;
    }
    waiting.add(this);
    return false;
  }

  tick(): void {
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
    this.sweepKept();
    this.pickUp();
    // Pull requests squad-kit opened, merged by a person on the code host: a quiet look now and then, beside the work.
    lookOutsideBeside(this.bp);
    // The databases of stories that no longer need one go, now and then.
    tidyStoryDbsBeside(this.bp);
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
      this.stops.get('__firstSave')?.abort();
      // Nothing runs, so nothing would answer the Stop (the usage limit holds the read).
      if (!this.running.has('__scan') && !this.running.has('__setup') && !this.running.has('__firstSave')) {
        settleSetupStop(this.bp);
        return;
      }
    }
    // A big folder with no git yet gets its first save first, beside everything else: nothing can start without it.
    if (firstSaveHolds(meta)) {
      if (firstSaveDue(meta) && !meta.setup?.stopping && !this.running.has('__firstSave')) this.launch('__firstSave', () => runFirstSave(this.bp, this.stops.get('__firstSave')!.signal));
      return;
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
      // A long document waits for the person's word before the Analyst is paid to read it.
      else if (j.job.heldFor === 'long') continue;
      else if (pause) holdBreakdownJob(this.bp, j.id, limitText(pause));
      // Held at this month's budget: it starts again once the budget is raised, or the person pressed Carry on.
      else if (j.job.heldFor === 'budget' && analystOverBudget(this.bp, j.id)) this.letGoOnSubscription(j.id);
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
        // A project with no code: the first story picks the tools, so the others take their next step once it merges.
        const first = meta.scan?.empty ? firstOpenTicket(this.bp, t) : undefined;
        // A Required tool missing or too old for this step (a Flutter app on a computer without Flutter): it waits with
        // the reason, and goes on by itself once the tool is there (engine/tools).
        const tools = first || pause ? null : (toolsHold(this.bp, t, this.phaseFor(t)) ?? this.picturesWait(t, this.phaseFor(t)));
        if (!first && !pause && !tools && waitsForTools(t.status) && t.status !== TOOLS_CHECKING) this.toolsHere(t.id);
        if (first) this.hold(t, waitsForFirstWords(first.id));
        else if (pause) this.hold(t, limitText(pause));
        else if (tools) this.waitForTools(t, tools);
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

  launch(key: string, job: () => Promise<void>): void {
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

  /* ── helpers ─────────────────────────────────────────── */

  /**
   * Commands squad-kit runs itself (setup, checks) report to the watchdog too, and end on the ticket's Stop. One that
   * runs once more with a home of the project's own says so on the story in one plain line, with the details in the log.
   */
  commandWatch(id: string) {
    const signal = this.stops.get(id)?.signal;
    return { onSpawn: (pid: number) => this.dog.track(id, pid), onOutput: () => this.dog.beat(id), onHealed: (detail: string) => this.healed(id, detail), ...(signal ? { signal } : {}) };
  }

  /** The watchdog hooks and the guard together, for a command run in a ticket's copy. */
  guardedWatch(id: string, cwd: string) {
    const guard = this.guardFor(cwd, id);
    return { ...this.commandWatch(id), ...(guard ? { guard } : {}) };
  }

  /** Show live progress: the latest tool line on the ticket, a few of them in its activity. */
  watcher(id: string, role: Role, cwd: string, onLine?: (line: string, t: Ticket) => void) {
    let last = 0;
    let logged = 0;
    return (e: ToolEvent) => {
      const line = describeToolEvent(e, cwd);
      if (!line || Date.now() - last < 700) return;
      last = Date.now();
      // The status and the card get plain words; the exact command stays in the Conversation tab's full log.
      const said = plainToolLine(e, cwd) ?? DOING.other;
      this.update(id, (t) => {
        // The words follow what the step is about: writing tests, fixing what its own run of the tests found.
        const plain = stepWords(said, t);
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

  /**
   * What a Builder or Tester step's commands may reach in the sandbox: its copy, the proof folder, the cache home the
   * project's stories share and the sites the project's network level allows.
   */
  async sandboxFor(cwd: string, read: string[], cache?: string, network?: NetworkLevel) {
    return sandboxAsk({
      cwd,
      root: projectRoot(this.bp),
      read,
      proof: this.bp.proofDir,
      secrets: await secretFiles(this.bp, cwd),
      hosts: this.meta().allowedHosts ?? [],
      ...(network ? { network } : {}),
      ...(cache ? { cache } : {}),
    });
  }

  /** How many times squad-kit ran a story's checks again by itself for a missing tool, by story. */
  toolReruns = new Map<string, number>();
}

// The methods of each step live in their own file (waits.ts, checks.ts, proof.ts…). They go on the class here, made
// like its own methods: not listed by for…in.
type Parts = typeof waitsPart &
  typeof keptPart &
  typeof watchPart &
  typeof agentWindowPart &
  typeof agentRunPart &
  typeof stopsPart &
  typeof projectPart &
  typeof stepPart &
  typeof questionsPart &
  typeof chatPart &
  typeof changePart &
  typeof planPart &
  typeof workspacePart &
  typeof buildPart &
  typeof asksPart &
  typeof basePart &
  typeof checksPart &
  typeof checkStopsPart &
  typeof reviewPart &
  typeof proofPart &
  typeof pictureCheckPart &
  typeof beforePart &
  typeof mainCopyPart &
  typeof screensPart &
  typeof shootPart;
export interface LiveSquad extends Parts {}
for (const part of [waitsPart, keptPart, watchPart, agentWindowPart, agentRunPart, stopsPart, projectPart, stepPart, questionsPart, chatPart, changePart, planPart, workspacePart, buildPart, asksPart, basePart, checksPart, checkStopsPart, reviewPart, proofPart, pictureCheckPart, beforePart, mainCopyPart, screensPart, shootPart]) {
  for (const [name, value] of Object.entries(part)) Object.defineProperty(LiveSquad.prototype, name, { value, writable: true, configurable: true });
}

function isInside(dir: string, file: unknown): boolean {
  return typeof file === 'string' && !path.relative(dir, file).startsWith('..');
}
