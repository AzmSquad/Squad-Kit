/**
 * Azure DevOps (Boards, Repos, Wiki) as far as squad-kit uses it, in memory. A fetch stand-in for the shared module
 * tests: one feature (10) with a story under it (40) in the current sprint, states New, Active, Resolved, Closed.
 * It makes work items of the types its process has, with fields, parent and dependency links, as Azure does: a type
 * or field the process lacks, a second parent and a link it already has are refused.
 */

type Item = {
  type: string;
  title: string;
  state: string;
  description: string;
  tags: string[];
  parent?: number;
  sprint?: string;
  priority?: number;
  acceptance?: string;
  /** Its predecessors. */
  deps?: number[];
};

export type FakeProcess = 'Agile' | 'Scrum' | 'CMMI' | 'Basic';

const CRITERIA = 'Microsoft.VSTS.Common.AcceptanceCriteria';
const COMMON = ['System.Title', 'System.State', 'System.Description', 'System.Tags', 'System.IterationPath', 'System.AreaPath'];
/** Each process's types, and whether a type has the acceptance criteria field. */
const TYPES: Record<FakeProcess, Record<string, boolean>> = {
  Agile: { Epic: true, Feature: true, 'User Story': true, Task: false, Bug: true, Issue: false },
  Scrum: { Epic: true, Feature: true, 'Product Backlog Item': true, Task: false, Bug: true, Impediment: false },
  CMMI: { Epic: true, Feature: true, Requirement: false, Task: false, Bug: false, Issue: false, Risk: false },
  Basic: { Epic: false, Issue: false, Task: false },
};

export interface FakeAzure {
  fetch: typeof fetch;
  comments: Map<number, string[]>;
  setClash(on: boolean): void;
  items: Map<number, Item>;
  /** Every POST and PATCH to a work item, with its JSON patch body. */
  writes: { method: string; path: string; body: { op: string; path: string; value?: unknown }[] }[];
  /** Turns writes down, as for a token that may only read. */
  denyWrites(on: boolean): void;
}

export interface FakeAzureOptions {
  process?: FakeProcess;
  /** Types turned off in the project's process. */
  disabled?: string[];
  /** Leave the fields out of the type list, so they are read per type. */
  fieldsApart?: boolean;
}

