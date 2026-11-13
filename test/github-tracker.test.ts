import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOARD_ID, REPO, fakeGithub } from './fakes/github.js';
import { trackerContract, trackerCreateContract } from './contracts/tracker.js';
import { GithubTracker } from '../src/modules/github/tracker.js';
import type { GithubSettings } from '../src/modules/github/settings.js';
import { ModuleError } from '../src/modules/errors.js';
import { priorityOf } from '../src/modules/github/project.js';
import { attachmentsOf } from '../src/modules/github/body.js';
import { sprintToShow } from '../src/modules/tracker/sprints.js';

/** GitHub as a tracker, against a fake GitHub: the shared tests, then Issues, a Project board, comments and bugs. */

const ISSUES: GithubSettings = { repo: REPO, from: 'issues', labels: [], stages: {}, anyone: false, readOnly: false };
const BOARD: GithubSettings = { ...ISSUES, from: 'project', board: { owner: 'octo', number: 2, id: BOARD_ID, title: 'Shop board' }, sprints: 'Iteration' };
const S40 = 'octo/shop#40';

trackerContract('GitHub (a Project board)', () => {
  const fake = fakeGithub();
  return {
    tracker: new GithubTracker(fake.calls, BOARD),
    story: S40,
    comments: (id) => fake.comments.get(id) ?? [],
    refused: new GithubTracker(fakeGithub({ refused: true }).calls, BOARD),
    keepsMarkdown: true,
  };
});

trackerCreateContract('GitHub with labels for the levels', () => new GithubTracker(fakeGithub().calls, ISSUES));
trackerCreateContract('GitHub with issue types', () => new GithubTracker(fakeGithub({ types: ['Task', 'Bug', 'Feature', 'Epic'] }).calls, ISSUES));
trackerCreateContract('GitHub on a Project board', () => new GithubTracker(fakeGithub().calls, BOARD));
// A plain gh sign-in has no Projects right: Issues never need it.
trackerCreateContract('GitHub Issues without the Projects right', () => new GithubTracker(fakeGithub({ noProjectScope: true }).calls, ISSUES));

describe('GitHub refs', () => {
  const t = new GithubTracker(fakeGithub().calls, ISSUES);

  it('keeps every id as owner/repo#40, and shows #40 for the own repo', () => {
    expect(t.parseRef('#40')).toBe(S40);
    expect(t.parseRef('40')).toBe(S40);
    expect(t.parseRef('Octo/Shop#40')).toBe(S40);
    expect(t.parseRef('https://github.com/octo/api/issues/7')).toBe('octo/api#7');
    expect(t.parseRef('AB#40')).toBeNull();
    expect(t.refOf(S40)).toBe('#40');
    expect(t.refOf('octo/api#7')).toBe('octo/api#7');
  });

  it('names tickets like every other board name', () => {
    expect(t.ticketName(S40)).toBe('GH-40');
    expect(t.ticketName('octo/api#7')).toBe('GH-OCTO-API-7');
  });
});

