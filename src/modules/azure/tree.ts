import type { TrackerItemRow, TrackerTree } from '../tracker/types.js';
import { walkUp, type AboveItem } from '../tracker/tree.js';
import { ROW_FIELDS, type Azure, type RawItem, type WorkItemRow } from './client.js';

/**
 * How Azure Boards nests a backlog: each work item's parent link, read through the System.Parent field, 200 items per
 * call. A server too old for that field (Azure DevOps Server before 2020) gives the links with the items instead.
 */

const PARENT_FIELD = 'System.Parent';
const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse';
/** Azure reads at most this many work items per call. */
const BATCH = 200;

function parentOf(w: RawItem): string | undefined {
  const field = w.fields?.[PARENT_FIELD];
  if (typeof field === 'number' && field > 0) return String(field);
  const link = (w.relations ?? []).find((r) => r.rel === PARENT_LINK);
  const id = link ? Number(link.url.split('/').pop()) : NaN;
  return Number.isInteger(id) && id > 0 ? String(id) : undefined;
}

/** The work items, with their fields and parent link, in batches. `fields` left out: every field and the links. */
async function batch(az: Azure, ids: number[], fields: string[] | null): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const body = fields ? { ids: ids.slice(i, i + BATCH), fields, errorPolicy: 'omit' } : { ids: ids.slice(i, i + BATCH), $expand: 'Relations', errorPolicy: 'omit' };
    const got = await az.call<{ value: (RawItem | null)[] }>('POST', '_apis/wit/workitemsbatch', body);
    out.push(...got.value.filter((w): w is RawItem => Boolean(w)));
  }
  return out;
}

/** Servers that said they do not know the parent field: asked with the links from then on. */
const noParentField = new WeakSet<Azure>();

/** Read with the parent field, or, where the server does not know it (it says 400), with the links. */
async function withParents(az: Azure, ids: number[], fields: string[]): Promise<RawItem[]> {
  if (noParentField.has(az)) return batch(az, ids, null);
  try {
    return await batch(az, ids, [...fields, PARENT_FIELD]);
  } catch (err) {
    if ((err as { status?: number }).status !== 400) throw err;
    noParentField.add(az);
    return batch(az, ids, null);
  }
}

export async function azureTree(az: Azure, rows: TrackerItemRow[], toRow: (w: WorkItemRow) => TrackerItemRow): Promise<TrackerTree> {
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  const first: Record<string, string> = {};
  for (const w of await withParents(az, ids, ['System.Id'])) {
    const p = parentOf(w);
    if (p) first[String(w.id)] = p;
  }
  return walkUp(rows, first, async (above) => {
    const found = new Map<string, AboveItem>();
    for (const w of await withParents(az, above.map(Number), ROW_FIELDS)) {
      const parent = parentOf(w);
      found.set(String(w.id), { row: toRow(az.row(w)), ...(parent ? { parent } : {}) });
    }
    return found;
  });
}
