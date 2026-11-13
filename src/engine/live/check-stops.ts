import fs from 'node:fs';
import { addActivity, now, readTicket } from '../../board/store.js';
import { wayOptions, gateCantRunCard, saveTestCommand } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { ProjectCommands } from '../../board/types.js';
import { CHECK_SILENT_MS, runCommand, type CheckResult } from '../checks.js';
import type { Weakening } from '../weakened.js';
import { noTestsDetail, noTestsQuestion, notCheckedText, ranOf } from '../not-checked.js';
import * as P from '../prompts.js';
import type { GateDone } from '../gate-run.js';
import type { GuardSpec } from '../project-guard.js';
import { sleptSince, type SleepMark } from '../interrupt.js';
import { judgeTestChange } from '../test-change.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import type { LiveSquad } from './squad.js';

/** What the checks step stops on: a test command to change, checks not run, gates that cannot run, weakened tests. */
export const checkStopsPart = {
  /**
   * The design changes how the tests run (engine/test-change.ts): squad-kit tries the new way in the ticket's copy and
   * keeps what works, with one plain line on the story. The commands go to the log and the Developer tab. When it cannot
   * tell, the person gets one plain sentence and the checks keep the current one meanwhile. The commands the checks use now.
   */
  async tryTestChange(this: LiveSquad, id: string, cwd: string, commands: ProjectCommands, guard: GuardSpec | undefined, mark: SleepMark): Promise<ProjectCommands> {
    const c = readTicket(this.bp, id)?.testChange;
    if (!c || c.ask) return commands;
    const from = commands.test?.trim();
    // Another ticket changed it meanwhile: to this very command, or away from the one it was tried against.
    if (!from || from === c.to) {
      this.update(id, (x) => delete x.testChange);
      return commands;
    }
    const verdict = await judgeTestChange({ from, to: c.to }, (command) => {
      this.log('info', `Trying the test command: ${command}`, id);
      return runCommand(cwd, command, undefined, { silentMs: CHECK_SILENT_MS, ...this.commandWatch(id), ...(guard ? { guard } : {}) });
    });
    // Stopped, or the computer slept under it: the runs say nothing, so the next checks try again.
    this.goOn(id);
    if (sleptSince(mark)) return commands;
    this.log('info', `The test command: from "${from}" to "${c.to}": ${'ask' in verdict ? 'squad-kit cannot tell' : `squad-kit keeps the ${verdict.keep} one`} (${verdict.why}; ${verdict.ran})`, id);
    if ('ask' in verdict) {
      this.update(id, (x) => {
        x.testChange = { ...c, from, ask: true, ran: verdict.ran };
        addActivity(x, 'squad', 'squad-kit cannot tell which way of testing to keep, so it asks you. The checks keep the current way for now');
      });
      return commands;
    }
    const keepNew = verdict.keep === 'new';
    if (keepNew) saveTestCommand(this.bp, this.meta(), c.repo ?? readTicket(this.bp, id)?.repo, c.to);
    this.update(id, (x) => {
      delete x.testChange;
      x.testDecided = { from, to: c.to, kept: verdict.keep, by: 'squad', why: verdict.why, ran: verdict.ran, at: now() };
      addActivity(x, 'squad', keepNew ? `squad-kit keeps the new way of testing: ${verdict.why}` : `squad-kit keeps the current way of testing: ${verdict.why}`);
    });
    return keepNew ? { ...commands, test: c.to } : commands;
  },

  /**
   * The checks passed, but no tests ran. Once you said to go on without tests in this project, the gate says
   * "Not checked" and the review goes on. Until then the ticket waits for one decision: use the test command the
   * Architect suggested so the Builder adds tests, go on without tests, or add one in Settings and check again.
   */
  notChecked(this: LiveSquad, id: string, results: CheckResult[], around: boolean): void {
    const meta = this.meta();
    const text = `${notCheckedText(results)}${around ? '; tests weakened, you continued' : ''}`;
    const ran = ranOf(results);
    if (meta.noTests) {
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: 'unchecked', checksText: text, ran };
        x.tries = 0;
        x.checksContinued = undefined;
        clearStaleStop(x);
        addActivity(x, 'tester', `Not checked: ${text}. You chose to go on without tests in this project`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      return;
    }
    this.update(id, (x) => {
      x.gates = { ...x.gates!, checks: 'unchecked', checksText: text, ran };
      x.tries = 0;
      x.live = false;
      x.squad = null;
      x.retryPhase = 'test';
      x.status = 'No tests to check the work';
      x.stuck = {
        gate: 'checks',
        kind: 'no-tests',
        question: noTestsQuestion(results),
        detail: noTestsDetail(results, x.testSuggestion),
        options: wayOptions({ gate: 'checks', kind: 'no-tests', test: x.testSuggestion }),
      };
      x.waiting = { kind: 'stuck', summary: 'No tests to check the work: needs one decision' };
      addActivity(x, 'tester', `Not checked: ${text}. Asked you once for this project: add tests or go on without them`);
    });
  },

  /** A gate of the team's could not run: a card, and nothing counts against the story. */
  gateCantRun(this: LiveSquad, id: string, cant: GateDone[]): void {
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      delete x.clock;
      x.retryPhase = 'test';
      x.status = 'Stopped: a check could not run';
      x.stuck = gateCantRunCard(cant, { auto: x.track === 'auto' });
      x.waiting = { kind: 'stuck', summary: 'A check of your team could not run and needs one decision' };
      for (const g of cant) addActivity(x, 'tester', `"${g.name}" could not run: ${g.why} Not a failed try`);
    });
  },

  /** The tests were made weaker: the ticket stops with what was weakened. Send it back, fix it, or continue with a reason. */
  weakenedStop(this: LiveSquad, id: string, found: Weakening[], base: string): void {
    this.update(id, (x) => {
      x.stage = 'test';
      x.live = false;
      x.squad = null;
      delete x.clock;
      // Weakening the tests is a run that did not get through, as failed checks are.
      x.fails = (x.fails ?? 0) + 1;
      x.retryPhase = 'restore-tests';
      x.gates = { checks: 'fail', checksText: 'Tests were weakened', review: x.gates?.review ?? 'pending', proof: 'pending' };
      x.status = 'The tests were made weaker';
      x.stuck = {
        gate: 'checks',
        kind: 'weakened',
        question: found.every((w) => w.key.startsWith('gate:')) ? 'This change touches what your checks run, so passing them would prove little.' : `This change makes the tests weaker than on ${base}, so passing checks would prove little.`,
        points: found.map((w) => w.text),
        checks: found.map((w) => w.key),
        detail: found.map((w) => `${w.kind}: ${w.file}`).join('\n'),
        options: wayOptions({ gate: 'checks', kind: 'weakened', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
      };
      x.waiting = { kind: 'stuck', summary: 'The tests were made weaker: needs one decision' };
      addActivity(x, 'tester', `Stopped before the checks: the tests were made weaker. ${found.map((w) => w.text).join(' ')}`);
    });
  },

  /** "Send it back to the Builder" after weakened tests: it puts them back, then the checks run again. */
  async restoreTests(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is putting the tests back';
    });
    await this.runBuilder(id, P.weakenedFixPrompt(t.stuck?.points ?? []), Boolean(t.sessions?.build));
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Put the tests back');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
