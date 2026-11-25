import type { TrackerChild, TrackerItemRow } from '../tracker/types.js';
import { htmlToText, type Azure, type RawItem, type WorkItemRow } from './client.js';

/**
 * What sits right under a work item on Azure Boards: its child links, read with their fields and links 200 at a time,
 * in backlog order (Stack Rank, or Backlog Priority where the process ranks by it, as Scrum does). A state's category
 * says whether the item is finished, so a renamed or custom state counts the same as Azure's own.
 */

const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward';
const NEEDS_LINK = 'System.LinkTypes.Dependency-Reverse';
/** The backlog's order: Agile, CMMI and Basic rank by Stack Rank, Scrum by Backlog Priority. */
const RANKS = ['Microsoft.VSTS.Common.StackRank', 'Microsoft.VSTS.Common.BacklogPriority'];
const BATCH = 200;
/** The categories of a state whose work is finished. */
const FINISHED = new Set(['Resolved', 'Completed', 'Removed']);

const idOf = (url: string) => Number(url.split('/').pop());
const text = (v: unknown) => (typeof v === 'string' ? htmlToText(v) : '');

/** Each type's states by name, with their category, read once per connection. A failed read is asked again next time. */
const kept = new WeakMap<Azure, Map<string, Map<string, string>>>();

async function categories(az: Azure, type: string): Promise<Map<string, string>> {
  const byType = kept.get(az) ?? new Map<string, Map<string, string>>();
  kept.set(az, byType);
  const hit = byType.get(type);
  if (hit) return hit;
  const read = await az.call<{ value?: { name: string; category: string }[] }>('GET', `_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`).catch(() => null);
  const map = new Map((read?.value ?? []).map((s) => [s.name, s.category]));
  if (read) byType.set(type, map);
  return map;
}

export async function azureChildren(az: Azure, id: number, toRow: (w: WorkItemRow) => TrackerItemRow): Promise<TrackerChild[]> {
  const item = await az.call<RawItem>('GET', `_apis/wit/workitems/${id}?$expand=relations`);
  const ids = [...new Set((item.relations ?? []).filter((r) => r.rel === CHILD_LINK).map((r) => idOf(r.url)))].filter((n) => Number.isInteger(n) && n > 0);
  const raws: RawItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const got = await az.call<{ value: (RawItem | null)[] }>('POST', '_apis/wit/workitemsbatch', { ids: ids.slice(i, i + BATCH), $expand: 'Relations', errorPolicy: 'omit' });
    raws.push(...got.value.filter((w): w is RawItem => Boolean(w)));
  }
  const rank = (w: RawItem) => {
    const n = RANKS.map((f) => w.fields?.[f]).find((v): v is number => typeof v === 'number');
    return n ?? Number.MAX_VALUE;
  };
  raws.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const out: TrackerChild[] = [];
  for (const w of raws) {
    const f = w.fields ?? {};
    const row = toRow(az.row(w));
    out.push({
      ...row,
      description: text(f['System.Description']),
      acceptanceCriteria: text(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
      reproSteps: text(f['Microsoft.VSTS.TCM.ReproSteps']),
      needs: (w.relations ?? []).filter((r) => r.rel === NEEDS_LINK).map((r) => String(idOf(r.url))),
      done: await finished(az, row),
    });
  }
  return out;
}

/** Whether a work item is finished, by its state's category; a state Azure does not list goes by its name. */
export async function finished(az: Azure, row: Pick<TrackerItemRow, 'type' | 'state'>): Promise<boolean> {
  const category = (await categories(az, row.type)).get(row.state);
  return category ? FINISHED.has(category) : /^(closed|done|removed|resolved)$/i.test(row.state);
}
