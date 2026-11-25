import type { TrackerChild } from '../tracker/types.js';
import type { JiraContext } from './context.js';
import { jqlText } from './refs.js';
import { blockedBy, rowFields, rowOf, type RawIssue } from './rows.js';
import { issueText } from './text.js';

/**
 * What sits right under an issue on Jira: the issues whose parent it is (an epic's stories, an initiative's epics, a
 * story's sub-tasks), in the backlog's rank order, with their text and what each one is blocked by. An item squad-kit
 * put beside its epic, where Jira cannot nest it, is linked to it, not under it, so it is not among them.
 */

const CAP = 500;

export async function jiraChildren(ctx: JiraContext, key: string): Promise<TrackerChild[]> {
  const fields = await ctx.fields();
  const want = [...rowFields(fields), 'description', 'issuelinks', ...(fields.criteria ? [fields.criteria.id] : [])];
  const found = await ctx.client.search<RawIssue>(`parent = ${jqlText(key)} ORDER BY Rank ASC`, want, CAP);
  return found.issues.map((issue) => {
    const text = issueText(issue, fields);
    return {
      ...rowOf(issue, fields, (k) => ctx.client.browseUrl(k)),
      description: text.description,
      acceptanceCriteria: text.acceptance,
      reproSteps: '',
      needs: blockedBy(issue.fields.issuelinks).map((d) => d.ref),
      done: issue.fields.status?.statusCategory?.key === 'done',
    };
  });
}
