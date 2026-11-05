import fs from 'node:fs';
import { addActivity, listTickets, now, readMeta, readTicket, updateTicket, type BoardPaths } from './store.js';
import type { DependencyChoice, Ticket } from './types.js';
import { BoardActionError } from './actions.js';
import { scheduleSquad } from './schedule.js';
import { repoFor } from '../engine/repos.js';

/**
 * Tickets that depend on unmerged work (E5). The design can name the open tickets a ticket needs ("depends on
 * RO-1"). While one of them is not merged, the ticket waits before its build with a card and three ways out: build on
 * that ticket's branch, build anyway from the base, or wait until it is merged. Every way is one call here, the same
 * for the board and the terminal.
 */

/** Merged into the base, or released: its code is in what new copies start from. */
export function isMerged(t: Ticket): boolean {
  return Boolean(t.mergedAt) || t.stage === 'done';
}

/** The open tickets on the board other than `self`: not merged, not archived, not being deleted. */
export function openOnBoard(bp: BoardPaths, self?: string): Ticket[] {
  return listTickets(bp).filter((t) => t.id !== self && !isMerged(t) && !t.archived && !t.deleting);
}

/** The tickets `t` depends on that are still on the board and not merged. One that left the board holds nothing up. */
export function unmergedDeps(bp: BoardPaths, t: Ticket): Ticket[] {
  return (t.dependsOn ?? []).map((id) => readTicket(bp, id)).filter((d): d is Ticket => Boolean(d && !isMerged(d) && !d.deleting));
}

/** True when every one of these tickets is merged, or no longer on the board. */
export function depsReady(bp: BoardPaths, ids: string[]): boolean {
  return ids.every((id) => {
    const d = readTicket(bp, id);
    return !d || d.deleting || isMerged(d);
  });
}

function names(deps: (Ticket | string)[]): string {
  return deps.map((d) => (typeof d === 'string' ? d : d.id)).join(' and ');
}

/** The card's line: "RO-2 needs RO-1, which is not merged yet". */
export function dependsLine(t: Ticket, deps: Ticket[]): string {
  return `${t.id} needs ${names(deps)}, which ${deps.length === 1 ? 'is' : 'are'} not merged yet`;
}

function waitLine(deps: (Ticket | string)[]): string {
  return `Waits for ${names(deps)} to merge · starts by itself`;
}

/** A dependency whose work a copy can start from: it has a copy of the code, or a branch. */
export function hasCode(d: Ticket): boolean {
  return Boolean(d.worktree || d.branch);
}

/** True when `from` depends on `to`, directly or through other tickets. */
function reaches(bp: BoardPaths, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (readTicket(bp, from)?.dependsOn ?? []).some((x) => reaches(bp, x, to, seen));
}

/**
 * What the design names, kept as the ticket's "depends on": other tickets on the board, never itself, and none that
 * already depends on it (that would wait forever).
 */
export function designDepends(bp: BoardPaths, t: Ticket, named: string[] | undefined): string[] | undefined {
  const ids = [...new Set((named ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean))].filter((id) => id !== t.id && readTicket(bp, id) && !reaches(bp, id, t.id));
  return ids.length ? ids : undefined;
}

/**
 * Before the build starts: a ticket with a dependency that is not merged, and no way chosen for it yet, waits for the
 * person with the card. One whose person chose to wait keeps waiting, with no card. Changes `t` in place (inside an
 * update); true when it waits.
 */
export function holdForDependency(bp: BoardPaths, t: Ticket): boolean {
  const deps = unmergedDeps(bp, t);
  if (!deps.length) return false;
  const c = t.dependency;
  const covered = Boolean(c && deps.every((d) => c.on.includes(d.id)));
  if (covered && c!.way !== 'wait') return false;
  t.live = false;
  t.squad = null;
  if (covered) {
    t.waiting = null;
    t.status = waitLine(deps);
    return true;
  }
  const line = dependsLine(t, deps);
  // Builds by itself never asks how to build around it: it waits, and starts by itself once that ticket merges.
  if (t.track === 'auto') {
    t.dependency = { on: deps.map((d) => d.id), way: 'wait', by: 'the squad', at: now() };
    t.waiting = null;
    t.status = waitLine(deps);
    addActivity(t, 'squad', `${line}. Builds by itself: it waits, and the build starts by itself once ${deps.length === 1 ? 'it merges' : 'they merge'}`);
    return true;
  }
  t.waiting = { kind: 'depends', summary: line };
  t.status = line;
  addActivity(t, 'squad', `${line}, so the build waits for you to choose how to build`);
  return true;
}

