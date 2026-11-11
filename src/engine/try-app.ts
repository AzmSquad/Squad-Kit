import fs from 'node:fs';
import { isUp } from '../board/apps.js';
import { pageUrl, proofPages, waitsAtReview } from '../board/at-review.js';
import { addActivity, readMeta, readTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { runsAsProduct } from '../board/parts.js';
import { startApp, type RunningApp } from './checks.js';
import { TRY_YIELDS_AFTER_MS, productHold } from './product-lock.js';
import { ProductError, productPlan, startProduct, stopProduct, waitWords } from './product-run.js';
import { guardSupport, ticketGuard } from './project-guard.js';
import { KILL_AFTER_MS } from './process-group.js';
import { repoFor } from './repos.js';
import { PhoneOpen } from './phone/open.js';
import { phoneStartPlan, type PhoneStartPlan } from './phone/plan.js';
import { languageProblem, phoneAppView, type PhoneAppView } from './run-app.js';

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
  /** An iPhone app on a Mac: Try it yourself opens the story's copy on squad-kit's iPhone (engine/phone/open.ts). */
  phone?: PhoneAppView;
  /** Why it stopped by itself last time, in plain words: "You closed the iPhone window, so squad-kit stopped the app." */
  ended?: string;
}

/** How Try it yourself starts: on squad-kit's iPhone, or the web version, and the language to open an iPhone app in. */
export interface TryHow {
  phone?: boolean;
  web?: boolean;
  language?: string;
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
  /** The story's own copy. On a product, what a person opens may run from a copy of main. */
  copy: string;
  /** The whole product runs for it, and it holds the running product. */
  product: boolean;
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
  /** The story's copy open on squad-kit's iPhone. */
  phone?: PhoneOpen;
  /** It opens on squad-kit's iPhone, from its first step. */
  onPhone?: boolean;
}

const WATCH_MS = 2000;

function markOf(t: Ticket): string {
  return `${t.stage}|${t.waiting?.kind ?? ''}|${t.stuck?.gate ?? ''}`;
}

