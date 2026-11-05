import { describe, it, expect } from 'vitest';
import { fakeAzureDevOps, type FakeAzureOptions } from './fakes/azure-devops.js';
import { Azure, processOf } from '../src/modules/azure/client.js';
import { AzureTracker } from '../src/modules/azure/tracker.js';

/** Making epics, features and stories in Azure Boards, for a breakdown's send. */

const CRITERIA = 'Microsoft.VSTS.Common.AcceptanceCriteria';
const ITEM_URL = 'https://dev.azure.com/momenysr/_apis/wit/workItems/';

function setup(opts: FakeAzureOptions = {}) {
  const fake = fakeAzureDevOps('secret', opts);
  const sent: { method: string; url: string; type?: string }[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? 'GET', url, type: (init.headers as Record<string, string>)['content-type'] });
    return fake.fetch(url, init);
  }) as unknown as typeof fetch;
  const tracker = new AzureTracker(new Azure({ organization: 'momenysr', project: 'Mawid', pat: 'secret' }, http));
  return { fake, tracker, sent, last: () => fake.writes.at(-1)! };
}

const story = { level: 'story' as const, title: 'Hold a slot', markdown: 'As a guest, I want to hold a slot.\n\nFrom the BRD: 3.4 Holding a slot, page 7', acceptance: '**Given** a free slot\n**When** I hold it\n**Then** it is mine' };

