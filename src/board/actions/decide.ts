import { addActivity, now, readMeta, requireTicket, updateTicket, writeMeta, type BoardPaths } from '../store.js';
import fs from 'node:fs';
import type { BoardMeta, Ticket, StuckChoice, StuckOption, WayOut } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { writeLog } from '../../core/app-log.js';
import { HARNESS_FILE_GATE } from '../additions.js';
import { BoardActionError, tellLater } from './errors.js';
import { refuseWhileSaving, saveFromHookCard } from './save.js';
import { ownerWay } from '../../engine/contribution/actions.js';

/** The card for gates that could not run. `save`: they stopped the save of an accepted change, not the checks. */
export function gateCantRunCard(cant: { id: string; name: string; why?: string; output?: string }[], opts: { auto: boolean; save?: boolean }): StuckChoice {
  const one = cant.length === 1 ? cant[0]! : null;
  const said = one ? (one.id === HARNESS_FILE_GATE ? one.why : `Your team's check "${one.name}" could not run. ${one.why}`) : `${cant.length} of your team's checks could not run.`;
  const detail = cant.filter((c) => c.output).map((c) => `${c.name}:\n${c.output}`).join('\n\n').slice(-6000);
  return {
    ...(opts.save ? {} : { gate: 'checks' as const }),
    kind: 'gate-cant-run',
    added: cant.map((c) => ({ id: c.id, name: c.name })),
    checks: cant.map((c) => c.id),
    question: `${said} This does not count against the story.`,
    ...(one ? {} : { points: cant.map((c) => `${c.name}: ${c.why}`) }),
    ...(detail ? { detail } : {}),
    options: wayOptions({ kind: 'gate-cant-run', auto: opts.auto, ...(opts.save ? { save: true } : {}) }),
  };
}

