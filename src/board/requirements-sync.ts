import { createHash } from 'node:crypto';
import { trackerModule } from '../modules/registry.js';
import type { Tracker } from '../modules/tracker/types.js';
import type { BrdRef, Breakdown, BreakdownEpic, BreakdownFeature, BreakdownLevel, BreakdownStory, TrackerLink } from './requirements-types.js';
import { addActivity, now, readMeta, readTicket, updateTicket, type BoardPaths } from './store.js';
import type { Criterion, Ticket, TrackerEvent } from './types.js';

/**
 * Sending a breakdown to the project's tracker, one way: epics, features and stories, each under its parent, with a
 * dependency link for every story a story needs. The breakdown is the truth: edits made in the tracker do not come
 * back, and Send changes updates the same items. Each item's ref is saved right after it is made, so a send cut off
 * half-way carries on without making doubles. squad-kit never deletes anything in the tracker.
 *
 * Only the Tracker interface is used here, never a product.
 */

type Part = BreakdownEpic | BreakdownFeature | BreakdownStory;

/** One part to make or change in the tracker. */
export interface SendItem {
  key: string;
  level: BreakdownLevel;
  /** create: not in this tracker yet. update: sent before, and its title, text, criteria or parent changed since. */
  action: 'create' | 'update';
  title: string;
  /** The item's text, in Markdown: the story or goal, its place in the BRD, and where it came from. */
  markdown: string;
  /** Stories only: Done when, as Given/When/Then lines. */
  acceptance?: string;
  /** The key of the part above it: a feature's epic, a story's feature (or its epic, when there are no features). */
  parent?: string;
  /** The item it went to before, for an update. */
  link?: TrackerLink;
  /** A short hash of the title, text, criteria and parent: what TrackerLink.sentHash starts with once it is sent. */
  hash: string;
}

/** The dependency links of one story. Only the links the tracker does not have yet are added. */
export interface SendLinks {
  /** The story that needs the others (S-5). */
  key: string;
  /** The stories it needs first (S-4). */
  on: string[];
  /** A short hash of `on`, kept after the text hash in TrackerLink.sentHash once the links are made. */
  hash: string;
}

/** How many parts of one level the breakdown has, and how many are new, changed or the same since the last send. */
export interface LevelCount {
  all: number;
  new: number;
  changed: number;
  unchanged: number;
}

/** What a send does, worked out from the breakdown and the hashes saved at the last send. It never deletes. */
export interface SendPlan {
  breakdown: string;
  module: string;
  /** In order: epics, then features, then stories, so a parent is always made before what sits under it. */
  items: SendItem[];
  /** Made once every item exists. */
  links: SendLinks[];
  counts: {
    epics: LevelCount;
    features: LevelCount;
    stories: LevelCount;
    /** Stories that sit straight under their epic (a small BRD with no features). */
    storiesUnderEpic: number;
    /** Every "S-5 needs S-4" in the breakdown, one link each: "18 links between stories that need each other". */
    links: number;
    new: number;
    changed: number;
    unchanged: number;
  };
}

const sha = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length);

/** TrackerLink.sentHash is the text hash, then ":" and the links hash once a story's dependency links are made. */
function splitHash(sentHash: string | undefined): [string, string] {
  const [text = '', links = ''] = (sentHash ?? '').split(':');
  return [text, links];
}

function joinHash(text: string, links: string): string {
  return links ? `${text}:${links}` : text;
}

/** "From the BRD: 3.4 Holding a slot, page 7". */
function brdPlace(ref: BrdRef | undefined): string {
  if (!ref) return '';
  const where = [ref.section, ref.title].map((x) => x?.trim()).filter(Boolean).join(' ');
  const place = [where, ref.page ? `page ${ref.page}` : ''].filter(Boolean).join(', ');
  return place ? `From the BRD: ${place}` : '';
}

/** Done when, one criterion per paragraph, as Given, When and Then lines. */
function doneWhen(criteria: Criterion[]): string {
  return criteria.map((c) => `**Given** ${c.given.trim()}\n**When** ${c.when.trim()}\n**Then** ${c.then.trim()}`).join('\n\n');
}

/**
 * The line every item ends with: "Made by squad-kit from BR-1, S-4." With the item's BR-1 tag it finds an item a send
 * made but was cut off before saving.
 */
export function madeLine(id: string, key: string): string {
  return `Made by squad-kit from ${id}, ${key}.`;
}