describe('Azure Boards making items', () => {
  it('makes a story with a JSON patch: title, text and criteria as HTML, tags and its parent link', async () => {
    const { tracker, sent, last } = setup();
    const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'Guests book rooms online.' });
    const row = await tracker.createItem({ ...story, parent: epic.id, tags: ['squad-kit', 'BR-1'] });
    expect(row).toMatchObject({ ref: `AB#${row.id}`, type: 'User Story', url: `https://dev.azure.com/momenysr/Mawid/_workitems/edit/${row.id}` });
    expect(last().method).toBe('POST');
    expect(last().path).toMatch(/_apis\/wit\/workitems\/\$User Story$/);
    expect(sent.find((s) => s.method === 'POST' && /\$User%20Story/.test(s.url))?.type).toBe('application/json-patch+json');
    expect(last().body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Hold a slot' },
      { op: 'add', path: '/fields/System.Description', value: '<p>As a guest, I want to hold a slot.</p><p>From the BRD: 3.4 Holding a slot, page 7</p>' },
      { op: 'add', path: `/fields/${CRITERIA}`, value: '<p><b>Given</b> a free slot<br><b>When</b> I hold it<br><b>Then</b> it is mine</p>' },
      { op: 'add', path: '/fields/System.Tags', value: 'squad-kit; BR-1' },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ITEM_URL}${epic.id}` } },
    ]);
  });

  it('puts items into the backlog: no write ever sets an iteration', async () => {
    const { fake, tracker } = setup();
    const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    const feature = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'x', parent: epic.id });
    const s = await tracker.createItem({ ...story, parent: feature.id });
    await tracker.updateItem(s.id, { title: 'Hold a room', markdown: 'y', acceptance: 'z', parent: epic.id });
    await tracker.linkDepends(s.id, [feature.id]);
    const paths = fake.writes.flatMap((w) => w.body.map((op) => op.path));
    expect(paths.some((p) => /Iteration/i.test(p))).toBe(false);
    expect(fake.items.get(Number(s.id))!.sprint).toBeUndefined();
  });

  it('finds the process from the project work item types, and makes each level as that process names it', async () => {
    const expected = {
      Agile: ['Epic', 'Feature', 'User Story'],
      Scrum: ['Epic', 'Feature', 'Product Backlog Item'],
      CMMI: ['Epic', 'Feature', 'Requirement'],
      Basic: ['Epic', 'Issue', 'Task'],
    } as const;
    for (const process of Object.keys(expected) as (keyof typeof expected)[]) {
      const { tracker, sent } = setup({ process });
      const [epic, feature, s] = expected[process];
      expect(await tracker.levels()).toEqual({ epic, feature, story: s, process, project: 'Mawid' });
      const e = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
      const f = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'x', parent: e.id });
      const st = await tracker.createItem({ ...story, parent: f.id });
      expect([e.type, f.type, st.type]).toEqual([epic, feature, s]);
      // The types are read once per tracker.
      expect(sent.filter((x) => /workitemtypes\?/.test(x.url))).toHaveLength(1);
    }
    expect(processOf(['Epic', 'Feature', 'User Story', 'Issue', 'Task'])).toBe('Agile');
    expect(processOf(['Epic', 'Feature', 'Requirement', 'Issue', 'Task'])).toBe('CMMI');
    expect(processOf(['Bug', 'Test Case'])).toBeNull();
  });

  it('keeps the criteria in their own field where the type has one, and at the end of the description where not', async () => {
    const basic = setup({ process: 'Basic' });
    const e = await basic.tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    await basic.tracker.createItem({ ...story, parent: e.id });
    const ops = basic.last().body;
    expect(ops.some((o) => o.path === `/fields/${CRITERIA}`)).toBe(false);
    expect(ops.find((o) => o.path === '/fields/System.Description')?.value).toBe(
      '<p>As a guest, I want to hold a slot.</p><p>From the BRD: 3.4 Holding a slot, page 7</p><p><b>Done when</b></p><p><b>Given</b> a free slot<br><b>When</b> I hold it<br><b>Then</b> it is mine</p>',
    );

    // Fields not listed with the types are read for the type itself.
    const apart = setup({ fieldsApart: true });
    const e2 = await apart.tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    await apart.tracker.createItem({ ...story, parent: e2.id });
    expect(apart.last().body.some((o) => o.path === `/fields/${CRITERIA}`)).toBe(true);
    expect(apart.sent.some((x) => /workitemtypes\/User%20Story\/fields/.test(x.url))).toBe(true);

    // An update writes both again on a type that keeps the criteria in its text.
    const id = [...basic.fake.items].find(([, w]) => w.type === 'Task')![0];
    await basic.tracker.updateItem(String(id), { markdown: 'As a guest, I want to hold a room.', acceptance: '**Given** a free room' });
    expect(basic.last().body).toEqual([{ op: 'add', path: '/fields/System.Description', value: '<p>As a guest, I want to hold a room.</p><p><b>Done when</b></p><p><b>Given</b> a free room</p>' }]);
  });

  it('replaces the parent of a moved story: the old link goes, then the new one is added', async () => {
    const { fake, tracker, last } = setup();
    const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    const f1 = await tracker.createItem({ level: 'feature', title: 'Search', markdown: 'x', parent: epic.id });
    const f2 = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'x', parent: epic.id });
    const s = await tracker.createItem({ ...story, parent: f1.id });
    await tracker.linkDepends(s.id, [f1.id]);
    await tracker.updateItem(s.id, { parent: f2.id });
    expect(last()).toMatchObject({ method: 'PATCH', body: [{ op: 'remove', path: '/relations/0' }, { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ITEM_URL}${f2.id}` } }] });
    expect(fake.items.get(Number(s.id))).toMatchObject({ parent: Number(f2.id), deps: [Number(f1.id)] });

    // The same parent again: nothing is sent.
    const writes = fake.writes.length;
    await tracker.updateItem(s.id, { parent: f2.id });
    expect(fake.writes).toHaveLength(writes);
  });

  it('links a story to the stories it needs as predecessors, only the missing ones, and reads them back as dependsOn', async () => {
    const { fake, tracker, last } = setup();
    const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x' });
    const a = await tracker.createItem({ ...story, title: 'Check in', parent: epic.id });
    const b = await tracker.createItem({ ...story, title: 'Pay', parent: epic.id });
    const c = await tracker.createItem({ ...story, title: 'Check out', parent: epic.id });
    await tracker.linkDepends(c.id, [a.id]);
    expect(last().body).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Dependency-Reverse', url: `${ITEM_URL}${a.id}` } }]);
    await tracker.linkDepends(c.id, [a.id, b.id, b.id]);
    expect(last().body).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Dependency-Reverse', url: `${ITEM_URL}${b.id}` } }]);
    const writes = fake.writes.length;
    await tracker.linkDepends(c.id, [b.id, a.id]);
    expect(fake.writes).toHaveLength(writes);
    expect((await tracker.get(c.id)).dependsOn.map((d) => d.ref)).toEqual([`AB#${a.id}`, `AB#${b.id}`]);
  });

  it('finds an item a cut-off send made, by its tag and its "Made by squad-kit" line, in one query', async () => {
    const { tracker, sent } = setup();
    const mark = 'Made by squad-kit from BR-1, S-3.';
    const made = await tracker.createItem({ ...story, markdown: `${story.markdown}\n\n${mark}`, tags: ['squad-kit', 'BR-1'] });
    await tracker.createItem({ ...story, title: 'Another story', markdown: 'Made by squad-kit from BR-1, S-4.', tags: ['squad-kit', 'BR-1'] });
    await tracker.createItem({ ...story, markdown: 'Made by squad-kit from BR-2, S-3.', tags: ['squad-kit', 'BR-2'] });
    const before = sent.length;
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark })).toMatchObject({ id: made.id, ref: `AB#${made.id}`, title: 'Hold a slot' });
    const asked = sent.slice(before).filter((s) => s.method === 'POST');
    expect(asked.map((s) => s.url.replace(/\?.*$/, '').split('/').pop())).toEqual(['wiql', 'workitemsbatch']);
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark: 'Made by squad-kit from BR-1, S-9.' })).toBeNull();
    expect(await tracker.findMade({ level: 'epic', tag: 'BR-1', mark })).toBeNull();
  });

  it('never deletes: only POST and PATCH reach work items', async () => {
    const { tracker, sent } = setup();
    const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
    const s = await tracker.createItem({ ...story, parent: epic.id });
    await tracker.updateItem(s.id, { title: 'Hold a room' });
    expect(sent.some((x) => x.method === 'DELETE')).toBe(false);
  });

  it('says in plain words when the token may not write, or the project lacks a type', async () => {
    const denied = setup();
    denied.fake.denyWrites(true);
    await expect(denied.tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' })).rejects.toMatchObject({
      kind: 'sign-in',
      message:
        'Azure DevOps did not let squad-kit make an Epic in project Mawid. The token needs the Work Items (Read & write) scope, and its owner needs the right to add work items there. Check the token in Settings, then try again.',
    });

    const noEpic = setup({ disabled: ['Epic'] });
    await expect(noEpic.tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' })).rejects.toMatchObject({
      kind: 'not-found',
      message: "Project Mawid on Azure DevOps has no Epic work item type, which the Agile process uses for epics. Turn it on in the project's process settings, or ask the person who runs Azure DevOps.",
    });
    expect(noEpic.fake.writes).toHaveLength(0);

    const bare = new AzureTracker(
      new Azure({ organization: 'o', project: 'Mawid', pat: 'x' }, (async () => new Response(JSON.stringify({ value: [{ name: 'Bug' }, { name: 'Test Case' }] }))) as unknown as typeof fetch),
    );
    await expect(bare.levels()).rejects.toThrow(/has no User Story, Product Backlog Item, Requirement or Issue work item type/);
  });
});
