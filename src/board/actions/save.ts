import {
  addActivity,
  now,
  readMeta,
  requireTicket,
  updateTicket,
  writeRelease,
  listReleases,
  type BoardPaths,
} from '../store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Ticket } from '../types.js';
import { DOING } from '../../engine/plain-doing.js';
import { commitTicket, commitWithoutCheckLater } from '../../engine/release.js';
import {
  baseTurn,
  CommitStopped,
  GitStopped,
  HookRefused,
  addWorktree,
  git,
  pushedBranch,
  type HookRun,
} from '../../engine/git.js';
import { guardSupport, ticketGuard } from '../../engine/project-guard.js';
import { repoFor } from '../../engine/repos.js';
import { writeLog } from '../../core/app-log.js';
import { leaveProjectFiles, stageTicketDocs } from '../../engine/project-git.js';
import { refuseBeforeDependency } from '../depends.js';
import { copyViews } from '../../engine/copies.js';
import { noteGates, runGatesAt } from '../../engine/gate-run.js';
import { actionFailed, BoardActionError, tellLater } from './errors.js';
import { approve } from './approve.js';
import { acceptProof, repairCopy } from './accept.js';
import { openChange } from './change.js';
import { decideNow, decideStuck, gateCantRunCard, wayOptions } from './decide.js';
import { ensureDraftRelease } from './release.js';

/* ── The project's own commit hooks ──────────────────── */

/** The project's commit hook said no: the ticket has a stop card with ways out, and this says so. */
export class HookStopped extends BoardActionError {}

/**
 * Tickets from their Looks right until the merge is over, each with what ends its hook, and the commit each got: null when
 * it had nothing to save. Other buttons wait for that: what they asked for would not stop the merge.
 */
const savingNow = new Map<string, AbortController>();
const savedCommits = new Map<string, string | null>();
const saveKey = (bp: BoardPaths, id: string) => `${bp.squadDir}\0${id.toUpperCase()}`;

/** A ticket on its way in takes no other button. The person can look at it again once it is in. */
export function refuseWhileSaving(bp: BoardPaths, id: string): void {
  if (isSaving(bp, id)) throw new BoardActionError(`${id.toUpperCase()} is being saved, so this has to wait. Try again in a moment.`);
}

/** True while the ticket is on its way in, from its save until the merge is over: the board shows it as working. */
export function isSaving(bp: BoardPaths, id: string): boolean {
  return savingNow.has(saveKey(bp, id));
}

/** Holds a ticket from its save until the merge is over. A second press is refused. */
export async function holdingSave<T>(bp: BoardPaths, id: string, job: (closing: AbortController) => Promise<T>): Promise<T> {
  refuseWhileSaving(bp, id);
  const key = saveKey(bp, id);
  const closing = new AbortController();
  savingNow.set(key, closing);
  try {
    return await job(closing);
  } finally {
    savingNow.delete(key);
    // Saved for an accept that did not come: the next one saves for itself.
    for (const k of savedCommits.keys()) if (k === key || k.startsWith(`${key}\0`)) savedCommits.delete(k);
  }
}

/**
 * The accept itself, in the turn of each repo it moves, in one synchronous piece: `accept` reads the ticket once more, and
 * nothing can run between that look and the merge.
 */
export function acceptInTurn<T>(bp: BoardPaths, id: string, closing: AbortController, accept: () => T): Promise<T> {
  const meta = readMeta(bp);
  const dirs = copyViews(meta, requireTicket(bp, id)).map((view) => path.join(bp.root, repoFor(meta, view).path));
  return baseTurn(dirs, () => {
    if (closing.signal.aborted) throw new CommitStopped();
    return accept();
  });
}

const movedOn = (id: string) => new BoardActionError(`${id} changed while it was saved, so it did not go in. Its work is safe in its copy.`);

