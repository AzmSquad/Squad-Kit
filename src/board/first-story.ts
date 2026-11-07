import { listTickets, readMeta, writeMeta, type BoardPaths } from './store.js';
import { allKeys, allStories, listBreakdowns, nextKey, updateBreakdown } from './requirements.js';
import type { Breakdown, BreakdownEpic, BreakdownStory } from './requirements-types.js';
import { isMerged } from './depends.js';
import type { Ticket } from './types.js';

/**
 * A project with no code starts with one story squad-kit adds itself: "Set up the product". It picks the tools and makes a
 * first version that starts, in one repo, and everything else waits for it to merge. So two stories never pick different
 * tools, and every other story builds on the same start. The person sees it in the breakdown and approves it with the
 * rest. A project with code never gets it. Its merge ends "no code yet": the next read of the code finds the parts.
 */

const STORY_WORDS = {
  epic: 'Set up the product',
  goal: 'squad-kit added this: the project has no code yet. This story picks the tools and makes a first version that starts. The other stories wait for it, so they all build on the same start.',
  title: 'Set up the product',
  story: 'As the team building this product, we want a first version that starts, so that every other story builds on the same tools.',
  criteria: [
    { given: 'the project has no code yet', when: 'this story is merged', then: 'the product starts and shows that it is running' },
    { given: 'the product has started', when: 'the squad runs its checks', then: 'they pass, so the next stories can build on them' },
  ],
};

const isFirstStory = (s: BreakdownStory): boolean => Boolean(s.setsUp);

const firstStoryOf = (b: Breakdown): BreakdownStory | undefined => allStories(b).map((p) => p.story).find(isFirstStory);

/**
 * Adds the first story to a breakdown on a project with no code, and makes the stories that need nothing need it. Safe to
 * call again: after a redo, and at approve for a story the person added. One breakdown has it, whichever came first: the
 * stories of another wait at the start of their tickets (see `firstOpenTicket`).
 */
export function withFirstStory(bp: BoardPaths, x: Breakdown): void {
  if (!readMeta(bp).scan?.empty) return;
  let first = firstStoryOf(x);
  if (!first) {
    if (listBreakdowns(bp).some((o) => o.id !== x.id && firstStoryOf(o))) return;
    first = {
      key: nextKey(x, 'story'),
      title: STORY_WORDS.title,
      story: STORY_WORDS.story,
      criteria: STORY_WORDS.criteria.map((c) => ({ ...c })),
      size: 'S',
      dependsOn: [],
      setsUp: true,
    };
    const epic: BreakdownEpic = { key: nextKey(x, 'epic'), title: STORY_WORDS.epic, goal: STORY_WORDS.goal, features: [], stories: [first] };
    x.epics.unshift(epic);
  }
  first.dependsOn = [];
  for (const { story } of allStories(x)) if (story !== first && !story.dependsOn.length) story.dependsOn = [first.key];
}

/** A breakdown as the Analyst sees it when it redoes the whole thing: squad-kit's own story is not its to rewrite. */
export function withoutFirstStory(b: Breakdown): Breakdown {
  if (!firstStoryOf(b)) return b;
  const copy = structuredClone(b);
  takeOut(copy);
  return copy;
}

function takeOut(x: Breakdown): void {
  const first = firstStoryOf(x);
  if (!first) return;
  for (const e of x.epics) {
    e.stories = e.stories.filter((s) => s !== first);
    for (const f of e.features) f.stories = f.stories.filter((s) => s !== first);
  }
  x.epics = x.epics.filter((e) => e.stories.length || e.features.length);
  const left = new Set(allKeys(x));
  for (const { story } of allStories(x)) story.dependsOn = story.dependsOn.filter((n) => left.has(n));
}

/**
 * The first merge on a project that had no code. Stories stop picking the technology, and the next read of the code also
 * finds the parts. A first story that never started has nothing left to do, so it goes: the others no longer wait for it.
 */
export function firstCodeMerged(bp: BoardPaths): void {
  const meta = readMeta(bp);
  if (!meta.scan?.empty) return;
  writeMeta(bp, { ...meta, scan: { ...meta.scan, empty: false, fromNothing: true } });
  for (const b of listBreakdowns(bp)) {
    const first = firstStoryOf(b);
    if (first && !first.ticket) updateBreakdown(bp, b.id, takeOut);
  }
}

/**
 * The ticket `t` waits for on a project with no code, when there is one: the oldest still open. It picks the tools, so `t`
 * takes its first step only once that one merges. A ticket that left the board holds nothing up.
 */
export function firstOpenTicket(bp: BoardPaths, t: Ticket): Ticket | undefined {
  const open = listTickets(bp).filter((x) => !isMerged(x) && !x.archived && !x.deleting);
  const oldest = open.reduce<Ticket | undefined>((a, x) => (!a || x.createdAt < a.createdAt ? x : a), undefined);
  return oldest && oldest.id !== t.id ? oldest : undefined;
}

/** What a ticket's card says while it waits for the first one. */
export const waitsForFirstWords = (id: string): string => `Waits for ${id} to merge: it picks the tools for this project. Starts by itself.`;

export const waitsForFirst = (status: string): boolean => /^Waits for \S+ to merge: it picks the tools/.test(status);
