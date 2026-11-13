import {
  addActivity,
  listDecisions,
  listReleases,
  listTickets,
  now,
  readTicket,
  writeMeta,
} from '../../board/store.js';
import {
  TECH_ROLES,
  type BoardMeta,
  type ImpactCheck,
  type PatternNote,
  type StackNote,
  type TechDraft,
} from '../../board/types.js';
import { detectStack } from '../../board/stack.js';
import { AI_TOOLS, aiTool, describeToolEvent } from '../../modules/registry.js';
import { DOING } from '../plain-doing.js';
import type { ToolEvent } from '../../modules/ai-tool/types.js';
import { runCommand, tail } from '../checks.js';
import { ShotsUnavailable, shotsErrorDetail, takeOne } from '../shots.js';
import { baseTurn, changedTracked, isLockFile, putBackTracked } from '../git.js';
import * as P from '../prompts.js';
import { baseCommits, workspaceRepos } from '../repos.js';
import { cleanParts, partsAfterRead } from '../../board/parts.js';
import { syncWiki } from '../sync.js';
import { readAgent } from '../agents.js';
import { guardSupport, projectGuardFor } from '../project-guard.js';
import { howPaid } from '../../board/payment.js';
import { scanProblem } from '../answers.js';
import { LimitReached } from '../usage-limit.js';
import { readAgainDone, readIdea, readSaid, saveBlueprintParts, saveFirstWords, talkReply } from '../onboard-live.js';
import { readFailed, readStarted, readingNow, saveScan, type ScanAnswer } from '../onboard.js';
import { SETUP_MS } from '../run-app.js';
import { addBreakdownActivity, updateJob } from '../../board/requirements.js';
import { breakdownDir } from '../../board/requirements-paths.js';
import { runBreakdownJob } from '../breakdown-job.js';
import { analystOverBudget } from '../../board/requirements-build.js';
import { WORDS_STEP_MS } from './limits.js';
import { projectRoot, STOPPED } from './shared.js';
import type { LiveSquad } from './squad.js';

