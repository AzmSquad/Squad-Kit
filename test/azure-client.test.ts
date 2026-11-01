import { describe, it, expect } from 'vitest';
import { Azure, gitAuthEnv, htmlToText, parseAzureRemote, pickState } from '../src/modules/azure/client.js';

type Route = { method: string; match: RegExp; reply: unknown | ((body: unknown) => unknown); status?: number };

function fakeAzure(routes: Route[]) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const http = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body, headers: init.headers as Record<string, string> });
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) return new Response(JSON.stringify({ message: `no route for ${method} ${url}` }), { status: 404 });
    const reply = typeof route.reply === 'function' ? (route.reply as (b: unknown) => unknown)(body) : route.reply;
    return new Response(JSON.stringify(reply), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { azure: new Azure({ organization: 'momenysr', project: 'Mawid', pat: 'secret' }, http), calls };
}

const item = (id: number, fields: Record<string, unknown>, relations: unknown[] = []) => ({ id, fields, relations });

describe('Azure client', () => {
  it('lists a sprint backlog in backlog order with points and sprint', async () => {
    const { azure, calls } = fakeAzure([
      { method: 'POST', match: /_apis\/wit\/wiql/, reply: { workItems: [{ id: 42 }, { id: 35 }] } },
      {
        method: 'POST',
        match: /workitemsbatch/,
        reply: {
          value: [
            item(35, { 'System.WorkItemType': 'User Story', 'System.Title': 'Owner signs up', 'System.State': 'New', 'System.IterationPath': 'Mawid\\Sprint 1', 'Microsoft.VSTS.Scheduling.StoryPoints': 3, 'System.Tags': 'owner; mvp' }),
            item(42, { 'System.WorkItemType': 'User Story', 'System.Title': 'Customer picks a time', 'System.State': 'Active', 'System.IterationPath': 'Mawid\\Sprint 1', 'Microsoft.VSTS.Scheduling.StoryPoints': 8 }),
          ],
        },
      },
    ]);
    const rows = await azure.listWorkItems({ sprintPath: 'Mawid\\Sprint 1' });
    expect(rows.map((r) => r.id)).toEqual([42, 35]);
    expect(rows[1]).toMatchObject({ points: 3, sprint: 'Sprint 1', tags: ['owner', 'mvp'], url: 'https://dev.azure.com/momenysr/Mawid/_workitems/edit/35' });
    const query = (calls[0]!.body as { query: string }).query;
    expect(query).toContain("[System.IterationPath] = 'Mawid\\Sprint 1'");
    expect(query).toContain("NOT IN ('Closed', 'Done', 'Removed')");
    expect(calls[0]!.headers.authorization).toBe('Basic ' + Buffer.from(':secret').toString('base64'));
  });

  it('reads a story with its feature, epic and the stories it depends on', async () => {
    const { azure } = fakeAzure([
      {
        method: 'GET',
        match: /workitems\/49\?/,
        reply: item(
          49,
          {
            'System.WorkItemType': 'User Story',
            'System.Title': 'Specialists have their own hours',
            'System.State': 'New',
            'System.Description': '<p>As an owner, I want <b>hours</b>.</p>',
            'Microsoft.VSTS.Common.AcceptanceCriteria': '<ol><li><b>Given</b> a specialist</li><li>Then &amp; done</li></ol>',
          },
          [
            { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/momenysr/_apis/wit/workItems/11' },
            { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/momenysr/_apis/wit/workItems/42' },
          ],
        ),
      },
      { method: 'GET', match: /workitems\/11\?/, reply: item(11, { 'System.WorkItemType': 'Feature', 'System.Title': 'Staff and opening hours' }, [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'x/workItems/7' }]) },
      { method: 'GET', match: /workitems\/7\?/, reply: item(7, { 'System.WorkItemType': 'Epic', 'System.Title': 'Business setup' }) },
      { method: 'POST', match: /workitemsbatch/, reply: { value: [item(42, { 'System.Title': 'Customer picks a time', 'System.State': 'Active' })] } },
    ]);
    const w = await azure.getWorkItem(49);
    expect(w.description).toBe('As an owner, I want hours.');
    expect(w.acceptanceCriteria).toBe('- Given a specialist\n- Then & done');
    expect(w.parents).toEqual([
      { id: 11, type: 'Feature', title: 'Staff and opening hours' },
      { id: 7, type: 'Epic', title: 'Business setup' },
    ]);
    expect(w.dependsOn).toEqual([{ id: 42, title: 'Customer picks a time', state: 'Active' }]);
  });

  it('moves a work item by state category, whatever the process calls it', async () => {
    const { azure, calls } = fakeAzure([
      { method: 'GET', match: /workitems\/35\?fields/, reply: item(35, { 'System.WorkItemType': 'Product Backlog Item', 'System.State': 'New' }) },
      {
        method: 'GET',
        match: /workitemtypes\/Product%20Backlog%20Item\/states/,
        reply: { value: [{ name: 'New', category: 'Proposed' }, { name: 'Committed', category: 'InProgress' }, { name: 'Done', category: 'Completed' }] },
      },
      { method: 'PATCH', match: /workitems\/35/, reply: item(35, {}) },
    ]);
    expect(await azure.moveTo(35, 'InProgress')).toBe('Committed');
    expect(calls.at(-1)!.body).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Committed' }]);
    // Scrum has no Resolved state, so nothing changes.
    expect(await azure.moveTo(35, 'Resolved')).toBeNull();
  });

  it('finds Resolved in the Agile process, where it sits in the In Progress category, and never moves back', () => {
    const agile = [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
    ];
    expect(pickState(agile, 'InProgress', 0)).toBe('Active');
    expect(pickState(agile, 'Resolved', 1)).toBe('Resolved');
    expect(pickState(agile, 'Completed', 2)).toBe('Closed');
    const scrum = [
      { name: 'New', category: 'Proposed' },
      { name: 'Committed', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ];
    expect(pickState(scrum, 'Resolved', 1)).toBeUndefined();
  });

  it('opens a PR linked to the work item and merges it', async () => {
    let polls = 0;
    const { azure, calls } = fakeAzure([
      { method: 'POST', match: /repositories\/Mawid\/pullrequests/, reply: { pullRequestId: 7, status: 'active' } },
      {
        method: 'GET',
        match: /pullrequests\/7/,
        reply: () => (++polls < 2 ? { pullRequestId: 7, status: 'active', lastMergeSourceCommit: { commitId: 'abc' } } : { pullRequestId: 7, status: 'completed', lastMergeCommit: { commitId: 'm1' } }),
      },
      { method: 'PATCH', match: /pullrequests\/7/, reply: { pullRequestId: 7, status: 'active', mergeStatus: 'queued' } },
    ]);
    const pr = await azure.createPullRequest({ repo: 'Mawid', source: 'squad/ma-1', target: 'main', title: 'Owner signs up', description: 'x', workItemIds: [35] });
    expect(pr.url).toBe('https://dev.azure.com/momenysr/Mawid/_git/Mawid/pullrequest/7');
    expect(calls[0]!.body).toMatchObject({ sourceRefName: 'refs/heads/squad/ma-1', targetRefName: 'refs/heads/main', workItemRefs: [{ id: '35' }] });
    const done = await azure.completePullRequest('Mawid', 7, 'Merge PR 7');
    expect(done.mergeCommit).toBe('m1');
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { completionOptions: { mergeStrategy: string; deleteSourceBranch: boolean } };
    expect(patch.completionOptions).toMatchObject({ mergeStrategy: 'noFastForward', deleteSourceBranch: true });
  }, 10_000);

  it('reads every page of the project wiki', async () => {
    const { azure } = fakeAzure([
      { method: 'GET', match: /_apis\/wiki\/wikis\?/, reply: { value: [{ id: 'w1', type: 'projectWiki' }] } },
      { method: 'GET', match: /pages\?path=%2FBusiness%20rules&includeContent/, reply: { content: '# Business rules\nRiyadh time.' } },
      { method: 'GET', match: /pages\?path=%2FGlossary&includeContent/, reply: { content: '' } },
      { method: 'GET', match: /pages\?path=\/&recursionLevel=full/, reply: { path: '/', subPages: [{ path: '/Business rules' }, { path: '/Glossary' }] } },
    ]);
    // Empty pages are left out.
    expect(await azure.wikiPages()).toEqual([{ path: '/Business rules', content: '# Business rules\nRiyadh time.' }]);
  });

  it('explains a refused token in plain words', async () => {
    const { azure } = fakeAzure([{ method: 'GET', match: /connectionData/, reply: { message: 'TF400813: not authorized' }, status: 401 }]);
    await expect(azure.whoAmI()).rejects.toThrow(/refused the token .*TF400813/);
  });
});

describe('Azure helpers', () => {
  it('recognises Azure Repos remotes', () => {
    expect(parseAzureRemote('https://dev.azure.com/momenysr/Mawid/_git/Mawid')).toEqual({ organization: 'momenysr', project: 'Mawid', repo: 'Mawid' });
    expect(parseAzureRemote('https://momenysr@dev.azure.com/momenysr/My%20Project/_git/api')).toEqual({ organization: 'momenysr', project: 'My Project', repo: 'api' });
    expect(parseAzureRemote('https://dttmoj.visualstudio.com/DefaultCollection/AI/_git/moj-t4-api')).toEqual({ organization: 'dttmoj', project: 'AI', repo: 'moj-t4-api' });
    expect(parseAzureRemote('git@ssh.dev.azure.com:v3/momenysr/Mawid/Mawid')).toEqual({ organization: 'momenysr', project: 'Mawid', repo: 'Mawid' });
    expect(parseAzureRemote('https://github.com/a/b.git')).toBeNull();
  });

  it('gives git the token through env vars only for Azure https remotes', () => {
    const env = gitAuthEnv('secret', 'https://dev.azure.com/momenysr/Mawid/_git/Mawid');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://dev.azure.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: Basic ' + Buffer.from(':secret').toString('base64'));
    expect(gitAuthEnv('secret', 'https://github.com/a/b.git')).toEqual({});
    expect(gitAuthEnv(undefined, 'https://dev.azure.com/momenysr/Mawid/_git/Mawid')).toEqual({});
  });

  it('turns Azure HTML into plain text', () => {
    expect(htmlToText('<div>One<br>Two</div><ul><li>A</li><li>B</li></ul>')).toBe('One\nTwo\n- A\n- B');
  });
});
