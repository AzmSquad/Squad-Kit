import fs from 'node:fs';
import { addActivity, now, readTicket } from '../../board/store.js';
import { wayOptions } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { Ticket } from '../../board/types.js';
import { tail } from '../checks.js';
import { ranOf } from '../not-checked.js';
import * as P from '../prompts.js';
import { CapReached, capCard } from '../caps.js';
import { copiesOf } from '../copies.js';
import { offLimits } from '../../board/project-files.js';
import {
  GUARD_BLOCKED,
  GUARD_BLOCKED_DOCKER,
  blockedDocker,
  guardBlockedDetail,
  type GuardSpec,
} from '../project-guard.js';
import { checkLane, watchLane, type Lane } from '../lane.js';
import { hookFiles, isHookFile } from '../hook-files.js';
import { checkTools, toolsHold } from '../tools/index.js';
import { afterToolMissing } from '../tool-missing.js';
import { isLimitText, limitText, type LimitPause } from '../usage-limit.js';
import { StepError } from '../../board/problem.js';
import { checkNames, held, STOPPED } from './shared.js';
import type { LiveSquad } from './squad.js';

/** The Builder's lanes, and the plain stops: a guard refusal, a failed step, a cap, a missing tool or the usage limit. */
export const stopsPart = {
  /**
   * After a Builder, Tester or Reviewer step, in the ticket's copy: what the step may not change goes back, with a
   * line saying so, and a branch or commit that moved stops the ticket. `skip` holds folders the step may write in.
   */
  async keepLane(this: LiveSquad, id: string, role: 'builder' | 'tester' | 'reviewer', lane: Lane, skip: string[] = []): Promise<void> {
    const who = role === 'builder' ? 'Builder' : role === 'tester' ? 'Tester' : 'Reviewer';
    const c = await checkLane(lane, skip);
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
  },

  /** The lane check on each of a story's copies. */
  watchCopies(this: LiveSquad, t: Ticket, wholeCopy = false): Promise<Lane[]> {
    return Promise.all(copiesOf(this.meta(), t).map((c) => watchLane(c.dir, this.protectedFiles(c.dir), wholeCopy)));
  },

  /** Every copy is put right, even when one stops the story: the first stop is the one said. */
  async keepLanes(this: LiveSquad, id: string, role: 'builder' | 'tester' | 'reviewer', lanes: Lane[], skip: string[] = []): Promise<void> {
    let stop: unknown;
    for (const lane of lanes) {
      try {
        await this.keepLane(id, role, lane, skip);
      } catch (err) {
        stop ??= err;
      }
    }
    if (stop) throw stop;
  },

  /**
   * Notes reach a running agent at a safe moment: the start of its next step. A fresh session reads every note in
   * its ticket context; a session that goes on gets only the ones added since its last step.
   */
  withNewNotes<T extends { prompt: string; resume?: string; sessionId?: string; ticket?: string }>(this: LiveSquad, opts: T): T {
    const session = opts.resume ?? opts.sessionId;
    if (!opts.ticket || !session) return opts;
    const t = readTicket(this.bp, opts.ticket);
    const notes = t?.notes ?? [];
    if (!t || !notes.length) return opts;
    const seen = opts.resume ? (t.notesSeen?.[session] ?? 0) : notes.length;
    this.update(t.id, (x) => (x.notesSeen = { ...x.notesSeen, [session]: notes.length }));
    const fresh = notes.slice(seen);
    return fresh.length ? { ...opts, prompt: `${opts.prompt}\n${P.notesText(fresh, true)}` } : opts;
  },

  /**
   * squad-kit's own guard blocked a file a project command needed outside its copy. The person sees one plain
   * sentence (never the path, never "sandbox") and Try again; Ask a question is at the top of the story as always.
   * Engineers get the exact path and the command. An engineer allows the file in Settings or with a terminal command.
   */
  guardStop(this: LiveSquad, id: string, retryPhase: string, target: string, command: string, output: string, guard: GuardSpec): void {
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
  },

  /** Something went wrong: stop and ask the person, with a way to try again. The exact error stays for engineers. */
  fail(this: LiveSquad, id: string, error: string, retryPhase: string, detail?: string): void {
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
  },

  /**
   * A step reached one of its caps. The work so far is kept and it is not a failed try: the card offers Give it more
   * (the same step goes on, with twice the caps) or Stop.
   */
  capPause(this: LiveSquad, id: string, phase: string, cap: CapReached): void {
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
  },

  /**
   * Checks that failed only because a tool is missing (tool-missing.ts): squad-kit checks this computer's tools again
   * and runs the checks once more, with no try counted. Still missing: the story waits with the Tools page's line when
   * the Tools page knows the tool, and goes on by itself once it is there; else a card says what is missing. The
   * Builder is never asked: no code change brings a tool.
   */
  async toolMissingNow(this: LiveSquad, id: string, lacking: { check: string; command: string; what: string; line: string }[], ran: ReturnType<typeof ranOf>): Promise<void> {
    const first = lacking[0]!;
    const names = checkNames(lacking.map((l) => l.check));
    const words = `${names.charAt(0).toUpperCase()}${names.slice(1)} could not run: ${first.what} is not there for it`;
    this.log('warn', lacking.map((l) => `${l.check} could not run, ${l.what} is missing (${l.command}): ${l.line}`).join('\n'), id);
    // A tool installed meanwhile, or one squad-kit just set up, counts from now.
    await checkTools().catch(() => undefined);
    const now = readTicket(this.bp, id);
    if (!now) return;
    const block = toolsHold(this.bp, now, 'test');
    const reruns = this.toolReruns.get(id) ?? 0;
    const next = afterToolMissing(reruns, block);
    if (next !== 'stop') {
      this.toolReruns.set(id, reruns + 1);
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: 'pending', checksText: `${first.check} could not run: ${first.what} is missing`, ran };
        addActivity(x, 'tester', next === 'again' ? `${words}, so squad-kit set its tools up again and runs the checks once more. Not a failed try` : block!.text);
        x.stage = 'test';
        scheduleSquad(x, 'test', 0.2, 1);
      });
      return;
    }
    this.toolReruns.delete(id);
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      x.retryPhase = 'test';
      x.status = 'Stuck: a tool the checks need is missing';
      x.gates = { ...x.gates!, checks: 'fail', checksText: `${first.check} could not run: ${first.what} is missing`, ran };
      // One plain sentence: a tool to install, never code to fix. What it printed is for engineers.
      x.stuck = {
        gate: 'checks',
        checks: lacking.map((l) => l.check),
        question: `squad-kit can't run ${checkNames(lacking.map((l) => l.check))} on this computer: ${first.what} is missing. Install it, then press Try again. The code was not the problem.`,
        detail: lacking.map((l) => `${l.check} (${l.command}):\n${l.line}`).join('\n\n'),
        options: wayOptions({ gate: 'checks', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
      };
      x.waiting = { kind: 'stuck', summary: 'A tool the checks need is missing' };
    });
  },

  /**
   * The AI account hit its usage limit. The ticket waits with the whole queue and runs the same step again by itself
   * once the limit resets. Nothing failed, so it is not a failed try.
   */
  waitForLimit(this: LiveSquad, id: string, phase: string, pause: LimitPause): void {
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
  },
};
