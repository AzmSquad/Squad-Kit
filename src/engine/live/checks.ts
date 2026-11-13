import fs from 'node:fs';
import path from 'node:path';
import { addActivity, listDecisions, readTicket, writeDecision, writeMeta } from '../../board/store.js';
import { wayOptions } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { OldFailure, ProjectCommands, Ticket } from '../../board/types.js';
import { CHECK_DOING, DOING } from '../plain-doing.js';
import {
  blockedByGuard,
  checksToRun,
  failedOnceLine,
  runChecks as runChecksNow,
  startsToo,
  tail,
  testCount,
  type CheckResult,
} from '../checks.js';
import { TurnTimeout, inTurn, stopAppsIn } from '../copy-turn.js';
import { forgetKnownFailure, knownFailures } from '../known-failures.js';
import { testTitle } from '../failed-tests.js';
import { oldGateText, oldLine, storiesForOld, type MainResult } from '../old-tests.js';
import { weakenedChecks, type Weakening } from '../weakened.js';
import { checkWords, noTestsRan, ranOf } from '../not-checked.js';
import { findCommands } from '../find-commands.js';
import * as P from '../prompts.js';
import { gatesChanged, noteGates, runGatesAt as runGatesNow } from '../gate-run.js';
import { repoFor, reposOf } from '../repos.js';
import { copiesOf, type CopyOf } from '../copies.js';
import { workSoFar } from '../handover.js';
import { checkLane, treeOf, watchLane } from '../lane.js';
import { hookFiles } from '../hook-files.js';
import { endStep, startStep, stepDoing } from '../../board/clock.js';
import { toolMissing } from '../tool-missing.js';
import { StepError } from '../../board/problem.js';
import { sleepMark, sleptSince } from '../interrupt.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import { MAX_CHECK_TRIES } from './limits.js';
import { checkNames } from './shared.js';
import type { LiveSquad } from './squad.js';

const PROJECT_CHECKS = ['test', 'lint', 'build', 'check', 'start'];
/** The checks waited their whole time for the app starting in the same copy. */
const CHECKS_WAITED = "The checks waited too long for the app starting in this story's copy, so they did not run. Press Try again to run them.";
/** The checks step uses the Builder's last run of the checks (builderPassed). */
const CHECKS_PASSED_FOR_BUILDER = 'The checks already passed on this same code when squad-kit ran them for the Builder, so they do not run again';