/** The Architect's work on the whole project: reading it, its blueprint, decisions, and breakdown jobs. */
export const projectPart = {
  /* ── the project scan ────────────────────────────────── */

  async scan(this: LiveSquad): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    meta.scan = { status: 'running', at: now() };
    // An AI tool installed since the board opened shows as ready now.
    meta.tools = AI_TOOLS.map((t) => ({ name: t.label, ready: t.ready() }));
    writeMeta(this.bp, meta);
    const architect = aiTool(readAgent(this.bp, 'architect').tool);
    await readStarted(this.bp, { label: architect?.label ?? 'The AI tool', ready: Boolean(architect?.ready()) });
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
        timeoutMs: WORDS_STEP_MS,
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
  },

  /** The first run's proof: squad-kit takes one picture of the app it opened, with its own browser. No agent runs. */
  async setupShot(this: LiveSquad, o: { cwd: string; url: string; file: string; onLine?: (text: string) => void }): Promise<{ file?: string; why?: string }> {
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
  },

  /** "Something is wrong" on the overview: the Architect's answer, or its Stop. */
  talk(this: LiveSquad): void {
    talkReply(this.bp, {
      running: this.running.has('__talk'),
      stop: () => this.stops.get('__talk')?.abort(),
      launch: (job) => this.launch('__talk', job),
      run: (o) => this.runAgent({ role: 'architect', step: 'chat', levelStep: 'chat', job: '__talk', cwd: projectRoot(this.bp), permissions: ['read'], schema: P.CHAT_SCHEMA, timeoutMs: WORDS_STEP_MS, prompt: o.prompt }),
    });
  },

  /* ── the person's own checkout, after a merge ─────────── */

  async localSetup(this: LiveSquad, id: string): Promise<void> {
    const ls = readTicket(this.bp, id)?.localSetup;
    if (!ls) return;
    this.update(id, (x) => (x.localSetup = { dir: ls.dir, command: ls.command, status: 'running', at: now() }));
    // The person's own changes stay: what differed before the setup ran is theirs.
    // In its turn, as is what comes after: git may write the index while it looks, and a move of this folder's base would run into that.
    const theirs = await baseTurn(ls.dir, () => changedTracked(ls.dir));
    // The person's own checkout: the setup reads its .env files, as when they run it themselves (Prisma needs DATABASE_URL).
    // It takes its downloads from the project's own cache home, where no story writes: you run this checkout with no guard.
    const allow = this.meta().guard;
    const guard = guardSupport().on ? { ...projectGuardFor(this.bp, { cwd: ls.dir, ...(allow ? { allow } : {}) }), noPush: true, ownEnv: true } : undefined;
    const r = await runCommand(ls.dir, ls.command, SETUP_MS, { ...(guard ? { guard } : {}), onHealed: (detail) => this.log('info', detail, id) });
    const seconds = Math.round(r.seconds);
    await this.putBackLockFiles(id, ls.dir, theirs);
    this.update(id, (x) => {
      x.localSetup = { dir: ls.dir, command: ls.command, status: r.ok ? 'done' : 'failed', at: now(), seconds, ...(r.ok ? {} : { output: tail(r.output, 12) }) };
      addActivity(x, 'release', r.ok ? 'Your copy is ready' : 'Your copy could not be set up');
    });
    // The exact command is for engineers: here, and in the ticket's Developer tab.
    this.log(r.ok ? 'info' : 'warn', r.ok ? `Your copy is ready: ran ${ls.command} (${seconds} s)` : `Setting up your copy failed (${ls.command}): ${tail(r.output, 2)}`, id);
  },

  /**
   * A lock file the setup rewrote goes back, as in a story's copy, so the person's folder shows no change they did not
   * make. Only lock files here: this folder is the person's, so a file they saved while the setup ran looks just the
   * same as one the setup wrote, and a database the setup moved on must stay. The rest is said to engineers.
   */
  async putBackLockFiles(this: LiveSquad, id: string, dir: string, theirs: string[]): Promise<void> {
    const back = await baseTurn(dir, () => putBackTracked(dir, { keep: theirs, only: isLockFile }));
    if (back.length) this.log('info', `The setup command changed ${back.join(', ')} in your folder; squad-kit put ${back.length === 1 ? 'it' : 'them'} back`, id);
    const left = (await baseTurn(dir, () => changedTracked(dir))).filter((f) => !theirs.includes(f));
    if (left.length) this.log('info', `${left.join(', ')} changed in your folder while the setup command ran; squad-kit left ${left.length === 1 ? 'it' : 'them'} as they are`, id);
  },

  /* ── stack and patterns, for the architecture page ──── */

  async readBlueprint(this: LiveSquad): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    const decisions = listDecisions(this.bp);
    meta.blueprint = { stack: [], patterns: [], ...meta.blueprint, status: 'running' };
    writeMeta(this.bp, meta);
    // The code this read sees, so the next merge can tell whether files came, went or moved since.
    const commits = baseCommits(root, meta);
    // The first read of a project that had no code: nobody has said yet what runs in it.
    const findRuns = Boolean(meta.scan?.fromNothing);
    try {
      const r = await this.runAgent({
        role: 'architect',
        step: 'blueprint',
        cwd: root,
        prompt: P.blueprintPrompt(meta, decisions, detectStack(root, meta).map((x) => x.name), findRuns),
        permissions: ['read'],
        schema: findRuns ? P.FIRST_BLUEPRINT_SCHEMA : P.BLUEPRINT_SCHEMA,
        timeoutMs: WORDS_STEP_MS,
      });
      const out = r.structured as { map: BoardMeta['map']; stack: StackNote[]; patterns: PatternNote[]; runs?: unknown; summary?: string; users?: string };
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
      if (findRuns && fresh.scan) {
        const parts = partsAfterRead(cleanParts(out.runs, fresh, this.bp.root), fresh.parts);
        if (parts.length) fresh.parts = parts;
        if (out.summary?.trim()) fresh.scan.summary = out.summary.trim();
        delete fresh.scan.fromNothing;
      }
      writeMeta(this.bp, fresh);
      if (findRuns) saveFirstWords(this.bp, out.users);
      // The overview's picture of the parts follows the code.
      saveBlueprintParts(this.bp, r.structured);
    } catch (err) {
      const fresh = this.meta();
      fresh.blueprint = { stack: [], patterns: [], ...fresh.blueprint, status: 'failed', error: (err as Error).message };
      writeMeta(this.bp, fresh);
    }
  },

  /** A decision was approved: which tickets planned before it does it change? The person decides on each one. */
  async checkImpact(this: LiveSquad, adr: string): Promise<void> {
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
        timeoutMs: WORDS_STEP_MS,
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
  },

  async writeTechDecision(this: LiveSquad, tech: string): Promise<void> {
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
        timeoutMs: WORDS_STEP_MS,
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
  },

  /** An Analyst held at the month's budget, and the person moved to a subscription: there is no budget to pass, so it goes on. */
  letGoOnSubscription(this: LiveSquad, id: string): void {
    if (this.paymentLooks.has(id)) return;
    this.paymentLooks.add(id);
    void howPaid(this.bp)
      .then(({ payment }) => {
        if (payment === 'api-key') return;
        updateJob(this.bp, id, (j, s) => {
          if (j.heldFor !== 'budget') return;
          delete j.heldFor;
          j.now = 'Waiting for the Analyst';
          addBreakdownActivity(s, 'squad', 'The Analyst goes on: a subscription has no month\'s budget to pass');
        });
      })
      .catch(() => undefined)
      .finally(() => this.paymentLooks.delete(id));
  },

  /** One step of the Analyst's work on a breakdown: read only, in the project, with the breakdown's folder beside it. */
  breakdownJob(this: LiveSquad, id: string): Promise<void> {
    const key = `__breakdown:${id}`;
    const signal = this.stops.get(key)?.signal;
    return runBreakdownJob(this.bp, id, {
      ...(signal ? { signal } : {}),
      budgetHold: async () => {
        const held = analystOverBudget(this.bp, id);
        return held && (await howPaid(this.bp)).payment === 'api-key' ? held : null;
      },
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
          ...(o.more ? { capMore: o.more } : {}),
        }),
    });
  },
};
