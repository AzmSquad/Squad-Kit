import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  addActivity,
  boardExists,
  listDecisions,
  listTickets,
  now,
  readMeta,
  readTicket,
  updateTicket,
  writeDecision,
  writeMeta,
  type BoardPaths,
} from '../board/store.js';
import { approveExpress, wayOptions } from '../board/actions.js';
import { scheduleSquad } from '../board/schedule.js';
import type { BoardMeta, ProjectCommands, Question, Role, Ticket } from '../board/types.js';
import { describeTool, runClaude, type RunOptions, type RunResult } from './claude.js';
import { AcpStartError, acpAdapterPath, runClaudeAcp } from './acp-runner.js';
import { runChecks, runCommand, startApp, tail, testCount, type RunningApp } from './checks.js';
import { addWorktree, git } from './git.js';
import * as P from './prompts.js';
import { findNestedRepos, repoFor, rulesFiles } from './repos.js';
import { flushTracker, publishTicket, syncWiki } from './sync.js';
import { agentInstructions, readAgent, type AgentRole } from './agents.js';
import { Watchdog, processTable, type Quiet } from './watchdog.js';
import { isMediaNote, prepareMedia } from './media.js';

/**
 * The live squad. Each step of a ticket is one real Claude Code run in the project (or the
 * ticket's own worktree). Every step reads the ticket file, does its work, and writes the result
 * back, so the board and the terminal always show the true state.
 */

const READ_ONLY = ['Read', 'Glob', 'Grep', 'LS'];
const BUILD_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'Bash', 'TodoWrite'];
const NO_GIT_WRITES = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git reset:*)',
  'Bash(git rebase:*)',
  'Bash(git merge:*)',
  'Bash(git branch:*)',
  'Bash(git tag:*)',
];
const MAX_CHECK_TRIES = 3;
const MAX_REVIEW_ROUNDS = 2;

export function projectRoot(bp: BoardPaths): string {
  return path.dirname(path.dirname(bp.dir));
}

export class LiveSquad {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stops = new Map<string, AbortController>();
  private syncing = new Set<string>();
  private closing = false;
  private dog = new Watchdog();
  private lastWatch = 0;

  constructor(private bp: BoardPaths) {}

  start(intervalMs = 1000): () => void {
    this.resumeAfterRestart();
    this.timer = setInterval(() => this.tick(), intervalMs);
    return () => {
      // Closing the board: stop running steps quietly; they resume when the board opens again.
      this.closing = true;
      if (this.timer) clearInterval(this.timer);
      for (const c of this.stops.values()) c.abort();
    };
  }

  /** A step that was running when the console stopped is picked up again right away. */
  private resumeAfterRestart(): void {
    try {
      if (!boardExists(this.bp) || readMeta(this.bp).engine !== 'live') return;
      for (const t of listTickets(this.bp)) {
        if (t.squad && Date.parse(t.squad.nextAt) > Date.now()) {
          this.update(t.id, (x) => {
            if (x.squad) x.squad.nextAt = now();
          });
        }
      }
    } catch {
      // Unreadable board; the tick will report it.
    }
  }

  private tick(): void {
    if (!boardExists(this.bp)) return;
    let meta: BoardMeta;
    try {
      meta = readMeta(this.bp);
    } catch {
      return;
    }
    if (meta.engine !== 'live') return;
    this.watch();
    const limit = Math.max(1, meta.parallel ?? 2);
    if (meta.scan?.status === 'pending' && !this.running.has('__scan')) {
      this.launch('__scan', () => this.scan());
      return;
    }
    if (meta.scan?.status === 'running' && !this.running.has('__scan')) {
      // The console restarted mid-scan; read the project again.
      this.launch('__scan', () => this.scan());
      return;
    }
    for (const t of listTickets(this.bp)) {
      // Tracker updates run beside the squad's work and never count against the parallel limit.
      if (t.trackerQueue?.length && !this.syncing.has(t.id)) {
        this.syncing.add(t.id);
        flushTracker(this.bp, t.id)
          .catch(() => undefined)
          .finally(() => this.syncing.delete(t.id));
      }
      if (t.stopRequested) {
        this.stops.get(t.id)?.abort();
        if (!this.running.has(t.id)) this.stopped(t.id);
        continue;
      }
      if (this.running.size >= limit + 1) break;
      if (this.running.has(t.id)) continue;
      const q = t.questions?.find((x) => x.thinking);
      if (q) {
        this.launch(t.id, () => this.reply(t.id, q.id));
        continue;
      }
      if (t.squad && Date.parse(t.squad.nextAt) <= Date.now()) {
        const phase = t.squad.phase;
        this.launch(t.id, () => this.step(t.id, phase));
      }
    }
  }