/** The text an item gets in the tracker. The breakdown's name stays out, so renaming it changes no item. */
export function itemText(b: Breakdown, level: BreakdownLevel, part: Part): { title: string; markdown: string; acceptance?: string } {
  const lead = level === 'epic' ? (part as BreakdownEpic).goal : level === 'feature' ? (part as BreakdownFeature).summary : (part as BreakdownStory).story;
  const markdown = [lead?.trim() ?? '', brdPlace(part.ref), madeLine(b.id, part.key)].filter(Boolean).join('\n\n');
  const criteria = level === 'story' ? doneWhen((part as BreakdownStory).criteria ?? []) : '';
  return { title: part.title.trim(), markdown, ...(level === 'story' ? { acceptance: criteria } : {}) };
}

function allStories(b: Breakdown): BreakdownStory[] {
  return b.epics.flatMap((e) => [...e.features.flatMap((f) => f.stories), ...e.stories]);
}

function partOf(b: Breakdown, key: string): Part | undefined {
  for (const e of b.epics) {
    if (e.key === key) return e;
    for (const f of e.features) {
      if (f.key === key) return f;
      const s = f.stories.find((x) => x.key === key);
      if (s) return s;
    }
    const s = e.stories.find((x) => x.key === key);
    if (s) return s;
  }
  return undefined;
}

/** The stories a story needs, as keys still in the breakdown, without itself or doubles. */
function needsOf(s: BreakdownStory, keys: Set<string>): string[] {
  return [...new Set(s.dependsOn ?? [])].filter((k) => k !== s.key && keys.has(k));
}

/** What to make, change and link so the tracker matches the breakdown. Pure: nothing is sent. */
export function planSend(b: Breakdown, module: string): SendPlan {
  const count = (): LevelCount => ({ all: 0, new: 0, changed: 0, unchanged: 0 });
  const counts: SendPlan['counts'] = { epics: count(), features: count(), stories: count(), storiesUnderEpic: 0, links: 0, new: 0, changed: 0, unchanged: 0 };
  const byLevel: Record<BreakdownLevel, LevelCount> = { epic: counts.epics, feature: counts.features, story: counts.stories };
  const keys = new Set(allStories(b).map((s) => s.key));
  const items: SendItem[] = [];
  const links: SendLinks[] = [];

  const visit = (level: BreakdownLevel, part: Part, parent?: string) => {
    const text = itemText(b, level, part);
    const hash = sha(JSON.stringify([level, text.title, text.markdown, text.acceptance ?? '', parent ?? '']), 12);
    // An item sent to another tracker is new to this one.
    const link = part.tracker?.module === module ? part.tracker : undefined;
    const [sentText, sentLinks] = splitHash(link?.sentHash);
    const action = !link ? 'create' : sentText !== hash ? 'update' : null;
    const c = byLevel[level];
    c.all += 1;
    if (action === 'create') c.new += 1;
    else if (action === 'update') c.changed += 1;
    else c.unchanged += 1;
    if (action) items.push({ key: part.key, level, action, ...text, ...(parent ? { parent } : {}), ...(link ? { link } : {}), hash });
    if (level !== 'story') return;
    const on = needsOf(part as BreakdownStory, keys);
    if (!on.length) return;
    counts.links += on.length;
    const linksHash = sha(JSON.stringify([...on].sort()), 8);
    if (sentLinks !== linksHash) links.push({ key: part.key, on, hash: linksHash });
  };

  for (const e of b.epics) visit('epic', e);
  for (const e of b.epics) for (const f of e.features) visit('feature', f, e.key);
  for (const e of b.epics) {
    for (const f of e.features) for (const s of f.stories) visit('story', s, f.key);
    // A small BRD skips features: its stories sit straight under the epic.
    for (const s of e.stories) visit('story', s, e.key);
    counts.storiesUnderEpic += e.stories.length;
  }
  for (const c of [counts.epics, counts.features, counts.stories]) {
    counts.new += c.new;
    counts.changed += c.changed;
    counts.unchanged += c.unchanged;
  }
  return { breakdown: b.id, module, items, links, counts };
}

/** The dependency links still to make, one for each "S-5 needs S-4": the unit the Send dialog counts links in. */
export function linkCount(plan: Pick<SendPlan, 'links'>): number {
  return plan.links.reduce((n, l) => n + l.on.length, 0);
}

