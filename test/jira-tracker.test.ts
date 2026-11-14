import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMAIL, SITE, fakeJira, type FakeJiraOptions } from './fakes/jira.js';
import { trackerContract, trackerCreateContract } from './contracts/tracker.js';
import { JiraClient } from '../src/modules/jira/client.js';
import { JiraTracker } from '../src/modules/jira/tracker.js';
import { siteOf } from '../src/modules/jira/refs.js';
import type { JiraSettings } from '../src/modules/jira/settings.js';
import { ModuleError, mayPassSoon, refusedForGood } from '../src/modules/errors.js';
import { sprintToShow } from '../src/modules/tracker/sprints.js';

/** Jira Cloud as a tracker, against a fake Jira Cloud: the shared tests, then the backlog, items, states, writes and errors. */

const SETTINGS: JiraSettings = { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', board: { id: 1, name: 'PAY board' }, readOnly: false };

function jira(opts: FakeJiraOptions = {}, settings: Partial<JiraSettings> = {}, token = 'secret') {
  const fake = fakeJira('secret', opts);
  const s = { ...SETTINGS, token, ...settings };
  const waits: number[] = [];
  const tracker = new JiraTracker(new JiraClient(s, fake.fetch, { pause: async (ms) => void waits.push(ms) }), s);
  return { fake, tracker, waits };
}

trackerContract('Jira Cloud', () => {
  const { fake, tracker } = jira();
  return { tracker, story: 'PAY-40', comments: (id) => fake.comments(id), refused: jira({}, {}, 'wrong').tracker };
});

trackerCreateContract('Jira Cloud', () => jira().tracker);
trackerCreateContract('Jira Cloud with Initiative above Epic', () => jira({ initiative: true }).tracker);
trackerCreateContract('Jira Cloud without an Acceptance Criteria field or sub-tasks', () => jira({ noCriteria: true, noSubtask: true }).tracker);
trackerCreateContract('Jira Cloud with In Review, a step at a time, and its Relates link renamed', () => jira({ review: true, steps: true, noRelates: true }).tracker);

describe('Jira refs', () => {
  const { tracker } = jira();

  it('takes keys, numbers in the project and pasted links', () => {
    expect(tracker.parseRef('PAY-40')).toBe('PAY-40');
    expect(tracker.parseRef(' pay-40 ')).toBe('PAY-40');
    expect(tracker.parseRef('40')).toBe('PAY-40');
    expect(tracker.parseRef(`https://${SITE}/browse/OPS-7`)).toBe('OPS-7');
    expect(tracker.parseRef(`https://${SITE}/jira/software/projects/PAY/boards/1?selectedIssue=PAY-41`)).toBe('PAY-41');
    expect(tracker.parseRef('AB#40')).toBeNull();
    expect(tracker.parseRef('PAY-0')).toBeNull();
    expect([siteOf('acme'), siteOf(`https://${SITE}/browse/PAY-4`), siteOf('jira.mycorp.com')]).toEqual([SITE, SITE, 'jira.mycorp.com']);
    expect([siteOf(`${SITE}:8443`), siteOf('10.0.0.5'), siteOf('https://1.2.3.4/browse/PAY-4'), siteOf('[::1]'), siteOf('acme .net')]).toEqual([null, null, null, null, null]);
    expect(tracker.refOf('PAY-40')).toBe('PAY-40');
    expect(tracker.refOf('40')).toBe('PAY-40');
  });
});

describe('Jira backlog', () => {
  it("lists the project's stories, tasks and bugs in rank order, without epics, sub-tasks or finished ones", async () => {
    const { tracker, fake } = jira();
    const rows = await tracker.list();
    expect(rows.map((r) => r.ref)).toEqual(['PAY-40', 'PAY-41', 'PAY-42', 'PAY-44']);
    expect(rows[0]).toMatchObject({ type: 'Story', title: 'Hold a slot', state: 'To Do', points: 3, priority: 2, sprint: 'PAY Sprint 7', assignedTo: 'Sara Ali', tags: ['ready'], url: `https://${SITE}/browse/PAY-40`, isBug: false });
    expect(rows[2]).toMatchObject({ ref: 'PAY-42', isBug: true, priority: 1 });
    expect(rows.more).toBeUndefined();
    // Only the paged JQL search: Atlassian removed the old one in 2025.
    expect(fake.requests.filter((r) => r.url.includes('/search')).every((r) => r.method === 'POST' && r.url.endsWith('/rest/api/3/search/jql'))).toBe(true);
    expect((await tracker.list({ includeDone: true })).map((r) => r.ref)).toContain('PAY-43');
  });

  it("a sprint's items, and the sprints with the running one shown first", async () => {
    const { tracker } = jira();
    const sprints = await tracker.sprints();
    expect(sprints.map((s) => [s.name, s.path, s.current])).toEqual([
      ['PAY Sprint 5', '5', false],
      ['PAY Sprint 6', '6', false],
      ['PAY Sprint 7', '7', true],
      ['PAY Sprint 8', '8', false],
    ]);
    expect(sprints[2]).toMatchObject({ start: '2026-11-02', finish: '2026-11-16' });
    expect(sprintToShow(sprints)?.path).toBe('7');
    expect((await tracker.list({ sprint: '7' })).map((r) => r.ref)).toEqual(['PAY-40', 'PAY-42']);
    await expect(tracker.list({ sprint: 'Sprint 7' })).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('pages with nextPageToken up to 500, and says when there were more', async () => {
    const { tracker, fake } = jira({ extra: 520 });
    const rows = await tracker.list();
    expect(rows).toHaveLength(500);
    expect(rows.more).toBe(true);
    const pages = fake.requests.filter((r) => r.url.endsWith('/search/jql'));
    expect(pages).toHaveLength(5);
  });

  it("stops when Jira gives the same page token again and never says it is the last (Jira's paging bug)", async () => {
    const { tracker, fake } = jira({ stuckPaging: true, extra: 300 });
    const rows = await tracker.list();
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((r) => r.id)).size).toBe(100);
    expect(fake.requests.filter((r) => r.url.endsWith('/search/jql')).length).toBeLessThanOrEqual(3);
  });

  it('without sprints when no board is chosen, and a plain way out when no project is', async () => {
    expect(await jira({}, { board: undefined }).tracker.sprints()).toEqual([]);
    expect(jira({}, { board: undefined }).tracker.abilities.sprints).toBe(false);
    const none = jira({}, { project: undefined }).tracker;
    await expect(none.list()).rejects.toThrow('Pick the Jira project the stories come from in Settings, then press Save and check.');
    expect(none.abilities.create).toBe(false);
    // One item by its key still works.
    expect((await none.get('PAY-40')).title).toBe('Hold a slot');
  });
});

describe('Jira items', () => {
  it('reads the text as Markdown, the criteria field, the parents nearest first, what it needs and its files', async () => {
    const { tracker } = jira();
    const sub = await tracker.get('PAY-45');
    expect(sub.parents.map((p) => [p.id, p.type])).toEqual([
      ['PAY-40', 'Story'],
      ['PAY-10', 'Epic'],
    ]);
    const story = await tracker.get('PAY-40');
    expect(story.description).toBe('As a guest, I want to hold a slot, so that nobody takes it.');
    expect(story.acceptanceCriteria).toBe('Given a free slot\n\nWhen I hold it, then it is mine for 10 minutes');
    expect(story.attachments).toEqual([{ name: 'slot.png', url: `https://${SITE}/rest/api/3/attachment/content/10100`, size: 4 }]);
    expect((await tracker.get('PAY-44')).dependsOn).toEqual([{ ref: 'PAY-41', title: 'Pay at the desk', state: 'To Do' }]);
    await expect(tracker.get('PAY-999')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('without a criteria field, the part of the text under Done when is the criteria', async () => {
    const { tracker, fake } = jira({ noCriteria: true });
    fake.issues.get('PAY-41')!.description = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Pay in cash.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Done when', marks: [{ type: 'strong' }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a receipt prints' }] }] }] },
      ],
    };
    expect(await tracker.get('PAY-41')).toMatchObject({ description: 'Pay in cash.', acceptanceCriteria: '- a receipt prints' });
  });

  it("downloads a file through Jira's redirect, with no sign-in sent to the media host", async () => {
    const { tracker, fake } = jira();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jira-')), 'files', 'slot.png');
    await tracker.download(`https://${SITE}/rest/api/3/attachment/content/10100`, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('PNG!');
    expect(fake.requests.slice(-2).map((r) => [new URL(r.url).host, r.signedIn])).toEqual([
      [SITE, true],
      ['api.media.atlassian.com', false],
    ]);
    await expect(tracker.download('https://evil.example/file', file)).rejects.toThrow(`squad-kit only downloads files kept on ${SITE}.`);
  });
});

