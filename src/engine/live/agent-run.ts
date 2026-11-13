import { androidCommandEnv, hasAndroid } from '../android-env.js';
import path from 'node:path';
import { addActivity, readMeta, readTicket } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { AI_TOOLS, aiTool } from '../../modules/registry.js';
import type { AgentResult, AgentRun, AiTool, BlockedAction } from '../../modules/ai-tool/types.js';
import { AgentWindow, tooManyMistakesWords, tooManyWords } from '../window.js';
import { closeWindow, openWindow, windowAccess } from '../window-server.js';
import {
  TECHNICAL_TRIES,
  askText,
  judgeReply,
  questionBackPrompt,
  refusedAskLine,
  refusedReplyLine,
  stoppedQuestion,
} from '../question-filter.js';
import { ownRunWords, ownWords } from '../plain-stop.js';
import { copyDirsIn } from '../git.js';
import * as P from '../prompts.js';
import { rulesFor } from '../../board/additions.js';
import { AGENTS, agentInstructions, readAgent, type AgentRole } from '../agents.js';
import {
  DEFAULT_QUALITY,
  builderLevel,
  describeLevel,
  effortOn,
  personLevels,
  resolveLevel,
  stepCaps,
} from '../levels.js';
import { CapReached } from '../caps.js';
import { ownHomeEnv } from '../own-home.js';
import { selfRule } from '../self-project.js';
import { blockedLine, noPushEnv, noteBlockedSite, projectNetwork, sandboxOf } from '../sandbox.js';
import { copyDbEnv } from '../db-env.js';
import { offLimits } from '../../board/project-files.js';
import { agentPrivatePlaces, IN_GUARD } from '../project-guard.js';
import { cacheHomeEnv, ownFolder, storiesCacheDir } from '../cache-home.js';
import { recordUsage } from '../../board/usage.js';
import { answerProblem } from '../answers.js';
import { hookFiles } from '../hook-files.js';
import { endStep, startStep, timedStep } from '../../board/clock.js';
import { projectKinds } from '../tools/kinds.js';
import { LimitReached, startPause } from '../usage-limit.js';
import { explainError, StepError } from '../../board/problem.js';
import { writeLog, type LogLevel } from '../../core/app-log.js';
import { inTheWay } from '../port-ask.js';
import { RUN_MS } from '../acp-runner.js';
import { PassingTrouble, projectRoot, secretFiles, STOPPED } from './shared.js';
import type { LiveSquad } from './squad.js';