/** The hooks' say on this ticket, for the accept right after them. Undefined when they had none. */
export function takeSaved(bp: BoardPaths, id: string, repo?: string): string | null | undefined {
  const key = `${saveKey(bp, id)}${repo ? `\0${repo}` : ''}`;
  const commit = savedCommits.get(key);
  savedCommits.delete(key);
  return commit;
}

/** The board is closing, or the terminal command was stopped: a hook running on a save ends, and nothing is merged. */
export function endSaves(bp: BoardPaths): void {
  for (const [key, stop] of savingNow) if (key.startsWith(`${bp.squadDir}\0`)) stop.abort();
}

/** How the project's commit hooks run for a ticket: in the project's guard, where this computer has one. */
function hookRun(bp: BoardPaths, t: Ticket): HookRun {
  if (!t.worktree || !guardSupport().on) return {};
  const allow = readMeta(bp).guard;
  return { guard: ticketGuard(bp, { cwd: t.worktree, id: t.id, ...(allow ? { allow } : {}) }) };
}

/** The Builder went round once and it still says no: what is left is the person's or an engineer's. */
const HOOK_STILL_NO = " The Builder tried, and it still says no. If the check itself is what needs changing, that is for you or an engineer: change it in the ticket's copy, or save without it and say why.";

/** The stop for a hook that said no. Only the person can go past it, with a reason on the record. */
function hookStopped(bp: BoardPaths, id: string, err: HookRefused, byItself?: string, gate?: { id: string; name: string }): HookStopped {
  const words = gate ? `Your team's check "${gate.name}" runs on every save, and it said no. The change is not saved yet. It is safe in the ticket's copy.` : err.timedOut
    ? `This project has its own check that runs on every save. It did not finish in ${Math.round(err.limitMs / 60_000)} minutes, so the change is not saved yet. It is safe in the ticket's copy.`
    : "This project has its own check that runs on every save, and it said no. The change is not saved yet. It is safe in the ticket's copy.";
  const plain = `${words}${requireTicket(bp, id).hookFixTried ? HOOK_STILL_NO : ''}`;
  writeLog({ level: 'warn', project: readMeta(bp).project, ticket: id, text: `${plain} ${err.said}` });
  updateTicket(bp, id, (t) => {
    t.waiting = { kind: 'stuck', summary: "The project's own check said no and needs one decision" };
    t.live = false;
    t.squad = null;
    t.status = "Stopped: the project's own check said no";
    t.stuck = { kind: 'hook', ...(gate ? { added: [gate] } : {}), question: plain, ...(err.said ? { detail: `${gate ? gate.name : 'A commit hook'} said no:\n${err.said}` } : {}), options: wayOptions({ kind: 'hook', copy: Boolean(t.worktree && fs.existsSync(t.worktree)) }) };
    if (byItself) addActivity(t, 'squad', `Not accepted by itself: the project's own check said no`);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    addActivity(t, 'release', "The project's own check said no, so the change is not saved yet");
  });
  return new HookStopped(`${plain} See the ways out on the ticket.`);
}

/**
 * Work the hooks still owe a look (hookOwed) with no copy of the code left: they would have nothing to look at, and the
 * branch would merge unseen. The copy is made again from the branch; with no branch either, it is a stop card.
 */
async function copyForTheHooks(bp: BoardPaths, ticket: Ticket, signal: AbortSignal): Promise<Ticket> {
  if (!ticket.hookOwed || (ticket.worktree && fs.existsSync(ticket.worktree))) return ticket;
  const repo = repoFor(readMeta(bp), ticket);
  const root = path.join(bp.root, repo.path);
  const branch = ticket.branch ?? `squad/${ticket.id.toLowerCase()}`;
  if (!git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true }) && !pushedBranch(root, branch)) {
    throw new HookRefused("The ticket's copy of the code and its branch are gone, so the project's own check has nothing to look at.", false, 0);
  }
  const wt = await addWorktree(root, ticket.id, repo.base, undefined, undefined, { signal, making: () => updateTicket(bp, ticket.id, (t) => (t.status = DOING.copy)) });
  return updateTicket(bp, ticket.id, (t) => {
    t.worktree = wt.dir;
    t.branch = wt.branch;
    addActivity(t, 'squad', "This ticket's copy of the code was gone, so squad-kit made it again for the project's own check");
  });
}

