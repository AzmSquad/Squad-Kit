import fs from 'node:fs';
import { now, readMeta, type BoardPaths } from './store.js';
import { BoardActionError } from './actions.js';
import type { Breakdown, BreakdownEpic, BreakdownFeature, BreakdownState, BreakdownStory, EpicPreview, LeftOut, TrackerLink } from './requirements-types.js';
import { addBreakdownActivity, estimateBreakdown, findLoop, listBreakdowns, nextBreakdownId, readBreakdownState, storyProgress, writeBreakdown, writeBreakdownState } from './requirements.js';
import { usualReadSeconds } from './requirements-actions.js';
import { breakdownDir } from './requirements-paths.js';
import { howPaid } from './payment.js';
import { parallelLimit } from '../core/settings.js';
import { plainWords } from '../core/for-people.js';
import type { Tracker, TrackerChild, TrackerItem } from '../modules/tracker/types.js';
import { buildOrder, readEpic, storiesOf, type EpicRead } from './epic-tree.js';
import { TRACKER_FILE, itemHash, itemSection, leadOf, parseCriteria, writeCopy } from './epic-text.js';
import { heldItems, heldWords } from './epic-held.js';

/**
 * Build all on an epic or a feature from the tracker (ADR-013): what it would run, for the dialog, and the run itself,
 * a breakdown that is already in the tracker. Its parts mirror the tracker's: the epic, its features and their stories,
 * each with its tracker link from the start, so Send has nothing to send and a later change there shows. Nothing new
 * is made in the tracker, and no story is split (ADR-004). Only the Tracker interface is used, never a product.
 */

type Item = Pick<TrackerChild, 'id' | 'ref' | 'url' | 'type' | 'title' | 'description' | 'acceptanceCriteria' | 'reproSteps'>;

/** An item's tracker link, with the hash of its words now. */
export function linkOf(tracker: Pick<Tracker, 'name'>, i: Item): TrackerLink {
  return { module: tracker.name, id: i.id, ref: i.ref, url: i.url, type: i.type, sentHash: itemHash(i), sentAt: now() };
}

/** A story part for an item, with its criteria when the tracker has them as Given/When/Then. Its needs come after. */
export function storyPart(tracker: Pick<Tracker, 'name'>, c: TrackerChild, key: string, ticket?: string): BreakdownStory {
  return {
    key,
    title: c.title.trim() || c.ref,
    story: leadOf(c),
    criteria: parseCriteria(c.acceptanceCriteria),
    size: 'M',
    dependsOn: [],
    ref: { section: c.ref, title: c.title.trim() },
    tracker: linkOf(tracker, c),
    ...(ticket ? { ticket } : {}),
  };
}

/** A feature part for a group under the epic. */
export function featurePart(tracker: Pick<Tracker, 'name'>, g: Item, key: string): BreakdownFeature {
  return { key, title: g.title.trim() || g.ref, ...(leadOf(g) ? { summary: leadOf(g) } : {}), ref: { section: g.ref, title: g.title.trim() }, stories: [], tracker: linkOf(tracker, g) };
}

/** Each story's needs, as keys inside the run, from the tracker's own links. */
export function trackerNeeds(stories: { part: BreakdownStory; item: TrackerChild }[], keyOf: (id: string) => string | undefined): void {
  for (const { part, item } of stories) {
    const keys = [...new Set(item.needs.map(keyOf).filter((k): k is string => Boolean(k) && k !== part.key))];
    part.dependsOn = [...new Set([...part.dependsOn, ...keys])];
    if (keys.length) part.needsFrom = { ...part.needsFrom, ...Object.fromEntries(keys.map((k) => [k, 'tracker' as const])) };
  }
}

/** Needs that go round in a loop are cut where the loop closes: a story never waits for good. How many were cut. */
export function cutNeedLoops(b: Pick<Breakdown, 'epics'>): number {
  let cut = 0;
  for (let loop = findLoop(b); loop && cut < 50; loop = findLoop(b), cut += 1) {
    const from = loop[loop.length - 2]!;
    const to = loop[loop.length - 1]!;
    for (const e of b.epics) {
      for (const s of [...e.features.flatMap((f) => f.stories), ...e.stories]) {
        if (s.key !== from) continue;
        s.dependsOn = s.dependsOn.filter((n) => n !== to);
        if (s.needsFrom) delete s.needsFrom[to];
      }
    }
  }
  return cut;
}

