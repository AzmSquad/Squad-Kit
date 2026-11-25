import { now, type BoardPaths } from './store.js';
import type { Breakdown, BreakdownStory, TrackerLink } from './requirements-types.js';
import type { BoardMeta } from './types.js';
import { addBreakdownActivity, allStories, andWords, findItem, isBreakdownMine, jobBusy, listBreakdowns, readBreakdownState, storyMerged, updateBreakdown, updateBreakdownState, type StoryPlace } from './requirements.js';
import { breakdownDir } from './requirements-paths.js';
import { trackerFor } from '../modules/registry.js';
import type { Tracker, TrackerChild, TrackerItem } from '../modules/tracker/types.js';
import { writeLog } from '../core/app-log.js';
import { plainWords } from '../core/for-people.js';
import { WROTE_DONE_WHEN, itemHash, itemSection, leadOf, parseCriteria, readCopy, withSection, writeCopy } from './epic-text.js';
import { readEpic, storiesOf } from './epic-tree.js';
import { heldItems } from './epic-held.js';

/**
 * A run from the tracker while it builds (ADR-013). Before each story starts it is read again: changed there since the
 * approval, it waits for the person to read it; closed there, it is left out with a line. The epic and its features
 * move forward in the tracker as their stories start and merge: never backwards, and a move that fails is written in
 * the log and stops nothing. Every few minutes new stories under the epic are looked for; they join only when the
 * person adds them. Only the Tracker interface is used here, never a product (ADR-002).
 */

/** How often a run looks for new stories under its epic, and tries again a move the tracker refused. */
export const TRACKER_LOOK_MS = 10 * 60_000;

/** The project's tracker, when it is the one the run came from. `room.tracker`: the queue's own, for tests. */
export function runTracker(bp: BoardPaths, b: Pick<Breakdown, 'source'>, room?: { tracker?(): Tracker | null }): Tracker | null {
  const module = b.source.kind === 'tracker' ? b.source.tracker?.module : undefined;
  if (!module) return null;
  try {
    const t = room?.tracker ? room.tracker() : trackerFor(bp);
    return t?.name === module ? t : null;
  } catch {
    return null;
  }
}

/* ── Before a story starts ──────────────────────────────── */

type Read = (TrackerChild | TrackerItem) & { done?: boolean };

/**
 * The item now: from its group's children, else read on its own (a group that cannot be read is not a stop: the item is
 * read by itself). Both say whether it is finished, by the tracker's own finished states. Null: gone.
 */
async function readAgain(tracker: Tracker, place: StoryPlace, link: TrackerLink, kept: Map<string, Promise<TrackerChild[]>>): Promise<Read | null> {
  const group = (place.feature ?? place.epic).tracker;
  if (group && group.module === tracker.name && tracker.children) {
    if (!kept.has(group.id)) kept.set(group.id, tracker.children(group.id).catch(() => []));
    const found = (await kept.get(group.id)!).find((c) => c.id === link.id);
    if (found) return found;
  }
  try {
    return await tracker.get(link.id);
  } catch (err) {
    if ((err as { kind?: string }).kind === 'not-found') return null;
    throw err;
  }
}

/**
 * The next stories of a run, read again before they start: the ones that may start now, and why the rest wait. A story
 * changed in the tracker takes its new words and waits for the person (like a story rewritten after the approval); a
 * closed or gone one leaves the run, and the stories that needed it no longer wait for it.
 */
export async function checkBeforeStart(bp: BoardPaths, b: Breakdown, next: StoryPlace[], tracker: Tracker): Promise<{ start: StoryPlace[]; held?: string; review?: boolean }> {
  const start: StoryPlace[] = [];
  const changed: { key: string; item: Read }[] = [];
  const closed: { key: string; ref: string; title: string; state: string }[] = [];
  const kept = new Map<string, Promise<TrackerChild[]>>();
  for (const place of next) {
    const link = place.story.tracker;
    if (!link || link.module !== tracker.name) {
      start.push(place);
      continue;
    }
    let item: Read | null;
    try {
      item = await readAgain(tracker, place, link, kept);
    } catch (err) {
      const why = plainWords(err, `Reading ${link.ref} before it starts`, 'something technical stopped it').replace(/\.?$/, '.');
      const k = place.story.key;
      return { start: [], held: `Could not read ${link.ref} on ${tracker.label} to check it before it starts: ${why} It tries again in a moment. Start it yourself: squad requirements start ${b.id} ${k}, or take it out of the run: squad requirements remove ${b.id} ${k}.` };
    }
    if (!item || item.done) closed.push({ key: place.story.key, ref: link.ref, title: place.story.title, state: item ? item.state || 'Closed' : 'Gone' });
    else if (itemHash(item) !== link.sentHash) changed.push({ key: place.story.key, item });
    else start.push(place);
  }
  if (closed.length) leaveOut(bp, b.id, closed, tracker.label);
  if (!changed.length) return { start };
  takeChanges(bp, b.id, changed, tracker);
  const keys = changed.map((c) => c.key);
  return { start: [], review: true, held: changedWords(b.id, changed.map((c) => findItem(b, c.key)?.story?.tracker?.ref ?? c.key), tracker.label, keys) };
}

