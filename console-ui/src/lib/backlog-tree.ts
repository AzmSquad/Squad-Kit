import type { BacklogGroup, BacklogTree, WorkItemRow } from '../api/types';

/**
 * The backlog in the order people read it as a tree: each epic where its first item is in the backlog, what sits under
 * it in the backlog's own order, and last the items under no epic. The same order as `squad backlog`
 * (src/board/backlog-tree.ts). `under`: the groups and items above a line, so a folded one hides what is under it.
 */

export type BacklogLine =
  | { kind: 'group'; depth: number; group: BacklogGroup; under: string[]; items: WorkItemRow[] }
  | { kind: 'item'; depth: number; item: WorkItemRow; under: string[]; hasUnder: boolean }
  | { kind: 'loose' };

export function nestBacklog(items: WorkItemRow[], tree: BacklogTree | undefined): BacklogLine[] {
  if (!tree || !Object.keys(tree.above).length) return items.map((item) => ({ kind: 'item', depth: 0, item, under: [], hasUnder: false }));
  const groups = new Map(tree.groups.map((g) => [g.id, g]));
  const index = new Map(items.map((r, i) => [r.id, i]));
  const parentOf = (id: string) => {
    const p = tree.above[id];
    return p && p !== id && (index.has(p) || groups.has(p)) ? p : undefined;
  };
  const children = new Map<string, string[]>();
  for (const id of [...index.keys(), ...groups.keys()]) {
    const p = parentOf(id);
    if (p) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const first = new Map<string, number>();
  const firstOf = (id: string, seen = new Set<string>()): number => {
    if (first.has(id)) return first.get(id)!;
    if (seen.has(id)) return Infinity;
    seen.add(id);
    const n = Math.min(index.get(id) ?? Infinity, ...(children.get(id) ?? []).map((c) => firstOf(c, seen)));
    first.set(id, n);
    return n;
  };
  const lines: BacklogLine[] = [];
  const shown = new Set<string>();
  const walk = (id: string, depth: number, under: string[]): WorkItemRow[] => {
    if (shown.has(id)) return [];
    shown.add(id);
    const g = groups.get(id);
    const kids = [...(children.get(id) ?? [])].sort((a, b) => firstOf(a) - firstOf(b));
    if (g) {
      const line: BacklogLine = { kind: 'group', depth, group: g, under, items: [] };
      lines.push(line);
      const below = kids.flatMap((c) => walk(c, depth + 1, [...under, id]));
      line.items = below;
      return below;
    }
    const item = items[index.get(id)!]!;
    lines.push({ kind: 'item', depth, item, under, hasUnder: kids.length > 0 });
    return [item, ...kids.flatMap((c) => walk(c, depth + 1, [...under, id]))];
  };
  const byPlace = (a: string, b: string) => firstOf(a) - firstOf(b);
  for (const id of [...groups.keys()].filter((g) => !parentOf(g)).sort(byPlace)) walk(id, 0, []);
  // Groups in a loop of links (A under B under A) have no top: the first of them in the backlog heads the loop.
  for (const id of [...groups.keys()].filter((g) => !shown.has(g)).sort(byPlace)) walk(id, 0, []);
  const loose = items.filter((r) => !shown.has(r.id) && !parentOf(r.id));
  const left = () => items.filter((r) => !shown.has(r.id));
  if (loose.length || left().length) lines.push({ kind: 'loose' });
  for (const r of loose) walk(r.id, 0, []);
  for (const r of left()) walk(r.id, 0, []);
  return lines;
}

/** Hidden when anything above it is folded. */
export function folded(line: BacklogLine, closed: Set<string>): boolean {
  return line.kind !== 'loose' && line.under.some((id) => closed.has(id));
}
