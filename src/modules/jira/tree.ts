import type { TrackerItemRow, TrackerTree } from '../tracker/types.js';
import { walkUp, type AboveItem } from '../tracker/tree.js';
import type { JiraClient } from './client.js';
import type { JiraContext } from './context.js';
import { jqlText } from './refs.js';
import { rowFields, rowOf, type RawIssue } from './rows.js';

/**
 * How Jira nests a backlog: each issue's parent (an epic, or an initiative above it on plans that have one), read with
 * the paged JQL search, 100 keys a search. An item squad-kit put beside its epic, where Jira cannot nest it, shows on
 * its own here: that link is a "relates to", not a parent.
 */

const KEYS_PER_SEARCH = 100;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

/**
 * The issues, 100 keys a search. Jira refuses a whole search (400) when one key is gone or hidden from this account (an
 * epic in a project it cannot browse), so such a part is read one issue at a time instead, leaving out the missing ones.
 */
async function search(client: JiraClient, keys: string[], fields: string[]): Promise<RawIssue[]> {
  const ok = [...new Set(keys)].filter((k) => KEY.test(k));
  const out: RawIssue[] = [];
  for (let i = 0; i < ok.length; i += KEYS_PER_SEARCH) {
    const part = ok.slice(i, i + KEYS_PER_SEARCH);
    try {
      out.push(...(await client.search<RawIssue>(`key in (${part.map(jqlText).join(', ')})`, fields, part.length)).issues);
    } catch (err) {
      if ((err as { status?: number }).status !== 400) throw err;
      for (const key of part) {
        const one = await client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`).catch((e: unknown) => {
          if ((e as { status?: number }).status === 404) return null;
          throw e;
        });
        if (one?.key) out.push(one);
      }
    }
  }
  return out;
}

export async function jiraTree(ctx: JiraContext, rows: TrackerItemRow[]): Promise<TrackerTree> {
  const client = ctx.client;
  const first: Record<string, string> = {};
  for (const issue of await search(client, rows.map((r) => r.id), ['parent'])) {
    if (issue.fields.parent?.key) first[issue.key] = issue.fields.parent.key;
  }
  const fields = await ctx.fields();
  return walkUp(rows, first, async (keys) => {
    const found = new Map<string, AboveItem>();
    for (const issue of await search(client, keys, [...rowFields(fields), 'parent'])) {
      const parent = issue.fields.parent?.key;
      found.set(issue.key, { row: rowOf(issue, fields, (k) => client.browseUrl(k)), ...(parent ? { parent } : {}) });
    }
    return found;
  });
}