function changedWords(id: string, refs: string[], label: string, keys: string[]): string {
  const one = refs.length === 1;
  return `${andWords(refs)} changed on ${label} since you approved. No new story starts until you read ${one ? 'it' : 'them'} (${andWords(keys)}) and press Build continuously again: squad requirements build ${id}.`;
}

/** Closed or gone in the tracker: out of the run, out of the other stories' needs, with a line. */
function leaveOut(bp: BoardPaths, id: string, closed: { key: string; ref: string; title: string; state: string }[], label: string): void {
  updateBreakdown(bp, id, (x) => {
    for (const c of closed) {
      const f = findItem(x, c.key);
      if (!f?.story || f.story.ticket) continue;
      f.list.splice(f.list.indexOf(f.item), 1);
      x.leftOut.push({ text: `${c.ref} ${c.title}`, why: `${c.state} on ${label} after you approved`, ref: { section: c.ref } });
      for (const { story } of allStories(x)) {
        story.dependsOn = story.dependsOn.filter((n) => n !== c.key);
        if (story.needsFrom) delete story.needsFrom[c.key];
      }
    }
  });
  updateBreakdownState(bp, id, (s) => {
    for (const c of closed) addBreakdownActivity(s, 'squad', `Left ${c.ref} ${c.title} out of the run: it is ${c.state.toLowerCase()} on ${label}`);
  });
}

/**
 * A story changed in the tracker takes its new words, here and in the run's copy, and waits for the person to read it.
 * Criteria no longer in Given/When/Then are written again: the old ones go, and the Analyst fills the story in again.
 */
function takeChanges(bp: BoardPaths, id: string, changed: { key: string; item: Read }[], tracker: Tracker): void {
  const dir = breakdownDir(bp, id);
  let copy = readCopy(dir);
  const refill: string[] = [];
  updateBreakdown(bp, id, (x) => {
    for (const { key, item } of changed) {
      const s = findItem(x, key)?.story;
      if (!s?.tracker) continue;
      s.title = item.title.trim() || s.title;
      s.story = leadOf(item);
      const criteria = parseCriteria(item.acceptanceCriteria);
      s.criteria = criteria;
      if (!criteria.length) {
        refill.push(key);
        x.decided = x.decided.filter((d) => !(d.item === key && d.text.startsWith(WROTE_DONE_WHEN)));
      }
      s.tracker = { ...s.tracker, sentHash: itemHash(item), sentAt: now() };
      copy = withSection(copy, s.tracker.ref, itemSection(3, item));
    }
  });
  if (copy) writeCopy(dir, copy);
  updateBreakdownState(bp, id, (s) => {
    s.rewritten = [...new Set([...(s.rewritten ?? []), ...changed.map((c) => c.key)])];
    for (const { key, item } of changed) addBreakdownActivity(s, 'squad', `${item.ref} (${key}) changed on ${tracker.label} since you approved: read it again, then press Build continuously`);
    if (!refill.length) return;
    // The Analyst writes the "done when" again from the new words; the story waits for the person either way.
    if (jobBusy(s.job)) addBreakdownActivity(s, 'squad', `${andWords(refill)} ${refill.length === 1 ? 'has' : 'have'} no "done when" now. The Analyst is busy: add one, or ask it to redo ${refill.length === 1 ? 'it' : 'them'}`);
    else s.job = { step: 'redo', status: 'pending', item: refill.join(','), now: 'Waiting for the Analyst' };
  });
}

/* ── The epic and its features in the tracker ───────────── */

const RANK = { 'in-progress': 1, resolved: 2 } as const;
/** Moves that failed, by run and item, and when: tried again after a while, never every few seconds. */
const failed = new Map<string, number>();

/** Where each of the run's epics and features should be now: in progress once a story started, resolved once all merged. */
function wantedMoves(bp: BoardPaths, b: Breakdown, moved: Record<string, 'in-progress' | 'resolved'>): { link: TrackerLink; to: 'in-progress' | 'resolved' }[] {
  const out: { link: TrackerLink; to: 'in-progress' | 'resolved' }[] = [];
  const module = b.source.tracker?.module;
  const visit = (link: TrackerLink | undefined, stories: BreakdownStory[], mayResolve: boolean) => {
    if (!link || link.module !== module || !stories.length) return;
    const to = mayResolve && stories.every((s) => storyMerged(bp, s)) ? 'resolved' : stories.some((s) => s.ticket) ? 'in-progress' : null;
    if (to && RANK[to] > (moved[link.id] ? RANK[moved[link.id]!] : 0)) out.push({ link, to });
  };
  for (const e of b.epics) {
    // The epic above a feature's run holds other features too: it only moves to in progress.
    visit(e.tracker, [...e.features.flatMap((f) => f.stories), ...e.stories], e.tracker?.id === b.source.tracker?.id);
    for (const f of e.features) visit(f.tracker, f.stories, true);
  }
  return out;
}