/** The words when an item has a run already: new stories under it join that run, never a second one. */
export function runAlreadyWords(ref: string, run: string): string {
  return `${ref} has a run already: ${run}. New stories under it show there with Add to the run.`;
}

/** The run of an item that exists already, by its breakdown id. */
export function runOfItem(bp: BoardPaths, module: string, id: string): string | undefined {
  return listBreakdowns(bp).find((b) => b.source.kind === 'tracker' && b.source.tracker?.module === module && b.source.tracker.id === id)?.id;
}

/** A run as the Backlog shows it on its epic's or feature's row. */
export interface RunSummary {
  id: string;
  /** Approved: it builds by itself, or is paused. */
  approved: boolean;
  on: boolean;
  stories: number;
  merged: number;
  building: number;
  needsYou: number;
}

/** Every run from this tracker, by its epic's or feature's id. */
export function trackerRuns(bp: BoardPaths, module: string): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const b of listBreakdowns(bp)) {
    if (b.source.kind !== 'tracker' || b.source.tracker?.module !== module) continue;
    const state = readBreakdownState(bp, b.id);
    const progress = storyProgress(bp, b, state);
    const count = (...states: string[]) => progress.filter((p) => states.includes(p.state)).length;
    out.set(b.source.tracker.id, { id: b.id, approved: b.status === 'approved', on: Boolean(state.build?.on), stories: progress.length, merged: count('merged', 'released'), building: count('building'), needsYou: count('needs-you') });
  }
  return out;
}

/** The item a person named, read with what sits under it; a problem reading it is said in plain words. */
async function readNamed(tracker: Tracker, ref: string): Promise<EpicRead> {
  const id = tracker.parseRef(ref);
  if (!id) throw new BoardActionError(`"${ref}" is not an item on ${tracker.label}.`);
  try {
    return await readEpic(tracker, id);
  } catch (err) {
    if (err instanceof BoardActionError) throw err;
    throw new BoardActionError(`Could not read ${tracker.refOf(id)} on ${tracker.label}: ${plainWords(err, 'Reading an epic from the tracker', 'something technical stopped it. Try again.')}`);
  }
}

/** The ids of the items in a sprint, and its name. */
async function inSprint(tracker: Tracker, sprint: string): Promise<{ name: string; ids: Set<string> }> {
  const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
  const found = sprints.find((s) => s.path === sprint || s.name.toLowerCase() === sprint.toLowerCase());
  if (!found) throw new BoardActionError(`${tracker.label} has no sprint "${sprint}".`);
  return { name: found.name, ids: new Set((await tracker.list({ sprint: found.path })).map((r) => r.id)) };
}

const rootOf = (read: EpicRead): EpicPreview['root'] => ({ id: read.root.id, ref: read.root.ref, title: read.root.title, type: read.root.type, level: read.level, url: read.root.url });

/** What Build all would run, for its dialog. `sprint`: the sprint the Backlog shows, to offer only its stories. */
export async function epicPreview(bp: BoardPaths, tracker: Tracker, ref: string, opts: { sprint?: string } = {}): Promise<EpicPreview> {
  const read = await readNamed(tracker, ref);
  const sprint = opts.sprint ? await inSprint(tracker, opts.sprint) : null;
  const run = runOfItem(bp, tracker.name, read.root.id);
  // Held by another breakdown: built there, never twice. A ticket on the board carries on there.
  const held = heldItems(bp, tracker, run);
  const elsewhere = storiesOf(read).filter((s) => held.get(s.id)?.run);
  const stories = storiesOf(read).filter((s) => !held.get(s.id)?.run);
  const board = new Map(stories.flatMap((s) => (held.get(s.id)?.ticket ? [[s.id, held.get(s.id)!.ticket!] as const] : [])));
  const ids = new Set(stories.map((s) => s.id));
  const featureOf = new Map(read.groups.flatMap((g) => g.stories.map((s) => [s.id, g.item.title] as const)));
  const refOf = new Map(stories.map((s) => [s.id, s.ref]));
  const meta = readMeta(bp);
  const pseudo = { epics: [{ key: 'E-1', title: '', features: [], stories: stories.map((s, i) => ({ key: `S-${i + 1}`, title: s.title, story: '', criteria: [], size: 'M' as const, dependsOn: [], ...(board.get(s.id) ? { ticket: board.get(s.id) } : {}) })) }] } as unknown as Breakdown;
  const estimate = estimateBreakdown(bp, pseudo, (await howPaid(bp)).payment, { parallel: parallelLimit(meta.parallel) });
  return {
    root: rootOf(read),
    stories: buildOrder(stories).map((s) => ({
      id: s.id,
      ref: s.ref,
      title: s.title,
      type: s.type,
      isBug: s.isBug,
      state: s.state,
      ...(featureOf.get(s.id) ? { feature: featureOf.get(s.id) } : {}),
      needs: s.needs.filter((n) => ids.has(n) && n !== s.id).map((n) => refOf.get(n)!),
      ...(sprint ? { inSprint: sprint.ids.has(s.id) } : {}),
      ...(board.get(s.id) ? { onBoard: board.get(s.id) } : {}),
    })),
    leftOut: [...read.leftOut.map(({ item, why }) => ({ ref: item.ref, title: item.title, why })), ...elsewhere.map((s) => ({ ref: s.ref, title: s.title, why: heldWords(held.get(s.id)!) }))],
    ...(sprint ? { sprint: { name: sprint.name, count: stories.filter((s) => sprint.ids.has(s.id)).length } } : {}),
    ...(run ? { run } : {}),
    atOnce: Math.min(parallelLimit(meta.parallel), meta.atOnce ?? Infinity),
    estimate: { minutes: estimate.minutes, ...(estimate.costUsd !== undefined ? { costUsd: estimate.costUsd } : {}), rough: estimate.rough },
  };
}

