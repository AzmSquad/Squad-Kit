import { describe, it, expect } from 'vitest';
import { backlogTree, groupLevel, walkUp, type AboveItem } from '../src/modules/tracker/tree.js';
import { nestBacklog } from '../src/board/backlog-tree.js';
import { folded, nestBacklog as boardOrder } from '../console-ui/src/lib/backlog-tree.js';
import type { WorkItemRow } from '../console-ui/src/api/types.js';
import { demoTracker } from '../src/board/demo-tracker.js';
import { Azure } from '../src/modules/azure/client.js';
import { AzureTracker } from '../src/modules/azure/tracker.js';
import { fakeAzureDevOps } from './fakes/azure-devops.js';
import type { TrackerItemRow, TrackerTree } from '../src/modules/tracker/types.js';
import { EMAIL, SITE, fakeJira } from './fakes/jira.js';
import { JiraClient } from '../src/modules/jira/client.js';
import { JiraTracker } from '../src/modules/jira/tracker.js';
import { REPO, fakeGithub } from './fakes/github.js';
import { GithubTracker } from '../src/modules/github/tracker.js';

const row = (id: string, type = 'User Story'): TrackerItemRow => ({ id, ref: `AB#${id}`, type, title: `Item ${id}`, state: 'New', tags: [], url: '', isBug: type === 'Bug' });

/** A tracker's items above the listed ones, by id: [type, parent]. */
function reader(above: Record<string, [string, string?]>, asked: string[][] = []) {
  return async (ids: string[]) => {
    asked.push(ids);
    const found = new Map<string, AboveItem>();
    for (const id of ids) {
      const a = above[id];
      if (a) found.set(id, { row: row(id, a[0]), ...(a[1] ? { parent: a[1] } : {}) });
    }
    return found;
  };
}