  private launch(key: string, job: () => Promise<void>): void {
    this.running.add(key);
    this.stops.set(key, new AbortController());
    this.dog.beat(key);
    const phase = readTicket(this.bp, key)?.squad?.phase;
    job()
      .catch((err: Error) => {
        if (key === '__scan' || this.closing) return;
        if (readTicket(this.bp, key)?.stopRequested) return this.stopped(key, phase);
        if (err instanceof WaitingForYou) return;
        this.fail(key, err.message, phase ?? 'analyst-read');
      })
      .finally(() => {
        this.running.delete(key);
        this.stops.delete(key);
        this.dog.forget(key);
        if (key !== '__scan') this.setQuiet(key, null);
      });
  }

  /**
   * Every 15 seconds: is any running step quiet? Then say so on the ticket, with what it waits on, so nothing hangs
   * without the person knowing.
   */
  private watch(): void {
    if (Date.now() - this.lastWatch < 15_000) return;
    this.lastWatch = Date.now();
    const keys = [...this.running].filter((k) => k !== '__scan');
    if (!keys.length) return;
    const rows = processTable();
    for (const id of keys) {
      const t = readTicket(this.bp, id);
      if (!t) continue;
      const snoozed = t.quietSnoozedUntil && Date.parse(t.quietSnoozedUntil) > Date.now();
      this.setQuiet(id, snoozed ? null : this.dog.check(id, Date.now(), rows));
    }
  }

  private setQuiet(id: string, q: Quiet | null): void {
    try {
      const t = readTicket(this.bp, id);
      if (!t || (!q && !t.quiet)) return;
      if (q && t.quiet && q.kind === t.quiet.kind && q.detail === t.quiet.detail) return;
      this.update(id, (x) => {
        if (q && x.quiet?.kind !== q.kind) addActivity(x, 'squad', q.kind === 'stuck' ? `Looks stuck: ${q.detail}` : `Taking long: ${q.detail}`);
        if (q) x.quiet = q;
        else delete x.quiet;
      });
    } catch {
      // The ticket was removed meanwhile.
    }
  }

  /** The person pressed Stop: park the ticket with a way to pick it up again. */
  private stopped(id: string, phase?: string): void {
    this.fail(id, 'You stopped the squad. Nothing was lost; the work so far is kept.', phase ?? readTicket(this.bp, id)?.retryPhase ?? 'analyst-read');
    this.update(id, (t) => {
      t.stopRequested = undefined;
      if (t.stuck) t.stuck.options[0] = { name: 'Carry on', note: 'Run the stopped step again.' };
    });
  }

  /* ── helpers ─────────────────────────────────────────── */

  /** Commands squad-kit runs itself (setup, checks) report to the watchdog too. */
  private commandWatch(id: string) {
    return { onSpawn: (pid: number) => this.dog.track(id, pid), onOutput: () => this.dog.beat(id) };
  }

  private meta(): BoardMeta {
    return readMeta(this.bp);
  }

  private ctx(t?: Ticket): P.PromptContext {
    const meta = this.meta();
    return { rules: rulesFiles(projectRoot(this.bp)), ...(t ? { repo: repoFor(meta, t) } : {}) };
  }

  /** Roles working in a worktree still need to read the project's rule files. */
  private extraDirs(t: Ticket): string[] {
    const root = projectRoot(this.bp);
    return [...attachmentDirs(t), ...(rulesFiles(root).length ? [root] : [])];
  }

  private update(id: string, change: (t: Ticket) => void): Ticket {
    return updateTicket(this.bp, id, change);
  }