/**
 * The epic part of a run, and the item it stands for: the epic itself, or for a feature its own epic (or, with none, a
 * part named after the feature, with no link of its own).
 */
async function epicPart(tracker: Tracker, read: EpicRead): Promise<{ part: BreakdownEpic; item: TrackerItem }> {
  const r = read.root;
  const part = (i: TrackerItem, linked: boolean): BreakdownEpic => ({
    key: 'E-1',
    title: i.title.trim() || i.ref,
    ...(leadOf(i) ? { goal: leadOf(i) } : {}),
    ...(linked ? { ref: { section: i.ref, title: i.title.trim() }, tracker: linkOf(tracker, i) } : {}),
    features: [],
    stories: [],
  });
  if (read.level === 'epic') return { part: part(r, true), item: r };
  const above = r.parents[0];
  const upper = above && /epic|initiative|theme|portfolio/i.test(above.type) ? await tracker.get(above.id).catch(() => null) : null;
  // An epic written by someone outside the team is not used: its words would reach the agents.
  const parent = upper && !upper.outsider ? upper : null;
  return parent ? { part: part(parent, true), item: parent } : { part: part(r, false), item: r };
}

/**
 * Makes the run: a breakdown whose source is the tracker item, with the copy of every item's text, waiting for the
 * Analyst's one read. `onlySprint`: only the stories in that sprint; the others are left out with why.
 */
