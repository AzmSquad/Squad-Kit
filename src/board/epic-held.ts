import { listTickets, type BoardPaths } from './store.js';
import type { Ticket } from './types.js';
import type { Breakdown, BreakdownStory } from './requirements-types.js';
import { allStories, listBreakdowns } from './requirements.js';
import type { Tracker } from '../modules/tracker/types.js';

/**
 * Tracker items squad-kit holds already, so none is built twice (ADR-013): a story of a breakdown (a run from the
 * tracker, or a breakdown sent there), and a ticket on the board that came from the item. Only the Tracker interface is
 * used, never a product.
 */

export interface Held {
  /** The breakdown it is a story of, the story's key, and the run's epic or feature when it is a run from the tracker. */
  run?: { id: string; key: string; root?: string };
  /** Its ticket on the board. */
  ticket?: string;
}

/** Every item held, by its id. `except`: a breakdown whose own stories do not count (the run being added to). */
export function heldItems(bp: BoardPaths, tracker: Pick<Tracker, 'name' | 'parseRef'>, except?: string): Map<string, Held> {
  const out = new Map<string, Held>();
  for (const b of listBreakdowns(bp)) {
    if (b.id === except) continue;
    const root = b.source.kind === 'tracker' ? b.source.tracker?.ref : undefined;
    for (const { story } of allStories(b)) {
      const t = story.tracker;
      if (t?.module === tracker.name) out.set(t.id, { ...out.get(t.id), run: { id: b.id, key: story.key, ...(root ? { root } : {}) } });
    }
  }
  for (const t of listTickets(bp)) {
    if (t.source.type !== tracker.name || t.deleting || t.archived) continue;
    const id = t.source.id ?? (t.source.ref ? tracker.parseRef(t.source.ref) : null);
    if (id) out.set(id, { ...out.get(id), ticket: t.id });
  }
  return out;
}

/** Why an item held by another breakdown is not taken again: "In BR-3 already". */
export function heldWords(h: Held): string {
  return `In ${h.run!.id} already`;
}

/** The refusal when an item of a breakdown is started on its own: it starts from its breakdown. */
export function startsFromRun(ref: string, h: Held): string {
  return h.run!.root ? `${ref} is in ${h.run!.id}, the run of ${h.run!.root}: it starts from there.` : `${ref} is ${h.run!.key} of ${h.run!.id}: it starts from there.`;
}

/**
 * A live ticket a story has already and does not name yet: one made for it by a start that was cut off, or one on the
 * board for its tracker item (Start on the Backlog). Its line says which, for the activity.
 */
export function ticketBefore(bp: BoardPaths, b: Pick<Breakdown, 'id'>, story: Pick<BreakdownStory, 'key' | 'tracker'>): { ticket: Ticket; line: string } | undefined {
  const live = listTickets(bp).filter((t) => !t.deleting && !t.archived);
  const made = live.find((t) => t.breakdown?.id === b.id && t.breakdown.item === story.key);
  if (made) return { ticket: made, line: `${story.key} has its ticket ${made.id} from a start that was cut off: it carries on there` };
  const link = story.tracker;
  const pulled = link && live.find((t) => t.source.type === link.module && (t.source.id ? t.source.id === link.id : t.source.ref === link.ref));
  return pulled ? { ticket: pulled, line: `${story.key} is on the board already as ${pulled.id}, from ${link.ref}: it carries on there` } : undefined;
}
