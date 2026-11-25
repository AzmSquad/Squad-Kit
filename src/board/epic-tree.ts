import { BoardActionError } from './actions.js';
import { groupLevel } from '../modules/tracker/tree.js';
import type { Tracker, TrackerChild, TrackerItem } from '../modules/tracker/types.js';

/**
 * What sits under an epic or a feature in the tracker, read down to three levels for a run (ADR-013): the groups right
 * under it (its features) with every open story below each one, the stories right under it, and what is left out
 * with why: finished items, groups with no open story, and stories past the most one run takes. Only the Tracker
 * interface is used, never a product (ADR-002).
 */

/** The most stories one run takes. */
export const MAX_RUN_STORIES = 100;

/** How far below the epic or feature the stories are read: a feature, a group under it, and its stories. */
const DEPTH = 3;

/** Why a story written by someone outside the team is left out: its words never reach the agents. */
export const OUTSIDER = 'Written by someone outside the team';

/** The tracker's own words for a group. A type the tracker uses for its features (Basic's Issue) counts too. */
const GROUP_WORD = /epic|initiative|theme|portfolio|feature/i;

export interface EpicGroup {
  item: TrackerChild;
  /** Every open story below it, in the tracker's order: a group under it adds its stories here. */
  stories: TrackerChild[];
}

export interface EpicRead {
  root: TrackerItem;
  level: 'epic' | 'feature';
  groups: EpicGroup[];
  /** The stories right under the epic or feature. */
  stories: TrackerChild[];
  leftOut: { item: TrackerChild; why: string }[];
}

/** The type names this tracker uses for epics and features, besides the words. None when it cannot say. */
async function groupTypes(tracker: Tracker): Promise<Set<string>> {
  try {
    const lv = await tracker.levels();
    return new Set([lv.epic, lv.feature].filter((t) => t && t.toLowerCase() !== lv.story.toLowerCase()).map((t) => t.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Reads the epic or feature and what sits under it. Throws in plain words when it cannot be built as a whole. */
export async function readEpic(tracker: Tracker, id: string): Promise<EpicRead> {
  if (!tracker.children) throw new BoardActionError(`squad-kit cannot read what sits under an item on ${tracker.label} yet, so it cannot build a whole one.`);
  const children = (of: string) => tracker.children!(of);
  const root = await tracker.get(id);
  if (root.outsider) throw new BoardActionError(`${root.ref} was written by someone outside the team, so squad-kit does not give its words to the agents. To build it, let stories come from anyone in Settings.`);
  const types = await groupTypes(tracker);
  const isGroup = (c: Pick<TrackerChild, 'type' | 'isBug' | 'hasChildren'>) => !c.isBug && (Boolean(c.hasChildren) || GROUP_WORD.test(c.type) || types.has(c.type.toLowerCase()));
  const out: EpicRead = { root, level: 'feature', groups: [], stories: [], leftOut: [] };
  let taken = 0;
  const take = (c: TrackerChild, into: TrackerChild[]) => {
    if (taken >= MAX_RUN_STORIES) out.leftOut.push({ item: c, why: `Past the ${MAX_RUN_STORIES} stories one run takes` });
    else {
      into.push(c);
      taken += 1;
    }
  };
  /** Finished, or written by someone outside the team: left out, with why. */
  const skip = (c: TrackerChild) => {
    const why = c.outsider ? OUTSIDER : c.done ? `${c.state || 'Finished'} on ${tracker.label}` : '';
    if (why) out.leftOut.push({ item: c, why });
    return Boolean(why);
  };
  /** A group's open stories, at any depth; one with none is left out, unless only the tracker's setup made it a group. */
  const groupStories = async (g: TrackerChild, depth: number): Promise<TrackerChild[] | null> => {
    const stories: TrackerChild[] = [];
    for (const c of await children(g.id)) {
      if (skip(c)) continue;
      if (isGroup(c) && depth < DEPTH) {
        const under = await groupStories(c, depth + 1);
        if (under) stories.push(...under);
      } else take(c, stories);
    }
    if (stories.length) return stories;
    if (GROUP_WORD.test(g.type) || g.hasChildren) out.leftOut.push({ item: g, why: 'No open stories under it' });
    else take(g, stories);
    return stories.length ? stories : null;
  };
  const top = await children(id);
  if (!top.length && !isGroup(root)) throw new BoardActionError(`${root.ref} (${root.type}) is not an epic or a feature. Start it on its own from the Backlog.`);
  for (const c of top) {
    if (skip(c)) continue;
    if (isGroup(c)) {
      const stories = await groupStories(c, 2);
      // A group that was itself taken as a story (it had nothing under it) sits right under the epic or feature.
      if (stories?.length === 1 && stories[0] === c) out.stories.push(c);
      else if (stories) out.groups.push({ item: c, stories });
    } else take(c, out.stories);
  }
  out.level = groupLevel(root.type, out.groups.length > 0);
  return out;
}

/** Every story of a read, in the tracker's order: each group's, then the ones right under the epic or feature. */
export function storiesOf(read: Pick<EpicRead, 'groups' | 'stories'>): TrackerChild[] {
  return [...read.groups.flatMap((g) => g.stories), ...read.stories];
}

/** The stories in the order they would build: what a story needs comes first, else the tracker's own order. */
export function buildOrder(stories: TrackerChild[]): TrackerChild[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const open = new Set<string>();
  const out: TrackerChild[] = [];
  const visit = (s: TrackerChild) => {
    if (placed.has(s.id) || open.has(s.id)) return;
    open.add(s.id);
    for (const n of s.needs) {
      const need = byId.get(n);
      if (need) visit(need);
    }
    open.delete(s.id);
    placed.add(s.id);
    out.push(s);
  };
  stories.forEach(visit);
  return out;
}