describe('GitHub Issues', () => {
  it('lists the team’s open issues without pull requests, filtered by labels and assignee', async () => {
    const fake = fakeGithub();
    expect((await new GithubTracker(fake.calls, ISSUES).list()).map((r) => r.ref)).toEqual(['#40', '#11', '#10']);
    expect((await new GithubTracker(fake.calls, { ...ISSUES, labels: ['ready'] }).list()).map((r) => r.id)).toEqual([S40]);
    expect((await new GithubTracker(fake.calls, { ...ISSUES, assignee: '@me' }).list()).map((r) => r.id)).toEqual([S40]);
    expect((await new GithubTracker(fake.calls, { ...ISSUES, assignee: 'someone' }).list()).length).toBe(0);
  });

  it("leaves out issues by people the repo does not know, unless stories may come from anyone", async () => {
    const fake = fakeGithub();
    expect((await new GithubTracker(fake.calls, { ...ISSUES, labels: ['ready'] }).list()).map((r) => r.ref)).toEqual(['#40']);
    expect((await new GithubTracker(fake.calls, { ...ISSUES, labels: ['ready'], anyone: true }).list()).map((r) => r.ref)).toEqual(['#60', '#40']);
  });

  it('works without the Projects right: pull, move, change, link', async () => {
    const fake = fakeGithub({ noProjectScope: true });
    const t = new GithubTracker(fake.calls, ISSUES);
    expect((await t.get(S40)).parents.map((p) => p.title)).toEqual(['Holding', 'Booking']);
    await t.updateItem(S40, { title: 'Hold a room', parent: fake.key(10) });
    await t.linkDepends(S40, [fake.key(11)]);
    expect(await t.moveTo(S40, 'resolved')).toBe('Closed');
    expect(fake.issues.get(S40)).toMatchObject({ title: 'Hold a room', parent: fake.key(10), blockedBy: [fake.key(11)], state: 'closed' });
  });

  it('reads the type from the labels and the issue type, and a bug from either', async () => {
    const fake = fakeGithub();
    fake.issues.get(S40)!.labels.push('bug');
    const rows = await new GithubTracker(fake.calls, ISSUES).list();
    expect(rows.find((r) => r.id === fake.key(10))).toMatchObject({ type: 'Epic', isBug: false });
    expect(rows.find((r) => r.id === S40)).toMatchObject({ isBug: true, tags: ['ready', 'bug'], assignedTo: 'momen' });
    fake.issues.get(fake.key(11))!.type = 'Bug';
    expect((await new GithubTracker(fake.calls, ISSUES).get(fake.key(11))).isBug).toBe(true);
  });

  it('has no sprints, wiki or board; stays open until merged, then closes once', async () => {
    const fake = fakeGithub();
    const t = new GithubTracker(fake.calls, ISSUES);
    expect(t.abilities).toEqual({ sprints: false, wiki: false, bugs: true, tags: true, create: true });
    expect(await t.sprints()).toEqual([]);
    expect(await t.moveTo(S40, 'in-progress')).toBeNull();
    expect(await t.moveTo(S40, 'resolved')).toBe('Closed');
    expect(fake.issues.get(S40)!.state).toBe('closed');
    expect(await t.moveTo(S40, 'closed')).toBeNull();
  });

  it('splits the text from Done when, and finds the uploads in it', async () => {
    const item = await new GithubTracker(fakeGithub().calls, ISSUES).get(S40);
    expect(item.description).toBe('As a guest I hold a slot.\n\n![shot](https://github.com/user-attachments/assets/abc-123)');
    expect(item.acceptanceCriteria).toBe('- it is mine for 10 minutes');
    expect(item.attachments).toEqual([{ name: 'image-1.png', url: 'https://github.com/user-attachments/assets/abc-123', size: 0 }]);
    expect(item.parents.map((p) => `${p.type} ${p.title}`)).toEqual(['Feature Holding', 'Epic Booking']);
  });

  it('a link with a stray % still gives its file', () => {
    expect(attachmentsOf('[plan.pdf](https://github.com/user-attachments/files/1/50%-off.pdf)')).toEqual([
      { name: 'plan.pdf', url: 'https://github.com/user-attachments/files/1/50%-off.pdf', size: 0 },
    ]);
    expect(attachmentsOf('![](https://github.com/user-attachments/assets/a%zz)')[0]!.name).toBe('image-1.png');
  });

  it('downloads only files GitHub keeps', async () => {
    const t = new GithubTracker(fakeGithub().calls, ISSUES);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-'));
    await expect(t.download('https://evil.example/x.png', path.join(dir, 'x.png'))).rejects.toMatchObject({ kind: 'not-found' });
    expect(fs.existsSync(await t.download('https://github.com/user-attachments/assets/abc', path.join(dir, 'image-1.png')))).toBe(true);
  });

  it('says plainly when an issue is not there', async () => {
    await expect(new GithubTracker(fakeGithub().calls, ISSUES).get(fakeGithub().key(99))).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('says when it read the most it reads at once', async () => {
    const fake = fakeGithub();
    for (let n = 100; n < 650; n += 1) fake.issues.set(fake.key(n), { ...fake.issues.get(fake.key(10))!, number: n });
    const rows = await new GithubTracker(fake.calls, ISSUES).list();
    expect(rows.more).toBe(true);
    expect((await new GithubTracker(fakeGithub().calls, ISSUES).list()).more).toBeUndefined();
  });
});

describe('GitHub Project board', () => {
  it('lists the board in its order with Status, points, priority and sprint, without Done', async () => {
    const fake = fakeGithub();
    fake.items.push({ id: 'item-11', issue: fake.key(11), status: 'Done' });
    const rows = await new GithubTracker(fake.calls, BOARD).list();
    expect(rows.map((r) => r.ref)).toEqual(['#40', 'octo/api#7']);
    expect(rows[0]).toMatchObject({ state: 'Todo', points: 3, priority: 3, sprint: 'Sprint 2' });
    expect(fake.queries).toEqual(['is:open']);
    expect((await new GithubTracker(fake.calls, BOARD).list({ includeDone: true })).map((r) => r.id)).toContain(fake.key(11));
    expect((await new GithubTracker(fake.calls, { ...BOARD, anyone: true }).list()).map((r) => r.ref)).toContain('#60');
  });

  it("filters by the chosen view's filter, one Status, or a sprint, on GitHub's side", async () => {
    const fake = fakeGithub();
    expect((await new GithubTracker(fake.calls, { ...BOARD, view: 'Ready' }).list()).map((r) => r.id)).toEqual([S40]);
    expect((await new GithubTracker(fake.calls, { ...BOARD, status: 'In Progress' }).list()).map((r) => r.id)).toEqual(['octo/api#7']);
    expect((await new GithubTracker(fake.calls, BOARD).list({ sprint: 'it-now' })).map((r) => r.id)).toEqual([S40]);
    expect(fake.queries).toEqual(['label:ready is:open', 'status:"In Progress" is:open', 'iteration:"Sprint 2" is:open']);
  });

  it('says when the board had more than it reads at once', async () => {
    expect((await new GithubTracker(fakeGithub({ endless: true }).calls, BOARD).list()).more).toBe(true);
  });

  it('gives the iterations as sprints, the current one marked', async () => {
    const sprints = await new GithubTracker(fakeGithub().calls, BOARD).sprints();
    expect(sprints.map((s) => [s.name, s.current])).toEqual([
      ['Sprint 1', false],
      ['Sprint 2', true],
      ['Sprint 3', false],
    ]);
    expect(new GithubTracker(fakeGithub().calls, { ...BOARD, sprints: undefined }).abilities.sprints).toBe(false);
  });

  it('spreads a Priority field over the scale by the order of its options', () => {
    const three = [{ name: 'P0' }, { name: 'P1' }, { name: 'P2' }];
    expect(three.map((o) => priorityOf(o.name, three))).toEqual([1, 3, 4]);
    const four = [{ name: 'Now' }, { name: 'Soon' }, { name: 'Later' }, { name: 'Someday' }];
    expect(four.map((o) => priorityOf(o.name, four))).toEqual([1, 2, 3, 4]);
    expect(priorityOf('Gone', four)).toBeUndefined();
  });

  it('moves Status by the best name match, or by the mapping chosen in Settings, and closes the issue when merged', async () => {
    const fake = fakeGithub();
    const t = new GithubTracker(fake.calls, { ...BOARD, stages: { resolved: 'In Progress' } });
    expect(await t.moveTo(S40, 'in-progress')).toBe('In Progress');
    // Merged maps to In Progress here, where the story is: no move, but the issue closes.
    expect(await t.moveTo(S40, 'resolved')).toBe('Closed');
    expect(await t.moveTo(S40, 'closed')).toBe('Done');
    expect(fake.issues.get(S40)!.state).toBe('closed');
  });

  it('puts an issue on the board when it is not there yet', async () => {
    const fake = fakeGithub();
    expect(await new GithubTracker(fake.calls, BOARD).moveTo(fake.key(11), 'in-progress')).toBe('In Progress');
    expect(fake.items.find((i) => i.issue === fake.key(11))?.status).toBe('In Progress');
  });

  it('reads and moves an issue from another repo on the board', async () => {
    const fake = fakeGithub();
    const t = new GithubTracker(fake.calls, BOARD);
    expect((await t.get('octo/api#7')).ref).toBe('octo/api#7');
    expect(await t.moveTo('octo/api#7', 'closed')).toBe('Done');
    await t.comment('octo/api#7', 'Released in **1.2.0**.');
    expect(fake.comments.get('octo/api#7')).toEqual(['Released in **1.2.0**.']);
  });

  it('a missing Projects right is a sign-in problem with the gh command that fixes it', async () => {
    const t = new GithubTracker(fakeGithub({ noProjectScope: true }).calls, BOARD);
    const err = await t.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect(err).toMatchObject({ kind: 'sign-in' });
    expect((err as Error).message).toContain('gh auth refresh -s project');
    await expect(t.list()).rejects.toMatchObject({ kind: 'sign-in' });
    await expect(t.get(S40)).rejects.toMatchObject({ kind: 'sign-in' });
  });
});

describe('GitHub bugs and labels', () => {
  it('files a bug with the bug label, linked to the items, and adds it to the board as not started', async () => {
    const fake = fakeGithub();
    const bug = await new GithubTracker(fake.calls, BOARD).fileBug({ title: 'Friday shows open', steps: 'Open hours', severity: 'stops-work', tags: ['1.2.0'], related: [S40] });
    expect(bug).toMatchObject({ id: fake.key(61), ref: '#61', isBug: true, type: 'Bug' });
    expect(fake.issues.get(bug.id)).toMatchObject({ labels: ['bug', '1.2.0'], body: 'Open hours\n\n**How bad:** Stops work\n\nFound with: #40' });
    expect(fake.items.find((i) => i.issue === bug.id)?.status).toBe('Todo');
  });

  it('uses the Bug issue type when the organization has it', async () => {
    const fake = fakeGithub({ types: ['Task', 'Bug'] });
    const bug = await new GithubTracker(fake.calls, ISSUES).fileBug({ title: 'x', steps: 'y', severity: 'small', tags: [], related: [] });
    expect(fake.issues.get(bug.id)!.type).toBe('Bug');
    expect(bug.isBug).toBe(true);
  });

  it('adds a release as a label', async () => {
    const fake = fakeGithub();
    await new GithubTracker(fake.calls, ISSUES).addTag(S40, '1.2.0');
    expect(fake.issues.get(S40)!.labels).toContain('1.2.0');
  });
});

describe('GitHub set up before this version', () => {
  const old = { ...BOARD, readOnly: true };

  it('reads as before: lists, pulls and says who is signed in', async () => {
    const t = new GithubTracker(fakeGithub().calls, old);
    expect(await t.whoAmI()).toBe('momen');
    expect((await t.list()).map((r) => r.ref)).toEqual(['#40', 'octo/api#7']);
    expect((await t.get(S40)).title).toBe('Hold a slot');
  });

  it('writes nothing until connected again: moves, comments, labels and bugs wait, and no breakdown is sent', async () => {
    const fake = fakeGithub();
    const t = new GithubTracker(fake.calls, old);
    expect(t.abilities.create).toBe(false);
    for (const write of [() => t.moveTo(S40, 'in-progress'), () => t.comment(S40, 'x'), () => t.addTag(S40, '1.0'), () => t.fileBug({ title: 'x', steps: 'y', severity: 'small', tags: [], related: [] })]) {
      await expect(write()).rejects.toMatchObject({ kind: 'sign-in', message: expect.stringContaining('connect it again') });
    }
    expect(fake.items.find((i) => i.issue === S40)?.status).toBe('Todo');
    expect(fake.comments.size).toBe(0);
  });
});

describe('GitHub levels for a breakdown', () => {
  it('uses issue types where the organization has them, labels for the rest', async () => {
    expect(await new GithubTracker(fakeGithub().calls, ISSUES).levels()).toEqual({ epic: 'Epic', feature: 'Feature', story: 'Story', process: 'labels', project: REPO });
    const mixed = fakeGithub({ types: ['Task', 'Bug', 'Feature'] });
    const t = new GithubTracker(mixed.calls, ISSUES);
    expect(await t.levels()).toMatchObject({ feature: 'Feature', process: 'issue types and labels' });
    const story = await t.createItem({ level: 'story', title: 'S', markdown: 'x', tags: ['squad-kit', 'BR-1'] });
    const feature = await t.createItem({ level: 'feature', title: 'F', markdown: 'x' });
    expect(mixed.issues.get(story.id)).toMatchObject({ labels: ['squad-kit', 'BR-1', 'story'] });
    expect(mixed.issues.get(feature.id)).toMatchObject({ labels: [], type: 'Feature' });
  });

  it('keeps an issue’s Done when when only its text is sent again, as an epic is', async () => {
    const fake = fakeGithub();
    const t = new GithubTracker(fake.calls, ISSUES);
    const epic = await t.createItem({ level: 'epic', title: 'E', markdown: 'Old goal.' });
    fake.issues.get(epic.id)!.body += '\n\n**Done when**\n\nA person wrote this.';
    await t.updateItem(epic.id, { title: 'E2', markdown: 'New goal.' });
    expect(fake.issues.get(epic.id)!.body).toBe('New goal.\n\n**Done when**\n\nA person wrote this.');
    await t.updateItem(epic.id, { acceptance: 'Squad-kit wrote this.' });
    expect(fake.issues.get(epic.id)!.body).toBe('New goal.\n\n**Done when**\n\nSquad-kit wrote this.');
  });

  it('finds an item a cut-off send made by its label and line, and puts it on the board it missed', async () => {
    const fake = fakeGithub({ failNextStatus: true });
    const t = new GithubTracker(fake.calls, BOARD);
    const mark = 'Made by squad-kit from BR-1, S-4.';
    await expect(t.createItem({ level: 'story', title: 'Hold', markdown: `x\n\n${mark}`, tags: ['squad-kit', 'BR-1'] })).rejects.toMatchObject({ kind: 'offline' });
    const made = fake.key(61);
    expect(fake.items.find((i) => i.issue === made)?.status).toBeUndefined();
    expect((await t.findMade({ level: 'story', tag: 'BR-1', mark }))?.id).toBe(made);
    expect(fake.items.find((i) => i.issue === made)?.status).toBe('Todo');
    expect(await t.findMade({ level: 'epic', tag: 'BR-1', mark })).toBeNull();
  });
});

describe('the sprint a backlog opens on', () => {
  const sprint = (name: string, start?: string, current = false) => ({ name, path: name, current, ...(start ? { start } : {}) });

  it('the one running now, else the next to start, else the newest; never an old one while a newer is there', () => {
    expect(sprintToShow([sprint('1', '2026-10-01'), sprint('2', '2026-11-01', true), sprint('3', '2026-12-01')], '2026-11-13')?.name).toBe('2');
    expect(sprintToShow([sprint('1', '2026-10-01'), sprint('3', '2026-12-01'), sprint('4', '2027-01-01')], '2026-11-13')?.name).toBe('3');
    expect(sprintToShow([sprint('2', '2026-10-15'), sprint('1', '2026-10-01')], '2026-11-13')?.name).toBe('2');
    expect(sprintToShow([sprint('A'), sprint('B')], '2026-11-13')?.name).toBe('B');
    expect(sprintToShow([], '2026-11-13')).toBeNull();
  });
});