/** How far a send is: the items made or changed, then the links, each counted as the dialog counts them. */
export interface SendProgress {
  items: { done: number; of: number };
  links: { done: number; of: number };
}

/** One thing a send saved: an item's tracker link, or the send itself at the end. */
export type SendChange = { key: string; tracker: TrackerLink } | { sent: NonNullable<Breakdown['sent']> };

/**
 * Puts what a send saved into a breakdown. A save callback can use it on a freshly read breakdown, so edits made
 * while the send runs are kept.
 */
export function applySendChange(b: Breakdown, change: SendChange): void {
  if ('sent' in change) {
    b.sent = change.sent;
    return;
  }
  const part = partOf(b, change.key);
  if (part) part.tracker = change.tracker;
}

export interface SendOptions {
  /** Called right after each item is made or changed, with its tracker link already in `b`, and once at the end. */
  save: (b: Breakdown, change: SendChange) => void;
  /** `done` of `of`: items and links together, each link one "S-5 needs S-4"; `parts` says each apart. */
  progress?: (done: number, of: number, parts: SendProgress) => void;
  /** Called with an item's key just before it is made in the tracker, and with null once its link is saved. */
  making?: (key: string | null) => void;
  /**
   * The item the last send was making when it was cut off: it may be in the tracker without its link saved, so it is
   * looked for there (by its tag and its "Made by squad-kit" line) before it is made again.
   */
  cutOff?: string;
  /** Stop: the send ends between two items, and the next send carries on. */
  signal?: AbortSignal;
  /** Who sends it, for `b.sent`. The breakdown's owner when left out. */
  by?: string;
}

export interface SendResult {
  /** Items and links together, each link one "S-5 needs S-4". */
  done: number;
  of: number;
  created: number;
  updated: number;
  /** Dependency links made, one for each "S-5 needs S-4". */
  linked: number;
  /** Items a cut-off send had made already, found in the tracker and used instead of made again. */
  found?: number;
  /** Why the send stopped half-way, in plain words. What was done is kept, and Send again carries on from there. */
  error?: string;
  /** Stopped by the signal before the end. */
  stopped?: boolean;
}

/**
 * Sends the breakdown: makes and changes the items in plan order, then the dependency links. Saves after every item,
 * so nothing is made twice. A tracker problem ends the send with a plain `error`; the items made so far stay.
 * Throws only before anything is sent: the breakdown is not approved, or the tracker cannot make items.
 */
