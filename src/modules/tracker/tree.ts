import { createHash } from 'node:crypto';
import { writeLog } from '../../core/app-log.js';
import type { Tracker, TrackerGroup, TrackerItemRow, TrackerTree } from './types.js';

/**
 * A backlog's tree, built the same way for every tracker: a module says what is right above the listed items and reads
 * the items above them; this walks up from the listed items, at most three levels, and names each group an epic or a
 * feature. Only the Tracker interface is used here, never a product (ADR-002).
 */

/** How far above a listed item the tree reaches: its feature, its epic, and one above that (an initiative). */
export const TREE_DEPTH = 3;

/** An item above the listed ones, as a module read it: its row and the item right above it. */
export interface AboveItem {
  row: TrackerItemRow;
  parent?: string;
}

/** An epic when its type says so (Epic, Initiative, Theme) or when another group sits under it; else a feature. */
export function groupLevel(type: string, hasGroupBelow: boolean): TrackerGroup['level'] {
  if (/epic|initiative|theme|portfolio/i.test(type)) return 'epic';
  if (/feature/i.test(type)) return 'feature';
  return hasGroupBelow ? 'epic' : 'feature';
}

/**
 * The tree, from the item right above each listed item (`first`, by id) and a way to read items by id. `read` answers
 * with the items it found; one it cannot find (gone, or not readable with this sign-in) is left out, and what sits under
 * it shows on its own. A listed item above another listed item stays where it is listed (a bug under a story), unless it is
 * an epic or a feature itself: a tracker that lists them with the stories (GitHub's Issues) gets them as groups too.
 */
export async function walkUp(rows: TrackerItemRow[], first: Record<string, string>, read: (ids: string[]) => Promise<Map<string, AboveItem>>): Promise<TrackerTree> {
  const listed = new Set(rows.map((r) => r.id));
  const above: Record<string, string> = {};
  for (const r of rows) if (first[r.id] && first[r.id] !== r.id) above[r.id] = first[r.id]!;
  const found = new Map<string, AboveItem>();
  let next = [...new Set(Object.values(above))].filter((id) => !listed.has(id));
  for (let depth = 0; depth < TREE_DEPTH && next.length; depth += 1) {
    const asked = new Set(next);
    const up = new Set<string>();
    for (const [id, item] of await read(next)) {
      // Only what was asked for: a tracker that answers with another item (moved, renamed) adds nothing.
      if (!asked.has(id) || listed.has(id) || found.has(id)) continue;
      found.set(id, item);
      if (item.parent && item.parent !== id) {
        above[id] = item.parent;
        up.add(item.parent);
      }
    }
    next = [...up].filter((id) => !listed.has(id) && !found.has(id));
  }
  // A link to an item that was not read (too far up, gone, or refused) is dropped, so nothing points nowhere.
  for (const [id, p] of Object.entries(above)) if (!listed.has(p) && !found.has(p)) delete above[id];
  const listedGroups = rows.filter((r) => listedGroup(r, rows.filter((c) => above[c.id] === r.id)));
  const groupIds = new Set([...found.keys(), ...listedGroups.map((r) => r.id)]);
  const withGroupBelow = new Set([...groupIds].map((id) => above[id]).filter(Boolean));
  const groups = [...[...found.values()].map(({ row }) => row), ...listedGroups].map((row) => ({ ...row, level: groupLevel(row.type, withGroupBelow.has(row.id)) }));
  return { above, groups };
}

/**
 * A listed item that is a group: an epic or a feature by its type, or, where the tracker has no such types (GitHub
 * issues with no labels), an item that is not a bug with something under it that is not a bug either.
 */
function listedGroup(r: TrackerItemRow, under: TrackerItemRow[]): boolean {
  if (!under.length) return false;
  return /epic|feature|initiative|theme|portfolio/i.test(r.type) || (!r.isBug && under.some((c) => !c.isBug));
}

/** How long a backlog's tree is kept for the same items: the Backlog page asks again every few seconds. */
const KEEP_MS = 60_000;
const kept = new Map<string, { at: number; tree: Promise<TrackerTree | null> }>();

/**
 * The tree for a backlog, read again at most once a minute for the same items. A read still going on is shared, and
 * one that failed is kept as no tree for the minute too, so a broken tree is not asked for every few seconds. Never
 * throws: null when the tracker has no tree or it could not be read (the log says why).
 */
export function backlogTree(tracker: Tracker, rows: TrackerItemRow[]): Promise<TrackerTree | null> {
  if (!tracker.tree || !rows.length) return Promise.resolve(null);
  const ids = createHash('sha1').update(rows.map((r) => r.id).sort().join('\n')).digest('hex');
  const key = `${tracker.name}/${tracker.identity}/${ids}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.tree;
  const tree = tracker.tree(rows).catch((err: unknown) => {
    writeLog({ level: 'warn', text: `Reading the epics and features above the backlog: ${(err as Error).message}` });
    return null;
  });
  kept.delete(key);
  kept.set(key, { at: Date.now(), tree });
  // The oldest go first: a few sprints and views are kept, never every list ever read.
  while (kept.size > 20) kept.delete(kept.keys().next().value!);
  return tree;
}