/** The team's gates before a save, in the copy about to be saved. Failing takes the road of a refused hook, the same card. */
async function gatesBeforeSave(bp: BoardPaths, ticket: Ticket, copy: Ticket, label: string | undefined, byItself: string | undefined, signal: AbortSignal): Promise<void> {
  const meta = readMeta(bp);
  const place = { dir: copy.worktree!, repo: repoFor(meta, copy).path, ...(label ? { label } : {}) };
  const done = await runGatesAt(bp, 'merge', [place], requireTicket(bp, ticket.id).addedSkipped ?? [], (dir) => ({ signal, ...hookRun(bp, { ...copy, worktree: dir }) }));
  if (signal.aborted) throw new CommitStopped();
  if (!done.length) return;
  updateTicket(bp, ticket.id, (x) => noteGates(x, done, (text) => addActivity(x, 'release', text)));
  const failed = done.find((d) => d.stops && d.result === 'failed');
  if (failed) throw hookStopped(bp, ticket.id, new HookRefused(failed.output, false, 0), byItself, { id: failed.id, name: failed.name });
  const cant = done.filter((d) => d.stops && d.result === 'cant-run');
  if (!cant.length) return;
  const words = gateCantRunCard(cant, { auto: ticket.track === 'auto', save: true });
  updateTicket(bp, ticket.id, (t) => {
    t.waiting = { kind: 'stuck', summary: 'A check of your team could not run and needs one decision' };
    t.live = false;
    t.squad = null;
    t.status = 'Stopped: a check could not run';
    t.stuck = words;
    for (const c of cant) addActivity(t, 'release', `"${c.name}" could not run: ${c.why} Not a failed try`);
  });
  throw new HookStopped(`${words.question} See the ways out on the ticket.`);
}

/** Saves the accepted change with the hooks running beside everything else, so a slow hook never holds up the board. */
async function saveBeside(bp: BoardPaths, ticket: Ticket, closing: AbortController, byItself?: string, signal?: AbortSignal): Promise<void> {
  const key = saveKey(bp, ticket.id);
  const stop = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
  try {
    const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
    const views = copyViews(readMeta(bp), ticket);
    // Every copy is saved, with the project's own check on each, before anything goes in.
    for (const view of views) {
      const copy = views.length === 1 ? await copyForTheHooks(bp, view, stop) : view;
      repairCopy(bp, copy);
      await gatesBeforeSave(bp, ticket, copy, views.length > 1 ? copy.repo : undefined, byItself, stop);
      leaveProjectFiles(bp, copy, repoFor(readMeta(bp), copy).base);
      stageTicketDocs(bp, { ...copy, stage: 'release', release: release.version, waiting: null, hookOwed: undefined });
      const saved = await commitTicket(copy, { ...hookRun(bp, copy), signal: stop });
      // What the hooks left, saved now too, so the accept that comes next has no save of its own to do on the board's time.
      savedCommits.set(views.length === 1 ? key : `${key}\0${view.repo}`, (await commitWithoutCheckLater(copy)) ?? saved);
    }
    if (ticket.hookOwed) updateTicket(bp, ticket.id, (t) => delete t.hookOwed);
  } catch (err) {
    // A merge was finished before the hooks looked at it: no later save would show it to them.
    if ((err instanceof CommitStopped || err instanceof HookRefused) && err.owed) updateTicket(bp, ticket.id, (t) => (t.hookOwed = true));
    if (err instanceof CommitStopped || err instanceof HookStopped) throw err;
    if (err instanceof GitStopped) throw new CommitStopped();
    if (err instanceof HookRefused) throw hookStopped(bp, ticket.id, err, byItself);
    throw actionFailed(bp, ticket.id, `squad-kit could not save the change. It is safe in the ticket's copy, and an engineer can see why in squad-kit's log. ${byItself ? 'Press Try again.' : 'Press Looks right to try again.'}`, err);
  }
}

