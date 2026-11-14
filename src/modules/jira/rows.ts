import type { TrackerItemRow } from '../tracker/types.js';
import type { SiteFields } from './context.js';

/** A Jira issue as squad-kit lists it: key, type, summary, status, priority, story points, sprint, labels and assignee. */

interface RawLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: LinkedIssue;
  outwardIssue?: LinkedIssue;
}

interface LinkedIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

export interface RawIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    issuetype?: { id?: string; name?: string; subtask?: boolean; hierarchyLevel?: number };
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string } | null;
    labels?: string[];
    assignee?: { displayName?: string } | null;
    description?: unknown;
    attachment?: { filename: string; content: string; size?: number }[];
    parent?: { key: string; fields?: { summary?: string; issuetype?: { name?: string } } };
    issuelinks?: RawLink[];
    [field: string]: unknown;
  };
}

const ROW_FIELDS = ['summary', 'issuetype', 'status', 'priority', 'labels', 'assignee'];

/** The fields a row needs on this site: the standard ones, its story points and its sprint. */
export function rowFields(f: SiteFields): string[] {
  return [...ROW_FIELDS, ...f.points, ...(f.sprint ? [f.sprint] : [])];
}

/** Jira's priority names, 1 the highest as on every tracker: Highest and High, Medium, then Low and Lowest. */
function priorityOf(name: string | undefined): number | undefined {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return undefined;
  if (/highest|blocker|critical|urgent/.test(n)) return 1;
  if (/high|major/.test(n)) return 2;
  if (/medium|normal/.test(n)) return 3;
  if (/low|minor|trivial/.test(n)) return 4;
  return undefined;
}

/** The sprint an issue is in now: the running one, else the next, else the last it was in. */
function sprintName(value: unknown): string | undefined {
  const list = (Array.isArray(value) ? value : []) as { name?: string; state?: string }[];
  const pick = list.find((s) => s.state === 'active') ?? list.find((s) => s.state === 'future') ?? list[list.length - 1];
  return pick?.name || undefined;
}

function isBugType(type: string, labels: string[]): boolean {
  return /\bbug\b/i.test(type) || labels.some((l) => l.toLowerCase() === 'bug');
}

export function rowOf(issue: RawIssue, f: SiteFields, browse: (key: string) => string): TrackerItemRow {
  const x = issue.fields ?? {};
  const type = x.issuetype?.name ?? '';
  const labels = Array.isArray(x.labels) ? x.labels : [];
  const points = f.points.map((id) => x[id]).find((v): v is number => typeof v === 'number');
  const priority = priorityOf(x.priority?.name);
  const sprint = f.sprint ? sprintName(x[f.sprint]) : undefined;
  return {
    id: issue.key,
    ref: issue.key,
    type,
    title: x.summary ?? '',
    state: x.status?.name ?? '',
    ...(points !== undefined ? { points } : {}),
    ...(priority ? { priority } : {}),
    ...(sprint ? { sprint } : {}),
    ...(x.assignee?.displayName ? { assignedTo: x.assignee.displayName } : {}),
    tags: labels,
    url: browse(issue.key),
    isBug: isBugType(type, labels),
  };
}

/** The items an issue needs first: its "is blocked by" links. */
export function blockedBy(links: RawLink[] = []): { ref: string; title: string; state: string }[] {
  return links
    .filter((l) => l.inwardIssue && (l.type?.name === 'Blocks' || /blocked by/i.test(l.type?.inward ?? '')))
    .map((l) => ({ ref: l.inwardIssue!.key, title: l.inwardIssue!.fields?.summary ?? '', state: l.inwardIssue!.fields?.status?.name ?? '' }));
}

/** A Jira label has no spaces: "release 1.2" becomes "release-1.2". */
export function labelOf(tag: string): string {
  return tag.trim().replace(/\s+/g, '-');
}