export function fakeAzureDevOps(token = 'secret', opts: FakeAzureOptions = {}): FakeAzure {
  const types: Record<string, boolean> = { Bug: false, ...TYPES[opts.process ?? 'Agile'] };
  const fieldsOf = (type: string) => [...COMMON, ...(types[type] ? [CRITERIA] : []), 'Microsoft.VSTS.TCM.ReproSteps', 'Microsoft.VSTS.Common.Severity'];
  const writes: FakeAzure['writes'] = [];
  let denied = false;
  const items = new Map<number, Item>([
    [10, { type: 'Feature', title: 'Business setup', state: 'Active', description: '', tags: [] }],
    [40, { type: 'User Story', title: 'Owner sets opening hours', state: 'New', description: '<p>Owner sets <b>hours</b> for each day.</p>', tags: ['owner'], parent: 10, sprint: 'Mawid\\Sprint 1', priority: 1 }],
  ]);
  const comments = new Map<number, string[]>();
  const prs = new Map<number, { source: string; status: string; description: string }>();
  let clash = false;
  let nextId = 100;
  let nextPr = 7;
  const auth = 'Basic ' + Buffer.from(`:${token}`).toString('base64');
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const states = [
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' },
  ];
  const raw = (id: number) => {
    const w = items.get(id)!;
    return {
      id,
      fields: {
        'System.WorkItemType': w.type,
        'System.Title': w.title,
        'System.State': w.state,
        'System.Description': w.description,
        'System.Tags': w.tags.join('; '),
        'System.IterationPath': w.sprint ?? 'Mawid',
        ...(w.priority ? { 'Microsoft.VSTS.Common.Priority': w.priority } : {}),
        ...(w.acceptance ? { [CRITERIA]: w.acceptance } : {}),
      },
      relations: relationsOf(id),
    };
  };
  /** In Azure's order, which is also how a link is removed: by its place in this list. */
  function relationsOf(id: number): { rel: string; url: string; attributes?: { name: string; resourceSize: number } }[] {
    const w = items.get(id)!;
    return [
      ...(w.parent ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/org/_apis/wit/workItems/${w.parent}` }] : []),
      ...(w.deps ?? []).map((d) => ({ rel: 'System.LinkTypes.Dependency-Reverse', url: `https://dev.azure.com/org/_apis/wit/workItems/${d}` })),
      ...(id === 40 ? [{ rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/a1', attributes: { name: 'hours.png', resourceSize: 4 } }] : []),
    ];
  }
  /** Applies a JSON patch to an item, as Azure checks it. Returns a refusal message, or null. */
  function apply(id: number, ops: { op: string; path: string; value?: unknown }[]): string | null {
    const w = items.get(id)!;
    const rels = relationsOf(id).map((r) => ({ rel: r.rel, id: Number(r.url.split('/').pop()) }));
    for (const op of ops) {
      const field = /^\/fields\/(.+)$/.exec(op.path)?.[1];
      if (field) {
        if (!fieldsOf(w.type).includes(field)) return `TF51535: Cannot find field ${field}.`;
        const v = String(op.value ?? '');
        if (field === 'System.Title') w.title = v;
        if (field === 'System.State') w.state = v;
        if (field === 'System.Description') w.description = v;
        if (field === 'System.Tags') w.tags = v.split(';').map((t) => t.trim()).filter(Boolean);
        if (field === 'System.IterationPath') w.sprint = v;
        if (field === CRITERIA) w.acceptance = v;
        continue;
      }
      const at = /^\/relations\/(\d+)$/.exec(op.path);
      if (op.op === 'remove' && at) {
        if (!rels[Number(at[1])]) return `Relation ${at[1]} does not exist.`;
        rels.splice(Number(at[1]), 1);
        continue;
      }
      if (op.op === 'add' && op.path === '/relations/-') {
        const v = op.value as { rel: string; url: string };
        const target = Number(v.url.split('/').pop());
        if (!items.has(target)) return `TF401232: Work item ${target} does not exist.`;
        if (rels.some((r) => r.rel === v.rel && r.id === target)) return 'Relation already exists.';
        if (v.rel === 'System.LinkTypes.Hierarchy-Reverse' && rels.some((r) => r.rel === v.rel)) return 'TF201036: A work item can have only one Parent link.';
        rels.push({ rel: v.rel, id: target });
      }
    }
    w.parent = rels.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.id;
    w.deps = rels.filter((r) => r.rel === 'System.LinkTypes.Dependency-Reverse').map((r) => r.id);
    return null;
  }

  const handler = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== auth) return json({ message: 'TF400813: not authorized' }, 401);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const path = decodeURIComponent(url.split('?')[0]!);

    if (/_apis\/connectionData/.test(path)) return json({ authenticatedUser: { providerDisplayName: 'Momen' } });
    if (method === 'GET' && /_apis\/projects\/[^/]+$/.test(path)) return json({ defaultTeam: { name: 'Mawid Team' } });
    if (/teamsettings\/iterations/.test(path)) return json({ value: [{ name: 'Sprint 1', path: 'Mawid\\Sprint 1', attributes: { timeFrame: 'current', startDate: '2026-11-01T00:00:00Z', finishDate: '2026-11-14T00:00:00Z' } }] });
    if (method === 'POST' && /_apis\/wit\/wiql/.test(path)) {
      const q = String((body as { query: string }).query);
      const sprint = /IterationPath\] = '([^']+)'/.exec(q)?.[1]?.replace(/''/g, "'");
      // A breakdown's send looking for an item it made: one type, one tag, newest first.
      const type = /WorkItemType\] = '([^']+)'/.exec(q)?.[1]?.replace(/''/g, "'");
      const tag = /Tags\] CONTAINS '([^']+)'/.exec(q)?.[1]?.replace(/''/g, "'");
      if (type && tag) return json({ workItems: [...items].filter(([, w]) => w.type === type && w.tags.includes(tag)).map(([id]) => ({ id })).reverse() });
      const ids = [...items].filter(([, w]) => ['User Story', 'Bug'].includes(w.type) && w.state !== 'Closed' && (!sprint || w.sprint === sprint)).map(([id]) => ({ id }));
      return json({ workItems: ids });
    }
    if (method === 'POST' && /workitemsbatch/.test(path)) return json({ value: (body as { ids: number[] }).ids.map(raw) });
    if (method === 'GET' && /_apis\/wit\/workitemtypes$/.test(path)) {
      return json({
        value: Object.keys(types).map((name) => ({
          name,
          isDisabled: (opts.disabled ?? []).includes(name),
          ...(opts.fieldsApart ? {} : { fields: fieldsOf(name).map((referenceName) => ({ referenceName })) }),
        })),
      });
    }
    const typeFields = /_apis\/wit\/workitemtypes\/([^/]+)\/fields$/.exec(path);
    if (method === 'GET' && typeFields) return json({ value: fieldsOf(typeFields[1]!).map((referenceName) => ({ referenceName })) });
    const create = /_apis\/wit\/workitems\/\$(.+)$/i.exec(path);
    if (method === 'POST' && create) {
      const type = create[1]!;
      if (!(type in types) || (opts.disabled ?? []).includes(type)) return json({ message: `VS402323: Work item type ${type} does not exist in project Mawid.` }, 400);
      writes.push({ method, path, body });
      if (denied) return json({ message: 'TF237111: The current user does not have permissions to save work items under the specified area path.' }, 403);
      const id = nextId++;
      items.set(id, { type, title: '', state: 'New', description: '', tags: [] });
      const refused = apply(id, body as { op: string; path: string; value?: unknown }[]);
      if (refused) {
        items.delete(id);
        return json({ message: refused }, 400);
      }
      return json(raw(id));
    }
    const wi = /_apis\/wit\/workitems\/(\d+)$/i.exec(path);
    if (wi) {
      const id = Number(wi[1]);
      if (!items.has(id)) return json({ message: 'not found' }, 404);
      if (method === 'PATCH') {
        writes.push({ method, path, body });
        if (denied) return json({ message: 'TF237111: The current user does not have permissions to save work items under the specified area path.' }, 403);
        const before = structuredClone(items.get(id)!);
        const refused = apply(id, body as { op: string; path: string; value?: unknown }[]);
        if (refused) {
          items.set(id, before);
          return json({ message: refused }, 400);
        }
      }
      return json(raw(id));
    }
    const cm = /_apis\/wit\/workItems\/(\d+)\/comments$/i.exec(path);
    if (cm && method === 'POST') {
      const id = Number(cm[1]);
      comments.set(id, [...(comments.get(id) ?? []), String((body as { text: string }).text)]);
      return json({ id: 1 });
    }
    if (/workitemtypes\/.+\/states$/.test(path)) return json({ value: states });
    if (/_apis\/wit\/attachments\//.test(path)) return new Response('PNG!', { status: 200 });
    if (/_apis\/wiki\/wikis$/.test(path)) return json({ value: [{ id: 'w1', type: 'projectWiki' }] });
    if (/_apis\/wiki\/wikis\/w1\/pages$/.test(path)) {
      const page = new URL(url).searchParams.get('path');
      if (page === '/') return json({ path: '/', subPages: [{ path: '/Business rules' }] });
      return json({ path: page, content: 'Prices include VAT.' });
    }
    const att = /pullRequests\/(\d+)\/attachments\/(.+)$/i.exec(path);
    if (att && method === 'POST') return json({ url: `https://dev.azure.com/att/${att[2]}` });
    if (/\/pullrequests$/i.test(path) && method === 'POST') {
      const id = nextPr++;
      prs.set(id, { source: String((body as { sourceRefName: string }).sourceRefName).replace('refs/heads/', ''), status: 'active', description: String((body as { description: string }).description) });
      return json({ pullRequestId: id, status: 'active' });
    }
    if (/\/pullrequests$/i.test(path) && method === 'GET') {
      const source = new URL(url).searchParams.get('searchCriteria.sourceRefName')?.replace('refs/heads/', '');
      return json({ value: [...prs].filter(([, p]) => p.source === source && p.status === 'active').map(([id, p]) => ({ pullRequestId: id, status: p.status })) });
    }
    const pr = /\/pullrequests\/(\d+)$/i.exec(path);
    if (pr) {
      const id = Number(pr[1]);
      const p = prs.get(id);
      if (!p) return json({ message: 'not found' }, 404);
      if (method === 'PATCH') {
        const b = body as { status?: string; description?: string };
        if (b.description !== undefined) p.description = b.description;
        if (b.status === 'abandoned') p.status = 'abandoned';
        if (b.status === 'completed' && !clash) p.status = 'completed';
      }
      return json({ pullRequestId: id, status: p.status, mergeStatus: clash ? 'conflicts' : 'succeeded', lastMergeSourceCommit: { commitId: 's' }, lastMergeCommit: { commitId: 'merge-1' } });
    }
    return json({ message: `unexpected ${method} ${url}` }, 404);
  };
  return { fetch: handler as typeof fetch, comments, setClash: (on) => (clash = on), items, writes, denyWrites: (on) => (denied = on) };
}
