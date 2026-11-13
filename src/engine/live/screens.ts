import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { addActivity, readTicket } from '../../board/store.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { startApp, tail, type RunningApp } from '../checks.js';
import { TurnTimeout, inTurn, startPastOther, type TurnKind } from '../copy-turn.js';
import { ALL_TOOLS, AgentWindow } from '../window.js';
import { closeWindow, openWindow } from '../window-server.js';
import { repoFor } from '../repos.js';
import { runsAsProduct } from '../../board/parts.js';
import { ProductError, productPlan } from '../product-run.js';
import { dockerBlockedWords } from '../project-guard.js';
import { treeOf } from '../lane.js';
import { startStep } from '../../board/clock.js';
import { WEB_VERSION, picturesWay, untilGot, type PicturesWay } from '../phone/plan.js';
import { PhoneSession, PhoneUnavailable } from '../phone/session.js';
import { StepError } from '../../board/problem.js';
import { folderOf, projectCopies } from '../leftovers.js';
import type { LiveSquad } from './squad.js';
import type { ShotRound } from './proof.js';

/** The app waited its whole time for the tests running in the same copy. */
const APP_WAITED = "squad-kit could not start the app: the tests in this story's copy were still running after a long wait. Press Try again to try once more.";

/** Taking the screenshots: the way (browser or phone), and starting the app for them. */
export const screensPart = {
  /**
   * The Tester takes screenshots for each "done when", before or after the change, with squad-kit's own tools (the
   * window): squad-kit starts the app first and the Tester takes, looks at and retakes the pictures through it.
   * Before-shots run `beside` the build, in their own copy of the code, with their own Stop and conversation, and leave
   * the card's line to the Builder. An app that does not start stops here, in plain words: no agent is asked to.
   */
  async screens(this: LiveSquad, id: string, when: 'before' | 'after', beside?: { cwd: string; job: string; signal: AbortSignal }, again: string[] = []): Promise<ShotRound> {
    const meta = this.meta();
    // A product that cannot run yet says why, before anything else starts.
    const cannot = !beside && runsAsProduct(meta) ? productPlan(this.bp, meta, readTicket(this.bp, id)!).why : undefined;
    if (cannot) throw new StepError(cannot, cannot);
    // A phone app: squad-kit's own phone, else its web version meanwhile, else it waits for the tools (phone/plan.ts).
    let way = await this.picturesWayOf(id, beside);
    // squad-kit gets its own tools for the phone now, the first time: the pictures wait for that short download.
    if (way.way === 'wait' && way.getting) {
      const block = way.block;
      this.update(id, (x) => {
        addActivity(x, 'tester', block.text);
        if (!beside) x.status = block.status;
      });
      await untilGot(beside?.signal ?? this.stops.get(id)?.signal);
      way = await this.picturesWayOf(id, beside);
    }
    if (way.way === 'wait') throw new StepError(way.block.text, way.block.text);
    // squad-kit's browser is on this computer before any clock starts: the first time, it is downloaded.
    if (way.way !== 'phone') await this.readyBrowser(id, beside?.signal ?? this.stops.get(id)?.signal, beside?.job ?? id);
    const t = this.update(id, (x) => {
      if (!beside) {
        x.sessions = { ...x.sessions, tester: x.sessions?.tester ?? randomUUID() };
        x.status = when === 'before' ? 'Tester is taking before screenshots' : again.length ? 'Tester is taking the screenshots again' : 'Tester is taking after screenshots';
        startStep(x, { who: 'tester', step: 'proof' });
      }
      // A new round of after-shots: the last round's no longer count (the before-shots stay). A retake adds to the rows.
      if (when === 'after' && !beside && !again.length && x.proof?.length) {
        x.proof = x.proof.filter((p) => p.beforeLabel !== 'New screen').map((p) => ({ criterion: p.criterion, before: p.before, ...(p.beforeDevice ? { beforeDevice: p.beforeDevice } : {}), after: '', beforeLabel: p.beforeLabel, afterLabel: p.afterLabel }));
      }
      if (when === 'after' && !beside && !again.length) delete x.offScreen;
      addActivity(x, 'tester', when === 'before' ? 'Taking screenshots before the change' : 'Taking screenshots after the change');
      // Pictures of the web version stand in for the phone's: said once a round, with the line of the Tools page.
      if (!beside && way.way === 'web') {
        if (x.picturesNote?.text !== way.line || !again.length) addActivity(x, 'tester', way.line);
        x.picturesNote = { text: way.line, link: way.link };
      } else if (!beside) delete x.picturesNote;
    });
    fs.mkdirSync(this.bp.proofDir, { recursive: true });
    if (way.way === 'phone') return this.phoneScreens(id, t, when, meta, way, beside, again);
    const product = !beside && runsAsProduct(meta);
    const appCopy = this.appOf(t);
    const rc = (appCopy?.repo ?? repoFor(meta, t)).commands;
    const cwd = beside?.cwd ?? appCopy?.dir ?? t.worktree!;
    const signal = beside?.signal ?? this.stops.get(id)?.signal;
    const start = rc.start?.trim() ?? '';
    const url = rc.url?.trim() ?? '';
    // The story's own copy: the app the review kept, or the last round's, while it answers and the code is the same
    // (keptFor). It does not start again. A product, and the copy of the code as it was, start as before.
    const shares = !beside && !product;
    // New packages or database changes since the copy was set up: it is set up again first (setUpAgain), and an app
    // kept from before does not stand, as it runs on what was there.
    const setUp = shares ? await this.setUpAgain(id, appCopy ?? { repo: repoFor(meta, t), dir: cwd }) : { ran: false };
    if (setUp.failed) this.log('warn', `Setting up the copy again did not work, so the app may not work (${setUp.failed.command}):\n${tail(setUp.failed.output, 30)}`, id);
    if (setUp.ran) await this.dropKept(id);
    const kept = shares ? await this.keptFor(id, cwd) : null;
    let tree = kept?.tree;
    let app: RunningApp;
    if (kept) {
      app = kept.app;
      this.log('info', `squad-kit uses the app that already runs at ${app.url} for the Tester`, id);
      this.update(id, (x) => addActivity(x, 'tester', 'The app squad-kit started earlier still runs, so the Tester uses it'));
    } else {
      // The code the app starts from, so the next round can tell whether it may use it too.
      if (shares) tree = await treeOf(cwd);
      app = await this.startForPictures(id, cwd, start, url, signal, product, Boolean(beside));
      // The address goes to the log; the story gets one plain line.
      this.log('info', `squad-kit started the app at ${app.url}${app.url !== url ? ` (${url} was used by another program)` : ''}`, id);
      this.update(id, (x) => addActivity(x, 'tester', 'squad-kit started the app'));
    }
    const at = app.url;
    const win = new AgentWindow({
      ...this.windowBase(id, 'tester', cwd, beside?.job ?? id),
      step: 'proof',
      who: 'Tester',
      // A copy of the code as it was has nothing to check; the story's own copy does.
      tools: beside ? ALL_TOOLS.filter((x) => x !== 'run_checks') : [...ALL_TOOLS, 'ask_api'],
      ...(beside ? {} : { api: () => this.apiParts(t) }),
      app: { cwd, start, url, ...(this.guardFor(cwd, id) ? { guard: this.guardFor(cwd, id)! } : {}), ...(product ? this.productApp(id) : {}) },
      ...(beside ? {} : { checks: this.windowChecks(id, cwd) }),
      running: app,
      // The next round of pictures, or a retake, uses it too: the proof's end stops it (proof).
      ...(shares ? { keep: (a: RunningApp) => this.keepApp(id, cwd, a, tree) } : {}),
      ...(way.way === 'web' ? { pictureLabel: WEB_VERSION } : {}),
      prefix: `${id.toLowerCase()}-${when}`,
      ...(signal ? { signal } : {}),
    });
    openWindow(win);
    try {
      return await this.shoot(id, t, when, meta, win, at, beside, again);
    } finally {
      // The app squad-kit started stops with the window, or goes on to the next round, and the window's key stops working.
      await closeWindow(win);
    }
  },

  /** How this round's pictures are taken: the story's copy, or the copy of the code as it was for the before-shots. */
  picturesWayOf(this: LiveSquad, id: string, beside?: { cwd: string }): Promise<PicturesWay> {
    const t = readTicket(this.bp, id)!;
    const where = beside ? { parts: t.parts, repo: t.repo, worktree: beside.cwd } : t;
    return picturesWay(this.bp, where, this.hasWeb(t));
  },

  /**
   * The Tester's pictures on squad-kit's own phone: the app is built for the phone (the iPhone, or Android) in the
   * story's copy and the phone comes up with it, before the Tester's clock starts, each long step on the card with its
   * usual time. No app is started for the browser; the Tester's tools take the pictures on the phone, each labelled
   * with its device.
   */
  async phoneScreens(this: LiveSquad, id: string, t: Ticket, when: 'before' | 'after', meta: BoardMeta, way: Extract<PicturesWay, { way: 'phone' }>, beside?: { cwd: string; job: string; signal: AbortSignal }, again: string[] = []): Promise<ShotRound> {
    const cwd = beside?.cwd ?? this.appOf(t)?.dir ?? t.worktree!;
    const signal = beside?.signal ?? this.stops.get(id)?.signal;
    const say = (text: string) =>
      this.update(id, (x) => {
        addActivity(x, 'tester', text);
        if (!beside) x.status = text;
      });
    const session = new PhoneSession({ cwd: way.dir, kind: way.kind, system: way.system, tools: way.tools, say, log: (text) => this.log('info', text, id), ...(signal ? { signal } : {}) });
    // Building the app and starting the phone are the step working, not hanging.
    const beat = setInterval(() => this.dog.beat(beside?.job ?? id), 20_000);
    try {
      await session.ready();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof PhoneUnavailable) throw new StepError(err.message, err.detail);
      throw err;
    } finally {
      clearInterval(beat);
    }
    if (!beside) this.update(id, (x) => (x.status = when === 'before' ? 'Tester is taking before screenshots' : again.length ? 'Tester is taking the screenshots again' : 'Tester is taking after screenshots'));
    const win = new AgentWindow({
      ...this.windowBase(id, 'tester', cwd, beside?.job ?? id),
      step: 'proof',
      who: 'Tester',
      // No app to start for a browser: the phone itself. A copy of the code as it was has nothing to check.
      tools: beside ? ['take_screenshots', 'look_at_page', 'i_am_stuck'] : ['take_screenshots', 'look_at_page', 'run_checks', 'i_am_stuck'],
      ...(beside ? {} : { checks: this.windowChecks(id, cwd) }),
      phone: session,
      prefix: `${id.toLowerCase()}-${when}`,
      ...(signal ? { signal } : {}),
    });
    openWindow(win);
    try {
      return await this.shoot(id, t, when, meta, win, '', beside, again, session);
    } finally {
      await closeWindow(win);
    }
  },

  /**
   * Starts the app for the Tester in its copy's turn (copy-turn.ts): the tests running there finish first, and the card
   * says so. Then what squad-kit's copies left running stops, and when the app's framework names another dev server of
   * this copy that squad-kit may stop, it stops and the app starts once more. An app that does not start is a plain stop.
   */
  async startForPictures(this: LiveSquad, id: string, cwd: string, start: string, url: string, signal: AbortSignal | undefined, product: boolean, beside: boolean): Promise<RunningApp> {
    const onWait = (holder: TurnKind) => {
      if (!beside) this.update(id, (x) => (x.status = holder === 'checks' ? "Waiting for the tests in this story's copy, then starting the app" : "Waiting for the app starting in this story's copy"));
    };
    try {
      return await inTurn(
        cwd,
        'app',
        async () => {
          // No old server of squad-kit's own copies may hold the app's port.
          if (!beside) await this.clearBeforeApp(id);
          if (!beside) this.update(id, (x) => (x.status = 'Starting the app'));
          if (product) return this.startProductFor(id);
          return startPastOther(
            () => startApp(cwd, start, url, undefined, signal, this.guardFor(cwd, id), { onHealed: (detail) => this.healed(id, detail) }),
            async (pid) => Boolean(folderOf(cwd, projectCopies(this.bp))) && (await this.clearCopies([cwd], { only: [pid] }, id)).length > 0,
            (text) => this.log('info', text, id),
          );
        },
        { ...(signal ? { signal } : {}), onWait },
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof TurnTimeout) throw new StepError(APP_WAITED, `The app ${err.message}.`);
      if (err instanceof ProductError) throw new StepError(err.message, err.detail ?? err.message);
      throw new StepError(dockerBlockedWords((err as Error).message, this.guardFor(cwd, id)) ?? NO_APP, (err as Error).message);
    }
  },
};

/** The person's words when the app did not start for the screenshots. */
const NO_APP = 'squad-kit could not start the app, so it took no screenshots. Press Try again to try once more.';
