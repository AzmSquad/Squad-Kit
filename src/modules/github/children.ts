import { ModuleError } from '../errors.js';
import type { TrackerChild } from '../tracker/types.js';
import { textOf } from './body.js';
import type { GithubContext } from './context.js';
import { ISSUE_ROW, rowOf, type IssueNode } from './queries.js';
import { idOf } from './refs.js';

/**
 * What sits right under an issue on GitHub: its sub-issues, in their own order, with their text, the issues each one is
 * blocked by, and whether it has sub-issues of its own (a group, in a repo with no issue types or level labels), in one
 * query. GitHub holds at most 100 sub-issues under one issue.
 */

const QUERY = `query SquadChildren($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) {
  subIssues(first: 100) { nodes { ...SquadIssueRow body subIssuesSummary { total } blockedBy(first: 50) { nodes { number repository { nameWithOwner } } } } }
} } }
${ISSUE_ROW}`;

interface ChildNode extends IssueNode {
  body: string | null;
  subIssuesSummary?: { total: number } | null;
  blockedBy: { nodes: ({ number: number; repository: { nameWithOwner: string } } | null)[] };
}

type Answer = { repository: { issue: { subIssues: { nodes: (ChildNode | null)[] } } | null } | null };

/**
 * `wanted`: an issue squad-kit may read as a story. One written by someone outside the team comes as an outsider with no
 * words, so it can be named as left out and its words never reach the agents.
 */
export async function githubChildren(ctx: GithubContext, id: string, wanted: (issue: IssueNode) => boolean): Promise<TrackerChild[]> {
  const k = ctx.key(id);
  const data = await ctx.calls.graphql<Answer>(QUERY, { owner: k.owner, name: k.name, number: k.number });
  const issue = data.repository?.issue;
  if (!issue) throw new ModuleError(`GitHub has no issue ${k.owner}/${k.name}#${k.number}.`, 'not-found');
  return issue.subIssues.nodes
    .filter((n): n is ChildNode => Boolean(n))
    .map((n) => {
      const row = rowOf(n, ctx.own);
      const done = n.state !== 'OPEN';
      if (!wanted(n)) return { ...row, description: '', acceptanceCriteria: '', reproSteps: '', needs: [], done, outsider: true };
      const text = textOf(n.body);
      const needs = n.blockedBy.nodes.flatMap((b) => (b ? [idOf(b.repository.nameWithOwner, b.number)] : []));
      return { ...row, description: text.description, acceptanceCriteria: text.acceptance, reproSteps: '', needs, done, ...(n.subIssuesSummary?.total ? { hasChildren: true } : {}) };
    });
}