/** The live squad, as a build starts: a ticket with no copy of the code yet waits for its dependency. */
export function holdBuild(bp: BoardPaths, id: string): boolean {
  const t = readTicket(bp, id);
  if (!t || (t.worktree && fs.existsSync(t.worktree)) || !unmergedDeps(bp, t).length) return false;
  let held = false;
  updateTicket(bp, id, (x) => {
    held = holdForDependency(bp, x);
  });
  return held;
}

/** Waiting for a dependency, either on the card or because the person chose to wait. */
export function waitsForDependency(t: Ticket): boolean {
  return t.waiting?.kind === 'depends' || (t.dependency?.way === 'wait' && !t.dependency.started && !t.squad && !t.waiting);
}

const WAY_TEXT: Record<DependencyChoice['way'], (on: string, base: string) => string> = {
  branch: (on) => `Chose to build on ${on}'s branch: its work so far comes into this ticket's copy`,
  anyway: (on, base) => `Chose to build anyway, from ${base} without ${on}. It stays on the ticket's record`,
  wait: (on) => `Chose to wait for ${on}: the build starts by itself once it is merged`,
};

/**
 * One of the ways out of the card: "Build on RO-1's branch", "Build anyway" (from the base, on the record) or "Wait"
 * (starts by itself when RO-1 merges). A ticket that waits can still pick one of the other two.
 */
export function chooseBuild(bp: BoardPaths, id: string, way: DependencyChoice['way']): Ticket {
  if (!WAY_TEXT[way]) throw new BoardActionError('Pick how to build: on its branch, anyway, or wait.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    // Its copy could not start from the other ticket's branch (no code there after all): another way is open too.
    const failed = t.waiting?.kind === 'stuck' && Boolean(t.dependency) && !(t.worktree && fs.existsSync(t.worktree));
    if (!waitsForDependency(t) && !failed) throw new BoardActionError(`${t.id} is not waiting for a ticket it depends on.`);
    if (failed) {
      t.stuck = undefined;
      t.retryPhase = undefined;
    }
    const base = repoFor(meta, t).base;
    const deps = unmergedDeps(bp, t);
    if (!deps.length) {
      // Merged meanwhile: nothing to choose, it builds on the base, which has it now.
      t.waiting = null;
      t.dependency = t.dependency ? { ...t.dependency, started: now() } : undefined;
      startBuild(t, `Building on the latest ${base}`, meta.speed);
      addActivity(t, 'squad', `What it needs is merged now, so it builds on the latest ${base}`);
      return;
    }
    if (way === 'branch') {
      if (deps.length > 1) throw new BoardActionError(`${t.id} needs ${names(deps)}. A copy can start from one branch only: build anyway, or wait for them.`);
      const d = deps[0]!;
      if (meta.engine === 'live' && !hasCode(d)) throw new BoardActionError(`${d.id} has no code yet to build on. Wait for it, or build anyway.`);
      if (repoFor(meta, d).path !== repoFor(meta, t).path) throw new BoardActionError(`${d.id} changes another repo, so ${t.id} cannot start from its branch. Build anyway, or wait for it.`);
    }
    const on = names(deps);
    t.dependency = { on: deps.map((d) => d.id), way, by: meta.user.name, at: now() };
    t.waiting = null;
    addActivity(t, 'you', WAY_TEXT[way](on, base));
    if (way === 'wait') {
      t.live = false;
      t.squad = null;
      t.status = waitLine(deps);
      return;
    }
    startBuild(t, way === 'branch' ? `Building on ${on}'s branch` : `Building without ${on}`, meta.speed);
  });
}

function startBuild(t: Ticket, status: string, speed: number): void {
  t.stage = 'implement';
  t.live = true;
  t.status = status;
  scheduleSquad(t, 'build', 1, speed, 0);
}

/**
 * "Wait" ends once what the ticket waits for is merged (or left the board): its build starts by itself, from the
 * base that has it now. Both squads ask on every turn; true when this ticket starts now.
 */
export function wakeIfReady(bp: BoardPaths, t: Ticket): boolean {
  const c = t.dependency;
  if (c?.way !== 'wait' || c.started || t.squad || t.waiting || t.deleting || !depsReady(bp, c.on)) return false;
  const meta = readMeta(bp);
  const base = repoFor(meta, t).base;
  const gone = c.on.filter((id) => !readTicket(bp, id));
  updateTicket(bp, t.id, (x) => {
    x.dependency = { ...c, started: now() };
    startBuild(x, `${names(c.on)} merged · building now`, meta.speed);
    addActivity(x, 'squad', gone.length ? `${names(gone)} left the board, so the build starts now, on the latest ${base}` : `${names(c.on)} ${c.on.length === 1 ? 'is' : 'are'} merged, so the build starts now, on the latest ${base}`);
  });
  return true;
}

