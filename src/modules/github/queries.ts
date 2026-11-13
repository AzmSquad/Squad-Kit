import type { TrackerItemRow } from '../tracker/types.js';
import { idOf, refOf } from './refs.js';

/** What squad-kit reads of an issue through GraphQL, and how an issue becomes a row of the backlog. */

export const ISSUE_ROW = `fragment SquadIssueRow on Issue { id number title state url authorAssociation repository { nameWithOwner } issueType { name } labels(first: 50) { nodes { name } } assignees(first: 5) { nodes { login } } }`;

export const VALUE = `fragment SquadValue on ProjectV2ItemFieldValue {
  ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldIterationValue { title iterationId field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
}`;

const PARENT = `fragment SquadParent on Issue { number title repository { nameWithOwner } issueType { name } labels(first: 20) { nodes { name } } }`;

/**
 * One issue with its text, the issues above it and the issues it is blocked by. With a board, also its places on Project
 * boards: that part needs gh's Projects right, so a project that takes stories from Issues never asks for it. It is
 * left out of the query's text, not skipped by a directive, as GitHub checks the rights a query needs from its text.
 */
export function issueDetail(onBoard: boolean): string {
  return `query SquadIssue($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) {
  ...SquadIssueRow body
  parent { ...SquadParent parent { ...SquadParent parent { ...SquadParent } } }
  blockedBy(first: 50) { nodes { id number title state repository { nameWithOwner } } }
  ${onBoard ? 'projectItems(first: 20) { nodes { id project { id } fieldValues(first: 30) { nodes { ...SquadValue } } } }' : ''}
} } }
${ISSUE_ROW}
${PARENT}
${onBoard ? VALUE : ''}`;
}

export interface IssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  /** Who wrote it, as GitHub sees them in the repo: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE… */
  authorAssociation?: string;
  repository: { nameWithOwner: string };
  issueType: { name: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
}

interface ParentNode {
  number: number;
  title: string;
  repository: { nameWithOwner: string };
  issueType: { name: string } | null;
  labels: { nodes: { name: string }[] };
  parent?: ParentNode | null;
}

export interface ValueNode {
  name?: string;
  title?: string;
  iterationId?: string;
  number?: number;
  field?: { id: string; name: string };
}

export interface IssueDetail extends IssueNode {
  body: string | null;
  parent: ParentNode | null;
  blockedBy: { nodes: { id: string; number: number; title: string; state: string; repository: { nameWithOwner: string } }[] };
  /** Only asked for with a board. */
  projectItems?: { nodes: { id: string; project: { id: string }; fieldValues: { nodes: ValueNode[] } }[] };
}

/** The level labels a repo without issue types uses, and the type names they read as. */
export const LEVEL_LABEL = { epic: 'epic', feature: 'feature', story: 'story' } as const;
const LEVEL_TYPE: Record<string, string> = { epic: 'Epic', feature: 'Feature', story: 'Story', bug: 'Bug' };

const names = (labels: { nodes: { name: string }[] }) => labels.nodes.filter(Boolean).map((l) => l.name);

/** The issue's type: its issue type, or what its labels say (Epic, Feature, Story, Bug), or Issue. */
export function typeOf(issue: Pick<IssueNode, 'issueType' | 'labels'>): string {
  if (issue.issueType?.name) return issue.issueType.name;
  const label = names(issue.labels).find((l) => LEVEL_TYPE[l.toLowerCase()]);
  return label ? LEVEL_TYPE[label.toLowerCase()]! : 'Issue';
}

function isBugOf(issue: Pick<IssueNode, 'issueType' | 'labels'>): boolean {
  return /^bug$/i.test(issue.issueType?.name ?? '') || names(issue.labels).some((l) => /^bug$/i.test(l));
}

/** People the repo knows: its owner, the organization's members and those given access. */
const TEAM = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Written by someone the repo knows. Anyone else's words could steer the agents that read them. */
export function byTeam(issue: Pick<IssueNode, 'authorAssociation'>): boolean {
  return TEAM.has((issue.authorAssociation ?? '').toUpperCase());
}

export function rowOf(issue: IssueNode, own: string, extra: Partial<Pick<TrackerItemRow, 'state' | 'points' | 'priority' | 'sprint'>> = {}): TrackerItemRow {
  const id = idOf(issue.repository.nameWithOwner, issue.number);
  const who = issue.assignees.nodes.find(Boolean)?.login;
  return {
    id,
    ref: refOf(id, own),
    type: typeOf(issue),
    title: issue.title,
    tags: names(issue.labels),
    url: issue.url,
    isBug: isBugOf(issue),
    ...(who ? { assignedTo: who } : {}),
    ...extra,
    state: extra.state ?? (issue.state === 'OPEN' ? 'Open' : 'Closed'),
  };
}

/** An issue as the REST API gives it, in the GraphQL shape. */
export interface RestIssue {
  node_id: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  body?: string | null;
  author_association?: string;
  labels: ({ name: string } | string)[];
  assignees?: { login: string }[] | null;
  type?: { name: string } | null;
  pull_request?: unknown;
}

export function fromRest(issue: RestIssue, repo: string): IssueNode {
  return {
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    url: issue.html_url,
    ...(issue.author_association ? { authorAssociation: issue.author_association } : {}),
    repository: { nameWithOwner: repo },
    issueType: issue.type?.name ? { name: issue.type.name } : null,
    labels: { nodes: issue.labels.map((l) => ({ name: typeof l === 'string' ? l : l.name })) },
    assignees: { nodes: (issue.assignees ?? []).map((a) => ({ login: a.login })) },
  };
}
