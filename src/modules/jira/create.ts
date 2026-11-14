import { ModuleError } from '../errors.js';
import type { BugSeverity, ItemLevel, NewTrackerItem, TrackerItemChange, TrackerItemRow } from '../tracker/types.js';
import { adfToMarkdown } from './adf-read.js';
import { markdownToAdf } from './adf-write.js';
import type { JiraContext } from './context.js';
import { levelPlan, typeFor } from './levels.js';
import { blockedBy, labelOf, rowFields, rowOf, type RawIssue } from './rows.js';

/**
 * Making issues: a breakdown's epics, features and stories (levels.ts says which types), with Jira's parent field for
 * what sits under what and "is blocked by" links for the order, and bugs. squad-kit never deletes an issue.
 */

const SEVERITY: Record<BugSeverity, { words: string; priority: RegExp[] }> = {
  'stops-work': { words: 'Stops work', priority: [/^highest$/i, /^high$/i, /highest|high|critical|blocker/i] },
  annoying: { words: 'Annoying', priority: [/^medium$/i, /medium|normal/i] },
  small: { words: 'Small', priority: [/^low$/i, /low|minor/i] },
};

/** An issue as a row, read again after a change. */
async function readRow(ctx: JiraContext, key: string): Promise<TrackerItemRow> {
  const fields = await ctx.fields();
  const issue = await ctx.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${rowFields(fields).join(',')}`);
  return rowOf(issue, fields, (k) => ctx.client.browseUrl(k));
}

/** Where an issue sits in Jira's hierarchy: 1 an Epic, 0 a Story or Task, -1 a Sub-task. */
async function levelOf(ctx: JiraContext, key: string): Promise<{ level: number; typeId: string; project: string }> {
  const issue = await ctx.client.call<RawIssue & { fields: { project?: { key?: string } } }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuetype,project`);
  const t = issue.fields.issuetype ?? {};
  const level = typeof t.hierarchyLevel === 'number' ? t.hierarchyLevel : t.subtask ? -1 : /^epic$/i.test(t.name ?? '') ? 1 : 0;
  return { level, typeId: String(t.id ?? ''), project: issue.fields.project?.key ?? ctx.project() };
}

/**
 * The description, and the acceptance criteria in their own field when the type's screen has one. A type without it
 * gets them at the end of its description, under Done when.
 */
async function textFields(ctx: JiraContext, project: string, typeId: string, markdown?: string, acceptance?: string): Promise<Record<string, unknown>> {
  const criteria = acceptance !== undefined ? (await ctx.fields()).criteria : undefined;
  if (criteria && (await ctx.createFields(project, typeId)).some((f) => f.fieldId === criteria.id)) {
    return {
      ...(markdown !== undefined ? { description: markdownToAdf(markdown) } : {}),
      [criteria.id]: criteria.rich ? markdownToAdf(acceptance!) : acceptance!.trim().slice(0, 255),
    };
  }
  if (markdown === undefined && acceptance === undefined) return {};
  const text = [markdown ?? '', acceptance?.trim() ? `**Done when**\n\n${acceptance.trim()}` : ''].filter(Boolean).join('\n\n');
  return { description: markdownToAdf(text) };
}

export async function createIssue(ctx: JiraContext, input: NewTrackerItem): Promise<TrackerItemRow> {
  ctx.writing();
  const project = ctx.project();
  const parent = input.parent ? await levelOf(ctx, input.parent) : null;
  const type = await typeFor(ctx, input.level, parent?.level ?? null);
  const made = await ctx.client.call<{ key: string }>('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: project },
      issuetype: { id: type.id },
      summary: input.title,
      ...(await textFields(ctx, project, type.id, input.markdown, input.acceptance)),
      ...(input.tags?.length ? { labels: [...new Set(input.tags.map(labelOf))] } : {}),
      ...(input.parent ? { parent: { key: input.parent } } : {}),
    },
  });
  return readRow(ctx, made.key);
}

