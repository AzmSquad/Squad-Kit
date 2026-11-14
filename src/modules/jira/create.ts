import { ModuleError } from '../errors.js';
import type { BugSeverity, ItemLevel, NewTrackerItem, TrackerItemChange, TrackerItemRow } from '../tracker/types.js';
import { adfToMarkdown } from './adf-read.js';
import { markdownToAdf } from './adf-write.js';
import type { JiraContext } from './context.js';
import { placeBeside, unlinkEpics } from './epic-links.js';
import { jqlText } from './refs.js';
import { levelPlan, nests, typeFor } from './levels.js';
import { blockedBy, labelOf, rowFields, rowOf, typeLevel, type RawIssue } from './rows.js';

/**
 * Making issues: a breakdown's epics, features and stories (levels.ts says which types), with Jira's parent field for
 * what sits under what (or a link and label where Jira cannot nest them), "is blocked by" links for the order, and
 * bugs. squad-kit never deletes an issue.
 */

/** How long Jira's search may take to find an issue just made. */
const FIND_AGAIN_MS = 5_000;

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

type Placed = RawIssue & { fields: { project?: { key?: string } } };

/** An issue's type, project, labels and links: where it sits, and what links it to an epic. */
function issueOf(ctx: JiraContext, key: string): Promise<Placed> {
  return ctx.client.call<Placed>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,project,labels,issuelinks`);
}

/** A title Jira takes: one line, at most 255 characters. */
function summaryOf(title: string): string {
  return title.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 255);
}

/**
 * The description, and the acceptance criteria in their own field when the screen (`screen`: its field ids) has one.
 * A type without it gets them at the end of its description, under Done when.
 */
async function textFields(ctx: JiraContext, screen: string[], markdown?: string, acceptance?: string): Promise<Record<string, unknown>> {
  const criteria = acceptance !== undefined ? (await ctx.fields()).criteria : undefined;
  if (criteria && screen.includes(criteria.id)) {
    return {
      ...(markdown !== undefined ? { description: markdownToAdf(markdown) } : {}),
      [criteria.id]: criteria.rich ? markdownToAdf(acceptance!) : acceptance!.trim().slice(0, 255),
    };
  }
  if (markdown === undefined && acceptance === undefined) return {};
  const text = [markdown ?? '', acceptance?.trim() ? `**Done when**\n\n${acceptance.trim()}` : ''].filter(Boolean).join('\n\n');
  return { description: markdownToAdf(text) };
}

/** Under its parent when Jira nests them; else beside it, linked and labelled (epic-links.ts). */
export async function createIssue(ctx: JiraContext, input: NewTrackerItem): Promise<TrackerItemRow> {
  ctx.writing();
  const project = ctx.project();
  const type = await typeFor(ctx, input.level);
  const parent = input.parent ? await issueOf(ctx, input.parent) : null;
  const under = parent ? nests(type.level, typeLevel(parent.fields.issuetype)) : false;
  const screen = (await ctx.createFields(project, type.id)).map((f) => f.fieldId);
  const labels = [...new Set((input.tags ?? []).map(labelOf).filter(Boolean))];
  const made = await ctx.client.call<{ key: string }>('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: project },
      issuetype: { id: type.id },
      summary: summaryOf(input.title),
      ...(await textFields(ctx, screen, input.markdown, input.acceptance)),
      // Labels only when there are some and the create screen has the field.
      ...(labels.length && screen.includes('labels') ? { labels } : {}),
      ...(parent && under ? { parent: { key: parent.key } } : {}),
    },
  });
  if (parent && !under) await placeBeside(ctx, { id: '', key: made.key, fields: {} }, { key: parent.key, title: parent.fields.summary ?? parent.key });
  return readRow(ctx, made.key);
}

/** A new parent replaces the old one: Jira's parent field, or the link and label to the epic it sat beside. */
export async function updateIssue(ctx: JiraContext, key: string, change: TrackerItemChange): Promise<void> {
  ctx.writing();
  const issue = await issueOf(ctx, key);
  // An update sets what the issue's edit screen has, which can differ from its create screen.
  const fields: Record<string, unknown> = {
    ...(change.title !== undefined ? { summary: summaryOf(change.title) } : {}),
    ...(await textFields(ctx, await ctx.editFields(key), change.markdown, change.acceptance)),
  };
  if (change.parent !== undefined) {
    const parent = await issueOf(ctx, change.parent);
    if (nests(typeLevel(issue.fields.issuetype), typeLevel(parent.fields.issuetype))) {
      fields.parent = { key: parent.key };
      await unlinkEpics(ctx, issue);
    } else await placeBeside(ctx, issue, { key: parent.key, title: parent.fields.summary ?? parent.key });
  }
  if (Object.keys(fields).length) await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
}

/** An item a cut-off send made: the newest of its level's types with the breakdown's label and this line in its text. */
export async function findMadeIssue(ctx: JiraContext, input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
  const type = await typeFor(ctx, input.level);
  const jql = `project = ${jqlText(ctx.project())} AND labels = ${jqlText(labelOf(input.tag))} AND issuetype = ${Number(type.id)} ORDER BY created DESC`;
  const fields = await ctx.fields();
  const look = async () => (await ctx.client.search<RawIssue>(jql, [...rowFields(fields), 'description'], 50)).issues.find((i) => adfToMarkdown(i.fields.description).includes(input.mark));
  // Jira's search catches up with a new issue a few seconds later: one made just before the cut is looked for twice.
  let hit = await look();
  if (!hit) {
    await ctx.client.wait(FIND_AGAIN_MS);
    hit = await look();
  }
  return hit ? rowOf(hit, fields, (k) => ctx.client.browseUrl(k)) : null;
}

/** "Is blocked by" each item it needs first; only the links it does not have yet. */
export async function linkBlockedBy(ctx: JiraContext, key: string, on: string[]): Promise<void> {
  ctx.writing();
  const blocks = await ctx.linkType((t) => t.name === 'Blocks' || /^is blocked by$/i.test(t.inward));
  if (!blocks) throw new ModuleError(`Jira at ${ctx.settings.site} has no Blocks link type, so squad-kit cannot say which stories need which.`, 'not-found');
  const issue = await ctx.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuelinks`);
  const have = new Set(blockedBy(issue.fields.issuelinks).map((d) => d.ref));
  // The issue needed first blocks this one.
  for (const need of [...new Set(on)].filter((k) => k !== key && !have.has(k))) await ctx.link(blocks.name, need, key);
}

