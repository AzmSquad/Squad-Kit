import { now, readMeta, readTicket, updateTicket, type BoardPaths } from './store.js';
import { BoardActionError } from './actions.js';
import type { BoardMeta, Payment, Ticket } from './types.js';
import type { Breakdown, BreakdownState, BreakdownStory } from './requirements-types.js';
import {
  addBreakdownActivity,
  allStories,
  isBreakdownMine,
  listBreakdowns,
  ownerOfBreakdown,
  readBreakdownState,
  redoHolding,
  requireBreakdown,
  updateBreakdownState,
  type StoryPlace,
} from './requirements.js';
import { startStory } from './requirements-actions.js';
import { isMerged } from './depends.js';
import { mergeWait, stopOf } from './auto.js';
import { isMine } from './owner.js';
import { budgetState } from './budget.js';
import { monthKey } from './usage.js';
import { parallelLimit } from '../core/settings.js';
import { limitText, type LimitPause } from '../engine/usage-limit.js';

/**
 * Build continuously: the squad starts the next stories of an approved breakdown by itself, in the tree's order, as
 * soon as everything a story needs is merged and a place is free. A place is the parallel limit, shared with every
 * ticket of every project: this breakdown's stories that are working (started, not merged, not waiting for the
 * person) stay under it, and the squad's own limit must have room. A story that waits for the person frees its place,
 * so the others carry on; the stories that need it wait. The month's budget and the AI account's usage limit hold the
 * queue with a reason, never as a failure. The switch lives in this computer's part of the breakdown, so a restart
 * carries on; Pause stops new starts only. Both squads run the same queue.
 */

function who(bp: BoardPaths): string {
  return readMeta(bp).user.name;
}

