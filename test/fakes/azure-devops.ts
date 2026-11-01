/**
 * Azure DevOps (Boards, Repos, Wiki) as far as squad-kit uses it, in memory. A fetch stand-in for the shared module
 * tests: one feature (10) with a story under it (40) in the current sprint, states New, Active, Resolved, Closed.
 */

type Item = { type: string; title: string; state: string; description: string; tags: string[]; parent?: number; sprint?: string; priority?: number };

export interface FakeAzure {
  fetch: typeof fetch;
  comments: Map<number, string[]>;
  setClash(on: boolean): void;
}

export function fakeAzureDevOps(token = 'secret'): FakeAzure {
  const items = new Map<number, Item>([
    [10, { type: 'Feature', title: 'Business setup', state: 'Active', description: '', tags: [] }],
    [40, { type: 'User Story', title: 'Owner sets opening hours', state: 'New', description: '<p>Owner sets <b>hours</b> for each day.</p>', tags: ['owner'], parent: 10, sprint: 'Mawid\\Sprint 1', priority: 1 }],
  ]);
  const comments = new Map<number, string[]>();
  const prs = new Map<number, { source: string; status: string; description: string }>();
  let clash = false;
  let nextBug = 100;
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
      },
      relations: [
        ...(w.parent ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/org/_apis/wit/workItems/${w.parent}` }] : []),
        ...(id === 40 ? [{ rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/a1', attributes: { name: 'hours.png', resourceSize: 4 } }] : []),
      ],
    };
  };

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
      const ids = [...items].filter(([, w]) => ['User Story', 'Bug'].includes(w.type) && w.state !== 'Closed' && (!sprint || w.sprint === sprint)).map(([id]) => ({ id }));
      return json({ workItems: ids });
    }
    if (method === 'POST' && /workitemsbatch/.test(path)) return json({ value: (body as { ids: number[] }).ids.map(raw) });
    if (method === 'POST' && /workitems\/\$Bug/i.test(path)) {
      const ops = body as { path: string; value: unknown }[];
      const id = nextBug++;
      items.set(id, { type: 'Bug', title: String(ops.find((o) => o.path === '/fields/System.Title')?.value), state: 'New', description: '', tags: [] });
      return json(raw(id));
    }
    const wi = /_apis\/wit\/workitems\/(\d+)$/i.exec(path);
    if (wi) {
      const id = Number(wi[1]);
      if (!items.has(id)) return json({ message: 'not found' }, 404);
      if (method === 'PATCH') {
        for (const op of body as { path: string; value: string }[]) {
          if (op.path === '/fields/System.State') items.get(id)!.state = op.value;
          if (op.path === '/fields/System.Tags') items.get(id)!.tags = op.value.split(';').map((s) => s.trim());
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
  return { fetch: handler as typeof fetch, comments, setClash: (on) => (clash = on) };
}