describe('Jira states', () => {
  it('a workflow without review: resolved is Done once merged, and stays in progress while its pull request waits', async () => {
    const { tracker, fake } = jira();
    expect(await tracker.moveTo('PAY-41', 'resolved', { merged: false })).toBe('In Progress');
    expect(await tracker.moveTo('PAY-41', 'resolved', { merged: false })).toBeNull();
    expect(await tracker.moveTo('PAY-41', 'resolved')).toBe('Done');
    expect(await tracker.moveTo('PAY-41', 'in-progress')).toBeNull();
    expect(fake.issues.get('PAY-41')!.status).toBe('Done');
  });

  it('a workflow with In Review: resolved is In Review, merged or not, and closed is Done', async () => {
    const { tracker, fake } = jira({ review: true });
    expect(await tracker.moveTo('PAY-40', 'resolved', { merged: false })).toBe('In Review');
    expect(await tracker.moveTo('PAY-40', 'resolved')).toBeNull();
    expect(await tracker.moveTo('PAY-40', 'closed')).toBe('Done');
    expect(fake.issues.get('PAY-40')!.status).toBe('Done');
  });

  it("goes a step at a time where the workflow has no direct way, and never to Won't Do", async () => {
    const { tracker, fake } = jira({ review: true, steps: true });
    expect(await tracker.moveTo('PAY-41', 'closed')).toBe('Done');
    const moves = fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/transitions'));
    expect(moves).toHaveLength(3);
    expect(fake.issues.get('PAY-41')!.status).toBe('Done');
  });
});

