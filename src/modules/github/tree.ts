import type { TrackerItemRow, TrackerTree } from '../tracker/types.js';
import { walkUp, type AboveItem } from '../tracker/tree.js';
import type { GithubCalls } from './calls.js';
import { ISSUE_ROW, rowOf, type IssueNode } from './queries.js';
import { idOf, keyOf } from './refs.js';

/**
 * How GitHub nests a backlog: sub-issues. One query reads up to 50 listed issues with the issues above each, three
 * levels up, so the whole tree costs a call per 50 issues. An issue type (Epic, Feature) names a group's level where
 * the organization has them; otherwise its place in the tree does.
 */

const PER_QUERY = 50;

interface ChainNode extends IssueNode {
  parent?: ChainNode | null;
}

/** "Owner/name" and the issue numbers in it, each with its alias in the query. */
function queryOf(rows: TrackerItemRow[], own: string): { query: string; slots: { repo: string; issue: string; id: string }[] } {
  const byRepo = new Map<string, { owner: string; name: string; items: { number: number; id: string }[] }>();
  for (const r of rows) {
    const k = keyOf(r.id, own);
    const repo = `${k.owner}/${k.name}`.toLowerCase();
    const entry = byRepo.get(repo) ?? { owner: k.owner, name: k.name, items: [] };
    entry.items.push({ number: k.number, id: r.id });
    byRepo.set(repo, entry);
  }
  const slots: { repo: string; issue: string; id: string }[] = [];
  const parts = [...byRepo.values()].map((repo, ri) => {
    const issues = repo.items.map((item, ii) => {
      slots.push({ repo: `r${ri}`, issue: `i${ii}`, id: item.id });
      return `i${ii}: issue(number: ${item.number}) { parent { ...SquadIssueRow parent { ...SquadIssueRow parent { ...SquadIssueRow } } } }`;
    });
    return `r${ri}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${issues.join(' ')} }`;
  });
  return { query: `query SquadTree { ${parts.join(' ')} }\n${ISSUE_ROW}`, slots };
}

type Answer = Record<string, Record<string, { parent: ChainNode | null } | null> | null>;

/**
 * The parent chains of these issues. GitHub refuses a whole query when one issue in it cannot be read (moved, or above
 * it an issue in an organization this sign-in may not see), so a refused query is split in two and asked again, down
 * to the one issue, which then shows on its own.
 */
async function chains(calls: GithubCalls, rows: TrackerItemRow[], own: string, into: (id: string, parent: ChainNode) => void): Promise<void> {
  const { query, slots } = queryOf(rows, own);
  let data: Answer;
  try {
    data = await calls.graphql<Answer>(query);
  } catch (err) {
    // A sign-in problem is the same for every half: no tree. One issue that cannot be read shows on its own.
    if ((err as { kind?: string }).kind === 'sign-in') throw err;
    if (rows.length === 1) return;
    const half = Math.ceil(rows.length / 2);
    await chains(calls, rows.slice(0, half), own, into);
    await chains(calls, rows.slice(half), own, into);
    return;
  }
  for (const slot of slots) {
    const parent = data?.[slot.repo]?.[slot.issue]?.parent;
    if (parent) into(slot.id, parent);
  }
}

export async function githubTree(calls: GithubCalls, rows: TrackerItemRow[], own: string): Promise<TrackerTree> {
  const first: Record<string, string> = {};
  const read = new Map<string, AboveItem>();
  const into = (id: string, top: ChainNode) => {
    first[id] = idOf(top.repository.nameWithOwner, top.number);
    for (let node: ChainNode | null = top; node; node = node.parent ?? null) {
      const at = idOf(node.repository.nameWithOwner, node.number);
      const up = node.parent ? idOf(node.parent.repository.nameWithOwner, node.parent.number) : undefined;
      // One read at the top of a chain has no parent asked for; another chain may know it.
      if (!read.get(at)?.parent) read.set(at, { row: rowOf(node, own), ...(up ? { parent: up } : {}) });
    }
  };
  for (let i = 0; i < rows.length; i += PER_QUERY) await chains(calls, rows.slice(i, i + PER_QUERY), own, into);
  return walkUp(rows, first, async (ids) => new Map(ids.filter((id) => read.has(id)).map((id) => [id, read.get(id)!])));
}