/**
 * `squad depends RO-2 --on RO-1`: name what a ticket depends on yourself, or nothing (`--none`). A ticket about to be
 * built waits for an unmerged one; one that waited for a ticket no longer named carries on.
 */
export function setDependsOn(bp: BoardPaths, id: string, on: string[]): Ticket {
  const ids = [...new Set(on.map((x) => x.trim().toUpperCase()).filter(Boolean))];
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (isMerged(t)) throw new BoardActionError(`${t.id} is merged already, so nothing holds it up.`);
    for (const d of ids) {
      if (d === t.id) throw new BoardActionError('A ticket cannot depend on itself.');
      if (!readTicket(bp, d)) throw new BoardActionError(`${d} is not on the board.`);
      if (reaches(bp, d, t.id)) throw new BoardActionError(`${d} depends on ${t.id} already, so ${t.id} cannot depend on it: they would wait for each other.`);
    }
    t.dependsOn = ids.length ? ids : undefined;
    addActivity(t, 'you', ids.length ? `Set what it depends on: ${names(ids)}` : 'Said it depends on no other ticket');
    // Waiting, or about to be built: it waits again, or carries on, by what it depends on now.
    const before = t.squad?.phase === 'build' && !(t.worktree && fs.existsSync(t.worktree));
    if (waitsForDependency(t) || before) {
      if (!holdForDependency(bp, t) && !before) {
        t.waiting = null;
        startBuild(t, `Building on the latest ${repoFor(meta, t).base}`, meta.speed);
      }
    }
  });
}

/**
 * Looks right on a ticket built on another's branch: it carries that ticket's work, so it goes into the base only
 * after that ticket. Throws with what to do instead.
 */
export function refuseBeforeDependency(bp: BoardPaths, t: Ticket): void {
  if (t.dependency?.way !== 'branch') return;
  const waiting = t.dependency.on.map((x) => readTicket(bp, x)).filter((d): d is Ticket => Boolean(d && !isMerged(d) && !d.deleting));
  if (!waiting.length) return;
  const base = repoFor(readMeta(bp), t).base;
  throw new BoardActionError(
    `${t.id} is built on ${names(waiting)}'s branch, so it carries ${waiting.length === 1 ? 'its' : 'their'} work too. Accept ${names(waiting)} first: then ${t.id} brings in the latest ${base} and goes in after it.`,
  );
}

/**
 * "Bring in latest main" on a ticket being built. Nothing runs: the base comes into its copy now, and the checks,
 * review and proof run again. A step runs: the base comes in when that step ends, before the next checks.
 */
export function bringInLatest(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    if (isMerged(t) || t.stage === 'release') throw new BoardActionError(`${t.id} is accepted already: it goes into ${base} as it is.`);
    const copy = meta.engine !== 'live' || Boolean(t.worktree && fs.existsSync(t.worktree));
    if (!['implement', 'test', 'review'].includes(t.stage) || !copy) throw new BoardActionError(`${t.id} is not being built yet. Its copy starts from the latest ${base} when the build starts.`);
    if (t.takenOver) throw new BoardActionError(`You have ${t.id}. Give it back first.`);
    if (t.chat?.open && !t.chat.beside) throw new BoardActionError(`${t.id} has a chat open. Finish it first.`);
    if (t.waiting && t.waiting.kind !== 'proof' && t.waiting.kind !== 'stuck') throw new BoardActionError(`${t.id} waits for you: ${t.waiting.summary}. Do that first.`);
    if (meta.engine !== 'live') {
      addActivity(t, 'you', `Brought in the latest ${base}. The sample board has no code, so nothing changed`);
      return;
    }
    if (!t.waiting && (t.live || t.squad)) {
      t.baseWanted = { by: meta.user.name, at: now() };
      addActivity(t, 'you', `Asked to bring in the latest ${base}: it comes in when the running step ends, before the checks`);
      return;
    }
    t.waiting = null;
    t.stuck = undefined;
    t.retryPhase = undefined;
    t.stage = 'implement';
    t.live = true;
    t.status = `Bringing in the latest ${base}`;
    addActivity(t, 'you', `Asked to bring in the latest ${base}`);
    scheduleSquad(t, 'update-base', 0.2, 1);
  });
}