describe('the backlog tree, the same for every tracker', () => {
  it('walks up from the listed items to their features and epics, one read per level', async () => {
    const asked: string[][] = [];
    const tree = await walkUp([row('40'), row('41'), row('50')], { '40': '10', '41': '10' }, reader({ '10': ['Feature', '1'], '1': ['Epic'] }, asked));
    expect(tree.above).toEqual({ '40': '10', '41': '10', '10': '1' });
    expect(tree.groups.map((g) => `${g.id} ${g.level}`).sort()).toEqual(['1 epic', '10 feature']);
    expect(asked).toEqual([['10'], ['1']]);
  });

  it('stops three levels up, and drops a link to an item it could not read', async () => {
    const tree = await walkUp([row('40'), row('41')], { '40': '10', '41': '99' }, reader({ '10': ['Feature', '5'], '5': ['Epic', '2'], '2': ['Initiative', '1'], '1': ['Theme'] }));
    expect(tree.above).toEqual({ '40': '10', '10': '5', '5': '2' });
    expect(tree.groups.map((g) => g.id).sort()).toEqual(['10', '2', '5']);
  });

  it('keeps a listed item under another listed item where it is listed, and survives a loop of links', async () => {
    const tree = await walkUp([row('40'), row('44', 'Bug')], { '44': '40', '40': '10' }, reader({ '10': ['Feature', '11'], '11': ['Feature', '10'] }));
    expect(tree.above).toMatchObject({ '44': '40', '40': '10', '10': '11', '11': '10' });
    expect(tree.groups.map((g) => g.id).sort()).toEqual(['10', '11']);
  });

  it('names a group by its type, else by what sits under it', () => {
    expect(groupLevel('Epic', false)).toBe('epic');
    expect(groupLevel('Initiative', false)).toBe('epic');
    expect(groupLevel('Feature', true)).toBe('feature');
    expect(groupLevel('Issue', true)).toBe('epic');
    expect(groupLevel('Issue', false)).toBe('feature');
  });

  it('reads the tree again at most once a minute for the same items', async () => {
    const t = demoTracker();
    const epic = await t.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    const story = await t.createItem({ level: 'story', title: 'Hold a slot', markdown: 'x', parent: epic.id });
    let calls = 0;
    const counted = Object.assign(Object.create(t), { tree: (rows: TrackerItemRow[]) => ((calls += 1), t.tree(rows)) });
    await backlogTree(counted, [story]);
    await backlogTree(counted, [story]);
    expect(calls).toBe(1);
    await backlogTree(counted, [story, await t.createItem({ level: 'story', title: 'Pay', markdown: 'x' })]);
    expect(calls).toBe(2);
  });

  it('keeps a failed tree as no tree for the minute, and shares a read still going on', async () => {
    let calls = 0;
    const broken = Object.assign(Object.create(demoTracker({ name: 'broken' })), {
      tree: async () => {
        calls += 1;
        throw new Error('Azure DevOps did not answer');
      },
    });
    const rows = [row('900')];
    const [a, b] = await Promise.all([backlogTree(broken, rows), backlogTree(broken, rows)]);
    expect([a, b]).toEqual([null, null]);
    expect(await backlogTree(broken, rows)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('an item a tracker hides from this account', () => {
  it('Jira: an epic in a project this account cannot browse is left out, and the rest of the tree stays', async () => {
    const fake = fakeJira('secret');
    const s = { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', board: { id: 1, name: 'PAY board' }, readOnly: false };
    const tracker = new JiraTracker(new JiraClient(s, fake.fetch, { pause: async () => {} }), s);
    const levels = await tracker.levels();
    const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    const feature = await tracker.createItem({ level: levels.linked?.includes('feature') ? 'story' : 'feature', title: 'Holding', markdown: 'x', parent: epic.id });
    const story = await tracker.createItem({ level: 'story', title: 'Pay', markdown: 'x' });
    fake.issues.get(epic.id)!.hidden = true;
    const tree = await tracker.tree([feature, story]);
    expect(tree.above).toEqual({});
    expect(tree.groups).toEqual([]);
    fake.issues.get(epic.id)!.hidden = false;
    expect((await tracker.tree([feature, story])).above).toEqual({ [feature.id]: epic.id });
  });

  it('GitHub: an issue a query cannot read shows on its own, and the others keep their epics', async () => {
    const fake = fakeGithub();
    const tracker = new GithubTracker(fake.calls, { repo: REPO, from: 'issues', labels: [], stages: {}, anyone: false, readOnly: false });
    const rows = await tracker.list();
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['octo/shop#40', 'octo/shop#11', 'octo/shop#10']));
    // The epic itself was moved: its own read fails, which fails the query it was in.
    fake.issues.get('octo/shop#10')!.hidden = true;
    const tree = await tracker.tree(rows);
    expect(tree.above).toEqual({ 'octo/shop#40': 'octo/shop#11', 'octo/shop#11': 'octo/shop#10' });
  });
});

describe('Azure Boards without the parent field', () => {
  it('reads the parent links with the items instead, on a server that says no to System.Parent', async () => {
    const fake = fakeAzureDevOps('secret');
    const fetchNoParent = (async (url: string | URL, init?: RequestInit) => {
      if (/workitemsbatch/.test(String(url)) && String(init?.body).includes('System.Parent')) return new Response(JSON.stringify({ message: 'TF51535: Cannot find field System.Parent.' }), { status: 400 });
      return fake.fetch(url, init);
    }) as typeof fetch;
    const tracker = new AzureTracker(new Azure({ organization: 'momenysr', project: 'Mawid', pat: 'secret' }, fetchNoParent));
    const tree = await tracker.tree(await tracker.list());
    expect(tree.above).toEqual({ '40': '10' });
    expect(tree.groups).toMatchObject([{ id: '10', ref: 'AB#10', type: 'Feature', level: 'feature', title: 'Business setup' }]);
  });
});

describe('the backlog in tree order', () => {
  const g = (id: string, type: string) => ({ ...row(id, type), level: (type === 'Epic' ? 'epic' : 'feature') as 'epic' | 'feature' });
  const lines = (items: TrackerItemRow[], tree: TrackerTree | null) =>
    nestBacklog(items, tree).map((l) => (l.kind === 'loose' ? '-- loose' : `${'  '.repeat(l.depth)}${l.kind === 'group' ? l.group.id : l.item.id}`));

  it('is the flat list when nothing nests', () => {
    expect(lines([row('1'), row('2')], null)).toEqual(['1', '2']);
    expect(lines([row('1'), row('2')], { above: {}, groups: [] })).toEqual(['1', '2']);
  });

  it('puts each epic where its first item is, its features and stories in backlog order, and the rest last', () => {
    const items = [row('41'), row('50'), row('40'), row('60'), row('44', 'Bug'), row('70')];
    const tree: TrackerTree = {
      above: { '40': 'F1', '41': 'F2', '50': 'E2', '60': 'F1', 'F1': 'E1', 'F2': 'E1', '44': '40' },
      groups: [g('E2', 'Epic'), g('F1', 'Feature'), g('E1', 'Epic'), g('F2', 'Feature')],
    };
    expect(lines(items, tree)).toEqual(['E1', '  F2', '    41', '  F1', '    40', '      44', '    60', 'E2', '  50', '-- loose', '70']);
  });

  it('heads a loop of groups with the first in the backlog, and keeps the items in their place', () => {
    const items = [row('1'), row('2')];
    const tree: TrackerTree = { above: { '1': 'A', A: 'B', B: 'A' }, groups: [g('A', 'Feature'), g('B', 'Feature')] };
    expect(lines(items, tree)).toEqual(['A', '  1', '  B', '-- loose', '2']);
  });

  it('is the same order on the board, where a folded epic hides what is under it', () => {
    const items = [row('41'), row('50'), row('40'), row('60'), row('44', 'Bug'), row('70')].map((r) => ({ ...r, ticket: null }) as WorkItemRow);
    const tree: TrackerTree = {
      above: { '40': 'F1', '41': 'F2', '50': 'E2', '60': 'F1', 'F1': 'E1', 'F2': 'E1', '44': '40' },
      groups: [g('E2', 'Epic'), g('F1', 'Feature'), g('E1', 'Epic'), g('F2', 'Feature')],
    };
    const board = boardOrder(items, tree);
    const shown = (closed: string[]) =>
      board.filter((l) => !folded(l, new Set(closed))).map((l) => (l.kind === 'loose' ? '-- loose' : `${'  '.repeat(l.depth)}${l.kind === 'group' ? l.group.id : l.item.id}`));
    expect(shown([])).toEqual(lines(items as TrackerItemRow[], tree));
    expect(shown(['F1', '50'])).toEqual(['E1', '  F2', '    41', '  F1', 'E2', '  50', '-- loose', '70']);
    const e1 = board.find((l) => l.kind === 'group' && l.group.id === 'E1');
    expect(e1?.kind === 'group' && e1.items.map((i) => i.id)).toEqual(['41', '40', '44', '60']);
    expect(boardOrder(items, undefined).map((l) => (l.kind === 'item' ? l.item.id : l.kind))).toEqual(['41', '50', '40', '60', '44', '70']);
  });
});
