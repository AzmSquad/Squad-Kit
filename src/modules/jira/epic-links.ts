import { ModuleError } from '../errors.js';
import type { JiraContext } from './context.js';
import { labelOf, type RawIssue } from './rows.js';

/**
 * Where Jira cannot nest an item under its epic (a feature that is an Epic under an epic that is an Epic too, or a story
 * straight under an epic above Epic), the item sits beside the epic instead: a label made from the epic's name, so
 * Jira's filters group them, and a "relates to" link to it.
 *
 * squad-kit keeps what it made in a property of the item (Jira's issue properties, unseen by people): the epic, the
 * link's id and the label. Only that counts as the item's epic, and only that is ever taken away: a teammate's link to
 * another Epic, or a team label like epic-q3-roadmap, stays as it is.
 */

const PROPERTY = 'squad-kit-epic';

/** What squad-kit made to put an item beside its epic. */
interface Placed {
  epic: string;
  link?: string;
  label?: string;
}

/** The label for an epic's items: "epic-front-desk". */
function epicLabel(name: string): string {
  return labelOf(`epic-${name.trim().toLowerCase()}`).slice(0, 255);
}

type LinkType = { name: string; inward: string; outward: string };

/** "relates to", or the closest the site has: a type named or worded like it. */
const relatesLike = (t: Partial<LinkType> | undefined) => Boolean(t && [t.name, t.outward, t.inward].some((w) => /relate/i.test(w ?? '')));

async function relatesType(ctx: JiraContext): Promise<LinkType> {
  const type = (await ctx.linkType((t) => t.name === 'Relates')) ?? (await ctx.linkType(relatesLike));
  if (!type) throw new ModuleError(`Jira at ${ctx.settings.site} has no "relates to" link type, so squad-kit cannot link an item to its epic.`, 'not-found');
  return type;
}

const propertyPath = (key: string) => `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${PROPERTY}`;

/** What squad-kit recorded on the item, or null when it put it beside no epic. */
async function placedOf(ctx: JiraContext, key: string): Promise<Placed | null> {
  try {
    const p = await ctx.client.call<{ value?: Placed }>('GET', propertyPath(key));
    return p?.value?.epic ? p.value : null;
  } catch (err) {
    if (err instanceof ModuleError && err.kind === 'not-found') return null;
    throw err;
  }
}

/** The "relates to" link between the item and another, on either side: Jira may show a link from either end. */
function relatesLink(issue: RawIssue, other: string, gone?: string) {
  return (issue.fields.issuelinks ?? []).find((l) => l.id !== gone && relatesLike(l.type) && (l.outwardIssue ?? l.inwardIssue)?.key === other);
}

/** The item right above: Jira's parent, else the epic squad-kit put it beside, while that link is still there. */
export async function itemAbove(ctx: JiraContext, issue: RawIssue): Promise<{ key: string; type: string; title: string } | null> {
  const p = issue.fields.parent;
  if (p) return { key: p.key, type: p.fields?.issuetype?.name ?? '', title: p.fields?.summary ?? '' };
  const placed = await placedOf(ctx, issue.key);
  const link = placed ? relatesLink(issue, placed.epic) : undefined;
  const other = link?.outwardIssue ?? link?.inwardIssue;
  return other ? { key: other.key, type: other.fields?.issuetype?.name ?? '', title: other.fields?.summary ?? '' } : null;
}

/**
 * Puts an item beside its epic: the epic's label (when its edit screen has labels) and "relates to" the epic, and records
 * them on the item. Sent again for the same epic, it changes nothing; for another one, what squad-kit made before goes.
 */
export async function placeBeside(ctx: JiraContext, issue: RawIssue, epic: { key: string; title: string }): Promise<void> {
  const label = epicLabel(epic.title);
  const before = await placedOf(ctx, issue.key);
  if (before?.epic === epic.key && relatesLink(issue, epic.key) && (!before.label || before.label === label)) return;
  const removed = await unlinkEpics(ctx, issue, before);
  const path = `/rest/api/3/issue/${encodeURIComponent(issue.key)}`;
  // Only what squad-kit makes here is recorded: a label or a link a teammate made already is used, never claimed.
  const made: Placed = { epic: epic.key };
  const hasLabel = (issue.fields.labels ?? []).includes(label) && removed.label !== label;
  if (!hasLabel && (await ctx.editFields(issue.key)).includes('labels')) {
    await ctx.client.call('PUT', path, { update: { labels: [{ add: label }] } });
    made.label = label;
  }
  if (!relatesLink(issue, epic.key, removed.link)) {
    const had = new Set((issue.fields.issuelinks ?? []).map((l) => l.id));
    await ctx.link((await relatesType(ctx)).name, issue.key, epic.key);
    const back = await ctx.client.call<RawIssue>('GET', `${path}?fields=issuelinks`);
    const fresh = (back?.fields.issuelinks ?? []).filter((l) => l.id && !had.has(l.id) && relatesLike(l.type) && (l.outwardIssue ?? l.inwardIssue)?.key === epic.key);
    if (fresh.length === 1) made.link = fresh[0]!.id;
  }
  await ctx.client.call('PUT', propertyPath(issue.key), made);
}

/**
 * Takes an item from beside the epic squad-kit put it beside: the link and label it made go, nothing else. Says what
 * it took away.
 */
export async function unlinkEpics(ctx: JiraContext, issue: RawIssue, known?: Placed | null): Promise<{ link?: string; label?: string }> {
  const placed = known === undefined ? await placedOf(ctx, issue.key) : known;
  if (!placed) return {};
  const removed: { link?: string; label?: string } = {};
  if (placed.link && (issue.fields.issuelinks ?? []).some((l) => l.id === placed.link)) {
    await ctx.client.call('DELETE', `/rest/api/3/issueLink/${encodeURIComponent(placed.link)}`);
    removed.link = placed.link;
  }
  if (placed.label && (issue.fields.labels ?? []).includes(placed.label)) {
    await ctx.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, { update: { labels: [{ remove: placed.label }] } });
    removed.label = placed.label;
  }
  await ctx.client.call('DELETE', propertyPath(issue.key));
  return removed;
}