/** One run of an agent: its tool, its guard and its window, and what its answer or failure means. */
export const agentRunPart = {
  /** The AI tool a role runs on, in words: "Claude Code". */
  toolLabel(this: LiveSquad, role: AgentRole): string {
    return aiTool(readAgent(this.bp, role).tool)?.label ?? 'its AI tool';
  },

  /**
   * `job` names a run beside the ticket's step (a chat reply, a proposed change): its own Stop and watchdog, not the
   * step's. `box` keeps the run's shell commands in its AI tool's sandbox, where it has one.
   * `check` finds what the answer's shape cannot say (a name that is not an open ticket): the run is asked once more.
   * `window` is squad-kit's own tools for the run (engine/window.ts), when the caller made them; a ticket's run gets
   * its own otherwise. Their key works for this run only, and they close with it. A question in the answer that may
   * not reach the person goes back to the agent first (engine/question-filter.ts). `reply` marks a reply in a talk
   * with the person (a chat answer is one too): one that asks for what is not allowed is replaced with a plain line.
   */
  async runAgent(this: LiveSquad, opts: AgentRun & { ticket?: string; job?: string; role: AgentRole; step?: string; levelStep?: string; box?: object; check?: (answer: unknown) => string | null; checkHelp?: () => string; win?: AgentWindow; reply?: boolean; capMore?: number }): Promise<AgentResult> {
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
  },

  async runWith(this: LiveSquad, opts: AgentRun & { capMore?: number; ticket?: string; job?: string; role: AgentRole; step?: string; levelStep?: string; box?: object; check?: (answer: unknown) => string | null; checkHelp?: () => string; win?: AgentWindow; reply?: boolean }, signal: AbortSignal): Promise<AgentResult> {
    const job = opts.job ?? opts.ticket;
    // Each role runs as its own agent: the team's file for it sets the tool, the model and extra instructions.
    const agent = readAgent(this.bp, opts.role);
    const tool = aiTool(agent.tool);
    if (!tool?.canRun) {
      const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
      throw new StepError(`The ${opts.role} agent is set to ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} on the Harness page, under Agents.`);
    }
    const extra = agentInstructions(agent, opts.step);
    const win = opts.win;
    const boxed = Boolean(opts.box && sandboxOf(tool).available);
    // A sandboxed step is told up front what its commands reach, and that a refused site is closed on purpose.
    const network = boxed ? projectNetwork(this.bp.root) : undefined;
    const instructions = [opts.instructions, P.PROCESS_RULE, selfRule(this.bp), extra, rulesFor(this.bp, opts.role), win ? P.windowRule(win.tools) : '', network ? P.networkRule(network) : ''].filter(Boolean).join('\n\n');
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
    if (timed) this.update(key!, (x) => startStep(x, { who: opts.role, step: timed, limit: Math.round((opts.timeoutMs ?? RUN_MS) / 60_000) }));
    const ended = (res: AgentResult): AgentResult => {
      if (timed) this.update(key!, (x) => endStep(this.bp, x));
      return res;
    };
    const watch = job ? { onActivity: () => this.dog.beat(job), onSpawn: (pid: number) => this.dog.track(job, pid) } : {};
    // The step's caps from the Quality setting, doubled for each Give it more on this same step.
    const raise = opts.capMore ?? (ticket?.capRaise?.role === opts.role && ticket.capRaise.step === levelStep ? ticket.capRaise.times : 0);
    const quality = this.meta().quality ?? DEFAULT_QUALITY;
    const caps = stepCaps({ role: opts.role, step: levelStep, quality }, raise);
    // Only the caps the tool keeps: a tool without a spend cap is held by its turns alone.
    const runCaps = { ...(tool.caps?.turns ? { turns: caps.turns } : {}), ...(tool.caps?.spend ? { spendUsd: caps.spendUsd } : {}) };
    // A sandboxed step of a ticket gets the cache home the project's stories share, as the project's own commands do.
    const cache = boxed && key ? storiesCacheDir(this.bp) : undefined;
    if (cache) ownFolder(cache);
    const sandbox = boxed ? await this.sandboxFor(opts.cwd, opts.addDirs ?? [], cache, network) : undefined;
    const android = hasAndroid(projectKinds(this.bp.root, this.meta(), ticket ?? undefined));
    const secrets = await secretFiles(this.bp, opts.cwd);
    // What the sandbox refused shows on the ticket in plain words, each thing once a run. A site asks nothing and stops
    // nothing: the agent goes on without it, and engineers find it in the log on Harness → Safety.
    const refused = new Set<string>();
    const onBlocked = (b: BlockedAction) => {
      if (!key || refused.has(`${b.kind}:${b.target}`) || refused.size >= 10) return;
      refused.add(`${b.kind}:${b.target}`);
      if (b.kind === 'host') noteBlockedSite(this.bp, { host: b.target, story: key, level: network ?? projectNetwork(this.bp.root) });
      this.update(key, (x) => addActivity(x, opts.role, blockedLine(b)));
    };
    // Every role runs through the Agent Client Protocol unless the board says to run tools directly.
    const run = ({ win: _own, reply: _reply, check: _check, checkHelp: _help, capMore: _more, ...o }: AgentRun & { win?: unknown; reply?: unknown; check?: unknown; checkHelp?: unknown; capMore?: unknown }) => tool.run({
      ...o,
      ...watch,
      secretFiles: secrets,
      privatePlaces: agentPrivatePlaces(),
      protectedFiles: this.protectedFiles(opts.cwd),
      ...(Object.keys(runCaps).length ? { caps: runCaps } : {}),
      ...(sandbox ? { sandbox, onBlocked } : {}),
      // A story with a database of its own: the agent's own commands reach that one too, never the person's.
      // An Android app: the agent's own builds and checks find squad-kit's Android tools too (android-env.ts).
      // A squad-kit the agent starts lands in a home of its copy's own (own-home.ts), never on this board. In its sandbox
      // it is inside a guard, as the project's own commands are: what cannot nest there skips (SQUAD_KIT_IN_GUARD).
      env: { ...noPushEnv(), ...ownHomeEnv(opts.cwd, cache), ...(sandbox ? { [IN_GUARD]: '1' } : {}), ...(sandbox && cache ? cacheHomeEnv(cache, { wall: 'agent', cwd: opts.cwd }) : {}), ...(android ? androidCommandEnv(sandbox && cache ? { cache } : {}) : {}), ...(key ? copyDbEnv(opts.cwd) : {}) },
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
    const capped = (res: AgentResult) => new CapReached(opts.role, levelStep, res.capped!.by, caps, quality, AGENTS.find((a) => a.role === opts.role)?.name ?? opts.role, { sessionId: res.sessionId, ...(res.usage ? { usage: res.usage } : {}) });
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
  },

  /**
   * A run that did not finish. On the usage limit the whole queue waits for the reset; anything else stops the step,
   * with the tool's exact words kept for engineers.
   */
  runFailed(this: LiveSquad, r: AgentResult, tool: AiTool, ticket: string | undefined, role: AgentRole): Error {
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
  },

  /**
   * A reply in a talk with the person that asks them for what is not allowed (a secret, a change to squad-kit's
   * settings, to git history) is replaced with one plain line and logged. Technical words stay: the person asked.
   */
  plainReply(this: LiveSquad, r: AgentResult, who: string, role: AgentRole, ticket?: string): AgentResult {
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
  },

  /** What the person reads when an answer in a talk did not come: squad-kit's own words, or one plain line. */
  couldNotAnswer(this: LiveSquad, err: unknown, ticket: string, line: string): string {
    const own = ownWords(err);
    const { what, detail } = explainError(err);
    this.log('warn', `Could not answer: ${[what, detail].filter(Boolean).join('\n')}`, ticket);
    return own ? `Could not answer: ${own}` : line;
  },

  projectName(this: LiveSquad): string {
    try {
      return readMeta(this.bp).project || this.bp.projectId;
    } catch {
      return this.bp.projectId;
    }
  },

  /** One line in the app log, with this project and the ticket. */
  log(this: LiveSquad, level: LogLevel, text: string, ticket?: string): void {
    writeLog({ level, project: this.projectName(), ...(ticket && !ticket.startsWith('__') ? { ticket } : {}), text });
  },

  /**
   * What no agent may change: squad-kit's own folder, the instructions and settings every AI tool loads, the project's
   * commit hooks with their settings, wherever `cwd`'s repo keeps them, and the copy's link to git's folder.
   */
  protectedFiles(this: LiveSquad, cwd?: string): string[] {
    const dirs = cwd ? copyDirsIn(cwd) : [];
    return [...new Set([`${path.basename(this.bp.squadDir)}/`, '.git', ...AI_TOOLS.flatMap((t) => t.instructionFiles ?? []), ...(dirs.length ? dirs.flatMap((d) => hookFiles(d)) : hookFiles(cwd ?? projectRoot(this.bp))), ...offLimits(this.meta()).map((f) => `/${f}`)])];
  },
};
