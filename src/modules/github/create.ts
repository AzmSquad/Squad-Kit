import type { BugSeverity, ItemLevel, NewTrackerItem, TrackerItemChange, TrackerItemRow, TrackerLevels } from '../tracker/types.js';
import { bodyOf, textOf } from './body.js';
import type { GithubContext } from './context.js';
import { addToBoard, setOption, valueOf } from './project.js';
import { fromRest, LEVEL_LABEL, rowOf, typeOf, type RestIssue } from './queries.js';
import { idOf, refOf, splitRepo } from './refs.js';
import type { IssueDetail } from './queries.js';

/**
 * Making issues: a breakdown's epics, features and stories, with sub-issues for what sits under what and "blocked by"
 * for the order, and bugs. Each level is the organization's issue type of that name when it has one, else a label.
 */

const TYPE_NAME: Record<ItemLevel, RegExp> = { epic: /^epic$/i, feature: /^feature$/i, story: /^(user )?story$/i };
const LEVEL_NAME: Record<ItemLevel, string> = { epic: 'Epic', feature: 'Feature', story: 'Story' };
const LEVELS: ItemLevel[] = ['epic', 'feature', 'story'];

/** Per level: the issue type to set, or the label to add. */
async function levelPlan(ctx: GithubContext): Promise<Record<ItemLevel, { name: string; type?: string }>> {
  const types = await ctx.issueTypes();
  return Object.fromEntries(
    LEVELS.map((l) => {
      const type = types.find((t) => TYPE_NAME[l].test(t.name));
      return [l, type ? { name: type.name, type: type.name } : { name: LEVEL_NAME[l] }];
    }),
  ) as Record<ItemLevel, { name: string; type?: string }>;
}

export async function levelsOf(ctx: GithubContext): Promise<TrackerLevels> {
  const plan = await levelPlan(ctx);
  const byType = LEVELS.filter((l) => plan[l].type).length;
  const process = byType === 3 ? 'issue types' : byType ? 'issue types and labels' : 'labels';
  return { epic: plan.epic.name, feature: plan.feature.name, story: plan.story.name, process, project: ctx.own };
}

/**
 * On the board as not started, when the stories come from one, unless it is there with a Status already. `issue`: what
 * was read of it; a new issue has none. Safe to repeat: GitHub puts an issue on a board once.
 */
async function onBoard(ctx: GithubContext, nodeId: string, issue?: IssueDetail): Promise<void> {
  const stages = await ctx.stages();
  const start = stages?.map['not-started'];
  if (!stages || !start) return;
  const item = issue?.projectItems?.nodes.find((n) => n?.project.id === stages.board.id);
  if (item && valueOf(item.fieldValues.nodes, stages.board.status!.id)) return;
  await setOption(ctx.calls, stages.board, item?.id ?? (await addToBoard(ctx.calls, stages.board, nodeId)), stages.board.status!, start);
}

/** A new issue in the project's repo, put on the board as not started when the stories come from one. */
async function newIssue(ctx: GithubContext, input: { title: string; body: string; labels: string[]; type?: string }): Promise<TrackerItemRow> {
  ctx.writing();
  const { owner, name } = splitRepo(ctx.own);
  const made = await ctx.calls.rest<RestIssue>(`/repos/${owner}/${name}/issues`, {
    method: 'POST',
    body: { title: input.title, body: input.body, labels: [...new Set(input.labels)], ...(input.type ? { type: input.type } : {}) },
  });
  const issue = fromRest(made, ctx.own);
  const row = rowOf(issue, ctx.own);
  ctx.remember(row.id, issue.id);
  await onBoard(ctx, issue.id);
  return row;
}

export async function createIssue(ctx: GithubContext, input: NewTrackerItem): Promise<TrackerItemRow> {
  const level = (await levelPlan(ctx))[input.level];
  const row = await newIssue(ctx, {
    title: input.title,
    body: bodyOf(input.markdown, input.acceptance),
    labels: [...(input.tags ?? []), ...(level.type ? [] : [LEVEL_LABEL[input.level]])],
    ...(level.type ? { type: level.type } : {}),
  });
  if (input.parent) await setParent(ctx, row.id, input.parent, false);
  return { ...row, type: level.name };
}

