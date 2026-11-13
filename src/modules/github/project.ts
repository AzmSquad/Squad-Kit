import type { Sprint } from '../tracker/types.js';
import type { GithubCalls } from './calls.js';
import { ISSUE_ROW, VALUE, type IssueNode, type ValueNode } from './queries.js';
import type { BoardRef } from './settings.js';

/** A GitHub Project (v2) board: its fields, views and items, read and set through GraphQL. */

interface FieldNode {
  __typename: string;
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string }[];
  configuration?: { iterations: Iteration[]; completedIterations: Iteration[] };
}

interface Iteration {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}

export interface Board {
  id: string;
  number: number;
  title: string;
  status?: { id: string; options: { id: string; name: string }[] };
  iteration?: { id: string; name: string; iterations: Iteration[] };
  priority?: { id: string; options: { id: string; name: string }[] };
  points?: { id: string };
  views: { name: string; filter: string | null }[];
}

const BOARD = `fragment SquadBoard on ProjectV2 {
  id number title
  fields(first: 50) { nodes { __typename
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name } }
    ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } } } }
  views(first: 30) { nodes { name filter } }
}`;

function boardOf(node: { id: string; number: number; title: string; fields: { nodes: FieldNode[] }; views: { nodes: { name: string; filter: string | null }[] } }): Board {
  const fields = node.fields.nodes.filter((f) => f?.id);
  const select = (name: RegExp) => fields.find((f) => f.dataType === 'SINGLE_SELECT' && name.test(f.name));
  const status = select(/^status$/i);
  const priority = select(/priority/i);
  const iteration = fields.find((f) => f.dataType === 'ITERATION');
  const points = fields.find((f) => f.dataType === 'NUMBER' && /points|estimate|size/i.test(f.name));
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    ...(status ? { status: { id: status.id, options: status.options ?? [] } } : {}),
    ...(priority ? { priority: { id: priority.id, options: priority.options ?? [] } } : {}),
    ...(iteration?.configuration
      ? { iteration: { id: iteration.id, name: iteration.name, iterations: [...iteration.configuration.completedIterations, ...iteration.configuration.iterations] } }
      : {}),
    ...(points ? { points: { id: points.id } } : {}),
    views: node.views.nodes,
  };
}

/** A board by its owner (an organization or a person) and number. */
export async function boardByNumber(calls: GithubCalls, ref: BoardRef): Promise<Board> {
  const data = await calls.graphql<{ repositoryOwner: { projectV2: Parameters<typeof boardOf>[0] | null } | null }>(
    `query SquadBoardByNumber($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { ...SquadBoard } } } }\n${BOARD}`,
    { owner: ref.owner, number: ref.number },
  );
  const node = data.repositoryOwner?.projectV2;
  if (!node) throw new Error(`GitHub has no Project ${ref.number} for ${ref.owner} that this sign-in can see.`);
  return boardOf(node);
}

export async function boardById(calls: GithubCalls, id: string): Promise<Board> {
  const data = await calls.graphql<{ node: Parameters<typeof boardOf>[0] | null }>(`query SquadBoard($id: ID!) { node(id: $id) { ...SquadBoard } }\n${BOARD}`, { id });
  if (!data.node) throw new Error('The GitHub Project this project uses is gone, or this sign-in cannot see it. Pick it again in Settings.');
  return boardOf(data.node);
}

/** The open boards of an owner for the Settings list, the ones changed last first. At most 500 are read. */
export async function boardsOf(calls: GithubCalls, owner: string): Promise<{ number: number; title: string }[]> {
  type Page = { repositoryOwner: { projectsV2?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { number: number; title: string; closed: boolean }[] } } | null };
  const boards: { number: number; title: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const data: Page = await calls.graphql(
      `query SquadBoards($owner: String!, $after: String) { repositoryOwner(login: $owner) { ... on ProjectV2Owner {
        projectsV2(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { number title closed } } } } }`,
      { owner, after },
    );
    const list = data.repositoryOwner?.projectsV2;
    boards.push(...(list?.nodes ?? []).filter((p) => p && !p.closed).map((p) => ({ number: p.number, title: p.title })));
    if (!list?.pageInfo.hasNextPage) break;
    after = list.pageInfo.endCursor;
  }
  return boards;
}