describe('Jira writes', () => {
  it('comments in ADF, with the marks and lists squad-kit writes', async () => {
    const { tracker, fake } = jira();
    await tracker.comment('PAY-40', '**Plan approved**\n\n1. Given a day\n2. Then it is saved');
    const body = JSON.parse(fake.comments('PAY-40')[0]!);
    expect(body.content[0].content[0]).toEqual({ type: 'text', text: 'Plan approved', marks: [{ type: 'strong' }] });
    expect(body.content[1].type).toBe('orderedList');
  });

  it('adds a label, with spaces turned into dashes as Jira wants', async () => {
    const { tracker, fake } = jira();
    await tracker.addTag('PAY-40', 'release 1.3.22');
    expect(fake.issues.get('PAY-40')!.labels).toEqual(['ready', 'release-1.3.22']);
  });

  it('files a bug as a Bug with its severity as the priority, related to what it was found with', async () => {
    const { tracker, fake } = jira();
    const bug = await tracker.fileBug({ title: 'Slot never frees', steps: 'Hold a slot\n\nWait 11 minutes', severity: 'stops-work', tags: ['v1.3.22'], related: ['PAY-40'] });
    expect(bug).toMatchObject({ type: 'Bug', isBug: true, priority: 1, tags: ['v1.3.22'] });
    expect(fake.links).toContainEqual(expect.objectContaining({ type: 'Relates', source: bug.id, target: 'PAY-40' }));
  });

  it('a breakdown without a level above Epic: epics and features are Epics, a feature linked to its epic, and every story a Story the backlog lists', async () => {
    const { tracker, fake } = jira();
    expect(await tracker.levels()).toEqual({ epic: 'Epic', feature: 'Epic', story: 'Story', process: 'company-managed', project: 'Payments', linked: ['feature'] });
    const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x', tags: ['BR 1'] });
    expect(fake.issues.get(epic.id)!.labels).toEqual(['BR-1']);
    const feature = await tracker.createItem({ level: 'feature', title: 'Paying', markdown: 'x', parent: epic.id });
    // Jira puts no Epic under an Epic: the feature sits beside its epic, linked and labelled with its name.
    expect(fake.issues.get(feature.id)).toMatchObject({ type: 'Epic', labels: ['epic-front-desk'] });
    expect(fake.issues.get(feature.id)!.parent).toBeUndefined();
    expect(fake.links).toContainEqual(expect.objectContaining({ type: 'Relates', source: feature.id, target: epic.id }));
    const story = await tracker.createItem({ level: 'story', title: 'Pay by card', markdown: 'As a guest…', acceptance: 'Given a card', parent: feature.id, tags: ['BR-1'] });
    const alone = await tracker.createItem({ level: 'story', title: 'Check in', markdown: 'x', parent: epic.id });
    expect([story.type, alone.type]).toEqual(['Story', 'Story']);
    expect([fake.issues.get(story.id)!.parent, fake.issues.get(alone.id)!.parent]).toEqual([feature.id, epic.id]);
    expect(JSON.stringify(fake.issues.get(story.id)!.criteria)).toContain('Given a card');
    expect((await tracker.get(story.id)).parents.map((p) => [p.id, p.type])).toEqual([
      [feature.id, 'Epic'],
      [epic.id, 'Epic'],
    ]);
    // Every story sent can be built: the backlog lists it.
    expect((await tracker.list()).map((r) => r.id)).toEqual(expect.arrayContaining([story.id, alone.id]));
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark: 'As a guest' })).toMatchObject({ id: story.id });
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark: 'nothing like it' })).toBeNull();
  });

  it('a feature moved to another epic: the old link and label go, the new ones come, and sending again changes nothing', async () => {
    const { tracker, fake } = jira();
    const first = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x' });
    const second = await tracker.createItem({ level: 'epic', title: 'Billing', markdown: 'x' });
    const feature = await tracker.createItem({ level: 'feature', title: 'Paying', markdown: 'x', parent: first.id });
    const story = await tracker.createItem({ level: 'story', title: 'Pay by card', markdown: 'x', parent: feature.id });
    await tracker.updateItem(feature.id, { parent: second.id });
    expect(fake.issues.get(feature.id)!.labels).toEqual(['epic-billing']);
    expect(fake.links.filter((l) => l.source === feature.id).map((l) => l.target)).toEqual([second.id]);
    expect((await tracker.get(story.id)).parents.map((p) => p.id)).toEqual([feature.id, second.id]);
    const before = fake.requests.length;
    await tracker.updateItem(feature.id, { title: 'Paying', parent: second.id });
    expect(fake.requests.slice(before).filter((r) => r.method !== 'GET').map((r) => r.method)).toEqual(['PUT']);
    expect(fake.links.filter((l) => l.source === feature.id)).toHaveLength(1);
  });

  it('a breakdown with Initiative above Epic: Initiative, Epic, Story nest, and a story straight under an initiative is linked to it', async () => {
    const { tracker, fake } = jira({ initiative: true });
    expect(await tracker.levels()).toMatchObject({ epic: 'Initiative', feature: 'Epic', story: 'Story', linked: ['story'] });
    const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x' });
    const feature = await tracker.createItem({ level: 'feature', title: 'Paying', markdown: 'x', parent: epic.id });
    expect(fake.issues.get(feature.id)).toMatchObject({ type: 'Epic', parent: epic.id, labels: [] });
    const alone = await tracker.createItem({ level: 'story', title: 'Check in', markdown: 'x', parent: epic.id });
    expect(fake.issues.get(alone.id)).toMatchObject({ type: 'Story', labels: ['epic-front-desk'] });
    expect((await tracker.get(alone.id)).parents.map((p) => [p.id, p.type])).toEqual([[epic.id, 'Initiative']]);
    // Moved under a feature: Jira's parent now, and the link and label to the initiative go.
    await tracker.updateItem(alone.id, { parent: feature.id });
    expect(fake.issues.get(alone.id)).toMatchObject({ parent: feature.id, labels: [] });
    expect(fake.links.filter((l) => l.source === alone.id)).toEqual([]);
    expect((await tracker.get(alone.id)).parents.map((p) => p.id)).toEqual([feature.id, epic.id]);
  });

  it("no item is ever a sub-task, and a bug relating to a story is not taken for its parent", async () => {
    const { tracker, fake } = jira();
    const epic = await tracker.createItem({ level: 'epic', title: 'E', markdown: 'x' });
    const feature = await tracker.createItem({ level: 'feature', title: 'F', markdown: 'x', parent: epic.id });
    const story = await tracker.createItem({ level: 'story', title: 'S', markdown: 'x', parent: feature.id });
    expect([...fake.issues.values()].filter((i) => i.type === 'Subtask').map((i) => i.key)).toEqual(['PAY-45']);
    const bug = await tracker.fileBug({ title: 'B', steps: 'x', severity: 'small', tags: [], related: [story.id] });
    expect((await tracker.get(bug.id)).parents).toEqual([]);
  });

  it('set up before this version: reads work, every write waits as a sign-in problem with the way to connect again', async () => {
    const { tracker, fake } = jira({}, { readOnly: true });
    expect(tracker.abilities.create).toBe(false);
    expect((await tracker.list()).length).toBeGreaterThan(0);
    for (const write of [() => tracker.moveTo('PAY-40', 'in-progress'), () => tracker.comment('PAY-40', 'x'), () => tracker.addTag('PAY-40', 'x')]) {
      const err = await write().catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'sign-in' });
      expect((err as Error).message).toContain('Save and check');
      expect(mayPassSoon(err)).toBe(true);
    }
    expect(fake.issues.get('PAY-40')!.status).toBe('To Do');
  });
});

