import type { TrackerGroup, TrackerItemRow, TrackerTree } from '../modules/tracker/types.js';

/**
 * A backlog in the order people read it as a tree: each epic, then what sits under it, every level in the backlog's own
 * order (a group goes where its first item is in the backlog), and last the items under no epic or feature. Used by the
 * terminal; the board orders its rows the same way (console-ui/src/lib/backlog-tree.ts).
 */

export type BacklogLine<R extends TrackerItemRow = TrackerItemRow> =
  | { kind: 'group'; depth: number; group: TrackerGroup }
  | { kind: 'item'; depth: number; item: R }
  | { kind: 'loose' };

export function nestBacklog<R extends TrackerItemRow>(items: R[], tree: TrackerTree | null | undefined): BacklogLine<R>[] {
  if (!tree || !Object.keys(tree.above).length) return items.map((item) => ({ kind: 'item', depth: 0, item }));
  const groups = new Map(tree.groups.map((g) => [g.id, g]));
  const index = new Map(items.map((r, i) => [r.id, i]));
  const known = (id: string) => index.has(id) || groups.has(id);
  const parentOf = (id: string) => {
    const p = tree.above[id];
    return p && known(p) && p !== id ? p : undefined;
  };
  const children = new Map<string, string[]>();
  for (const id of [...index.keys(), ...groups.keys()]) {
    const p = parentOf(id);
    if (p) children.set(p, [...(children.get(p) ?? []), id]);
  }
  // Where each node first shows in the backlog: its own place, or its first item's.
  const first = new Map<string, number>();
  const firstOf = (id: string, seen = new Set<string>()): number => {
    if (first.has(id)) return first.get(id)!;
    if (seen.has(id)) return Infinity;
    seen.add(id);
    const own = index.get(id) ?? Infinity;
    const n = Math.min(own, ...(children.get(id) ?? []).map((c) => firstOf(c, seen)));
    first.set(id, n);
    return n;
  };
  const byPlace = (a: string, b: string) => firstOf(a) - firstOf(b);
  const lines: BacklogLine<R>[] = [];
  const shown = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (shown.has(id)) return;
    shown.add(id);
    const g = groups.get(id);
    if (g) lines.push({ kind: 'group', depth, group: g });
    else lines.push({ kind: 'item', depth, item: items[index.get(id)!]! });
    for (const c of [...(children.get(id) ?? [])].sort(byPlace)) walk(c, depth + 1);
  };
  for (const id of [...groups.keys()].filter((g) => !parentOf(g)).sort(byPlace)) walk(id, 0);
  // Groups in a loop of links (A under B under A) have no top: the first of them in the backlog heads the loop.
  for (const id of [...groups.keys()].filter((g) => !shown.has(g)).sort(byPlace)) walk(id, 0);
  // Under no epic or feature, with what sits under them (a bug under a story); and any item a loop of links hid.
  const loose = items.filter((r) => !shown.has(r.id) && !parentOf(r.id));
  const left = () => items.filter((r) => !shown.has(r.id));
  if (loose.length || left().length) lines.push({ kind: 'loose' });
  for (const r of loose) walk(r.id, 0);
  for (const r of left()) walk(r.id, 0);
  return lines;
}
