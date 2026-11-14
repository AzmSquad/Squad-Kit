import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMAIL, SITE, fakeJira, type FakeJiraOptions } from './fakes/jira.js';
import { trackerContract, trackerCreateContract } from './contracts/tracker.js';
import { JiraClient } from '../src/modules/jira/client.js';
import { JiraTracker } from '../src/modules/jira/tracker.js';
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
trackerCreateContract('Jira Cloud without an Acceptance Criteria field', () => jira({ noCriteria: true }).tracker);
trackerCreateContract('Jira Cloud with In Review, a step at a time', () => jira({ review: true, steps: true }).tracker);

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
    expect(fake.links).toContainEqual({ type: 'Relates', source: bug.id, target: 'PAY-40' });
  });

  it('a breakdown: Epic, then a Story under it, then a Sub-task under that; a story straight under an epic is a Story', async () => {
    const { tracker, fake } = jira();
    expect(await tracker.levels()).toEqual({ epic: 'Epic', feature: 'Story', story: 'Subtask', process: 'company-managed', project: 'Payments' });
    const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x', tags: ['BR 1'] });
    const alone = await tracker.createItem({ level: 'story', title: 'Check in', markdown: 'x', parent: epic.id });
    expect(alone.type).toBe('Story');
    expect(fake.issues.get(epic.id)!.labels).toEqual(['BR-1']);
    const feature = await tracker.createItem({ level: 'feature', title: 'Paying', markdown: 'x', parent: epic.id });
    const story = await tracker.createItem({ level: 'story', title: 'Pay by card', markdown: 'As a guest…', acceptance: '**Given** a card', parent: feature.id, tags: ['BR-1'] });
    expect(story.type).toBe('Subtask');
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark: 'As a guest' })).toMatchObject({ id: story.id });
    expect(await tracker.findMade({ level: 'story', tag: 'BR-1', mark: 'nothing like it' })).toBeNull();
  });

  it('a feature story with the criteria field gets them there; a site without sub-tasks says so before a story goes under a feature', async () => {
    const { tracker, fake } = jira();
    const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x' });
    const feature = await tracker.createItem({ level: 'story', title: 'Check in', markdown: 'Text', acceptance: 'Given a guest', parent: epic.id });
    expect(JSON.stringify(fake.issues.get(feature.id)!.criteria)).toContain('Given a guest');
    expect(JSON.stringify(fake.issues.get(feature.id)!.description)).not.toContain('Given a guest');
    const bare = jira({ noSubtask: true }).tracker;
    expect((await bare.levels()).story).toBe('Story');
    const e = await bare.createItem({ level: 'epic', title: 'E', markdown: 'x' });
    const f = await bare.createItem({ level: 'feature', title: 'F', markdown: 'x', parent: e.id });
    await expect(bare.createItem({ level: 'story', title: 'S', markdown: 'x', parent: f.id })).rejects.toThrow(/has no Sub-task issue type/);
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