/** Moves the run's epic and features forward in the tracker. Never throws: a move that fails is logged and tried later. */
export async function moveGroups(bp: BoardPaths, b: Breakdown, room?: { tracker?(): Tracker | null }): Promise<void> {
  const wanted = wantedMoves(bp, b, readBreakdownState(bp, b.id).trackerMoved ?? {}).filter((w) => {
    const at = failed.get(`${bp.root}/${b.id}/${w.link.id}`);
    return !at || Date.now() - at >= TRACKER_LOOK_MS;
  });
  if (!wanted.length) return;
  const tracker = runTracker(bp, b, room);
  if (!tracker) return;
  for (const w of wanted) {
    const key = `${bp.root}/${b.id}/${w.link.id}`;
    try {
      const state = await tracker.moveTo(w.link.id, w.to, { merged: true });
      failed.delete(key);
      updateBreakdownState(bp, b.id, (s) => {
        s.trackerMoved = { ...s.trackerMoved, [w.link.id]: w.to };
        if (state) addBreakdownActivity(s, 'squad', `Moved ${w.link.ref} to ${state} on ${tracker.label}`);
      });
    } catch (err) {
      const first = !failed.has(key);
      failed.set(key, Date.now());
      writeLog({ level: 'warn', text: `${b.id}: could not move ${w.link.ref} to ${w.to} on ${tracker.label}: ${(err as Error).message}` });
      const why = plainWords(err, `Moving ${w.link.ref}`, 'something technical stopped it').replace(/\.?$/, '.');
      if (first) updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'squad', `Could not move ${w.link.ref} forward on ${tracker.label}: ${why} The stories carry on, and squad-kit tries again later`));
    }
  }
}

/* ── New stories under the epic ─────────────────────────── */

const looked = new Map<string, number>();

/**
 * Every few minutes while it is approved: the open stories under the run's epic or feature that are not in the run, kept
 * in `trackerNew` for the person to add. They never join by themselves. The first look is a while after the run starts.
 */
export async function lookForNew(bp: BoardPaths, b: Breakdown, room?: { tracker?(): Tracker | null }): Promise<void> {
  const key = `${bp.root}/${b.id}`;
  const last = looked.get(key);
  if (last === undefined || Date.now() - last < TRACKER_LOOK_MS) {
    if (last === undefined) looked.set(key, Date.now());
    return;
  }
  looked.set(key, Date.now());
  const tracker = runTracker(bp, b, room);
  const root = b.source.tracker;
  if (!tracker || !root) return;
  try {
    const read = await readEpic(tracker, root.id);
    const inRun = new Set(allStories(b).flatMap(({ story }) => (story.tracker ? [story.tracker.id] : [])));
    const outOfIt = new Set(b.leftOut.flatMap((l) => (l.ref?.section ? [l.ref.section] : [])));
    // Once in the run, never new again: a story the person took out stays out. One another breakdown holds is built there.
    const seen = new Set(root.seen ?? []);
    const held = heldItems(bp, tracker, b.id);
    const fresh = storiesOf(read)
      .filter((c) => !inRun.has(c.id) && !seen.has(c.id) && !outOfIt.has(c.ref) && !held.get(c.id)?.run)
      .map((c) => ({ id: c.id, ref: c.ref, title: c.title }));
    updateBreakdownState(bp, b.id, (s) => {
      const before = new Set((s.trackerNew ?? []).map((n) => n.id));
      const added = fresh.filter((n) => !before.has(n.id));
      if (fresh.length) s.trackerNew = fresh;
      else delete s.trackerNew;
      if (added.length) addBreakdownActivity(s, 'squad', `${added.length} new ${added.length === 1 ? 'story' : 'stories'} on ${tracker.label} under ${root.ref}: ${andWords(added.map((n) => n.ref))}. ${added.length === 1 ? 'It joins' : 'They join'} the run only when you add ${added.length === 1 ? 'it' : 'them'}`);
    });
  } catch (err) {
    writeLog({ level: 'warn', text: `${b.id}: could not look for new stories under ${root.ref} on ${tracker.label}: ${(err as Error).message}` });
  }
}

/**
 * Runs that are approved and not building now (paused, or every story merged) are still followed, at the same pace:
 * their epic and features move on, a move that failed is tried again until it goes through, and new stories show.
 */
export async function followRuns(bp: BoardPaths, meta: Pick<BoardMeta, 'user'>, building: Set<string>, room?: { tracker?(): Tracker | null }): Promise<void> {
  for (const b of listBreakdowns(bp)) {
    if (b.status !== 'approved' || b.source.kind !== 'tracker' || building.has(b.id) || !isBreakdownMine(b, meta)) continue;
    await moveGroups(bp, b, room);
    await lookForNew(bp, b, room);
  }
}

/** Lets a test look again at once. */
export function lookAgainNow(bp: BoardPaths, id: string): void {
  looked.set(`${bp.root}/${id}`, 0);
  for (const k of failed.keys()) if (k.startsWith(`${bp.root}/${id}/`)) failed.delete(k);
}