  /** Show live progress: the latest tool line on the ticket, a few of them in its activity. */
  private watcher(id: string, role: Role, cwd: string, onLine?: (line: string, t: Ticket) => void) {
    let last = 0;
    let logged = 0;
    return (e: Parameters<NonNullable<RunOptions['onTool']>>[0]) => {
      const line = describeTool(e, cwd);
      if (!line || Date.now() - last < 700) return;
      last = Date.now();
      this.update(id, (t) => {
        t.status = line;
        t.live = true;
        // The activity list keeps the changes to project files; commands only show as the live line.
        if (logged < 40 && /^(Editing|Writing) /.test(line) && e.name !== 'Bash' && isInside(cwd, e.input.file_path)) {
          addActivity(t, role, line);
          logged += 1;
        }
        onLine?.(line, t);
      });
    };
  }

  private async claude(opts: RunOptions & { ticket?: string; role: AgentRole }): Promise<RunResult> {
    const signal = opts.ticket ? this.stops.get(opts.ticket)?.signal : undefined;
    // Each role runs as its own agent: the team's file for it sets the tool, the model and extra instructions.
    const agent = readAgent(this.bp, opts.role);
    if (agent.tool !== 'claude') throw new Error(`The ${opts.role} agent is set to ${agent.tool}, which squad-kit cannot run yet. Switch it to Claude Code in Squad and AI.`);
    const extra = agentInstructions(agent);
    const appendSystemPrompt = [opts.appendSystemPrompt, extra].filter(Boolean).join('\n\n') || undefined;
    const key = opts.ticket;
    opts = this.withNewNotes(opts);
    const watch = key ? { onActivity: () => this.dog.beat(key), onSpawn: (pid: number) => this.dog.track(key, pid) } : {};
    const run = { ...opts, ...watch, ...(appendSystemPrompt ? { appendSystemPrompt } : {}), ...(agent.model ? { model: agent.model } : {}), ...(signal ? { signal } : {}) };
    let r: RunResult;
    // By default every role runs through the Agent Client Protocol; the direct runner is the fallback.
    if (this.meta().runner !== 'direct' && acpAdapterPath()) {
      try {
        r = await runClaudeAcp({ ...run, acpLogDir: path.join(this.bp.dir, 'sessions') });
      } catch (err) {
        if (!(err instanceof AcpStartError)) throw err;
        if (key) this.update(key, (x) => addActivity(x, 'squad', `ACP did not start (${err.message.slice(0, 160)}), so this step runs Claude Code directly`));
        r = await runClaude(run);
      }
    } else {
      r = await runClaude(run);
    }
    // ACP picks the id of a new conversation; keep the ticket pointing at it for follow-ups.
    const asked = opts.resume ?? opts.sessionId;
    if (key && asked && r.sessionId && r.sessionId !== asked) {
      this.update(key, (x) => {
        for (const k of Object.keys(x.sessions ?? {}) as (keyof NonNullable<Ticket['sessions']>)[]) {
          if (x.sessions?.[k] === asked) x.sessions[k] = r.sessionId;
        }
        if (x.notesSeen?.[asked] !== undefined) x.notesSeen[r.sessionId!] = x.notesSeen[asked];
      });
    }
    if (!r.ok) throw new Error(r.error ?? 'Claude Code did not finish.');
    return r;
  }