describe('Jira errors, in the shared way', () => {
  it('a token Jira refuses: sign-in, saying tokens expire, and never the token itself', async () => {
    const err = await jira({}, {}, 'expired-token-123').tracker.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect(err).toMatchObject({ kind: 'sign-in', status: 401 });
    expect((err as Error).message).toContain('expired');
    expect((err as Error).message).not.toContain('expired-token-123');
  });

  it('too many calls: a short wait is waited once; a long one is said with its seconds', async () => {
    const short = jira({ busy: 'once' });
    expect(await short.tracker.whoAmI()).toBe('Sara Ali');
    expect(short.waits).toEqual([1000]);
    const long = await jira({ busy: 'always' }).tracker.whoAmI().catch((e: unknown) => e);
    expect(long).toMatchObject({ kind: 'too-many', status: 429 });
    expect((long as Error).message).toContain('30 seconds');
    expect(mayPassSoon(long)).toBe(true);
  });

  it('no connection, and a refusal that stays', async () => {
    const offline = jira({}, { site: 'gone.atlassian.net' }).tracker;
    await expect(offline.whoAmI()).rejects.toMatchObject({ kind: 'offline' });
    const { tracker } = jira();
    const bad = await tracker.moveTo('NOPE', 'closed').catch((e: unknown) => e);
    expect(refusedForGood(bad)).toBe(true);
  });

  it('never puts the token in an address', async () => {
    const { tracker, fake } = jira();
    await tracker.list();
    await tracker.get('PAY-40');
    expect(fake.requests.every((r) => !r.url.includes('secret'))).toBe(true);
  });
});