/** What acceptProof saves when the person went past the project's own check, beside everything else. */
async function saveNoHooksBeside(bp: BoardPaths, ticket: Ticket): Promise<void> {
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  const views = copyViews(readMeta(bp), ticket);
  try {
    for (const view of views) {
      repairCopy(bp, view);
      leaveProjectFiles(bp, view, repoFor(readMeta(bp), view).base);
      stageTicketDocs(bp, { ...view, stage: 'release', release: release.version, waiting: null, hookOwed: undefined });
      savedCommits.set(views.length === 1 ? saveKey(bp, ticket.id) : `${saveKey(bp, ticket.id)}\0${view.repo}`, await commitWithoutCheckLater(view));
    }
  } catch (err) {
    throw actionFailed(bp, ticket.id, 'squad-kit could not save the change, so the proof stays as it is. Press Looks right to try again.', err);
  }
}

/** Looks right from the board or the squad: `approve`, with the project's hooks running beside everything else. */
export async function approveBeside(bp: BoardPaths, id: string): Promise<Ticket> {
  const ticket = requireTicket(bp, id);
  if (ticket.waiting?.kind !== 'proof' || readMeta(bp).engine !== 'live' || openChange(ticket)) return approve(bp, id);
  refuseBeforeDependency(bp, ticket);
  return holdingSave(bp, ticket.id, async (closing) => {
    await saveBeside(bp, ticket, closing);
    return acceptInTurn(bp, ticket.id, closing, () => {
      const now = requireTicket(bp, id);
      if (now.waiting?.kind !== 'proof' || now.deleting || now.takenOver || now.stopRequested) throw movedOn(now.id);
      return approve(bp, id);
    });
  });
}

/** `decideStuck`, with "Try the save again" running the project's hooks beside everything else. */
export async function decideStuckBeside(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string } = {}): Promise<Ticket> {
  const ticket = requireTicket(bp, id);
  const stuck = ticket.waiting?.kind === 'stuck' ? ticket.stuck : undefined;
  const way = stuck?.options[choice]?.do;
  const why = input.reason?.trim();
  const added = way === 'skip-hooks' && Boolean(stuck?.added?.length);
  if (added && !why) throw new BoardActionError('Write why you go on without this check. It shows on the story, the pull request and the release notes.');
  if (way !== 'save-again' && !(way === 'skip-hooks' && why)) return decideStuck(bp, id, choice, input);
  return holdingSave(bp, ticket.id, async (closing) => {
    if (way === 'save-again') await saveBeside(bp, ticket, closing);
    // Past a gate of the team's: the project's own hooks still get their say, on the save that follows.
    else if (added) {
      const by = readMeta(bp).user.name;
      updateTicket(bp, id, (t) => {
        t.overrides = [...(t.overrides ?? []), ...stuck!.added!.map((g) => ({ gate: 'hooks' as const, added: g.name, reason: why!, by, at: now() }))];
        t.addedSkipped = [...new Set([...(t.addedSkipped ?? []), ...stuck!.added!.map((g) => g.id)])];
        tellLater(t, readMeta(bp).engine, { kind: 'note', text: `Saved without your team's check: ${why}`, noteKind: 'note' });
      });
      await saveBeside(bp, requireTicket(bp, id), closing);
    }
    // Past the project's own check, with a reason on the record: the same save with no hooks, then the card's way out.
    else await saveNoHooksBeside(bp, ticket);
    return acceptInTurn(bp, ticket.id, closing, () => {
      const t = requireTicket(bp, id);
      if (t.waiting?.kind !== 'stuck' || t.deleting || t.takenOver) throw movedOn(t.id);
      return decideNow(bp, id, choice, input);
    });
  });
}