function and(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The live tickets of the stories, by story key. A ticket deleted since is no ticket: the story can start again. */
function ticketsOf(bp: BoardPaths, stories: StoryPlace[]): Map<string, Ticket> {
  const out = new Map<string, Ticket>();
  for (const { story } of stories) {
    const t = story.ticket ? readTicket(bp, story.ticket) : null;
    if (t && !t.deleting) out.set(story.key, t);
  }
  return out;
}

/**
 * Started, not merged, not waiting for the person: it holds one of the breakdown's places. A change accepted and
 * waiting to merge (a pull request's approver, the person's checkout) holds none: nothing runs for it.
 */
function working(t: Ticket | undefined): boolean {
  return Boolean(t && !isMerged(t) && !t.waiting && !t.archived && !mergeWait(t));
}

/* ── The switch ─────────────────────────────────────────── */

/**
 * Build continuously on, or Pause. Only the owner's squad builds a breakdown, and only once it is approved. Pressed
 * again while the queue is held at this month's budget (or after pausing there), it goes on for the rest of the month.
 */
export function setBuild(bp: BoardPaths, id: string, on: boolean): Breakdown {
  const b = requireBreakdown(bp, id);
  if (!isBreakdownMine(b, readMeta(bp))) throw new BoardActionError(`${b.id} is ${ownerOfBreakdown(b)}'s. Only their squad builds it.`);
  const was = readBreakdownState(bp, b.id).build;
  const by = who(bp);
  if (!on) {
    if (!was?.on) return b;
    updateBreakdownState(bp, b.id, (s) => {
      // Held at the budget when paused: pressing Build continuously again goes on past it.
      s.build = { on: false, by, at: now(), ...(was.heldFor === 'budget' ? { heldFor: 'budget' as const } : {}), ...(was.budgetOk ? { budgetOk: was.budgetOk } : {}) };
      addBreakdownActivity(s, 'you', 'Paused Build continuously. The stories building now carry on; no new one starts');
    });
    return b;
  }
  if (b.status !== 'approved' || !b.approved) throw new BoardActionError(`Approve ${b.id} first. Nothing is built before the breakdown is approved.`);
  const stories = allStories(b);
  const tickets = ticketsOf(bp, stories);
  if (stories.every(({ story }) => tickets.get(story.key) && isMerged(tickets.get(story.key)!))) throw new BoardActionError(`Every story of ${b.id} is merged. Nothing is left to build.`);
  const atBudget = was?.heldFor === 'budget';
  if (was?.on && !atBudget) return b;
  const month = monthKey();
  updateBreakdownState(bp, b.id, (s) => {
    s.build = { on: true, by, at: was?.on ? was.at : now(), ...(atBudget ? { budgetOk: month } : was?.budgetOk === month ? { budgetOk: month } : {}) };
    if (atBudget) addBreakdownActivity(s, 'you', "Let it go on past this month's budget");
    else addBreakdownActivity(s, 'you', `Turned on Build continuously, ${parallelLimit(readMeta(bp).parallel)} at a time`);
  });
  return b;
}

/* ── The queue ──────────────────────────────────────────── */

/** What the squad running the queue offers it. */
export interface QueueRoom {
  /** Free places in the squad's own limit for a new ticket, across every project. */
  free(): number;
  /** The AI account's usage limit, while it holds every new start. */
  pause: LimitPause | null;
  /** How the person pays: asked only when this month's budget is used up. */
  payment(): Promise<Payment>;
}

/** What one turn of the queue did to one breakdown. */
export interface QueueTurn {
  id: string;
  started: string[];
  held?: string;
  /** Every story is merged: Build continuously turned off. */
  done?: boolean;
}

/**
 * The live squad's free places for a story the queue starts: the app's one limit, less the tickets running in other
 * projects and this project's own tickets on the go (running, or due to run and not waiting for the person). Another
 * project waiting for a place gets it first.
 */
export function placesLeft(limit: number, tickets: Ticket[], meta: Pick<BoardMeta, 'user'>, othersRunning: number, othersWaiting: boolean): number {
  if (othersWaiting) return 0;
  const going = tickets.filter((t) => t.squad && !t.waiting && !t.deleting && !t.archived && isMine(t, meta)).length;
  return limit - othersRunning - going;
}

/** The breakdowns whose queue this computer's squad runs: mine, approved, with Build continuously on. */
export function buildingBreakdowns(bp: BoardPaths, meta: Pick<BoardMeta, 'user'> = readMeta(bp)): Breakdown[] {
  return listBreakdowns(bp).filter((b) => b.status === 'approved' && isBreakdownMine(b, meta) && readBreakdownState(bp, b.id).build?.on);
}

/** One turn of the queue for every breakdown building now. Both squads call it on their timer. */
export async function fillBuildQueue(bp: BoardPaths, room: QueueRoom): Promise<QueueTurn[]> {
  const meta = readMeta(bp);
  const turns: QueueTurn[] = [];
  for (const b of buildingBreakdowns(bp, meta)) turns.push(await queueTurn(bp, b, meta, room));
  return turns;
}

/** Why nothing more can start now, when what is left waits on other stories (or on a "done when" still missing). */
function waitsWords(stories: StoryPlace[], tickets: Map<string, Ticket>): string {
  const merged = (k: string) => Boolean(tickets.get(k) && isMerged(tickets.get(k)!));
  const left = stories.filter(({ story }) => !tickets.has(story.key));
  /** What the started stories among `keys` wait on: the person, a pull request's approver, the person's checkout. */
  const youWords = (keys: string[]) => {
    const you = keys.filter((k) => tickets.get(k)?.waiting);
    const pr = keys.filter((k) => mergeWait(tickets.get(k)) === 'pr');
    const copy = keys.filter((k) => mergeWait(tickets.get(k)) === 'checkout');
    const one = (xs: string[], a: string, many: string) => (xs.length === 1 ? a : many);
    return [
      you.length ? ` ${and(you)} ${one(you, 'needs', 'need')} you.` : '',
      pr.length ? ` ${and(pr)} ${one(pr, 'waits for someone to approve its pull request', 'wait for someone to approve their pull requests')}.` : '',
      copy.length ? ` ${and(copy)} ${one(copy, 'waits', 'wait')} to merge: your own copy of the code has changes in the same files.` : '',
    ].join('');
  };
  if (!left.length) {
    const you = youWords(stories.map(({ story }) => story.key).filter((k) => !merged(k)));
    return you ? `Every story has started.${you}` : 'Every story has started. The build is done when the last ones merge.';
  }
  // The started stories the rest wait on, through the stories that wait themselves.
  const byKey = new Map<string, BreakdownStory>(stories.map(({ story }) => [story.key, story]));
  const roots = new Set<string>();
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const n of byKey.get(k)?.dependsOn ?? []) {
      if (!byKey.has(n) || merged(n)) continue;
      if (tickets.has(n)) roots.add(n);
      else visit(n);
    }
  };
  for (const { story } of left) visit(story.key);
  const order = stories.map(({ story }) => story.key).filter((k) => roots.has(k));
  if (order.length) return `The next stories wait for ${and(order)} to merge.${youWords(order)}`;
  const bare = left.filter(({ story }) => !story.criteria.length).map(({ story }) => story.key);
  if (bare.length) return `${and(bare)} ${bare.length === 1 ? 'has' : 'have'} no "done when" yet. Add one and ${bare.length === 1 ? 'it starts' : 'they start'}.`;
  return 'Nothing more can start now.';
}

/**
 * This month's budget is used up: the queue holds, unless the person let the build go on past it this month (here, or
 * on one of its stories' budget cards, as for any ticket). `goOn`: it goes on past the budget, so the stories it
 * starts do not stop at their own budget card either.
 */
