import fs from 'node:fs';
import { isUp } from '../board/apps.js';
import { pageUrl, proofPages, waitsAtReview } from '../board/at-review.js';
import { addActivity, readMeta, readTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { startApp, type RunningApp } from './checks.js';
import { guardSupport, ticketGuard } from './project-guard.js';
import { KILL_AFTER_MS } from './process-group.js';
import { repoFor } from './repos.js';

/**
 * Try it yourself: while a ticket waits for the person's check, squad-kit runs that ticket's own copy of the app (its
 * copy of the code, with the change in it, nothing merged), so a project manager can click through it before Looks
 * right. One copy per project at a time: starting another stops the first. It stops by itself when the ticket moves
 * on (Looks right, Something's wrong, any next step), when the ticket is deleted, and when the board closes; nothing
 * it starts outlives the copy. Terminal: `squad try <ticket>`, `squad try <ticket> --stop`.
 */

export type TryState = 'off' | 'starting' | 'running' | 'failed';

export interface TryPage {
  page: string;
  url: string;
}

export interface TryStatus {
  ticket: string;
  state: TryState;
  /** Where the copy answers, while it runs. */
  url?: string;
  /** Each page of "Where to look" at that address, while it runs. */
  pages?: TryPage[];
  /** When it began to answer. */
  since?: string;
  /** Why it did not start, in plain words. */
  error?: string;
  /** What it printed, for engineers ("See what failed"). */
  detail?: string;
  /** Another ticket's copy runs or starts now: starting this one stops it. */
  other?: string;
  /** False when this ticket cannot be tried now; `why` says what is missing. */
  can: boolean;
  why?: string;
}

export interface TryOptions {
  /** How long the app gets to answer at its address. */
  waitMs?: number;
  /** How often squad-kit looks whether the ticket moved on, or the app stopped. */
  watchMs?: number;
}

/** A person-facing reason the copy cannot start: a 400 with the message. */
export class TryError extends Error {}

interface TryRun {
  ticket: string;
  state: 'starting' | 'running' | 'failed';
  /** Where the ticket stood when the copy started: when it changes, the ticket has moved on. */
  mark: string;
  cwd: string;
  url?: string;
  since?: string;
  error?: string;
  detail?: string;
  app?: RunningApp;
  stop: AbortController;
  /** Resolves once the start is over: running, failed or stopped. */
  settled: Promise<void>;
  /** How many looks in a row the address did not answer. */
  missed: number;
}

const WATCH_MS = 2000;

function markOf(t: Ticket): string {
  return `${t.stage}|${t.waiting?.kind ?? ''}|${t.stuck?.gate ?? ''}`;
}

/** Why a ticket cannot be tried now, in plain words; null when it can. */
export function tryBlocked(bp: BoardPaths, t: Ticket): string | null {
  if (!waitsAtReview(t)) return `${t.id} does not wait for your check now, so there is nothing to try.`;
  if (!t.worktree || !fs.existsSync(t.worktree)) return `${t.id} has no copy of the code on this computer to run.`;
  const rc = repoFor(readMeta(bp), t).commands;
  if (!rc.start?.trim()) return 'squad-kit does not know how to start the app yet. Set its start command in Settings, under How the squad checks and runs this project.';
  if (!rc.url?.trim()) return "squad-kit does not know the app's address yet. Set it in Settings, under How the squad checks and runs this project.";
  return null;
}

/**
 * The copy should stop now: the ticket moved on, went, or its copy of the code went. `note` is the line for its
 * activity; a ticket being deleted gets none. Null while it still waits for the person.
 */
function movedOn(t: Ticket | null, run: TryRun): { note?: string } | null {
  if (!t || t.deleting) return {};
  if (t.stage === 'release' || t.stage === 'done') return { note: 'Stopped the copy of the app you were trying: the ticket is accepted' };
  if (t.live || t.squad || !waitsAtReview(t) || markOf(t) !== run.mark || t.worktree !== run.cwd || !fs.existsSync(run.cwd)) {
    return { note: 'Stopped the copy of the app you were trying: the ticket moved on' };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ticket copies of one project's app: one runs at a time. The board's buttons and the terminal share it. */
export class TryRunner {
  private run?: TryRun;
  private timer?: NodeJS.Timeout;
  private looking = false;

  constructor(
    private bp: BoardPaths,
    private opts: TryOptions = {},
  ) {}

  private ticket(id: string): Ticket {
    const t = readTicket(this.bp, id);
    if (!t) throw new TryError(`No ticket ${id.toUpperCase()} on this board.`);
    return t;
  }

  /** A line in the ticket's activity. A ticket that is gone has none. */
  private note(id: string, text: string): void {
    try {
      updateTicket(this.bp, id, (x) => addActivity(x, 'squad', text));
    } catch {
      // Deleted meanwhile.
    }
  }

  /** How Try it yourself stands for a ticket: off, starting, running with its address and pages, or failed. */
  status(id: string): TryStatus {
    const t = this.ticket(id);
    const run = this.run;
    const mine = run?.ticket === t.id ? run : undefined;
    const why = tryBlocked(this.bp, t);
    const url = mine?.state === 'running' ? mine.url : undefined;
    return {
      ticket: t.id,
      state: mine?.state ?? 'off',
      ...(url ? { url, pages: proofPages(t).map((page) => ({ page, url: pageUrl(url, page) })) } : {}),
      ...(mine?.since && url ? { since: mine.since } : {}),
      ...(mine?.error ? { error: mine.error } : {}),
      ...(mine?.detail ? { detail: mine.detail } : {}),
      ...(run && !mine ? { other: run.ticket } : {}),
      can: !why,
      ...(why ? { why } : {}),
    };
  }

  /**
   * Starts the ticket's own copy of the app. It answers at once (Starting); the app starts on, until its address
   * answers. Something else at the app's address (the person's own app, or Your apps) moves it to a free port. Another
   * ticket's copy stops first. `settled()` waits for the end of the start.
   */
  start(id: string): TryStatus {
    const t = this.ticket(id);
    const why = tryBlocked(this.bp, t);
    if (why) throw new TryError(why);
    const now = this.run;
    if (now?.ticket === t.id && (now.state === 'starting' || now.state === 'running')) return this.status(t.id);
    const rc = repoFor(readMeta(this.bp), t).commands;
    let settle!: () => void;
    const run: TryRun = {
      ticket: t.id,
      state: 'starting',
      mark: markOf(t),
      cwd: t.worktree!,
      stop: new AbortController(),
      settled: new Promise<void>((r) => (settle = r)),
      missed: 0,
    };
    this.run = run;
    void this.launch(run, now, rc.start!.trim(), rc.url!.trim()).finally(settle);
    this.watch();
    return this.status(t.id);
  }

  private async launch(run: TryRun, before: TryRun | undefined, command: string, url: string): Promise<void> {
    if (before) await this.end(before, before.state === 'running' ? `Stopped the copy of the app you were trying: you started ${run.ticket}'s` : undefined);
    if (run.stop.signal.aborted) return;
    try {
      const allow = readMeta(this.bp).guard;
      const guard = guardSupport().on ? ticketGuard(this.bp, { cwd: run.cwd, id: run.ticket, ...(allow ? { allow } : {}) }) : undefined;
      const app = await startApp(run.cwd, command, url, this.opts.waitMs, run.stop.signal, guard);
      if (run.stop.signal.aborted) return app.stop();
      run.app = app;
      run.url = app.url;
      run.since = new Date().toISOString();
      run.state = 'running';
      this.note(run.ticket, "Started this story's own copy of the app for you to try. Nothing is merged.");
    } catch (err) {
      if (run.stop.signal.aborted) return;
      run.state = 'failed';
      run.error = 'The app did not start.';
      // One plain sentence; what it printed is behind "See what failed", for engineers.
      run.detail = (err as Error).message.slice(-4000);
      this.note(run.ticket, 'Try it yourself: the app did not start.');
    }
  }

  /** Waits until the start is over, and says how it went. */
  async settled(id: string): Promise<TryStatus> {
    const run = this.run;
    if (run?.ticket === this.ticket(id).id) await run.settled;
    return this.status(id);
  }

  /** Stops a copy and everything it started, then waits until its address no longer answers. */
  private async end(run: TryRun, why?: string): Promise<void> {
    run.stop.abort();
    run.app?.stop();
    await run.settled;
    if (this.run === run) this.run = undefined;
    if (run.app && run.url) {
      const until = Date.now() + KILL_AFTER_MS + 1500;
      while (Date.now() < until && (await isUp(run.url))) await sleep(200);
    }
    if (why) this.note(run.ticket, why);
  }

  /** Stop: the ticket's copy (any copy, without a ticket) stops, and what it started with it. */
  async stop(id?: string): Promise<TryStatus | null> {
    const t = id ? this.ticket(id) : undefined;
    const run = this.run;
    if (run && (!t || run.ticket === t.id)) {
      this.run = undefined;
      await this.end(run, run.state === 'running' ? 'You stopped the copy of the app you were trying' : undefined);
    }
    return t ? this.status(t.id) : null;
  }

  /** The ticket that has a copy running or starting now, if any. */
  current(): string | undefined {
    return this.run?.ticket;
  }

  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.look(), this.opts.watchMs ?? WATCH_MS);
    this.timer.unref();
  }

  /**
   * One look: the ticket moved on (Looks right, Something's wrong, a next step, Delete) or its copy of the code went,
   * so the copy stops; or the app stopped by itself, so it says so with Try again.
   */
  async look(): Promise<void> {
    const run = this.run;
    if (!run) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.looking) return;
    this.looking = true;
    try {
      const moved = movedOn(readTicket(this.bp, run.ticket), run);
      if (moved) {
        if (this.run === run) this.run = undefined;
        await this.end(run, run.state === 'running' ? moved.note : undefined);
        return;
      }
      if (run.state !== 'running' || !run.url) return;
      if (await isUp(run.url)) run.missed = 0;
      else if (++run.missed >= 2 && this.run === run) {
        run.app?.stop();
        run.state = 'failed';
        run.error = 'The app stopped by itself.';
        this.note(run.ticket, 'Try it yourself: the copy of the app stopped by itself.');
      }
    } finally {
      this.looking = false;
    }
  }

  /** The board closes: the copy stops at once, the whole process group. */
  stopAll(): void {
    const run = this.run;
    this.run = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    if (!run) return;
    run.stop.abort();
    run.app?.stop();
  }
}

