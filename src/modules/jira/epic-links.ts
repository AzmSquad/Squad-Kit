import { ModuleError } from '../errors.js';
import type { JiraContext } from './context.js';
import { labelOf, typeLevel, type RawIssue, type RawLink } from './rows.js';

/**
 * Where Jira cannot nest an item under its epic (a feature that is an Epic under an epic that is an Epic too, or a story
 * straight under an epic above Epic), the item sits beside the epic instead: it carries a label made from the epic's
 * name, so Jira's filters group them, and an outgoing "relates to" link to it, so squad-kit finds its epic again.
 * squad-kit reads such a link as the item's parent only on an item with an epic label.
 */

const PREFIX = 'epic-';

/** The label for an epic's items: "epic-front-desk". */
function epicLabel(name: string): string {
  return labelOf(`${PREFIX}${name.trim().toLowerCase()}`).slice(0, 255);
}

type LinkType = { name: string; inward: string; outward: string };

/** "relates to", or the closest the site has: a link that reads the same both ways. */
const relatesLike = (t: Partial<LinkType> | undefined) => Boolean(t && (t.name === 'Relates' || /relate/i.test(t.outward ?? '') || (t.inward && t.inward === t.outward)));

async function relatesType(ctx: JiraContext): Promise<LinkType> {
  const type = (await ctx.linkType((t) => t.name === 'Relates')) ?? (await ctx.linkType(relatesLike));
  if (!type) throw new ModuleError(`Jira at ${ctx.settings.site} has no "relates to" link type, so squad-kit cannot link an item to its epic.`, 'not-found');
  return type;
}

interface EpicLink {
  /** The link's own id, to take it away when the item moves to another epic. */
  linkId: string;
  key: string;
  title: string;
  type: string;
}

/** The epic an item sits beside: its outgoing "relates to" links to an item no lower than it, when it has an epic label. */
function epicLinks(issue: RawIssue): EpicLink[] {
  const f = issue.fields;
  if (!(f.labels ?? []).some((l) => l.startsWith(PREFIX))) return [];
  const own = typeLevel(f.issuetype);
  return (f.issuelinks ?? [])
    .filter((l): l is RawLink & { outwardIssue: NonNullable<RawLink['outwardIssue']> } => Boolean(l.outwardIssue) && relatesLike(l.type as Partial<LinkType>))
    .filter((l) => typeLevel(l.outwardIssue.fields?.issuetype) >= own)
    .map((l) => ({ linkId: l.id ?? '', key: l.outwardIssue.key, title: l.outwardIssue.fields?.summary ?? '', type: l.outwardIssue.fields?.issuetype?.name ?? '' }));
}

/** The item right above: Jira's parent, else the epic it sits beside. */
export function itemAbove(issue: RawIssue): { key: string; type: string; title: string } | null {
  const p = issue.fields.parent;
  if (p) return { key: p.key, type: p.fields?.issuetype?.name ?? '', title: p.fields?.summary ?? '' };
  return epicLinks(issue)[0] ?? null;
}

/** True when the item already has an outgoing "relates to" link to this one. */
function relatesTo(issue: RawIssue, key: string): boolean {
  return (issue.fields.issuelinks ?? []).some((l) => l.outwardIssue?.key === key && relatesLike(l.type as Partial<LinkType>));
}

/**
 * Puts an item beside its epic: the epic's label (when its edit screen has labels) and "this relates to the epic",
 * each only when it is not there yet. Its links to another epic, and their labels, go first.
 */
export async function placeBeside(ctx: JiraContext, issue: RawIssue, epic: { key: string; title: string }): Promise<void> {
  const label = epicLabel(epic.title);
  await unlinkEpics(ctx, issue, { key: epic.key, label });
  if (!(issue.fields.labels ?? []).includes(label) && (await ctx.editFields(issue.key)).includes('labels')) {
    await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, { update: { labels: [{ add: label }] } });
  }
  if (!relatesTo(issue, epic.key)) await ctx.link((await relatesType(ctx)).name, issue.key, epic.key);
}

/** Takes an item from beside the epics it had (all but `keep`): those links and epic labels go; the items stay. */
export async function unlinkEpics(ctx: JiraContext, issue: RawIssue, keep?: { key: string; label: string }): Promise<void> {
  for (const link of epicLinks(issue)) {
    if (link.linkId && link.key !== keep?.key) await ctx.client.call('DELETE', `/rest/api/3/issueLink/${encodeURIComponent(link.linkId)}`);
  }
  const labels = (issue.fields.labels ?? []).filter((l) => l.startsWith(PREFIX) && l !== keep?.label);
  if (labels.length) await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, { update: { labels: labels.map((l) => ({ remove: l })) } });
}