async function budgetHold(bp: BoardPaths, meta: BoardMeta, state: BreakdownState, tickets: Map<string, Ticket>, room: QueueRoom): Promise<{ held?: string; goOn: boolean }> {
  if (!meta.budget?.monthUsd) return { goOn: false };
  const b = budgetState(bp, null, meta.budget);
  if (!b.over.includes('month')) return { goOn: false };
  const month = monthKey();
  if (state.build?.budgetOk === month || [...tickets.values()].some((t) => t.budgetOk?.month === month)) return { goOn: true };
  if ((await room.payment()) !== 'api-key') return { goOn: false };
  return { held: `This month's budget is used up: ${usd(b.monthSpent)} of ${usd(b.monthUsd ?? 0)}. No new story starts. Raise the budget in Settings, or press Build continuously again to go on this month.`, goOn: false };
}

/**
 * Two or more stories stopped on a problem that is not one of the three stops (an error, a cap): something is wrong
 * beyond one story, so no new one starts until the person settles one. A gap, a clash or a failed check never holds it.
 */
function troubleWords(stories: StoryPlace[], tickets: Map<string, Ticket>): string | null {
  const stopped = stories.map(({ story }) => story.key).filter((k) => {
    const t = tickets.get(k);
    return t && !isMerged(t) && t.waiting && stopOf(t) === 'other';
  });
  return stopped.length >= 2 ? `${and(stopped)} stopped on a problem. No new story starts until you settle one of them.` : null;
}

async function queueTurn(bp: BoardPaths, b: Breakdown, meta: BoardMeta, room: QueueRoom): Promise<QueueTurn> {
  const state = readBreakdownState(bp, b.id);
  const stories = allStories(b);
  const tickets = ticketsOf(bp, stories);
  const merged = (k: string) => Boolean(tickets.get(k) && isMerged(tickets.get(k)!));
  if (stories.length && stories.every(({ story }) => merged(story.key))) {
    updateBreakdownState(bp, b.id, (s) => {
      if (!s.build?.on) return;
      s.build = { on: false, by: s.build.by, at: now() };
      addBreakdownActivity(s, 'squad', stories.length === 1 ? 'Its story is merged. Send the release out from Releases.' : `All ${stories.length} stories are merged. Send the release out from Releases.`);
    });
    return { id: b.id, started: [], done: true };
  }
  const keys = new Set(stories.map(({ story }) => story.key));
  const able = stories.filter(({ story }) => !tickets.has(story.key) && story.criteria.length > 0 && story.dependsOn.every((n) => !keys.has(n) || merged(n)));
  // A story inside a part the Analyst is redoing waits for the redo: it starts from the new version.
  const redo = able.map(({ story }) => redoHolding(b, state.job, story.key)).find(Boolean);
  const ready = able.filter(({ story }) => !redoHolding(b, state.job, story.key));
  let held: { text: string; for: 'budget' | 'limit' | 'waits' } | null = null;
  const started: string[] = [];
  let goOn = false;
  if (!ready.length && redo) held = { text: `The Analyst is redoing ${redo}. Its stories start once the redo is done.`, for: 'waits' };
  else if (!ready.length) held = { text: waitsWords(stories, tickets), for: 'waits' };
  else if (room.pause) held = { text: limitText(room.pause), for: 'limit' };
  else {
    const budget = await budgetHold(bp, meta, state, tickets, room);
    const trouble = troubleWords(stories, tickets);
    goOn = budget.goOn;
    if (budget.held) held = { text: budget.held, for: 'budget' };
    else if (trouble) held = { text: trouble, for: 'waits' };
  }
  if (!held) {
    const busy = stories.filter(({ story }) => working(tickets.get(story.key))).length;
    const places = Math.min(Math.min(parallelLimit(meta.parallel), meta.atOnce ?? Infinity) - busy, room.free());
    for (const { story } of ready.slice(0, Math.max(0, places))) {
      try {
        const t = startStory(bp, b.id, story.key, { by: 'squad' });
        // Let go on past this month's budget: the story does not stop at its own budget card either.
        if (goOn) updateTicket(bp, t.id, (x) => (x.budgetOk = { ...x.budgetOk, month: monthKey() }));
        started.push(t.id);
      } catch (err) {
        held = { text: `${story.key} could not start: ${(err as Error).message}`, for: 'waits' };
        break;
      }
    }
  }
  const before = state.build;
  if (before && (before.held !== held?.text || before.heldFor !== held?.for)) {
    updateBreakdownState(bp, b.id, (s) => {
      if (!s.build?.on) return;
      const { held: _h, heldFor: _f, ...rest } = s.build;
      s.build = { ...rest, ...(held ? { held: held.text, heldFor: held.for } : {}) };
    });
  }
  return { id: b.id, started, ...(held ? { held: held.text } : {}) };
}
