import { readMeta, type BoardPaths } from './store.js';
import { BoardActionError } from './actions.js';
import type { Breakdown, BreakdownStory } from './requirements-types.js';
import { addBreakdownActivity, allStories, andWords, isBreakdownMine, jobBusy, nextKey, ownerOfBreakdown, readBreakdownState, requireBreakdown, updateBreakdown, updateBreakdownState } from './requirements.js';
import { breakdownDir } from './requirements-paths.js';
import { plainWords } from '../core/for-people.js';
import type { Tracker, TrackerChild } from '../modules/tracker/types.js';
import { cutNeedLoops, featurePart, outOfRun, storyPart, trackerNeeds } from './epic-import.js';
import { heldItems, heldWords } from './epic-held.js';
import { readEpic } from './epic-tree.js';
import { itemSection, readCopy, withSection, writeCopy } from './epic-text.js';

/**
 * Add to the run: the new stories found under a run's epic or feature (`trackerNew`) join it, each under its own feature
 * (a new feature comes with them when the run has none for it), with the needs the tracker gives them. The Analyst
 * fills them in, and they wait for the person to read them before they build, like a story rewritten after the
 * approval. Nothing joins a run by itself (ADR-013).
 */
export async function addTrackerStories(bp: BoardPaths, id: string, tracker: Tracker): Promise<Breakdown> {
  const b0 = requireBreakdown(bp, id);
  if (!isBreakdownMine(b0, readMeta(bp))) throw new BoardActionError(`${b0.id} is ${ownerOfBreakdown(b0)}'s. Only they can change it.`);
  const root = b0.source.tracker;
  if (b0.source.kind !== 'tracker' || !root) throw new BoardActionError(`${b0.id} did not come from a tracker, so it has no new stories there.`);
  if (root.module !== tracker.name) throw new BoardActionError(`${b0.id} came from ${root.label}, and this project now uses ${tracker.label}.`);
  const state = readBreakdownState(bp, b0.id);
  const wanted = new Set((state.trackerNew ?? []).map((n) => n.id));
  if (!wanted.size) throw new BoardActionError(`No new stories on ${root.label} wait to join ${b0.id}.`);
  if (jobBusy(state.job)) throw new BoardActionError(`The Analyst is working on ${b0.id} now. Try again when it is done.`);
  let read;
  try {
    read = await readEpic(tracker, root.id);
  } catch (err) {
    throw new BoardActionError(`Could not read ${root.ref} on ${root.label}: ${plainWords(err, 'Reading new stories from the tracker', 'something technical stopped it. Try again.')}`);
  }
  const inRun = new Set(allStories(b0).flatMap(({ story }) => (story.tracker ? [story.tracker.id] : [])));
  // Held by another breakdown: built there, never twice. A ticket on the board carries on there.
  const held = heldItems(bp, tracker, b0.id);
  const elsewhere: TrackerChild[] = [];
  const fresh = (list: TrackerChild[]) =>
    list.filter((c) => {
      if (!wanted.has(c.id) || inRun.has(c.id)) return false;
      if (held.get(c.id)?.run) elsewhere.push(c);
      return !held.get(c.id)?.run;
    });
  let cut = 0;
  const made: { part: BreakdownStory; item: TrackerChild }[] = [];
  const dir = breakdownDir(bp, b0.id);
  let copy = readCopy(dir);
  const b = updateBreakdown(bp, b0.id, (x) => {
    const epic = x.epics[0];
    if (!epic) throw new BoardActionError(`${x.id} has no epic to put new stories under.`);
    const add = (c: TrackerChild, into: BreakdownStory[]) => {
      const part = storyPart(tracker, c, nextKey(x, 'story'), held.get(c.id)?.ticket);
      into.push(part);
      made.push({ part, item: c });
      copy = withSection(copy, c.ref, itemSection(3, c));
    };
    // A feature's run has one feature: what is new under it sits there, as at the start.
    const own = epic.features.find((f) => f.tracker?.id === root.id);
    for (const g of read.groups) {
      const stories = fresh(g.stories);
      if (!stories.length) continue;
      let f = own ?? epic.features.find((y) => y.tracker?.id === g.item.id);
      if (!f) {
        f = featurePart(tracker, g.item, nextKey(x, 'feature'));
        epic.features.push(f);
        copy = withSection(copy, g.item.ref, itemSection(2, g.item));
      }
      for (const c of stories) add(c, f.stories);
    }
    for (const c of fresh(read.stories)) add(c, own ? own.stories : epic.stories);
    const keyOf = new Map(allStories(x).flatMap(({ story }) => (story.tracker ? [[story.tracker.id, story.key] as const] : [])));
    trackerNeeds(made, (i) => keyOf.get(i));
    cut = cutNeedLoops(x);
    for (const c of elsewhere) x.leftOut.push(outOfRun(c, heldWords(held.get(c.id)!)));
    if (x.source.tracker) x.source.tracker.seen = [...new Set([...(x.source.tracker.seen ?? []), ...made.map((m) => m.item.id), ...elsewhere.map((c) => c.id)])];
  });
  if (!made.length) {
    updateBreakdownState(bp, b.id, (s) => delete s.trackerNew);
    const other = andWords(elsewhere.map((c) => `${c.ref} is in ${held.get(c.id)!.run!.id} already`));
    throw new BoardActionError(other ? `Nothing was added: ${other}.` : `The new stories under ${root.ref} are closed or gone on ${root.label} now. Nothing was added.`);
  }
  writeCopy(dir, copy);
  const keys = made.map((m) => m.part.key);
  updateBreakdownState(bp, b.id, (s) => {
    delete s.trackerNew;
    s.rewritten = [...new Set([...(s.rewritten ?? []), ...keys])];
    // A redo of the new stories alone: if it stops, the run stays approved and the rest carries on.
    s.job = { step: 'redo', status: 'pending', item: keys.join(','), now: 'Waiting for the Analyst' };
    addBreakdownActivity(s, 'you', `Added ${andWords(made.map((m) => `${m.item.ref} as ${m.part.key}`))} from ${root.label}. The Analyst fills ${made.length === 1 ? 'it' : 'them'} in; ${made.length === 1 ? 'it builds' : 'they build'} once you read ${made.length === 1 ? 'it' : 'them'} and press Build continuously`);
    if (elsewhere.length) addBreakdownActivity(s, 'squad', `Left out ${andWords(elsewhere.map((c) => c.ref))}: ${elsewhere.length === 1 ? 'it is' : 'they are'} in another breakdown already`);
    if (cut) addBreakdownActivity(s, 'squad', `Took away ${cut} ${cut === 1 ? 'need' : 'needs'} from ${root.label} that went round in a loop`);
  });
  return b;
}
