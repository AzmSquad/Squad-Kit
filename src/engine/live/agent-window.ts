import path from 'node:path';
import { addActivity, readTicket } from '../../board/store.js';
import type { RepoInfo, Ticket } from '../../board/types.js';
import { OWN_CHECK_DOING } from '../plain-doing.js';
import type { AgentRun } from '../../modules/ai-tool/types.js';
import { tail, type CheckResult, type RunningApp } from '../checks.js';
import {
  AgentWindow,
  toolsFor,
  type CheckName,
  type CheckRun,
  type WindowChecks,
  type WindowSetup,
} from '../window.js';
import { repoFor } from '../repos.js';
import { partsOf, runsAsProduct } from '../../board/parts.js';
import { AGENTS, type AgentRole } from '../agents.js';
import { appCopyOf, copiesOf, workFolder } from '../copies.js';
import { productPlan, startProduct, stopProduct, waitWords } from '../product-run.js';
import { treeOf } from '../lane.js';
import { ownCheckEnded, ranFor, runsFor } from '../../board/clock.js';
import { folderOf, projectCopies } from '../leftovers.js';
import type { LiveSquad } from './squad.js';

/** The window: squad-kit's own tools for one agent run, and the checks and apps behind them. */
export const agentWindowPart = {
  /**
   * squad-kit's own tools for a ticket's run: every tool for the Builder in the ticket's copy of an app, Look at a page
   * for the Reviewer's review there (read only: squad-kit starts the app for it), else I am stuck.
   */
  windowFor(this: LiveSquad, opts: AgentRun & { ticket: string; role: AgentRole; step?: string }, signal: AbortSignal): AgentWindow {
    const id = opts.ticket;
    const t = readTicket(this.bp, id);
    const appCopy = t ? this.appOf(t) : undefined;
    const rc = appCopy?.repo.commands ?? (t && !runsAsProduct(this.meta()) ? repoFor(this.meta(), t).commands : {});
    const inCopy = Boolean(t?.worktree && opts.cwd === workFolder(t));
    const here = inCopy && Boolean(rc.start?.trim() && rc.url?.trim());
    const builds = inCopy && opts.permissions.includes('edit');
    const app = here && builds;
    const look = here && opts.role === 'reviewer' && opts.step === 'review';
    // The Builder's own step, not a run beside it: its full runs of the checks are noted for the checks step.
    const noted = opts.role === 'builder' && !(opts as { job?: string }).job;
    const who = AGENTS.find((a) => a.role === opts.role)?.name ?? opts.role;
    return new AgentWindow({
      ...this.windowBase(id, opts.role, opts.cwd, (opts as { job?: string }).job ?? id),
      step: opts.step ?? 'chat',
      who,
      tools: toolsFor({ app, look, checks: builds, parts: builds && Boolean(t?.storyDir) }),
      ...(app || look ? { app: { cwd: appCopy!.dir, start: rc.start!.trim(), url: rc.url!.trim(), ...(runsAsProduct(this.meta()) || !this.guardFor(appCopy!.dir, id) ? {} : { guard: this.guardFor(appCopy!.dir, id)! }), ...this.productApp(id) } } : {}),
      ...(builds ? { checks: t?.storyDir ? this.windowChecksByPart(id, t, noted) : this.windowChecks(id, opts.cwd, undefined, noted) } : {}),
      ...(builds && t?.storyDir ? { addPart: (part: string) => this.addPart(id, part, this.lanesOf.get(id)) } : {}),
      // The app started for the review's look runs on into the proof when the review approves (afterReview). A product
      // starts and stops as before.
      ...(look && !runsAsProduct(this.meta()) ? { keep: (a: RunningApp) => this.keepApp(id, appCopy!.dir, a) } : {}),
      prefix: `${id.toLowerCase()}-${opts.role}`,
      signal,
    });
  },

  /**
   * The project's own saved checks for an agent's run_checks, in the ticket's copy, inside squad-kit's guard. `noted`:
   * the Builder's step, whose runs squad-kit notes for the checks step (noteRun).
   */
  windowChecks(this: LiveSquad, id: string, cwd: string, repo?: string, noted = false): WindowChecks {
    const guard = this.guardFor(cwd, id);
    return {
      cwd,
      // A project the Builder is setting up may say how by now.
      commands: () => this.saveFoundCommands(id, cwd, repo),
      ...(guard ? { guard } : {}),
      onStart: (name) =>
        this.update(id, (x) => {
          x.status = OWN_CHECK_DOING[name];
          runsFor(x, name, x.status);
        }),
      // What it found stays on the step's clock: the card says the Builder is fixing a failed test, not just slow.
      onEnd: (name, ok, alone) =>
        this.update(id, (x) => {
          if (noted) ownCheckEnded(x, name, ok, alone);
          else ranFor(x, name);
          if (x.clock?.doing) x.status = x.clock.doing;
        }),
      ...(noted ? { onRun: (run: { names: CheckName[]; only?: string }) => this.noteRun(id, cwd, run) } : {}),
    };
  },

  /**
   * The Builder's run_checks starts in the copy `cwd`: it is now the latest run there of each check it runs, so a run of
   * those noted before no longer counts. It notes the copy's code as it starts. Once it ran to its end and the code is
   * still the same, each check of it that passed with its whole saved command (not one test file) may stand for that
   * check at the checks step, instead of running it again. One test file adds nothing to a whole run of the tests on the
   * same code, so that run still stands, unless the file fails. Only in the round it started in (runBuilder): one taken
   * by the checks step, or a new round, notes nothing more.
   */
  async noteRun(this: LiveSquad, id: string, cwd: string, run: { names: CheckName[]; only?: string }): Promise<((ran: CheckRun[]) => Promise<void>) | undefined> {
    const notes = this.builderRuns.get(id);
    if (!run.only) for (const name of run.names) notes?.get(cwd)?.delete(name);
    const tree = notes ? await treeOf(cwd) : undefined;
    if (!notes || !tree) return undefined;
    const at = Date.now();
    return async (ran) => {
      // A test file that failed, or did not end, on code a whole run passed on: that run no longer counts.
      for (const r of ran) if (r.only && (!r.ok || r.ended)) notes.get(cwd)?.delete(r.name);
      const passed = ran.filter((r) => r.ok && !r.ended && !r.only);
      if (!passed.length) return;
      // An edit while it ran: the run may have seen some of the new code, or none of it.
      if ((await treeOf(cwd)) !== tree || this.builderRuns.get(id) !== notes) return;
      const here = notes.get(cwd) ?? new Map<string, { tree: string; run: CheckResult; at: number }>();
      for (const r of passed) here.set(r.name, { tree, run: { name: r.name, command: r.command, ok: r.ok, output: r.output, seconds: r.seconds }, at });
      notes.set(cwd, here);
    };
  },

  /** The copy the story's app runs from: on a product, the part a person opens, which may be a copy of main. */
  appOf(this: LiveSquad, t: Ticket): { repo: RepoInfo; dir: string } | undefined {
    const meta = this.meta();
    return runsAsProduct(meta) ? productPlan(this.bp, meta, t).front : appCopyOf(meta, t);
  },

  /** On a product, a window's app keeps its address, and what it relies on starts first and stops with it. */
  productApp(this: LiveSquad, id: string): { run?: () => Promise<RunningApp>; after?: () => void; reach?: () => string[] } {
    if (!runsAsProduct(this.meta())) return {};
    return {
      run: () => this.startProductFor(id),
      after: () => stopProduct(this.bp, id),
      reach: () => productPlan(this.bp, this.meta(), readTicket(this.bp, id)!).places.map((p) => p.url),
    };
  },

  /** The story's whole product, up and running, and the part a person opens. It waits its turn, and says so. */
  startProductFor(this: LiveSquad, id: string): Promise<RunningApp> {
    const signal = this.stops.get(id)?.signal;
    return startProduct(this.bp, readTicket(this.bp, id)!, id, 'story', {
      ...(signal ? { signal } : {}),
      onWait: (hold) => this.update(id, (x) => (x.status = waitWords(hold))),
      log: (text) => this.log('info', text, id),
    });
  },

  /** What the Tester may ask: the running parts of the product, or the one app, each only on its own address. */
  apiParts(this: LiveSquad, t: Ticket): Record<string, { name: string; url: string }> {
    const meta = this.meta();
    if (runsAsProduct(meta)) {
      const { places } = productPlan(this.bp, meta, t);
      // Parts that start together from their repo's one command each answer on their own address.
      const beside = partsOf(meta).filter((p) => p.url && !p.shared && !p.off && !p.noRun && places.some((x) => x.repo.path === p.repo && x.part.id !== p.id));
      return Object.fromEntries([...places.map((p) => [p.part.id, { name: p.part.name, url: p.url }]), ...beside.map((p) => [p.id, { name: p.name, url: p.url! }])]);
    }
    const c = (this.appOf(t)?.repo ?? repoFor(meta, t)).commands;
    return c.start?.trim() && c.url?.trim() ? { app: { name: 'the app', url: c.url.trim() } } : {};
  },

  /** A story's folder: run_checks takes the part, and runs in that part's copy. Read at each call, as a copy may be new. */
  windowChecksByPart(this: LiveSquad, id: string, t: Ticket, noted = false): WindowChecks {
    const parts = () => {
      const meta = this.meta();
      const now = readTicket(this.bp, id) ?? t;
      const copies = copiesOf(meta, now);
      const out: Record<string, WindowChecks> = {};
      for (const c of copies) {
        const named = partsOf(meta).filter((p) => p.repo === c.repo.path && !p.shared);
        for (const key of named.length ? named.map((p) => p.id) : [c.repo.path]) out[key] = this.windowChecks(id, c.dir, c.repo.path, noted);
      }
      return out;
    };
    return { ...this.windowChecks(id, t.worktree!, repoFor(this.meta(), t).path, noted), parts };
  },

  /** What every window of a ticket shares: its lines on the ticket, the app log, and squad-kit's own fixes. */
  windowBase(this: LiveSquad, id: string, role: AgentRole, cwd: string, job = id): Pick<WindowSetup, 'ticket' | 'proofDir' | 'say' | 'log' | 'beat' | 'beforeStart' | 'clearCopy' | 'inTheWay'> {
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
        // For the Reviewer and the Tester, the app's copy is set up again first when new packages or database changes
        // came in (setUpAgain). The Builder is still changing them.
        const t = role === 'builder' ? null : readTicket(this.bp, id);
        const c = t ? copiesOf(this.meta(), t).find((x) => path.resolve(x.dir) === path.resolve(cwd)) : undefined;
        const failed = c ? (await this.setUpAgain(id, c)).failed : undefined;
        if (failed) this.log('warn', `Setting up the copy again did not work, so the app may not work (${failed.command}):\n${tail(failed.output, 30)}`, id);
      },
      // What a finished check left in the app's own copy: only in squad-kit's own copies, and never what squad-kit runs
      // now (a check, a kept app, the agent itself).
      clearCopy: async (dir, only) => Boolean(folderOf(dir, projectCopies(this.bp))) && (await this.clearCopies([dir], only ? { only: [only] } : {}, id)).length > 0,
      inTheWay: async (text) => (await this.inTheWay(id, { text }))?.answer ?? null,
    };
  },
};