export async function updateIssue(ctx: JiraContext, key: string, change: TrackerItemChange): Promise<void> {
  ctx.writing();
  const { typeId, project } = await levelOf(ctx, key);
  const fields: Record<string, unknown> = {
    ...(change.title !== undefined ? { summary: change.title } : {}),
    ...(await textFields(ctx, project, typeId, change.markdown, change.acceptance)),
    // An issue has one parent: setting it moves the issue from the one it had.
    ...(change.parent !== undefined ? { parent: { key: change.parent } } : {}),
  };
  if (Object.keys(fields).length) await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
}

/** An item a cut-off send made: the newest of its level's types with the breakdown's label and this line in its text. */
export async function findMadeIssue(ctx: JiraContext, input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
  const plan = await levelPlan(ctx);
  const types = input.level === 'epic' ? [plan.epic] : input.level === 'feature' ? [plan.standard] : [plan.standard, ...(plan.subtask ? [plan.subtask] : [])];
  const jql = `project = "${ctx.project()}" AND labels = "${labelOf(input.tag).replace(/"/g, '')}" AND issuetype in (${types.map((t) => t.id).join(', ')}) ORDER BY created DESC`;
  const fields = await ctx.fields();
  const found = await ctx.client.search<RawIssue>(jql, [...rowFields(fields), 'description'], 50);
  const hit = found.issues.find((i) => adfToMarkdown(i.fields.description).includes(input.mark));
  return hit ? rowOf(hit, fields, (k) => ctx.client.browseUrl(k)) : null;
}

/** "Is blocked by" each item it needs first; only the links it does not have yet. */
export async function linkBlockedBy(ctx: JiraContext, key: string, on: string[]): Promise<void> {
  ctx.writing();
  const blocks = await ctx.linkType((t) => t.name === 'Blocks' || /^is blocked by$/i.test(t.inward));
  if (!blocks) throw new ModuleError(`Jira at ${ctx.settings.site} has no Blocks link type, so squad-kit cannot say which stories need which.`, 'not-found');
  const issue = await ctx.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuelinks`);
  const have = new Set(blockedBy(issue.fields.issuelinks).map((d) => d.ref));
  for (const need of [...new Set(on)].filter((k) => k !== key && !have.has(k))) {
    // Seen from this issue, as Jira shows it: the issue it needs is on the inward side, "is blocked by".
    await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { issuelinks: [{ add: { type: { name: blocks.name }, inwardIssue: { key: need } } }] } });
  }
}

/**
 * A bug: the project's Bug type (else its Story type with the bug label), its severity as the priority when the type's
 * screen has one, else in its text, and "relates to" links to the items it was found with.
 */
export async function fileBugIssue(ctx: JiraContext, input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
  ctx.writing();
  const project = ctx.project();
  const plan = await levelPlan(ctx);
  const type = plan.bug ?? plan.standard;
  const create = await ctx.createFields(project, type.id);
  const choices = create.find((f) => f.fieldId === 'priority')?.allowedValues ?? [];
  const priority = SEVERITY[input.severity].priority.map((re) => choices.find((c) => re.test(c.name ?? ''))).find(Boolean);
  const text = [
    input.steps.trim(),
    priority ? '' : `**How bad:** ${SEVERITY[input.severity].words}`,
    input.related.length ? `Found with ${input.related.join(', ')}.` : '',
  ].filter(Boolean);
  const made = await ctx.client.call<{ key: string }>('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: project },
      issuetype: { id: type.id },
      summary: input.title,
      description: markdownToAdf(text.join('\n\n')),
      labels: [...new Set([...input.tags.map(labelOf), ...(plan.bug ? [] : ['bug'])])],
      ...(priority ? { priority: { id: priority.id } } : {}),
    },
  });
  const relates = input.related.length ? await ctx.linkType((t) => t.name === 'Relates' || /^relates to$/i.test(t.outward)) : undefined;
  for (const other of relates ? input.related : []) {
    await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(made.key)}`, { update: { issuelinks: [{ add: { type: { name: relates!.name }, outwardIssue: { key: other } } }] } });
  }
  return readRow(ctx, made.key);
}