export async function sendBreakdown(b: Breakdown, tracker: Tracker, opts: SendOptions): Promise<SendResult> {
  if (!b.approved) throw new Error(`Approve ${b.id} before sending it to ${tracker.label}.`);
  if (!tracker.abilities.create) throw new Error(`squad-kit cannot make items in ${tracker.label}.`);
  const plan = planSend(b, tracker.name);
  const links = linkCount(plan);
  const result: SendResult = { done: 0, of: plan.items.length + links, created: 0, updated: 0, linked: 0 };
  const parts = (): SendProgress => ({ items: { done: result.created + result.updated, of: plan.items.length }, links: { done: result.linked, of: links } });
  const keep = (key: string, link: TrackerLink) => {
    const part = partOf(b, key);
    if (part) part.tracker = link;
    opts.save(b, { key, tracker: link });
  };
  const sentId = (key: string): string | undefined => {
    const link = partOf(b, key)?.tracker;
    return link?.module === tracker.name ? link.id : undefined;
  };
  const stepDone = (n = 1) => {
    result.done += n;
    opts.progress?.(result.done, result.of, parts());
  };

  let doing = `read the item types ${tracker.label} uses`;
  opts.progress?.(0, result.of, parts());
  try {
    // The project has every type it needs before anything is made.
    if (plan.items.length) await tracker.levels();
    for (const item of plan.items) {
      if (opts.signal?.aborted) return { ...result, stopped: true };
      doing = `${item.action === 'create' ? 'make' : 'update'} ${item.key} "${item.title}" in ${tracker.label}`;
      const parent = item.parent ? sentId(item.parent) : undefined;
      if (item.parent && !parent) throw new Error(`${item.parent} above it is not in ${tracker.label} yet`);
      const at = now();
      if (item.action === 'create') {
        // Cut off last time right after making it, maybe: the item is used again, never made twice.
        const made = item.key === opts.cutOff && tracker.findMade ? await tracker.findMade({ level: item.level, tag: b.id, mark: madeLine(b.id, item.key) }) : null;
        opts.making?.(item.key);
        const row =
          made ??
          (await tracker.createItem({
            level: item.level,
            title: item.title,
            markdown: item.markdown,
            ...(item.acceptance ? { acceptance: item.acceptance } : {}),
            ...(parent ? { parent } : {}),
            tags: ['squad-kit', b.id],
          }));
        // Found again: its text is sent once more, so it is the same as a new one.
        if (made) await tracker.updateItem(made.id, { title: item.title, markdown: item.markdown, ...(item.acceptance !== undefined ? { acceptance: item.acceptance } : {}), ...(parent ? { parent } : {}) });
        keep(item.key, { module: tracker.name, id: row.id, ref: row.ref, url: row.url, type: row.type, sentHash: item.hash, sentAt: at });
        opts.making?.(null);
        result.created += 1;
        if (made) result.found = (result.found ?? 0) + 1;
      } else {
        const link = item.link!;
        await tracker.updateItem(link.id, {
          title: item.title,
          markdown: item.markdown,
          ...(item.acceptance !== undefined ? { acceptance: item.acceptance } : {}),
          ...(parent ? { parent } : {}),
        });
        // The links part stays as it was until this send makes the links.
        keep(item.key, { ...link, sentHash: joinHash(item.hash, splitHash(link.sentHash)[1]), sentAt: at });
        result.updated += 1;
      }
      stepDone();
    }
    for (const l of plan.links) {
      if (opts.signal?.aborted) return { ...result, stopped: true };
      doing = `link ${l.key} to the stories it needs in ${tracker.label}`;
      const id = sentId(l.key);
      if (!id) throw new Error(`${l.key} is not in ${tracker.label} yet`);
      const on = l.on.map(sentId).filter((x): x is string => Boolean(x));
      await tracker.linkDepends(id, on);
      const link = partOf(b, l.key)!.tracker!;
      keep(l.key, { ...link, sentHash: joinHash(splitHash(link.sentHash)[0], l.hash), sentAt: now() });
      result.linked += l.on.length;
      stepDone(l.on.length);
    }
  } catch (err) {
    const why = ((err as Error)?.message ?? String(err)).trim().replace(/\.$/, '');
    const kept = result.done ? `${result.done} of ${result.of} are sent. Send again carries on from there.` : 'Nothing was sent yet.';
    return { ...result, error: `Could not ${doing}: ${why}. ${kept}` };
  }
  const sent = { module: tracker.name, at: now(), by: opts.by ?? b.owner };
  b.sent = sent;
  opts.save(b, { sent });
  return result;
}

/** A ticket's source for a story that is in the tracker, so the ticket updates its item like a pulled one. */
export function storySource(link: TrackerLink): Ticket['source'] {
  return { type: link.module, id: link.id, ref: link.ref, url: link.url, itemType: link.type };
}

/**
 * Tickets started from the breakdown's stories before the stories were sent get the story's item as their source.
 * Then the tracker updates work for them as for pulled tickets: the item moves forward, gets the squad's notes and is
 * closed on release. The move it missed is queued now. Returns the tickets it linked.
 */
export function linkTickets(bp: BoardPaths, b: Breakdown): string[] {
  const live = readMeta(bp).engine === 'live';
  const linked: string[] = [];
  for (const s of allStories(b)) {
    const link = s.tracker;
    if (!s.ticket || !link) continue;
    const t = readTicket(bp, s.ticket);
    if (!t || t.breakdown?.id !== b.id || t.breakdown.item !== s.key || t.source.type !== 'manual') continue;
    const module = trackerModule(link.module);
    updateTicket(bp, t.id, (x) => {
      x.source = storySource(link);
      addActivity(x, 'squad', `Linked to ${link.ref} on ${module?.label ?? link.module}, where ${b.id} › ${s.key} was sent`);
      // The same rule as every tracker update: the live squad sends it, and only to a tracker squad-kit has a module for.
      if (!live || !module) return;
      const missed: TrackerEvent[] = [{ kind: 'started' }];
      if (x.stage === 'done' && x.release) missed.push({ kind: 'released', version: x.release });
      x.trackerQueue = [...(x.trackerQueue ?? []), ...missed];
    });
    linked.push(t.id);
  }
  return linked;
}