/**
 * A bug: the project's Bug type (else its Story type with the bug label), its severity as the priority when the type's
 * screen has one, else in its text, and "relates to" links to the items it was found with.
 */
export async function fileBugIssue(ctx: JiraContext, input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
  ctx.writing();
  const project = ctx.project();
  const plan = await levelPlan(ctx);
  const type = plan.bug ?? plan.story;
  const create = await ctx.createFields(project, type.id);
  const choices = create.find((f) => f.fieldId === 'priority')?.allowedValues ?? [];
  const priority = SEVERITY[input.severity].priority.map((re) => choices.find((c) => re.test(c.name ?? ''))).find(Boolean);
  const text = [
    input.steps.trim(),
    priority ? '' : `**How bad:** ${SEVERITY[input.severity].words}`,
    input.related.length ? `Found with ${input.related.join(', ')}.` : '',
  ].filter(Boolean);
  const labels = [...new Set([...input.tags.map(labelOf), ...(plan.bug ? [] : ['bug'])].filter(Boolean))];
  const made = await ctx.client.call<{ key: string }>('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: project },
      issuetype: { id: type.id },
      summary: summaryOf(input.title),
      description: markdownToAdf(text.join('\n\n')),
      ...(labels.length && create.some((f) => f.fieldId === 'labels') ? { labels } : {}),
      ...(priority ? { priority: { id: priority.id } } : {}),
    },
  });
  const relates = input.related.length ? await ctx.linkType((t) => t.name === 'Relates' || /^relates to$/i.test(t.outward)) : undefined;
  for (const other of relates ? input.related : []) await ctx.link(relates!.name, made.key, other);
  return readRow(ctx, made.key);
}