describe('Jira workflows that are not straight', () => {
  it('takes a sideways step (In Progress to QA) when that is the only way on, and Bugs keep their own workflow', async () => {
    const { tracker, fake } = jira({ qa: 'way' });
    expect(await tracker.moveTo('PAY-40', 'closed')).toBe('Done');
    expect(fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/transitions'))).toHaveLength(3);
    expect(await tracker.moveTo('PAY-42', 'closed')).toBe('Done');
  });

  it("says plainly when the workflow has no way on, and that is not sent again", async () => {
    const { tracker, fake } = jira({ qa: 'dead-end' });
    const err = await tracker.moveTo('PAY-40', 'closed').catch((e: unknown) => e);
    expect((err as Error).message).toBe("Jira's workflow has no way from QA to Done; move PAY-40 in Jira.");
    expect(refusedForGood(err)).toBe(true);
    expect(fake.issues.get('PAY-40')!.status).toBe('QA');
  });

  it('prefers a way without a screen, and words a step Jira refuses for a missing field', async () => {
    const plain = jira({ screen: 'also' });
    expect(await plain.tracker.moveTo('PAY-41', 'closed')).toBe('Done');
    const only = jira({ screen: 'only' });
    const err = await only.tracker.moveTo('PAY-41', 'closed').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Jira needs more than squad-kit can fill in to move PAY-41 to Done (resolution: Resolution is required). Move it in Jira.');
    expect(refusedForGood(err)).toBe(true);
  });
});

describe('Jira, the careful parts', () => {
  it('a breakdown item made seconds before a cut is found on a second look, after a wait', async () => {
    const { tracker, waits } = jira({ lag: 1 });
    const made = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'Made by squad-kit for BR-1 E-1', tags: ['BR-1'] });
    expect(await tracker.findMade({ level: 'epic', tag: 'BR-1', mark: 'BR-1 E-1' })).toMatchObject({ id: made.id });
    expect(waits).toEqual([5000]);
  });

  it('labels only where the screens have them; a title is one line of at most 255 characters', async () => {
    const { tracker, fake } = jira({ noLabels: true });
    const epic = await tracker.createItem({ level: 'epic', title: `Front\ndesk ${'x'.repeat(300)}`, markdown: 'x', tags: ['BR-1'] });
    expect(fake.issues.get(epic.id)!.summary).toMatch(/^Front desk x+$/);
    expect(fake.issues.get(epic.id)!.summary).toHaveLength(255);
    const feature = await tracker.createItem({ level: 'feature', title: 'Paying', markdown: 'x', parent: epic.id });
    expect(fake.issues.get(feature.id)!.labels).toEqual([]);
    expect(fake.links).toContainEqual(expect.objectContaining({ type: 'Relates', source: feature.id, target: epic.id }));
    // Sent again: the link is there already, so nothing is linked twice.
    await tracker.updateItem(feature.id, { parent: epic.id });
    expect(fake.links.filter((l) => l.source === feature.id)).toHaveLength(1);
    const bug = await tracker.fileBug({ title: 'B', steps: 'x', severity: 'small', tags: ['v1'], related: [] });
    expect(fake.issues.get(bug.id)!.labels).toEqual([]);
  });

  it('every link goes through the issue link call, never an edit', async () => {
    const { tracker, fake } = jira();
    await tracker.linkDepends('PAY-44', ['PAY-40']);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/rest/api/3/issueLink'))).toHaveLength(1);
    expect(fake.links).toContainEqual(expect.objectContaining({ type: 'Blocks', source: 'PAY-40', target: 'PAY-44' }));
    expect((await tracker.get('PAY-44')).dependsOn.map((d) => d.ref)).toEqual(['PAY-41', 'PAY-40']);
  });

  it('an update sets what the edit screen has: criteria only on the create screen go in the text', async () => {
    const { tracker, fake } = jira({ criteriaOnCreateOnly: true });
    await tracker.updateItem('PAY-40', { markdown: 'Hold it longer.', acceptance: 'Given 20 minutes' });
    expect(JSON.stringify(fake.issues.get('PAY-40')!.description)).toContain('Given 20 minutes');
  });

  it('JQL: quotes and backslashes in a label are escaped, and a project key that is not one never reaches a query', async () => {
    const { tracker } = jira();
    const made = await tracker.createItem({ level: 'epic', title: 'E', markdown: 'mark-1', tags: ['BR"1\\x'] });
    expect(await tracker.findMade({ level: 'epic', tag: 'BR"1\\x', mark: 'mark-1' })).toMatchObject({ id: made.id });
    const odd = jira({}, { project: 'PAY" OR project = "OPS' });
    await expect(odd.tracker.list()).rejects.toThrow('is not a Jira project key');
    expect(odd.fake.requests.filter((r) => r.url.includes('/search'))).toEqual([]);
  });
});