/** The choices on a stuck card. Every stop has a way out: try again, do it yourself, go around it, or back to the plan. */
export function wayOptions(stop: { gate?: StuckChoice['gate']; kind?: StuckChoice['kind']; publish?: boolean; contribution?: boolean; copy?: boolean; base?: string; test?: string; auto?: boolean; save?: boolean }): StuckOption[] {
  // A gate of the team's could not run. Nothing here counts against the story. On Builds by itself it waits for a person.
  if (stop.kind === 'gate-cant-run') {
    return [
      { do: stop.save ? 'save-again' : 'retry', name: 'Try again', note: 'squad-kit runs it once more. Use this after an engineer fixed it, or when it was a one-off.' },
      { do: 'engineer', name: 'Let an engineer look', note: 'The story waits here, and what it printed is in the details.' },
      ...(stop.auto ? [] : [{ do: (stop.save ? 'skip-hooks' : 'continue') as WayOut, name: 'Go on without this check', note: 'This once, on this story. Write why: it shows on the story, the pull request and the release notes.' }]),
    ];
  }
  // No tests: asked once per project. The Builder adds tests, go on without them, or check again once an engineer added some.
  if (stop.kind === 'no-tests') {
    return [
      ...(stop.test ? [{ do: 'add-test' as const, name: 'Have the Builder add tests', note: 'The Builder writes the tests, and the checks run again.' }] : []),
      { do: 'no-tests', name: 'Go on without tests', note: 'This ticket and later ones show "Not checked" instead of a pass. squad-kit asks once per project.' },
      { do: 'retry', name: 'Check again', note: 'After an engineer adds tests to the project.' },
    ];
  }
  // The project's own commit hook said no. Its words go to the Builder or an engineer; only the person can go past it.
  if (stop.kind === 'hook') {
    return [
      { do: 'retry', name: 'Let the Builder fix it', note: "It gets the check's words and fixes the code. Then the checks, the review and the proof run again. It cannot change the check itself: that stays with you or an engineer." },
      ...(stop.copy ? [{ do: 'yourself' as const, name: 'Fix it yourself', note: "Open the ticket's copy in your editor and fix it. Then the checks, review and proof run again." }] : []),
      { do: 'save-again', name: 'Try the save again', note: 'After an engineer fixed the check, or when it was a one-off.' },
      { do: 'skip-hooks', name: 'Save without this check', note: "Go on without the project's own check, this once. Write why: it shows on the ticket, the pull request and the release notes." },
      { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
    ];
  }
  if (stop.publish) {
    return [
      { do: 'retry', name: 'Try again', note: 'Push the branch and open the pull request again.' },
      // A pull request into the main repo is the only way out for it: it never merges here or goes out in a release.
      ...(stop.contribution ? [] : [{ do: 'skip-pr' as const, name: 'Skip the pull request', note: 'Release merges this branch directly instead.' }]),
    ];
  }
  const retry: StuckOption =
    stop.kind === 'weakened'
      ? { do: 'retry', name: 'Send it back to the Builder', note: 'It puts the tests back as they were, then the checks run again.' }
      : stop.gate === 'checks'
      ? { do: 'retry', name: 'Let the Builder try 3 more times', note: 'It gets the full error and tries again.' }
      : stop.gate === 'review'
        ? { do: 'retry', name: 'Let the Builder fix the notes', note: 'Then the Reviewer gets two more rounds.' }
        : stop.gate === 'proof' && stop.kind === 'broken'
          ? { do: 'retry', name: 'Let the Builder try again', note: 'It gets what the screenshots show. Then the checks, the review and the screenshots run again.' }
        : stop.gate === 'proof'
          ? { do: 'retry', name: 'Take the screenshots again', note: 'Only the proof runs again. Nothing is rebuilt. You can add a note for the Tester.' }
          : stop.gate === 'merge'
          ? { do: 'retry', name: `Let the Builder bring in the newest code`, note: 'It brings the newer work into this ticket and fixes the clash. Then the checks run again.' }
          : { do: 'retry', name: 'Try again', note: 'Run the same step again. You can add a note for the squad.' };
  const out: StuckOption[] = [retry];
  if (stop.copy && stop.gate !== 'proof') {
    out.push({
      do: 'yourself',
      name: stop.gate === 'merge' ? 'Fix the clash yourself' : 'Fix it yourself',
      note: 'Open the ticket\'s copy in your editor and fix it. Then the checks, review and proof run again.',
    });
  }
  if (stop.gate === 'checks' || stop.gate === 'review' || stop.gate === 'proof') {
    const what =
      stop.kind === 'weakened'
        ? 'with the tests as they are now; the checks still run'
        : stop.kind === 'bad-proof'
          ? 'with the screenshots as they are'
          : stop.kind === 'broken'
            ? 'with a "done when" not working yet'
          : stop.kind === 'not-shown'
            ? 'with a "done when" not shown yet'
          : { checks: 'with the checks failing', review: 'with the review notes open', proof: 'without screenshots' }[stop.gate];
    out.push({ do: 'continue', name: 'Continue anyway', note: `Go on ${what}. Write why: it shows on the ticket, the pull request and the release notes.` });
  }
  out.push({ do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' });
  return out;
}

/** The project's test command, in the settings of the ticket's repo (the first one, or the project's own). */
export function saveTestCommand(bp: BoardPaths, meta: BoardMeta, repoPath: string | undefined, command: string): void {
  const repo = meta.repos?.find((r) => r.path === repoPath) ?? meta.repos?.[0];
  writeMeta(bp, repo ? { ...meta, repos: meta.repos!.map((r) => (r === repo ? { ...r, commands: { ...r.commands, test: command } } : r)) } : { ...meta, commands: { ...(meta.commands ?? {}), test: command } });
}

/**
 * squad-kit settles a change to the test command itself by trying it (engine/test-change.ts). Only when it cannot tell
 * does the person choose, and an engineer can always choose from the terminal. Use saves the new one in the settings
 * of the ticket's repo, Keep drops it. Either way the checks from now on run the command chosen. The commands go to the
 * Developer tab and the log, not the activity.
 */
export function decideTestCommand(bp: BoardPaths, id: string, use: boolean): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.testChange;
    if (!c) throw new BoardActionError(`${t.id} has no change to the test command waiting.`);
    if (use) saveTestCommand(bp, meta, c.repo ?? t.repo, c.to);
    addActivity(t, 'you', use ? 'Chose the new way of testing this project' : 'Kept the current way of testing this project');
    writeLog({ level: 'info', project: meta.project, ticket: t.id, text: `The test command stays "${use ? c.to : c.from}", as the person chose (from "${c.from}", to "${c.to}")` });
    t.testDecided = { from: c.from, to: c.to, kept: use ? 'new' : 'current', by: 'you', ...(c.ran ? { ran: c.ran } : {}), at: now() };
    delete t.testChange;
  });
}