const runners = new Map<string, TryRunner>();

/** The one runner for a project in this process. */
export function tryRunner(bp: BoardPaths): TryRunner {
  let r = runners.get(bp.root);
  if (!r) runners.set(bp.root, (r = new TryRunner(bp)));
  return r;
}

/** The address of the ticket's copy while it runs in this process, for the agent that answers the person's questions. */
export function tryingAt(bp: BoardPaths, id: string): string | undefined {
  const r = runners.get(bp.root);
  if (r?.current()?.toUpperCase() !== id.toUpperCase()) return undefined;
  const s = r.status(id);
  return s.state === 'running' ? s.url : undefined;
}

/** Looks right and Something's wrong stop the copy at once, not at the next look. */
export function lookAgain(bp: BoardPaths): void {
  void runners.get(bp.root)?.look();
}

/** Delete: the ticket's copy stops before its copy of the code goes. */
export async function stopTry(bp: BoardPaths, id: string): Promise<void> {
  const r = runners.get(bp.root);
  if (r?.current()?.toUpperCase() === id.toUpperCase()) await r.stop(id).catch(() => undefined);
}

/** The board closes the project: the copy stops with it. */
export function stopTries(bp: BoardPaths): void {
  runners.get(bp.root)?.stopAll();
  runners.delete(bp.root);
}