interface ItemsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: { id: string; isArchived: boolean; content: (IssueNode & { __typename: string }) | { __typename: string }; fieldValues: { nodes: ValueNode[] } }[];
}

interface BoardItem {
  id: string;
  issue: IssueNode;
  values: ValueNode[];
}

/** At most this many of a board's items are read: 5 pages of 100. */
export const BOARD_CAP = 500;

/**
 * The board's issues in its own order, filtered as one of its views would (GitHub's filter words, so the cap counts
 * after the filter). `more`: the board had more than the cap.
 */
export async function boardItems(calls: GithubCalls, board: Board, query: string): Promise<{ items: BoardItem[]; more: boolean }> {
  const items: BoardItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < BOARD_CAP / 100; page += 1) {
    const data: { node: { items: ItemsPage } } = await calls.graphql(
      `query SquadBoardItems($id: ID!, $after: String, $query: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after, query: $query) { pageInfo { hasNextPage endCursor }
        nodes { id isArchived content { __typename ... on Issue { ...SquadIssueRow } } fieldValues(first: 30) { nodes { ...SquadValue } } } } } } }\n${ISSUE_ROW}\n${VALUE}`,
      { id: board.id, after, query: query || null },
    );
    for (const n of data.node.items.nodes) {
      if (n && !n.isArchived && n.content.__typename === 'Issue') items.push({ id: n.id, issue: n.content as IssueNode, values: n.fieldValues.nodes });
    }
    if (!data.node.items.pageInfo.hasNextPage) return { items, more: false };
    after = data.node.items.pageInfo.endCursor;
  }
  return { items, more: true };
}

/** One field's value on an item, by the field's id. */
export function valueOf(values: ValueNode[], fieldId: string | undefined): ValueNode | undefined {
  return fieldId ? values.find((v) => v?.field?.id === fieldId) : undefined;
}

/** Puts an issue on the board, or finds it there. Returns the item's id. */
export async function addToBoard(calls: GithubCalls, board: Board, issueNodeId: string): Promise<string> {
  const data = await calls.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation SquadAddToBoard($board: ID!, $issue: ID!) { addProjectV2ItemById(input: { projectId: $board, contentId: $issue }) { item { id } } }`,
    { board: board.id, issue: issueNodeId },
  );
  return data.addProjectV2ItemById.item.id;
}

export async function setOption(calls: GithubCalls, board: Board, itemId: string, field: { id: string; options: { id: string; name: string }[] }, option: string): Promise<void> {
  const o = field.options.find((x) => x.name.toLowerCase() === option.toLowerCase());
  if (!o) throw new Error(`The Status "${option}" is not on GitHub Project ${board.title} any more. Pick another in Settings.`);
  await calls.graphql(
    `mutation SquadSetOption($board: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $board, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
    { board: board.id, item: itemId, field: field.id, option: o.id },
  );
}

/** The board's iterations as sprints, oldest first. */
export function sprintsOf(board: Board, today = new Date()): Sprint[] {
  const day = today.toISOString().slice(0, 10);
  return [...(board.iteration?.iterations ?? [])]
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((i) => {
      const end = new Date(Date.parse(`${i.startDate}T00:00:00Z`) + (i.duration - 1) * 86_400_000).toISOString().slice(0, 10);
      return { name: i.title, path: i.id, start: i.startDate, finish: end, current: i.startDate <= day && day <= end };
    });
}

/** 1 is the highest, 4 the lowest: the board's options spread over that scale in their own order, first the highest. */
export function priorityOf(name: string | undefined, options: { name: string }[]): number | undefined {
  const at = name ? options.findIndex((o) => o.name === name) : -1;
  if (at < 0) return undefined;
  return options.length === 1 ? 1 : 1 + Math.round((at * 3) / (options.length - 1));
}