/** Older stuck cards have no `do` on their options: the first tried again, the second went to the plan or skipped the PR. */
function wayOf(t: Ticket, option: StuckOption, choice: number): WayOut {
  if (option.do) return option.do;
  if (choice === 0) return 'retry';
  return t.retryPhase === 'publish' ? 'skip-pr' : 'plan';
}

export function decideStuck(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string } = {}): Ticket {
  refuseWhileSaving(bp, id);
  return decideNow(bp, id, choice, input);
}

export function decideNow(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string }): Ticket {
  const meta = readMeta(bp);
  const before = requireTicket(bp, id);
  const save = before.waiting?.kind === 'stuck' ? before.stuck?.options[choice]?.do : undefined;
  if (save === 'save-again' || save === 'skip-hooks') return saveFromHookCard(bp, id, choice, save, input.reason);
  // The owner's notes, or a pull request the owner closed (engine/contribution).
  const owner = ownerWay(bp, id, save);
  if (owner) return owner;
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'stuck' || !t.stuck) throw new BoardActionError(`${t.id} is not stuck.`);
    const option = t.stuck.options[choice];
    if (!option) throw new BoardActionError(`Pick a choice between 1 and ${t.stuck.options.length}.`);
    const way = wayOf(t, option, choice);
    // Nothing moves: the card stays, for the engineer and for whoever decides after.
    if (way === 'engineer') {
      addActivity(t, 'you', 'Asked an engineer to look');
      t.status = 'Waiting for an engineer';
      t.waiting = { kind: 'stuck', summary: 'Waiting for an engineer to look at it' };
      return;
    }
    const gate = t.stuck.gate;
    const reason = input.reason?.trim();
    const note = input.note?.trim();
    const kind = t.stuck.kind;
    if (way === 'continue') {
      if (gate !== 'checks' && gate !== 'review' && gate !== 'proof') throw new BoardActionError('Only a failed check, review or proof can be continued past.');
      if (!reason) throw new BoardActionError('Write why you continue anyway. It shows on the ticket, the pull request and the release notes.');
    }
    if ((way === 'more' || way === 'stop') && gate !== 'cap') throw new BoardActionError('Only a step paused at its limit can be given more or stopped here.');
    if (way === 'yourself' && meta.engine === 'live' && !(t.worktree && fs.existsSync(t.worktree))) {
      throw new BoardActionError(`${t.id} has no copy of the code to fix. Try again or send it back to the plan.`);
    }
    t.stuck.options.forEach((o, i) => (o.chosen = i === choice));
    t.waiting = null;
    t.live = true;
    // Whatever comes next is a new run, with a clock of its own.
    delete t.clock;
    addActivity(t, 'you', `Decided: ${option.name}${way === 'continue' ? `. Why: ${reason}` : ''}`);
    if (note) {
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text: note }];
      addActivity(t, 'you', `Added a note: ${note}`);
      tellLater(t, meta.engine, { kind: 'note', text: note, noteKind: 'note' });
    }
    if (way === 'continue') {
      const weakened = kind === 'weakened' ? (t.stuck.points ?? []) : [];
      const named = kind === 'gate-cant-run' ? { added: (t.stuck.added ?? []).map((g) => g.name).join(', ') } : {};
      t.overrides = [...(t.overrides ?? []), { gate: gate as 'checks' | 'review' | 'proof', ...(weakened.length ? { weakened } : {}), ...named, reason: reason!, by: meta.user.name, at: now() }];
      t.gates = { ...(t.gates ?? { checks: 'pending', review: 'pending', proof: 'pending' }), [gate as string]: 'skipped' };
      if (kind === 'weakened') {
        // Remembered: only tests weakened again, in a new way, stop the ticket again.
        t.weakenedContinued = [...new Set([...(t.weakenedContinued ?? []), ...(t.stuck.checks ?? [])])];
      } else if (kind === 'gate-cant-run') {
        t.addedSkipped = [...new Set([...(t.addedSkipped ?? []), ...(t.stuck.checks ?? [])])];
      } else if (gate === 'checks') {
        // Remembered: a later round where only these checks fail again goes on, instead of stopping on them once more.
        // Cards from before this was kept name the failed checks only in the gate's line: "lint, test failed".
        const failed = t.stuck.checks ?? (t.gates.checksText?.replace(/ failed$/, '').split(', ').filter(Boolean) ?? []);
        t.checksContinued = [...new Set([...(t.checksContinued ?? []), ...failed])];
        t.tries = 0;
      }
      tellLater(t, meta.engine, { kind: 'note', text: `Continued anyway past ${kind === 'weakened' ? 'the weakened tests' : kind === 'gate-cant-run' ? 'a check that could not run' : `the failed ${gate}`}: ${reason}`, noteKind: 'note' });
    }
    // No tests: the person's answer is the project's, so later tickets never ask again.
    if (way === 'add-test') {
      const command = t.testSuggestion?.trim();
      if (!command) throw new BoardActionError(`${t.id} has no suggested test command. Add one in Settings, then press Check again.`);
      saveTestCommand(bp, meta, t.repo, command);
      t.testSuggestion = undefined;
      // The exact command is for engineers: here, and in the Developer tab once the checks ran it.
      writeLog({ level: 'info', project: meta.project, ticket: t.id, text: `Saved the test command "${command}"` });
      addActivity(t, 'squad', 'Found how to test this project');
    }
    if (way === 'no-tests') {
      writeMeta(bp, { ...meta, noTests: { by: meta.user.name, at: now(), ticket: t.id } });
      t.gates = { ...(t.gates ?? { checks: 'pending', review: 'pending', proof: 'pending' }), checks: 'unchecked' };
      addActivity(t, 'you', 'Going on without tests in this project: the checks show "Not checked" from now on');
    }
    if (meta.engine !== 'live') {
      t.status = 'Builder is trying your choice';
      scheduleSquad(t, 'unstick', 2, meta.speed);
      return;
    }
    const retryPhase = t.retryPhase;
    t.retryPhase = undefined;
    switch (way) {
      case 'skip-pr':
        t.live = false;
        t.status = `Ready for ${t.release ?? 'the next release'}`;
        return;
      case 'retry':
        t.tries = 0;
        if (gate === 'review') {
          t.reviewRound = 0;
          t.stage = 'implement';
          t.status = 'Builder is fixing the review notes';
          scheduleSquad(t, 'review-fix', 0.5, 1);
        } else if (kind === 'hook') {
          // The hook's own words go to the Builder. The first line names the step on the card.
          t.changeRequest = `Fix what the project's own check found\nsquad-kit tried to save this change and the project's own commit hook refused it. Fix what it says in the code. Do not change or remove the hook or its settings: squad-kit puts them back. If only a change to the hook itself could fix this, leave it and say so in your summary: that is for the person or an engineer to decide. Do not commit: squad-kit does the git. What the hook said:\n${t.stuck.detail ?? '(it said nothing)'}`;
          t.hookFixTried = true;
          t.stage = 'implement';
          t.status = "Builder is fixing what the project's own check found";
          t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
          scheduleSquad(t, 'fix', 0.5, 1);
        } else if (gate === 'merge') {
          // The person asked for this one: on a track that merges by itself the count starts over, with this try first.
          if (t.selfAccept?.baseTried) t.selfAccept.baseTries = 1;
          t.stage = 'implement';
          t.status = 'Builder is bringing in the latest changes';
          scheduleSquad(t, 'update-base', 0.5, 1);
        } else {
          // The screenshots still showed a "done when" not working: the Builder gets two more rounds.
          if (gate === 'proof') t.proofRound = undefined;
          t.status = 'Trying again';
          scheduleSquad(t, retryPhase ?? 'analyst-read', 0.5, 1);
        }
        return;
      case 'more':
        // The same step goes on in its own conversation, with twice the caps each time.
        t.capRaise = { role: t.capRaise?.role ?? '', step: t.capRaise?.step ?? '', times: (t.capRaise?.times ?? 0) + 1 };
        t.status = 'Carrying on with more room';
        scheduleSquad(t, retryPhase ?? 'analyst-read', 0.2, 1);
        return;
      case 'stop':
        // As if the person pressed Stop: the card says so and offers carrying on later, fixing it, or the plan.
        t.live = false;
        t.retryPhase = retryPhase;
        t.capRaise = undefined;
        t.status = 'Stopped, needs you';
        t.stuck = {
          question: 'You stopped the squad. Nothing was lost; the work so far is kept.',
          options: [
            { do: 'retry', name: 'Carry on', note: 'Run the stopped step again.' },
            ...wayOptions({ copy: Boolean(t.worktree && fs.existsSync(t.worktree)) && ['implement', 'test', 'review'].includes(t.stage) }).slice(1),
          ],
        };
        t.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
        return;
      case 'yourself':
        t.tries = 0;
        t.checksContinued = undefined;
        t.reviewRound = 0;
        t.reviewNotes = undefined;
        t.proof = undefined;
        t.mergedAt = undefined;
        t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
        t.stage = 'test';
        t.status = 'Running the project checks on your fix';
        addActivity(t, 'you', 'Fixed it myself in the ticket\'s copy');
        scheduleSquad(t, 'test', 0.2, 1);
        return;
      case 'add-test':
        t.tries = 0;
        t.stage = 'test';
        t.status = 'Running the project checks with the new test command';
        scheduleSquad(t, 'test', 0.2, 1);
        return;
      case 'no-tests':
        t.tries = 0;
        t.stage = 'review';
        t.status = 'Reviewer is reading the changes';
        scheduleSquad(t, 'review', 0.2, 1);
        return;
      case 'continue':
        if (kind === 'weakened' || kind === 'gate-cant-run') {
          // Past the weakened tests, the checks themselves still run.
          t.stage = 'test';
          t.status = 'Running the project checks';
          scheduleSquad(t, 'test', 0.2, 1);
        } else if (gate === 'checks') {
          t.stage = 'review';
          t.status = 'Reviewer is reading the changes';
          scheduleSquad(t, 'review', 0.2, 1);
        } else if (gate === 'proof') {
          // No screenshots, on the record: you still check the work and press Looks right. Rows with no after go.
          t.live = false;
          t.stage = 'review';
          t.status = 'Proof ready to check';
          if (t.proof) t.proof = t.proof.filter((p) => p.after);
          t.waiting = {
            kind: 'proof',
            summary:
              kind === 'bad-proof'
                ? 'Ready for you to check: the screenshots did not pass the check'
                : kind === 'broken'
                  ? 'Ready for you to check: a "done when" is not working yet'
                  : kind === 'not-shown'
                    ? 'Ready for you to check: a "done when" is not shown yet'
                    : 'Ready for you to check, without screenshots',
          };
        } else {
          t.reviewNotes = undefined;
          t.status = 'Recording the proof';
          scheduleSquad(t, 'proof', 0.2, 1);
        }
        return;
      case 'plan':
        t.changeRequest = `The squad got stuck: ${t.stuck.question}`;
        t.stage = 'specs';
        t.status = 'Spec writer is updating the plan';
        scheduleSquad(t, t.story ? 'plan-rewrite' : 'analyst-read', 0.5, 1);
        return;
    }
  });
}