describe('Jira client answers that are not Jira data', () => {
  const access = { site: SITE, email: EMAIL, token: 'secret' };
  const seen: string[] = [];
  const answer = (res: () => Response) =>
    (async (input: string | URL | Request) => {
      seen.push(String(input));
      return res();
    }) as typeof fetch;

  it('a web page instead of data (a proxy or a sign-in page) is said plainly', async () => {
    const client = new JiraClient(access, answer(() => new Response('<html><body>Log in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(client.call('GET', '/rest/api/3/myself')).rejects.toThrow(`${SITE} answered with a web page instead of Jira's data.`);
  });

  it('a site that moved: one call, not followed, said with where it sends', async () => {
    seen.length = 0;
    const client = new JiraClient(access, answer(() => new Response(null, { status: 302, headers: { location: 'https://new.atlassian.net/rest/api/3/myself' } })));
    const err = await client.call('GET', '/rest/api/3/myself').catch((e: unknown) => e);
    expect((err as Error).message).toBe(`Jira at ${SITE} sends squad-kit to new.atlassian.net. If your site moved, enter the new one in Settings.`);
    expect(refusedForGood(err)).toBe(true);
    expect(seen).toEqual([`https://${SITE}/rest/api/3/myself`]);
  });

  it('only paths on the site: an address on another host is refused before any call', async () => {
    seen.length = 0;
    const client = new JiraClient(access, answer(() => new Response('{}')));
    await expect(client.call('GET', 'https://evil.example/steal')).rejects.toThrow('A Jira call takes a path on the site');
    expect(seen).toEqual([]);
  });
});