/** Why a ticket cannot be tried now, in plain words; null when it can. On squad-kit's iPhone it needs no start command. */
export function tryBlocked(bp: BoardPaths, t: Ticket, onPhone = false): string | null {
  if (!waitsAtReview(t)) return `${t.id} does not wait for your check now, so there is nothing to try.`;
  if (!t.worktree || !fs.existsSync(t.worktree)) return `${t.id} has no copy of the code on this computer to run.`;
  if (onPhone) return null;
  const meta = readMeta(bp);
  if (runsAsProduct(meta)) return productPlan(bp, meta, t).why ?? null;
  const rc = repoFor(meta, t).commands;
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
  if (t.live || t.squad || !waitsAtReview(t) || markOf(t) !== run.mark || t.worktree !== run.copy || !fs.existsSync(run.cwd)) {
    return { note: 'Stopped the copy of the app you were trying: the ticket moved on' };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Who holds the running product for this copy: never the story itself, whose own steps come back to it. */
const holderOf = (run: Pick<TryRun, 'ticket'>): string => `try:${run.ticket}`;

export { TRY_YIELDS_AFTER_MS };

/** The ticket copies of one project's app: one runs at a time. The board's buttons and the terminal share it. */
export class TryRunner {
  private run?: TryRun;
  private timer?: NodeJS.Timeout;
  private looking = false;
  /** Why the copy on the phone stopped by itself, by ticket, until it is tried again. */
  private ended = new Map<string, string>();

  /** The story's iPhone app, when it is one and not a product. */
  private phonePlan(t: Ticket): PhoneStartPlan | null {
    if (!t.worktree || runsAsProduct(readMeta(this.bp))) return null;
    return phoneStartPlan(this.bp, 'try-it', t);
  }

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
    const plan = this.phonePlan(t);
    const webWhy = tryBlocked(this.bp, t);
    const web = !webWhy;
    // An iPhone app with no web version says what the phone needs, with the Tools page line.
    const why = plan?.ready ? tryBlocked(this.bp, t, true) : webWhy && plan?.why && !tryBlocked(this.bp, t, true) ? plan.why : webWhy;
    const url = mine?.state === 'running' ? mine.url : undefined;
    const ended = !mine ? this.ended.get(t.id) : undefined;
    return {
      ticket: t.id,
      ...(plan ? { phone: phoneAppView(plan, web, mine?.phone, Boolean(mine?.onPhone)) } : {}),
      ...(ended ? { ended } : {}),
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
  start(id: string, how: TryHow = {}): TryStatus {
    const t = this.ticket(id);
    // An iPhone app opens on squad-kit's iPhone when its tools are here, unless the person asked for the web version.
    const plan = how.web ? null : this.phonePlan(t);
    const onPhone = Boolean(plan && (how.phone || plan.ready));
    if (how.phone && !plan) throw new TryError(`${t.id}'s app is not a phone app, so squad-kit runs it in the browser.`);
    if (onPhone && !plan!.ready) throw new TryError(plan!.why ?? `squad-kit can't open it on its ${plan!.word} yet.`);
    const wrong = onPhone ? languageProblem(how.language, plan!.languages) : null;
    if (wrong) throw new TryError(wrong);
    const why = tryBlocked(this.bp, t, onPhone) ?? (!onPhone && plan && !plan.ready && tryBlocked(this.bp, t) ? plan.why! : null);
    if (why) throw new TryError(why);
    const now = this.run;
    if (now?.ticket === t.id && (now.state === 'starting' || now.state === 'running')) return this.status(t.id);
    this.ended.delete(t.id);
    if (onPhone) return this.startOnPhone(t, plan!, how.language);
    const meta = readMeta(this.bp);
    const product = runsAsProduct(meta);
    const front = product ? productPlan(this.bp, meta, t).front : undefined;
    const rc = (front?.repo ?? repoFor(meta, t)).commands;
    let settle!: () => void;
    const run: TryRun = {
      ticket: t.id,
      state: 'starting',
      mark: markOf(t),
      cwd: front?.dir ?? t.worktree!,
      copy: t.worktree!,
      product,
      stop: new AbortController(),
      settled: new Promise<void>((r) => (settle = r)),
      missed: 0,
    };
    this.run = run;
    void this.launch(run, now, rc.start!.trim(), rc.url!.trim()).finally(settle);
    this.watch();
    return this.status(t.id);
  }

  /**
   * "Use the web version now", or Try it yourself again: the copy on the phone, starting or open, stops first, then the
   * web version starts the way Try it yourself does.
   */
  async startAs(id: string, how: TryHow = {}): Promise<TryStatus> {
    const t = this.ticket(id);
    if (how.web && this.run?.ticket === t.id && this.run.phone) await this.stop(t.id);
    return this.start(t.id, how);
  }

  /** The story's own copy, built and opened on squad-kit's iPhone, each step with the time left (phone/open.ts). */
  private startOnPhone(t: Ticket, plan: PhoneStartPlan, language?: string): TryStatus {
    const before = this.run;
    let settle!: () => void;
    const run: TryRun = { ticket: t.id, state: 'starting', mark: markOf(t), cwd: plan.dir, copy: t.worktree!, product: false, stop: new AbortController(), settled: new Promise<void>((r) => (settle = r)), missed: 0, onPhone: true };
    this.run = run;
    void (async () => {
      if (before) await this.end(before, before.state === 'running' ? `Stopped the copy of the app you were trying: you started ${run.ticket}'s` : undefined);
      if (run.stop.signal.aborted) return;
      const open = new PhoneOpen({
        dir: plan.dir,
        kind: plan.kind,
        system: plan.system,
        by: 'Try it yourself',
        again: 'Try it yourself',
        ...(language ? { language } : {}),
        yieldAfterMs: TRY_YIELDS_AFTER_MS,
        // The person closed the window, or a story needed the phone: it stops, said on the story in plain words.
        onEnd: (words) => {
          if (this.run === run) this.run = undefined;
          this.ended.set(run.ticket, words);
          this.note(run.ticket, words);
        },
      });
      run.phone = open;
      await open.settled;
      if (run.stop.signal.aborted) return;
      const v = open.view();
      if (v.state === 'running') {
        run.state = 'running';
        run.since = v.since ?? new Date().toISOString();
        this.note(run.ticket, `Opened this story's own copy of the app on squad-kit's ${v.device ?? plan.word} for you to try. Nothing is merged.`);
      } else if (v.state === 'failed') {
        run.state = 'failed';
        run.error = v.error ?? `The app did not open on the ${plan.word}.`;
        if (v.detail) run.detail = v.detail;
        this.note(run.ticket, `Try it yourself: the app did not open on the ${plan.word}.`);
      }
    })().finally(settle);
    this.watch();
    return this.status(t.id);
  }

  private async launch(run: TryRun, before: TryRun | undefined, command: string, url: string): Promise<void> {
    if (before) await this.end(before, before.state === 'running' ? `Stopped the copy of the app you were trying: you started ${run.ticket}'s` : undefined);
    if (run.stop.signal.aborted) return;
    try {
      const allow = readMeta(this.bp).guard;
      const guard = guardSupport().on ? ticketGuard(this.bp, { cwd: run.cwd, id: run.ticket, ...(allow ? { allow } : {}) }) : undefined;
      const app = run.product
        ? await startProduct(this.bp, this.ticket(run.ticket), holderOf(run), 'try', { signal: run.stop.signal, ...(this.opts.waitMs ? { waitMs: this.opts.waitMs } : {}), onWait: (hold) => this.note(run.ticket, waitWords(hold)) })
        : await startApp(run.cwd, command, url, this.opts.waitMs, run.stop.signal, guard);
      if (run.stop.signal.aborted) return app.stop();
      run.app = app;
      run.url = app.url;
      run.since = new Date().toISOString();
      run.state = 'running';
      this.note(run.ticket, "Started this story's own copy of the app for you to try. Nothing is merged.");
    } catch (err) {
      if (run.product) stopProduct(this.bp, holderOf(run));
      if (run.stop.signal.aborted) return;
      run.state = 'failed';
      const plain = err instanceof ProductError ? err : null;
      run.error = plain?.message ?? 'The app did not start.';
      // One plain sentence; what it printed is behind "See what failed", for engineers.
      run.detail = (plain?.detail ?? (err as Error).message).slice(-4000);
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
    // On the phone: the app closes and squad-kit's iPhone shuts down.
    await run.phone?.stop();
    await run.settled;
    if (run.product) stopProduct(this.bp, holderOf(run));
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
      // A forgotten copy never keeps the squad from its work: once a story wants the product, it ends after a while.
      if (run.product && productHold(this.bp)?.wanted && Date.now() - Date.parse(run.since ?? '') > TRY_YIELDS_AFTER_MS) {
        if (this.run === run) this.run = undefined;
        await this.end(run, `Stopped the copy of the app you were trying: ${productHold(this.bp)?.wanted ?? 'a story'} needs the product now. Press Try it yourself again later.`);
        return;
      }
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
    void run.phone?.stop();
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