/** Some of the checks come from the Builder's own run (builderPassed): those do not run again, and the others do. */
function someFromBuilder(names: string[]): string {
  const words = names.map((n) => (n === 'test' ? 'the tests' : n === 'lint' ? 'the code check' : n === 'build' ? 'the build' : `the ${n} check`));
  const what = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]!;
  const many = words.length > 1 || names[0] === 'test';
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} already passed on this same code when squad-kit ran ${many ? 'them' : 'it'} for the Builder, so ${many ? 'they do' : 'it does'} not run again. squad-kit is running the other checks`;
}

/**
 * The checks step's own runs of the project's checks (checks.ts) and of the team's gates (gate-run.ts), each in the
 * turn of the copies it runs in (copy-turn.ts): an app starting in the same copy goes first, and one that starts
 * meanwhile waits for them. Different copies never wait for each other. An app squad-kit runs in those copies (one kept
 * for the proof) stops first, as the tests may start their own: only the log says so.
 */
function runChecks(...a: Parameters<typeof runChecksNow>): ReturnType<typeof runChecksNow> {
  const signal = a[3]?.signal;
  const work = async () => {
    await stopAppsIn(a[0]);
    return runChecksNow(...a);
  };
  return inTurn(a[0], 'checks', work, signal ? { signal } : {}).catch(turnStop);
}

function runGatesAt(...a: Parameters<typeof runGatesNow>): ReturnType<typeof runGatesNow> {
  const dirs = a[2].map((p) => p.dir);
  const work = async () => {
    await stopAppsIn(dirs);
    return runGatesNow(...a);
  };
  return inTurn(dirs, 'checks', work).catch(turnStop);
}

/** The checks' turn did not come: one plain stop with Try again, the details for engineers. */
function turnStop(err: unknown): never {
  if (err instanceof TurnTimeout) throw new StepError(CHECKS_WAITED, `The checks ${err.message}.`);
  throw err;
}

/** The checks step: the project's checks and the team's gates, run by squad-kit itself. */
export const checksPart = {
  /**
   * How to test and run the project, found in the story's copy and saved, with a line on the story. It asks nobody. A
   * project that started empty, or has nothing saved at all, gets every command it lacks. Any other only gets a test
   * command when it has none, as the Builder may have written the project's first tests. The person's choice to go on
   * without tests stands. The commands saved now.
   */
  saveFoundCommands(this: LiveSquad, id: string, cwd: string, repoPath?: string): ProjectCommands {
    const meta = this.meta();
    const t = readTicket(this.bp, id)!;
    const repo = (repoPath ? reposOf(meta).find((r) => r.path === repoPath) : undefined) ?? repoFor(meta, t);
    const has = (k: keyof ProjectCommands) => Boolean(repo.commands[k]?.trim());
    const fresh = Boolean(meta.scan?.empty) || !(['test', 'lint', 'build', 'start', 'url'] as const).some(has);
    const wanted = (fresh ? (['setup', 'test', 'lint', 'build', 'start', 'url'] as const) : (['test'] as const)).filter((k) => !has(k) && !(k === 'test' && meta.noTests));
    if (!wanted.length || !fs.existsSync(cwd)) return repo.commands;
    const found = findCommands(cwd);
    const add = Object.fromEntries(wanted.filter((k) => found[k]?.trim()).map((k) => [k, found[k]!.trim()])) as ProjectCommands;
    if (!Object.keys(add).length) return repo.commands;
    if (meta.repos?.length) meta.repos = meta.repos.map((r) => (r.path === repo.path ? { ...r, commands: { ...r.commands, ...add } } : r));
    else meta.commands = { ...(meta.commands ?? {}), ...add };
    writeMeta(this.bp, meta);
    // The exact commands are for engineers: in the log and in Settings.
    this.log('info', `Found and saved: ${Object.entries(add).map(([k, v]) => `${k}: ${v}`).join(', ')}`, id);
    this.update(id, (x) => {
      if (add.test) delete x.testSuggestion;
      addActivity(x, 'squad', add.test && Object.keys(add).length === 1 ? 'squad-kit found the tests in the project, and runs them from now on' : 'squad-kit found how to test and run the project, and saved it');
    });
    return { ...repo.commands, ...add };
  },

  /**
   * What the checks step takes from the Builder's own run_checks in each copy it runs in, check by check, instead of
   * running that check again: the Builder's latest run of it in that copy passed, with the command saved for it now and
   * its whole saved command, and the copy's code is the same as when that run started (noteRun). The checks it has no
   * such run of run as usual, in each part on its own. A new test command still to be tried runs them all. Taken by this
   * step either way: a later checks step with no new round of the Builder runs them itself. Null when nothing is taken.
   */
  async builderPassed(this: LiveSquad, id: string, t: Ticket, copies: CopyOf[]): Promise<Map<CopyOf, CheckResult[]> | null> {
    const notes = this.builderRuns.get(id);
    this.builderRuns.delete(id);
    if (!notes?.size) return null;
    if (t.testChange && !t.testChange.ask) {
      this.log('info', "squad-kit runs the checks itself, not using the Builder's last run_checks: a new test command is still to be tried", id);
      return null;
    }
    const out = new Map<CopyOf, CheckResult[]>();
    for (const c of copies) {
      const here = notes.get(c.dir);
      if (!here?.size) continue;
      const tree = await treeOf(c.dir);
      const taken: CheckResult[] = [];
      for (const w of checksToRun(c.dir, c.repo.commands)) {
        const note = here.get(w.name);
        if (!note) continue;
        const why = note.run.command !== w.command ? `the checks now are not the ones it ran (${w.name}: ${w.command})` : note.tree !== tree ? `the code in ${c.label} changed since that run started` : '';
        if (why) this.log('info', `squad-kit runs ${w.name} itself, not using the Builder's last run_checks: ${why}`, id);
        else {
          taken.push(note.run);
          this.log('info', `squad-kit uses the Builder's run_checks from ${new Date(note.at).toISOString()} in ${c.label} for ${w.name} instead of running it again: it passed in the same copy, on the same code (tree ${note.tree.slice(0, 12)}): ${note.run.command}`, id);
        }
      }
      if (taken.length) out.set(c, taken);
    }
    return out.size ? out : null;
  },

  async checks(this: LiveSquad, id: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    // A project the Builder just set up says now how it is tested and run.
    for (const c of copiesOf(this.meta(), t)) this.saveFoundCommands(id, c.dir, c.repo.path);
    const meta = this.meta();
    const copies = copiesOf(meta, t);
    const several = copies.length > 1;
    // Tests made weaker first: passing them would prove little, and only you can go past it.
    const weak: Weakening[] = [];
    for (const c of copies) {
      if (c.baseCommit) weak.push(...(await weakenedChecks(c.dir, c.baseCommit, { skip: [`${path.basename(this.bp.squadDir)}/`], testCommand: c.repo.commands.test })), ...(await gatesChanged(this.bp, c.dir, c.repo.path, c.baseCommit)));
    }
    const fresh = weak.filter((w) => !(t.weakenedContinued ?? []).includes(w.key));
    if (fresh.length) return this.weakenedStop(id, fresh, repoFor(meta, t).base);
    // No old server of squad-kit's own copies may hold a port the checks need.
    await this.clearBeforeApp(id);
    this.goOn(id);
    // New packages or database changes since a copy's setup last ran: it runs again first. One that still fails is a
    // failed check, for the Builder.
    const setups: (CheckResult & { part?: string })[] = [];
    for (const c of copies) {
      const { failed } = await this.setUpAgain(id, c);
      if (failed) setups.push(several ? { ...failed, part: c.label } : failed);
      this.goOn(id);
    }
    // A part the story did not change has nothing new to check, unless nothing changed at all.
    const changed: typeof copies = [];
    for (const c of copies) if (!several || (c.baseCommit && (await workSoFar(c.dir, c.baseCommit)).length)) changed.push(c);
    // The Builder's own passing runs of the checks on this very code stand, check by check: those commands do not run again.
    const passed = await this.builderPassed(id, t, changed.length ? changed : copies.slice(0, 1));
    /** All of a copy's checks are known from the Builder's run, and none needs the app started: nothing runs there. */
    const whole = (dir: string, commands: ProjectCommands, had: CheckResult[]) => had.length > 0 && checksToRun(dir, commands).every((w) => had.some((k) => k.name === w.name && k.command === w.command)) && !startsToo(commands, had);
    const reused = ['test', 'lint', 'build'].filter((n) => [...(passed?.values() ?? [])].some((ran) => ran.some((r) => r.name === n)));
    const allReused = Boolean(passed) && (changed.length ? changed : copies.slice(0, 1)).every((c) => whole(c.dir, c.repo.commands, passed?.get(c) ?? []));
    this.update(id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.gates = { checks: 'pending', review: x.gates?.review ?? 'pending', proof: 'pending' };
      addActivity(x, 'tester', allReused ? CHECKS_PASSED_FOR_BUILDER : reused.length ? someFromBuilder(reused) : 'squad-kit is running the project checks');
      startStep(x, { who: 'squad', step: 'checks', limit: 15 });
    });
    const mark = sleepMark();
    const results: (CheckResult & { part?: string })[] = [...setups];
    // The copy each project check ran in, for a failed test to run on main's code.
    const ranIn = new Map<CheckResult, CopyOf>();
    for (const c of changed.length ? changed : copies.slice(0, 1)) {
      let commands = c.repo.commands;
      const onStart = (name: string, command?: string) => {
        // The exact command is for engineers: here, and in the ticket's Developer tab once it ran.
        this.log('info', `Running ${name}: ${command ?? commands[name as 'test' | 'start']}`, id);
        this.update(id, (x) => {
          x.status = CHECK_DOING[name] ?? DOING.check;
          stepDoing(x, x.status);
        });
      };
      const guard = this.guardFor(c.dir, id);
      // The checks run the Builder's code, which may write in its copy: never in the project's own check.
      const hookLane = await watchLane(c.dir, hookFiles(c.dir));
      if (!t.testChange?.repo || t.testChange.repo === c.repo.path) commands = await this.tryTestChange(id, c.dir, commands, guard, mark);
      const had = passed?.get(c) ?? [];
      const ran = whole(c.dir, commands, had) ? had : await runChecks(c.dir, commands, onStart, { ...this.commandWatch(id), ...(guard ? { guard } : {}) }, undefined, had);
      const hooksBack = (await checkLane(hookLane)).restored;
      if (hooksBack.length) this.update(id, (x) => addActivity(x, 'squad', `The project's checks changed the check that runs on every save (${hooksBack.slice(0, 6).join(', ')}); squad-kit put it back. Changing that check stays with you or an engineer`));
      // A check that needed a file outside its copy, which the guard blocked: one plain sentence, not a failed try.
      if (guard && !this.stops.get(id)?.signal.aborted) {
        // A check squad-kit ran outside its guard (an Xcode build) is never the guard's doing.
        const hit = blockedByGuard(ran, guard);
        if (hit) return this.guardStop(id, 'test', hit.path, hit.result.command, hit.result.output, guard);
      }
      for (const r of ran.map((x) => (several ? { ...x, part: c.label } : x))) {
        results.push(r);
        ranIn.set(r, c);
      }
      this.goOn(id);
    }
    // The team's own gates, by squad-kit's own hand. A must-pass one goes the way of a project check; the others only say.
    const gates = await runGatesAt(
      this.bp,
      'checks',
      (changed.length ? changed : copies.slice(0, 1)).map((c) => ({ dir: c.dir, repo: c.repo.path, ...(several ? { label: c.label } : {}) })),
      t.addedSkipped ?? [],
      (dir) => {
        const guard = this.guardFor(dir, id);
        return { ...this.commandWatch(id), ...(guard ? { guard } : {}) };
      },
      (name) =>
        this.update(id, (x) => {
          x.status = `Running your team's gate: ${name}`;
          stepDoing(x, x.status);
        }),
    );
    this.goOn(id);
    this.update(id, (x) => noteGates(x, gates, (text) => addActivity(x, 'tester', text)));
    results.push(
      ...gates
        .filter((g) => g.stops && g.result !== 'cant-run')
        // A gate named like one of the project's checks must not pass for it.
        .map((g) => ({ name: PROJECT_CHECKS.includes(g.name.toLowerCase()) ? `${g.name} (your team's gate)` : g.name, command: g.command, ok: g.result === 'passed', output: g.output, seconds: g.seconds, ...(g.failedFirst !== undefined ? { failedFirst: g.failedFirst } : {}), ...(g.label ? { part: g.label } : {}) })),
    );
    /** A check as a person reads it: on a story with several parts, it says whose. */
    const shown = (r: CheckResult & { part?: string }) => (r.part ? `${r.part}: ${r.name}` : r.name);
    // Stopped while a check ran: its result says nothing about the code, so it is no failed try.
    this.goOn(id);
    // A failed test this story may not have caused runs on its own on main's code first, before any try is counted
    // (engine/old-tests.ts). Not tests you already chose to continue past: that choice stands.
    const onMain = new Map<CheckResult & { part?: string }, MainResult>();
    for (const r of results) {
      // A run squad-kit had to end says nothing sure about its tests.
      if (r.ok || r.ended || r.name !== 'test' || (t.checksContinued ?? []).includes(shown(r)) || !ranIn.has(r)) continue;
      const found = await this.testsOnMain(id, ranIn.get(r)!, r);
      this.goOn(id);
      if (found) onMain.set(r, found);
    }
    // Nor when the computer slept under them: they run again, and no try is counted.
    if (sleptSince(mark)) {
      this.update(id, (x) => {
        delete x.clock;
        addActivity(x, 'squad', 'The computer slept while the checks ran, so squad-kit runs them again. Not a failed try');
        scheduleSquad(x, 'test', 0.2, 1);
      });
      return;
    }
    this.update(id, (x) => endStep(this.bp, x, Date.now(), reused.length ? { builderRun: { checks: reused, ...(allReused ? { all: true } : {}) } } : {}));
    // Failed once, then passed: no failed try and no Builder. One plain line here; the Developer tab and the log say more.
    for (const r of results.filter((x) => x.failedFirst !== undefined)) {
      this.log('warn', `${shown(r)} failed once and passed when run again (${r.command}):\n${r.failedFirst}`, id);
      this.update(id, (x) => addActivity(x, 'tester', failedOnceLine(r.name)));
    }
    const test = results.find((r) => r.name === 'test');
    if (test?.ok && test.failedFirst === undefined) forgetKnownFailure(this.bp, t, test.command);
    // A test check whose every failed test fails on main too is not this story's: it does not count as failed.
    const oldOnly = new Set([...onMain].filter(([, m]) => m.old.length && !m.fine.length).map(([r]) => r));
    const failed = results.filter((r) => !r.ok && !oldOnly.has(r));
    // A gate that could not run says nothing about the code: no failed try, no stronger model, no Builder. Only a card.
    const cant = gates.filter((g) => g.stops && g.result === 'cant-run');
    // The old tests found: one story fixes them, and the story says so in one line.
    const old: OldFailure[] = [];
    for (const [r, m] of onMain) {
      if (!m.old.length) continue;
      const fixes = storiesForOld(this.bp, readTicket(this.bp, id)!, m.old, m.printed, { command: r.command, ...(meta.repos?.length ? { repo: ranIn.get(r)!.repo.path } : {}), ...(r.part ? { part: r.part } : {}) });
      this.log('info', `${shown(r)} failed on main's code too, without ${id}'s change (${r.command}): ${fixes.map((f) => `${f.file} › ${f.title}${f.story ? ` (${f.story})` : ''}`).join('; ')}`, id);
      // The stories made for them wait on the board until the person starts them: the line says which still do.
      const waiting = fixes.flatMap((f) => (f.story && readTicket(this.bp, f.story)?.waitsToStart ? [f.story] : []));
      const line = oldLine(fixes, !failed.length && !cant.length, waiting);
      this.update(id, (x) => {
        if (!x.activity.some((a) => a.text === line)) addActivity(x, 'tester', line);
      });
      if (oldOnly.has(r)) old.push(...fixes);
    }
    if (cant.length && !failed.length) return this.gateCantRun(id, cant);
    const ran = ranOf(results);
    // Weakened tests you continued past are still there: the gate is never a plain pass.
    const around = weak.length > 0;
    if (failed.length === 0 && noTestsRan(results)) return this.notChecked(id, results, around);
    if (failed.length === 0) {
      this.toolReruns.delete(id);
      const tests = test ? testCount(test.output) : null;
      const parts = [...new Set(results.map((r) => r.part).filter(Boolean))];
      const names = parts.length ? parts.map((p) => `${p} ✓`).join(', ') : results.map((r) => checkWords(r.name)).join(', ');
      const passed = parts.length ? names : tests ? `${tests} ${tests === 1 ? 'test passes' : 'tests pass'}, ${names} OK` : `${names} pass`;
      // Old tests that fail on main too: the story goes on, and the gate says so in plain words.
      const text = old.length ? `${passed}; ${oldGateText(old.length)}` : passed;
      this.update(id, (x) => {
        x.gates = { ...x.gates!, checks: around ? 'skipped' : 'pass', checksText: around ? `${text}; tests weakened, you continued` : text, ran, ...(old.length ? { oldFailures: old } : {}) };
        // A pass starts the count again: a later round that fails has its own tries, and nothing is continued past.
        x.tries = 0;
        clearStaleStop(x);
        x.checksContinued = undefined;
        addActivity(x, 'tester', old.length ? `All checks pass, apart from ${old.length === 1 ? 'the old test that fails' : 'the old tests that fail'} on main too: ${names}` : `All checks pass: ${names}`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      for (const d of listDecisions(this.bp)) {
        if (d.from === id && d.checkedBy && !d.checkedBy.passing) writeDecision(this.bp, { ...d, checkedBy: { ...d.checkedBy, passing: true } });
      }
      return;
    }
    // You chose to continue past these very checks: they still fail, so the work goes on as you decided. A check
    // that failed only now is new, and goes through the fixes as usual.
    const past = t.checksContinued;
    if (past?.length && failed.every((f) => past.includes(shown(f)))) {
      const names = failed.map(shown).join(', ');
      this.update(id, (x) => {
        x.tries = 0;
        x.gates = { ...x.gates!, checks: 'skipped', checksText: `${names} still failed, continued anyway`, ran };
        clearStaleStop(x);
        addActivity(x, 'tester', `Checks still fail: ${names}. You continued anyway past them, so the work goes on`);
        x.stage = 'review';
        x.status = 'Reviewer is reading the changes';
        scheduleSquad(x, 'review', 0.2, 1, (x.reviewRound ?? 0) + 1);
      });
      return;
    }
    // A check that failed only because a tool is missing says nothing about the code: no try, and no Builder.
    const lacking = failed.flatMap((f) => {
      const miss = toolMissing(f.output);
      return miss ? [{ check: shown(f), command: f.command, ...miss }] : [];
    });
    if (lacking.length) return this.toolMissingNow(id, lacking, ran);
    this.toolReruns.delete(id);
    const tries = (t.tries ?? 0) + 1;
    this.update(id, (x) => {
      x.tries = tries;
      x.fails = (x.fails ?? 0) + 1;
      x.gates = { ...x.gates!, checks: 'fail', checksText: `${failed.map(shown).join(', ')} failed`, ran };
      addActivity(x, 'tester', `Checks failed: ${failed.map(shown).join(', ')} (try ${tries} of ${MAX_CHECK_TRIES})`);
    });
    if (tries >= MAX_CHECK_TRIES) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.retryPhase = 'test';
        x.status = `Stuck after ${tries} check runs`;
        // One plain sentence; what each check printed is for engineers.
        x.stuck = {
          gate: 'checks',
          checks: failed.map(shown),
          question: `The checks still fail after ${tries} tries: ${checkNames(failed.map(shown))} did not pass.`,
          detail: failed.map((f) => `${shown(f)} (${f.command}):\n${tail(f.output, 30)}`).join('\n\n').slice(-6000),
          options: wayOptions({ gate: 'checks', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The squad is stuck and needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.status = 'Builder is fixing the failed checks';
    });
    // What the failed tests did on main's code: those that pass there are this story's to fix, the old ones are not.
    const ranOnMain = [...onMain.values()];
    const said = { passes: ranOnMain.flatMap((m) => m.fine.map(testTitle)), fails: ranOnMain.flatMap((m) => m.old.map(testTitle)) };
    await this.runBuilder(id, P.fixChecksPrompt(failed.map((f) => ({ name: shown(f), command: f.command, output: tail(f.output, 60) })), knownFailures(this.bp, t, failed), said), true);
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the failed checks');
      x.stage = 'test';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