/**
 * The Builds by itself step: its commit, with the hooks beside everything else, before the accept. A refusal leaves its
 * card. The step's Stop ends a hook that is running (CommitStopped goes on up, to the step's own Stop handling).
 */
export async function saveBeforeAccept(bp: BoardPaths, id: string, closing: AbortController, signal?: AbortSignal): Promise<boolean> {
  const ticket = requireTicket(bp, id);
  try {
    await saveBeside(bp, ticket, closing, 'the squad', signal);
    return true;
  } catch (err) {
    if (err instanceof HookStopped) return false;
    throw err;
  }
}

/** The way out of a hook card that saves: back to the proof, with the hooks on, or off with a reason on the record. */
export function saveFromHookCard(bp: BoardPaths, id: string, choice: number, way: 'save-again' | 'skip-hooks', reason?: string): Ticket {
  const meta = readMeta(bp);
  const noHooks = way === 'skip-hooks' && !requireTicket(bp, id).stuck?.added?.length;
  const why = reason?.trim();
  if (way === 'skip-hooks' && !why) throw new BoardActionError('Write why you save it without the check. It shows on the ticket, the pull request and the release notes.');
  const ticket = updateTicket(bp, id, (t) => {
    const option = t.stuck!.options[choice]!;
    t.stuck!.options.forEach((o, i) => (o.chosen = i === choice));
    addActivity(t, 'you', `Decided: ${option.name}${why ? `. Why: ${why}` : ''}`);
    if (way === 'skip-hooks' && !t.stuck!.added?.length) {
      t.overrides = [...(t.overrides ?? []), { gate: 'hooks', reason: why!, by: meta.user.name, at: now() }];
      delete t.hookOwed;
      tellLater(t, meta.engine, { kind: 'note', text: `Saved without the project's own check: ${why}`, noteKind: 'note' });
    }
    t.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    t.status = 'Proof ready to check';
  });
  return acceptProof(bp, ticket, undefined, { noHooks });
}

/** The accepted branch clashes with the base: not a dead end, a stuck card with ways out. */
export function clashed(bp: BoardPaths, id: string, commit: string | null, error: string, byItself?: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    clashCard(t, base, `The change is saved, but it cannot go into ${base} yet: newer work changed the same lines.`, error);
    if (byItself) addActivity(t, 'squad', byItself);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', 'Saved the change');
    // git's own words are for the activity and the engineer details, never the sentence above.
    addActivity(t, 'release', `Could not merge into ${base}: ${error}`);
  });
}

function clashCard(t: Ticket, base: string, question: string, detail?: string): void {
  t.waiting = { kind: 'stuck', summary: `Clashes with ${base} and needs one decision` };
  t.live = false;
  t.squad = null;
  t.status = `Clashes with ${base}`;
  t.retryPhase = 'update-base';
  t.stuck = { gate: 'merge', question, ...(detail ? { detail } : {}), options: wayOptions({ gate: 'merge', base, copy: Boolean(t.worktree && fs.existsSync(t.worktree)) }) };
}

/**
 * The code host cannot merge the ticket's pull request: newer changes in the base clash with it. Instead of waiting there and
 * stopping the release, the ticket leaves the draft release with the clash card; accepting it again updates the same
 * pull request.
 */
export function pullRequestClashed(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    // With no pull request (a merge tried again here), the change itself.
    const what = t.pr ? `Pull request ${t.pr.id}` : 'The change';
    clashCard(t, base, `${what} cannot go into ${base} yet: newer work changed the same lines.`);
    t.stage = 'review';
    // Found again by its branch when the ticket is accepted the next time. Kept meanwhile: a person may settle the
    // clash on the code host and merge it there (engine/merged-outside.ts).
    if (t.pr) t.clashedPr = t.pr;
    t.pr = undefined;
    t.release = undefined;
    addActivity(t, 'release', `${what} clashes with newer changes in ${base}, so it left ${draft?.version ?? 'the release'}`);
  });
}