/** Puts an issue under a parent. An issue has one: `replace` moves it from the one it had. */
async function setParent(ctx: GithubContext, id: string, parent: string, replace: boolean): Promise<void> {
  await ctx.calls.graphql(
    `mutation SquadAddSubIssue($parent: ID!, $child: ID!, $replace: Boolean) { addSubIssue(input: { issueId: $parent, subIssueId: $child, replaceParent: $replace }) { issue { id } } }`,
    { parent: await ctx.nodeId(parent), child: await ctx.nodeId(id), replace },
  );
}

/**
 * Changes an issue made before. Text left out stays as it is: new text keeps the issue's own Done when, and new Done
 * when keeps its text, so an epic sent again (it has no Done when) never loses one a person wrote there.
 */
export async function updateIssue(ctx: GithubContext, id: string, change: TrackerItemChange): Promise<void> {
  ctx.writing();
  const patch: Record<string, string> = {};
  if (change.title !== undefined) patch.title = change.title;
  const text = change.markdown !== undefined || change.acceptance !== undefined;
  const whole = change.markdown !== undefined && change.acceptance !== undefined;
  const issue = (text && !whole) || change.parent !== undefined ? await ctx.detail(id) : null;
  if (text) {
    const now = textOf(issue?.body);
    patch.body = bodyOf(change.markdown ?? now.description, change.acceptance ?? now.acceptance);
  }
  if (Object.keys(patch).length) await ctx.calls.rest(ctx.path(id), { method: 'PATCH', body: patch });
  if (change.parent === undefined) return;
  const had = issue?.parent ? idOf(issue.parent.repository.nameWithOwner, issue.parent.number) : null;
  if (had !== change.parent.toLowerCase()) await setParent(ctx, id, change.parent, Boolean(had));
}

/** "Blocked by" each issue it needs that it is not blocked by yet. */
export async function linkBlockedBy(ctx: GithubContext, id: string, on: string[]): Promise<void> {
  ctx.writing();
  const issue = await ctx.detail(id);
  const have = new Set(issue.blockedBy.nodes.filter(Boolean).map((b) => idOf(b.repository.nameWithOwner, b.number)));
  for (const dep of [...new Set(on.map((d) => d.toLowerCase()))].filter((d) => d !== id.toLowerCase() && !have.has(d))) {
    await ctx.calls.graphql(
      `mutation SquadAddBlockedBy($issue: ID!, $blocking: ID!) { addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) { issue { id } } }`,
      { issue: issue.id, blocking: await ctx.nodeId(dep) },
    );
  }
}

/**
 * An issue a cut-off send made: it has the breakdown's label and its "Made by squad-kit" line. The send may have been cut
 * off before it reached the board, so it is put there now.
 */
export async function findMadeIssue(ctx: GithubContext, input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
  const { owner, name } = splitRepo(ctx.own);
  const level = (await levelPlan(ctx))[input.level].name;
  const q = new URLSearchParams({ labels: input.tag, state: 'all', per_page: '100' });
  const found = (await ctx.calls.rest<RestIssue[]>(`/repos/${owner}/${name}/issues?${q.toString()}`)).find(
    (i) => !i.pull_request && (i.body ?? '').includes(input.mark) && typeOf(fromRest(i, ctx.own)) === level,
  );
  if (!found) return null;
  const row = rowOf(fromRest(found, ctx.own), ctx.own);
  ctx.writing();
  if (ctx.board()) await onBoard(ctx, found.node_id, await ctx.detail(row.id));
  return row;
}

const HOW_BAD: Record<BugSeverity, string> = { 'stops-work': 'Stops work', annoying: 'Annoying', small: 'Small' };

/** A bug: the bug label, and the Bug issue type when the organization has one. */
export async function fileBugIssue(ctx: GithubContext, input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
  const bug = (await ctx.issueTypes()).find((t) => /^bug$/i.test(t.name));
  const related = input.related.length ? `\n\nFound with: ${input.related.map((r) => refOf(r, ctx.own)).join(', ')}` : '';
  return newIssue(ctx, {
    title: input.title,
    body: `${input.steps.trim()}\n\n**How bad:** ${HOW_BAD[input.severity]}${related}`,
    labels: ['bug', ...input.tags],
    ...(bug ? { type: bug.name } : {}),
  });
}