  /**
   * Notes reach a running agent at a safe moment: the start of its next step. A fresh session reads every note in
   * its ticket context; a session that goes on gets only the ones added since its last step.
   */
  private withNewNotes<T extends RunOptions & { ticket?: string }>(opts: T): T {
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

  /** Something went wrong: stop and ask the person, with a way to try again. */
  private fail(id: string, error: string, retryPhase: string): void {
    try {
      this.update(id, (t) => {
        t.live = false;
        t.squad = null;
        t.retryPhase = retryPhase;
        t.status = 'Stopped, needs you';
        t.stuck = {
          question: error,
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

  /* ── the project scan ────────────────────────────────── */

  private async scan(): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    meta.scan = { status: 'running', at: now() };
    writeMeta(this.bp, meta);
    const nested = findNestedRepos(root);
    await syncWiki(this.bp, undefined, true);
    try {
      const r = await this.claude({
        role: 'architect',
        cwd: root,
        prompt: P.scanPrompt(meta, nested, this.ctx()),
        allowedTools: READ_ONLY,
        schema: P.SCAN_SCHEMA,
        timeoutMs: 10 * 60_000,
      });
      const out = r.structured as {
        empty: boolean;
        summary: string;
        map: { area: string; detail: string }[];
        decisions: { title: string; why: string }[];
        commands: ProjectCommands;
        repos?: { path: string; summary: string; commands: ProjectCommands }[];
      };
      const fresh = this.meta();
      fresh.map = out.map;
      fresh.commands = { ...clean(out.commands), ...clean(fresh.commands ?? {}) };
      if (nested.length) {
        fresh.repos = nested.map((r) => {
          const found = out.repos?.find((x) => x.path.replace(/\/$/, '') === r.path);
          const kept = fresh.repos?.find((x) => x.path === r.path);
          return { ...r, summary: found?.summary ?? kept?.summary, commands: { ...clean(found?.commands ?? {}), ...clean(kept?.commands ?? {}) } };
        });
      }
      fresh.scan = { status: 'done', at: now(), summary: out.summary, empty: out.empty };
      writeMeta(this.bp, fresh);
      const existing = listDecisions(this.bp);
      let n = existing.length ? Math.max(...existing.map((d) => Number(d.id.replace(/\D/g, '')))) : 0;
      for (const d of out.decisions) {
        if (existing.some((x) => x.title === d.title)) continue;
        n += 1;
        writeDecision(this.bp, {
          id: `ADR-${String(n).padStart(3, '0')}`,
          title: d.title,
          why: d.why,
          options: [d.title],
          chosen: d.title,
          from: 'Project scan',
          approvedBy: fresh.user.name,
          date: now(),
          checkedBy: null,
          tickets: [],
        });
      }
    } catch (err) {
      const fresh = this.meta();
      fresh.scan = { status: 'failed', at: now(), error: (err as Error).message };
      writeMeta(this.bp, fresh);
    }
  }

  /* ── one step of a ticket ────────────────────────────── */

  private async step(id: string, phase: string): Promise<void> {
    this.update(id, (t) => {
      if (t.squad) t.squad.nextAt = new Date(Date.now() + 3_600_000).toISOString();
    });
    switch (phase) {
      case 'analyst-read':
        return this.intake(id);
      case 'triage':
        return this.triage(id);
      case 'plan-write':
        return this.plan(id);
      case 'plan-rewrite':
        return this.plan(id, readTicket(this.bp, id)?.changeRequest);
      case 'express-approve':
        approveExpress(this.bp, id);
        return;
      case 'build':
      case 'unstick':
        return this.build(id);
      case 'fix':
        return this.fixFromPerson(id);
      case 'answered-builder':
        return this.builderAnswered(id);
      case 'answered-reviewer':
        return this.review(id, true);
      case 'test':
        return this.checks(id);
      case 'review':
        return this.review(id);
      case 'review-fix':
        return this.reviewFix(id);
      case 'update-base':
        return this.updateBase(id);
      case 'proof':
        return this.proof(id);
      case 'publish':
        return publishTicket(this.bp, id);
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
    if (readTicket(this.bp, id)?.track === 'express') {
      this.update(id, (t) => {
        t.questions = [];
        t.stage = 'specs';
        t.live = true;
        t.status = 'Spec writer is writing the plan';
        addActivity(t, 'squad', 'Express track: no questions, straight to the plan');
        scheduleSquad(t, 'plan-write', 0.2, 1);
      });
      return;
    }
    const t0 = this.update(id, (t) => {
      t.stage = 'tickets';
      t.live = true;
      t.status = 'Analyst is reading the ticket';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const r = await this.claude({
        role: 'analyst',
      ticket: id,
      cwd: root,
      sessionId: t0.sessions!.intake,
      prompt: P.intakePrompt(meta, listDecisions(this.bp), t0, this.ctx()),
      allowedTools: READ_ONLY,
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
      const r = await this.claude({
        role: 'analyst',
        ticket: id,
        cwd: projectRoot(this.bp),
        resume: t.sessions?.intake,
        prompt: P.replyPrompt(q, n, ask),
        allowedTools: READ_ONLY,
        timeoutMs: 5 * 60_000,
      });
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: qq.from, text: r.text.trim(), at: now() }];
        qq.thinking = false;
      });
    } catch (err) {
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: 'squad', text: `Could not answer: ${(err as Error).message}`, at: now() }];
        qq.thinking = false;
      });
    }
  }

  private async plan(id: string, change?: string): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.stage = 'specs';
      t.live = true;
      t.status = change ? 'Spec writer is updating the plan' : 'Architect is choosing the design';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const resume = Boolean(readTicket(this.bp, id)?.activity.some((a) => a.who === 'analyst'));
    const r = await this.claude({
        role: 'architect',
      ticket: id,
      cwd: root,
      ...(resume ? { resume: t0.sessions!.intake } : { sessionId: t0.sessions!.intake }),
      prompt: resume
        ? P.planPrompt(t0, change, this.meta())
        : `${P.intakePrompt(this.meta(), listDecisions(this.bp), t0, this.ctx())}\n\n${P.planPrompt(t0, change, this.meta())}`,
      allowedTools: READ_ONLY,
      schema: P.PLAN_SCHEMA,
      timeoutMs: 10 * 60_000,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'architect', root),
    });
    const out = r.structured as {
      story: string;
      criteria: { given: string; when: string; then: string }[];
      decision?: { title: string; options: { name: string; note: string; chosen: boolean }[]; why: string; clientCheck?: string };
      steps: string[];
      tests: number;
      screens: number;
      releaseNote: string;
      commands?: ProjectCommands;
      repo?: string;
    };
    const meta = this.meta();
    const repo = meta.repos?.length ? (meta.repos.find((r) => r.path === out.repo?.replace(/\/$/, ''))?.path ?? meta.repos[0]!.path) : undefined;
    if (out.commands && Object.values(out.commands).some(Boolean)) {
      if (repo && meta.repos) {
        meta.repos = meta.repos.map((r) => (r.path === repo ? { ...r, commands: { ...r.commands, ...clean(out.commands!) } } : r));
      } else {
        meta.commands = { ...(meta.commands ?? {}), ...clean(out.commands) };
      }
      writeMeta(this.bp, meta);
    }
    this.update(id, (t) => {
      if (repo) t.repo = repo;
      t.story = out.story;
      t.criteria = out.criteria;
      if (out.decision) t.decision = { ...out.decision };
      else delete t.decision;
      t.steps = out.steps.map((s) => ({ title: s, status: 'todo' }));
      t.work = { steps: out.steps.length, tests: Math.max(0, out.tests), screens: Math.max(0, out.screens) };
      t.releaseNote = out.releaseNote;
      addActivity(t, 'spec', change ? `Updated the plan: ${change}` : 'Wrote the plan');
      if (t.track === 'express' && !change) {
        t.status = 'Express track: approving the plan';
        scheduleSquad(t, 'express-approve', 0.2, 1);
        return;
      }
      t.live = false;
      t.status = 'Plan ready for you';
      t.waiting = { kind: 'plan', summary: 'The plan is ready for your approval' };
      t.squad = null;
    });
  }

  /** Make (or reuse) the ticket's worktree and set it up once. */
  private async workspace(id: string): Promise<Ticket> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    let t = readTicket(this.bp, id)!;
    if (t.worktree && fs.existsSync(t.worktree)) return t;
    const repo = repoFor(meta, t);
    const wt = addWorktree(path.join(root, repo.path), id, repo.base);
    t = this.update(id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = x.baseCommit ?? wt.baseCommit;
      addActivity(x, 'builder', `Made a clean copy of ${repo.path === '.' ? 'the project' : repo.path} on branch ${wt.branch}`);
    });
    const setup = repo.commands.setup?.trim();
    if (setup) {
      this.update(id, (x) => (x.status = `Setting up the copy: ${setup}`));
      const r = await runCommand(wt.dir, setup, 20 * 60_000, this.commandWatch(id));
      // A new project has nothing to set up yet; the Builder creates it in this ticket.
      if (!r.ok && !meta.scan?.empty) throw new Error(`Setting up the project failed (${setup}): ${tail(r.output, 6)}`);
    }
    return readTicket(this.bp, id)!;
  }

  private async build(id: string): Promise<void> {
    const t0 = await this.workspace(id);
    const meta = this.meta();
    const rc = repoFor(meta, t0).commands;
    if (!t0.proof?.length && rc.start && rc.url && (t0.work?.screens ?? 0) > 0 && !meta.scan?.empty) {
      await this.screens(id, 'before').catch(() => undefined);
    }
    const t = this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = `Step 1 of ${x.steps?.length ?? 1} with Claude Code`;
      x.sessions = { ...x.sessions, build: x.sessions?.build ?? randomUUID() };
      x.tries = 0;
      x.reviewRound = 0;
    });
    const resume = Boolean(t.activity.some((a) => a.who === 'builder' && a.text.startsWith('Started')));
    this.update(id, (x) => addActivity(x, 'builder', resume ? 'Picked up where it stopped' : 'Started building'));
    await this.runBuilder(id, resume ? 'Continue the steps that are not done yet, then run the tests.' : P.buildPrompt(meta, listDecisions(this.bp), t, this.ctx(t)), resume);
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

  /** Runs (or continues) the Builder's conversation and maps its ">> step N" lines to the plan. */
  private async runBuilder(id: string, prompt: string, resume: boolean): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const cwd = t.worktree!;
    const started = Date.now();
    let current = -1;
    const r = await this.claude({
        role: 'builder',
      ticket: id,
      cwd,
      ...(resume ? { resume: t.sessions!.build } : { sessionId: t.sessions!.build }),
      prompt,
      allowedTools: BUILD_TOOLS,
      disallowedTools: NO_GIT_WRITES,
      permissionMode: 'acceptEdits',
      schema: P.BUILD_SCHEMA,
      timeoutMs: 60 * 60_000,
      addDirs: this.extraDirs(t),
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
          x.status = `Step ${n + 1} of ${steps.length} with Claude Code`;
        });
      },
      onTool: this.watcher(id, 'builder', cwd, (line, x) => {
        const doing = x.steps?.find((s) => s.status === 'doing');
        if (doing) doing.live = line;
      }),
    });
    this.askIfNeeded(id, 'builder', (r.structured as { question?: AgentAsk } | undefined)?.question);
  }

  /** The person answered the Builder: the same conversation carries on, then the checks run as after any build. */
  private async builderAnswered(id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
    });
    await this.runBuilder(id, P.answerPrompt(t.agentQuestion ?? { text: '' }, 'builder'), true);
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
  private askIfNeeded(id: string, from: 'builder' | 'reviewer', q: AgentAsk | undefined): void {
    if (!q?.text?.trim()) return;
    const who = from === 'builder' ? 'Builder' : 'Reviewer';
    this.update(id, (x) => {
      x.agentQuestion = { from, text: q.text.trim(), options: (q.options ?? []).filter((o) => o.trim()).slice(0, 4), ...(q.why ? { why: q.why } : {}), at: now() };
      x.live = false;
      x.squad = null;
      x.status = `${who} has a question for you`;
      x.waiting = { kind: 'ask', summary: `The ${who} needs an answer to carry on` };
      addActivity(x, from, `Asked you: ${q.text.trim()}`);
    });
    throw new WaitingForYou();
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
  private async updateBase(id: string): Promise<void> {
    const t = await this.workspace(id);
    const base = repoFor(this.meta(), t).base;
    const dir = t.worktree!;
    const baseSha = git(dir, ['rev-parse', base]);
    git(dir, ['merge', '--no-commit', '--no-ff', base], { allowFail: true });
    const clashes = git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    this.update(id, (x) => {
      x.baseCommit = baseSha;
      x.stage = 'implement';
      x.live = true;
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.status = clashes.length ? `Builder is fixing ${clashes.length} clashing ${clashes.length === 1 ? 'file' : 'files'}` : 'Running the project checks';
      addActivity(x, 'squad', `Brought the latest ${base} into this ticket${clashes.length ? `. Clashes in ${clashes.join(', ')}` : ''}`);
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
      x.reviewRound = 0;
      x.steps = [...(x.steps ?? []), { title: `Fix: ${x.changeRequest ?? 'what you found'}`, status: 'doing' }];
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

  private async checks(id: string): Promise<void> {
    const meta = this.meta();
    const t = readTicket(this.bp, id)!;
    const commands = repoFor(meta, t).commands;
    this.update(id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.gates = { checks: 'pending', review: x.gates?.review ?? 'pending', proof: 'pending' };
      addActivity(x, 'tester', 'squad-kit is running the project checks');
    });
    const results = await runChecks(t.worktree!, commands, (name) => this.update(id, (x) => (x.status = `Running ${name}: ${commands[name as 'test']}`)), this.commandWatch(id));
    const failed = results.filter((r) => !r.ok);
    if (results.length === 0) {
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: 'pass', checksText: 'No checks set up yet' };
        addActivity(x, 'tester', 'No test, lint or build commands are set up, so there was nothing to run');
        scheduleSquad(x, 'review', 0.2, 1, 1);
      });
      return;
    }
    if (failed.length === 0) {
      const tests = results.map((r) => testCount(r.output)).find((n) => n !== null);
      const names = results.map((r) => r.name).join(', ');
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: 'pass', checksText: tests ? `${tests} tests pass, ${names} OK` : `${names} pass` };
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
    const tries = (t.tries ?? 0) + 1;
    this.update(id, (x) => {
      x.tries = tries;
      x.gates = { ...x.gates!, checks: 'fail', checksText: `${failed.map((f) => f.name).join(', ')} failed` };
      addActivity(x, 'tester', `Checks failed: ${failed.map((f) => f.name).join(', ')} (try ${tries} of ${MAX_CHECK_TRIES})`);
    });
    if (tries >= MAX_CHECK_TRIES) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.retryPhase = 'test';
        x.status = `Stuck after ${tries} check runs`;
        x.stuck = {
          gate: 'checks',
          question: `The checks still fail after ${tries} tries. ${failed[0]!.name} says: ${tail(failed[0]!.output, 3).slice(0, 300)}`,
          options: wayOptions({ gate: 'checks', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The squad is stuck and needs one decision' };
      });
      return;
    }
    this.update(id, (x) => {
      x.stage = 'implement';
      x.status = 'Builder is fixing the failed checks';
    });
    await this.runBuilder(id, P.fixChecksPrompt(failed.map((f) => ({ name: f.name, command: f.command, output: tail(f.output, 60) }))), true);
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the failed checks');
      x.stage = 'test';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  }

  private async review(id: string, answered = false): Promise<void> {
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
    const r = await this.claude({
        role: 'reviewer',
      ticket: id,
      cwd: t0.worktree!,
      ...(round > 1 || goOn ? { resume: t0.sessions!.review } : { sessionId: t0.sessions!.review }),
      prompt: goOn ? P.answerPrompt(t0.agentQuestion ?? { text: '' }, 'reviewer') : P.reviewPrompt(meta, listDecisions(this.bp), t0, round, this.ctx(t0)),
      addDirs: this.extraDirs(t0),
      allowedTools: [...READ_ONLY, 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
      schema: P.REVIEW_SCHEMA,
      timeoutMs: 15 * 60_000,
      onTool: this.watcher(id, 'reviewer', t0.worktree!),
    });
    const out = r.structured as { approved: boolean; summary: string; comments: string[]; question?: AgentAsk };
    this.askIfNeeded(id, 'reviewer', out.question);
    if (goOn) this.update(id, (x) => (x.agentQuestion = undefined));
    if (out.approved) {
      this.update(id, (x) => {
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'pass', reviewBy: 'a second Claude session' } as Ticket['gates'];
        addActivity(x, 'reviewer', `Approved: ${out.summary}`);
        x.status = 'Recording the proof';
        scheduleSquad(x, 'proof', 0.2, 1);
      });
      return;
    }
    // The engine never waves a review through: after the last round, you decide.
    if (round >= MAX_REVIEW_ROUNDS) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.reviewNotes = out.comments;
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'fail', reviewBy: 'a second Claude session' } as Ticket['gates'];
        x.retryPhase = 'review-fix';
        x.status = `Review still open after ${round} rounds`;
        addActivity(x, 'reviewer', `Still asks for ${out.comments.length} ${out.comments.length === 1 ? 'fix' : 'fixes'} after ${round} rounds: ${out.comments.join(' ')}`);
        x.stuck = {
          gate: 'review',
          question: `The Reviewer still asks for changes after ${round} rounds: ${out.comments.join(' ')}`.slice(0, 600),
          options: wayOptions({ gate: 'review', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The review is still open and needs one decision' };
      });
      return;
    }
    this.update(id, (x) => {
      x.reviewNotes = out.comments;
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

  private async proof(id: string): Promise<void> {
    const meta = this.meta();
    const t = readTicket(this.bp, id)!;
    const rc = repoFor(meta, t).commands;
    const canShow = Boolean(rc.start && rc.url) && (t.work?.screens ?? 0) > 0;
    if (canShow) {
      try {
        await this.screens(id, 'after');
      } catch (err) {
        this.update(id, (x) => addActivity(x, 'tester', `Could not take screenshots: ${(err as Error).message}`));
      }
    }
    this.update(id, (x) => {
      x.proof = (x.proof ?? []).filter((p) => p.after);
      const shots = x.proof;
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'pass' } as Ticket['gates'];
      if (!shots.length) addActivity(x, 'tester', canShow ? 'No screenshots were taken, so the checks are the proof' : 'No screens to show, so the checks are the proof');
      x.live = false;
      x.stage = 'review';
      x.status = 'Proof ready to check';
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      x.squad = null;
    });
  }

  /** The Tester takes screenshots for each "done when", before or after the change. */
  private async screens(id: string, when: 'before' | 'after'): Promise<void> {
    const meta = this.meta();
    const t = this.update(id, (x) => {
      x.sessions = { ...x.sessions, tester: x.sessions?.tester ?? randomUUID() };
      x.status = when === 'before' ? 'Tester is taking before screenshots' : 'Tester is taking after screenshots';
      addActivity(x, 'tester', when === 'before' ? 'Taking screenshots before the change' : 'Taking screenshots after the change');
    });
    fs.mkdirSync(this.bp.proofDir, { recursive: true });
    const rc = repoFor(meta, t).commands;
    let app: RunningApp | null = null;
    if (rc.start && rc.url) {
      this.update(id, (x) => (x.status = `Starting the app: ${rc.start}`));
      try {
        app = await startApp(t.worktree!, rc.start, rc.url);
        this.update(id, (x) => addActivity(x, 'tester', `squad-kit started the app at ${rc.url}`));
      } catch (err) {
        // The Tester can still try on its own; it sees the error in the activity.
        this.update(id, (x) => addActivity(x, 'tester', (err as Error).message.slice(0, 300)));
      }
    }
    try {
      await this.shoot(id, t, when, meta, app !== null);
    } finally {
      app?.stop();
    }
  }

  private async shoot(id: string, t: Ticket, when: 'before' | 'after', meta: BoardMeta, appRunning: boolean): Promise<void> {
    const r = await this.claude({
        role: 'tester',
      ticket: id,
      cwd: t.worktree!,
      ...(t.activity.some((a) => a.text === 'Taking screenshots before the change') && when === 'after'
        ? { resume: t.sessions!.tester }
        : { sessionId: t.sessions!.tester }),
      prompt: P.proofPrompt(meta, t, this.bp.proofDir, when, this.ctx(t), appRunning),
      allowedTools: BUILD_TOOLS,
      disallowedTools: NO_GIT_WRITES,
      permissionMode: 'acceptEdits',
      schema: P.PROOF_SCHEMA,
      timeoutMs: 20 * 60_000,
      addDirs: [this.bp.proofDir, ...this.extraDirs(t)],
      onTool: this.watcher(id, 'tester', t.worktree!),
    });
    const out = r.structured as { shots: { criterion: number; file: string; note?: string }[]; skipped?: string };
    this.update(id, (x) => {
      const proof = x.proof ?? [];
      for (const s of out.shots) {
        const file = path.basename(s.file);
        if (!fs.existsSync(path.join(this.bp.proofDir, file))) continue;
        const c = x.criteria?.[s.criterion - 1];
        if (!c) continue;
        const criterion = `${c.then.charAt(0).toUpperCase()}${c.then.slice(1)}`;
        let row = proof.find((p) => p.criterion === criterion);
        if (!row) {
          row = { criterion, before: '', after: '', beforeLabel: 'Before', afterLabel: 'After' };
          proof.push(row);
        }
        if (when === 'before') row.before = file;
        else {
          row.after = file;
          if (s.note) row.note = s.note;
        }
      }
      x.proof = proof.map((p) => (p.before ? p : { ...p, before: p.after, beforeLabel: 'New screen', afterLabel: 'After' }));
      if (when === 'after') addActivity(x, 'tester', `Saved ${out.shots.length} screenshots${out.skipped ? `. Skipped: ${out.skipped}` : ''}`);
    });
  }
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
}