export async function importEpic(bp: BoardPaths, tracker: Tracker, ref: string, opts: { onlySprint?: string } = {}): Promise<Breakdown> {
  const read = await readNamed(tracker, ref);
  const r = read.root;
  const had = runOfItem(bp, tracker.name, r.id);
  if (had) throw new BoardActionError(runAlreadyWords(r.ref, had));
  const sprint = opts.onlySprint ? await inSprint(tracker, opts.onlySprint) : null;
  const leftOut: LeftOut[] = read.leftOut.map(({ item, why }) => outOfRun(item, why));
  const held = heldItems(bp, tracker);
  const keep = (c: TrackerChild) => {
    const h = held.get(c.id);
    const why = h?.run ? heldWords(h) : sprint && !sprint.ids.has(c.id) ? `Not in ${sprint.name}` : '';
    if (why) leftOut.push(outOfRun(c, why));
    return !why;
  };
  const groups = read.groups.map((g) => ({ ...g, stories: g.stories.filter(keep) })).filter((g) => g.stories.length);
  const direct = read.stories.filter(keep);
  if (!groups.length && !direct.length) throw new BoardActionError(`${r.ref} has no open stories${sprint ? ` in ${sprint.name}` : ''} under it, so there is nothing to build.`);
  const meta = readMeta(bp);
  const { part: epic, item: top } = await epicPart(tracker, read);
  let story = 1;
  const made: { part: BreakdownStory; item: TrackerChild }[] = [];
  const add = (c: TrackerChild, into: BreakdownStory[]) => {
    const part = storyPart(tracker, c, `S-${story++}`, held.get(c.id)?.ticket);
    into.push(part);
    made.push({ part, item: c });
  };
  const sections = [itemSection(1, top), ...(top === r ? [] : [itemSection(2, r)])];
  if (read.level === 'epic') {
    groups.forEach((g, i) => {
      const f = featurePart(tracker, g.item, `F-${i + 1}`);
      g.stories.forEach((c) => add(c, f.stories));
      epic.features.push(f);
    });
    direct.forEach((c) => add(c, epic.stories));
  } else {
    // A feature is the one feature of its run: the stories of any group under it sit under it too.
    const f = featurePart(tracker, r, 'F-1');
    [...groups.flatMap((g) => g.stories), ...direct].forEach((c) => add(c, f.stories));
    epic.features.push(f);
  }
  for (const f of epic.features) {
    const group = groups.find((g) => g.item.id === f.tracker?.id);
    if (group) sections.push(itemSection(2, group.item));
    for (const s of f.stories) sections.push(storySection(made, s.key));
  }
  for (const s of epic.stories) sections.push(storySection(made, s.key));
  const keyOf = new Map(made.map((m) => [m.item.id, m.part.key]));
  trackerNeeds(made, (id) => keyOf.get(id));
  // Pressed twice while the tracker was read: the first one made the run.
  const meanwhile = runOfItem(bp, tracker.name, r.id);
  if (meanwhile) throw new BoardActionError(runAlreadyWords(r.ref, meanwhile));
  const id = nextBreakdownId(bp);
  const b: Breakdown = {
    id,
    title: r.title.trim() || r.ref,
    status: 'reading',
    source: { file: TRACKER_FILE, name: `${r.ref} ${r.title.trim()}`.trim(), kind: 'tracker', bytes: 0, addedBy: meta.user.name, addedAt: now(), tracker: { module: tracker.name, id: r.id, ref: r.ref, url: r.url, type: r.type, label: tracker.label, seen: made.map((m) => m.item.id) } },
    questions: [],
    epics: [epic],
    decided: [],
    leftOut,
    createdAt: now(),
    createdBy: meta.user.name,
    owner: meta.user.name,
    next: { epic: 2, feature: epic.features.length + 1, story },
  };
  const cut = cutNeedLoops(b);
  let copy;
  try {
    copy = writeCopy(breakdownDir(bp, id), `${sections.join('\n\n')}\n`);
  } catch (err) {
    fs.rmSync(breakdownDir(bp, id), { recursive: true, force: true });
    throw err;
  }
  b.source.bytes = copy.bytes;
  if (copy.parts) b.source.pages = copy.parts;
  writeBreakdown(bp, b);
  const onIt = made.filter((m) => m.part.ticket).length;
  const s: BreakdownState = { activity: [] };
  addBreakdownActivity(s, 'you', `Started a run of ${r.type} ${r.ref} ${r.title.trim()} from ${tracker.label}: ${made.length} ${made.length === 1 ? 'story' : 'stories'}${onIt ? `, ${onIt} on the board already` : ''}${sprint ? `, only the ones in ${sprint.name}` : ''}`);
  addBreakdownActivity(s, 'squad', `Copied the text of ${sections.length} ${sections.length === 1 ? 'item' : 'items'} from ${tracker.label}${leftOut.length ? `, and left out ${leftOut.length}: ${[...new Set(leftOut.map((l) => l.why))].slice(0, 3).join('; ')}` : ''}`);
  if (cut) addBreakdownActivity(s, 'squad', `Took away ${cut} ${cut === 1 ? 'need' : 'needs'} from ${tracker.label} that went round in a loop`);
  s.job = { step: 'read', status: 'pending', now: 'Waiting for the Analyst', at: { done: 0, of: copy.parts, unit: 'part' }, usualSeconds: usualReadSeconds(copy) };
  writeBreakdownState(bp, id, s);
  return b;
}

/**
 * An item left out of the run. A story written by someone outside the team is named by its ref only: the left-out list
 * reaches the agents, and its words must not.
 */
export function outOfRun(c: Pick<TrackerChild, 'ref' | 'title' | 'outsider'>, why: string): LeftOut {
  return { text: c.outsider ? c.ref : `${c.ref} ${c.title}`, why, ref: { section: c.ref } };
}

/** A story's section of the copy, with the refs of what it needs inside the run. */
function storySection(made: { part: BreakdownStory; item: TrackerChild }[], key: string): string {
  const m = made.find((x) => x.part.key === key)!;
  const refs = new Map(made.map((x) => [x.item.id, x.item.ref]));
  return itemSection(3, m.item, m.item.needs.map((n) => refs.get(n)).filter((x): x is string => Boolean(x)));
}
