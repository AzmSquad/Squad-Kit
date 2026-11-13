import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions, readTicket } from '../../board/store.js';
import { changeWork, openChange } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { SpecChange } from '../../board/types.js';
import type { PlanEntry } from '../../modules/ai-tool/types.js';
import * as P from '../prompts.js';
import { repoFor } from '../repos.js';
import { runsAsProduct } from '../../board/parts.js';
import { CapReached } from '../caps.js';
import { workFolder } from '../copies.js';
import { workSoFar } from '../handover.js';
import { nextPart } from '../../board/clock.js';
import { LimitReached } from '../usage-limit.js';
import { StepError } from '../../board/problem.js';
import { holdBuild } from '../../board/depends.js';
import { CutOff, carriesOn, carryOnLine, carryOnPrompt, sleptSince } from '../interrupt.js';
import { changesScreens } from '../../board/outside-step.js';
import { BUILD_STEP_MS } from './limits.js';
import { type AgentAsk, openStep, PassingTrouble, planKey, planStepOf, WaitingForYou } from './shared.js';
import type { LiveSquad } from './squad.js';
import { picturesNeeded } from '../proof-kinds/lines.js';

/** The Builder's step. */
export const buildPart = {
  async build(this: LiveSquad, id: string): Promise<void> {
    // A ticket it depends on is not merged, and nobody chose how to build yet: it waits for the person.
    if (holdBuild(this.bp, id)) return;
    const t0 = await this.workspace(id);
    this.goOn(id);
    if (t0.replanFor) return this.rebuild(id, t0.replanFor);
    const meta = this.meta();
    const rc = (this.appOf(t0)?.repo ?? repoFor(meta, t0)).commands;
    // Work already in the copy (it came with a pushed branch): no "before" screens of it, and a fresh Builder reads it.
    const sofar = t0.baseCommit ? await workSoFar(t0.worktree!, t0.baseCommit) : [];
    // On a product, "before" pictures would need the whole product running beside the build, on the same addresses.
    if (!sofar.length && !t0.proof?.length && t0.baseCommit && rc.start && rc.url && picturesNeeded(t0, changesScreens(t0)) && !meta.scan?.empty && !runsAsProduct(meta)) {
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
  },

  /**
   * Runs (or continues) the Builder's conversation and maps its ">> step N" lines to the plan. An approved small change
   * reaches the Builder here, at a safe moment: the start of a step, before that step's own work.
   */
  async runBuilder(this: LiveSquad, id: string, prompt: string, resume: boolean, step: 'build' | 'fix' = 'fix', settled = 0, told = new Set<string>()): Promise<void> {
    // The Builder changes the code: an app kept for the review and the proof would show the old code, and hold the copy.
    await this.dropKept(id);
    // A new round of the Builder: a run of the checks it noted before no longer counts (noteRun).
    this.builderRuns.set(id, new Map());
    const change = this.handChange(id);
    let t = readTicket(this.bp, id)!;
    // Built outside squad-kit: the Builder has no conversation on it yet, so it gets one, and the story first.
    if (!t.sessions?.build) {
      t = this.update(id, (x) => (x.sessions = { ...x.sessions, build: randomUUID() }));
      resume = false;
      prompt = `${P.buildPrompt(this.meta(), listDecisions(this.bp), { ...t, story: t.story ?? t.ask }, this.ctx(t))}\n\nThis work was built outside squad-kit, and it is in this folder as it is now. Do not build it again. Look at what is there, then do only this:\n\n${prompt}`;
    }
    const cwd = workFolder(t)!;
    const started = Date.now();
    let current = -1;
    /** The Builder is on plan step `n` (from 0): the ones before are done. Only ever forward within a run. */
    const reached = (n: number) => {
      if (n <= current || n >= (readTicket(this.bp, id)?.steps?.length ?? 0)) return;
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
    };
    // Its ">> step N", in its words or in a command it runs (echo ">> step 5"). Its words come in pieces, so the end of
    // what came before is kept: a line cut in two is still read once its second half comes. Only forward and only a
    // step of the plan, so a number read before all of it came (1, then 10) does no harm.
    let heard = '';
    const stepSaid = (said: string) => {
      const m = [...said.matchAll(/>>\s*step\s+(\d+)/gi)].pop();
      if (m) reached(Number(m[1]) - 1);
    };
    // Its own to-do list (ACP's plan update), by the step numbers of its items or one item per plan step: where it really
    // is, step by step (planStepOf).
    const planSaid = (entries: PlanEntry[]) => {
      const n = planStepOf(entries, readTicket(this.bp, id)?.steps?.length ?? 0);
      if (n !== null) reached(n);
    };
    const watch = this.watcher(id, 'builder', cwd, (line, x) => {
      const doing = x.steps?.find((s) => s.status === 'doing');
      if (doing) doing.live = line;
    });
    const lanes = await this.watchCopies(t);
    this.lanesOf.set(id, lanes);
    const r = await this.runAgent({
        role: 'builder',
        step,
      ticket: id,
      cwd,
      ...(resume ? { resume: t.sessions!.build } : { sessionId: t.sessions!.build }),
      prompt: change ? [P.smallChangePrompt(change), prompt].filter(Boolean).join('\n\n') : prompt,
      permissions: ['edit'],
      schema: P.BUILD_SCHEMA,
      timeoutMs: BUILD_STEP_MS,
      addDirs: this.extraDirs(t),
      box: {},
      onText: (piece) => {
        heard = `${heard}${piece}`.slice(-200);
        stepSaid(heard);
        heard = heard.slice(-20);
      },
      onPlan: planSaid,
      onTool: (e) => {
        if (typeof e.input.command === 'string') stepSaid(e.input.command);
        watch(e);
      },
    })
      .finally(() => {
        this.lanesOf.delete(id);
        return this.keepLanes(id, 'builder', lanes);
      })
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
  },

  /**
   * The Builder's run itself failed (an error, a time limit): it counts like failed checks. A run that was cut off
   * never counts (engine/interrupt.ts): the board closing or restarting, a Stop or a delete (squad-kit ended it), or
   * the computer sleeping under it.
   */
  builderFailed(this: LiveSquad, id: string, err: unknown): never {
    // A network or service problem says nothing about the work: no failed try, so no higher level either.
    if (err instanceof PassingTrouble) throw err;
    if (err instanceof WaitingForYou || err instanceof LimitReached || err instanceof CapReached) throw err;
    const ended = this.closing || Boolean(this.stops.get(id)?.signal.aborted) || Boolean(readTicket(this.bp, id)?.stopRequested);
    if (ended) throw err;
    if (sleptSince(this.marks.get(id))) throw new CutOff('sleep');
    this.update(id, (x) => (x.fails = (x.fails ?? 0) + 1));
    throw err;
  },

  /** An approved small change the Builder has not had yet: it goes into the step that starts now. */
  handChange(this: LiveSquad, id: string): SpecChange | undefined {
    const t = readTicket(this.bp, id);
    const c = t ? openChange(t) : undefined;
    if (!t || !c || c.size === 'big' || changeWork(t) !== 'build') return undefined;
    this.update(id, (x) => {
      const y = openChange(x);
      if (y) y.status = 'building';
      addActivity(x, 'builder', `Took change ${c.id} into this step`);
    });
    return c;
  },
};
