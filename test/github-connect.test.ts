import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { BOARD_ID, REPO, fakeGithub } from './fakes/github.js';
import { githubTrackerModule } from '../src/modules/github/module.js';
import { signInSteps, type SignInProbe } from '../src/modules/github/sign-in.js';
import { GithubTracker } from '../src/modules/github/tracker.js';
import { sendBreakdown } from '../src/board/requirements-sync.js';
import type { Breakdown } from '../src/board/requirements-types.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { guessTracker, trackerModule } from '../src/modules/registry.js';
import { parseFields, setTrackerFromModule } from '../src/commands/config/set-tracker-module.js';
import { azureTracker } from '../src/modules/azure/tracker.js';
import { trackerReachCheck, trackerSignInCheck } from '../src/commands/doctor-tracker.js';

/** Connecting GitHub: what gh still needs, the lists Settings picks from, the save that checks, and a breakdown send. */

const probe = (has: boolean, token: string | null, scopes: string[] | null): SignInProbe => ({
  state: async () => (!has ? 'missing' : !token ? 'signed-out' : 'ready'),
  scopes: async () => scopes,
});

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-connect-'));
  fs.mkdirSync(path.join(root, '.squad'));
  saveConfig(buildPaths(root).configFile, DEFAULT_CONFIG);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const saved = () => (yaml.load(fs.readFileSync(buildPaths(root).configFile, 'utf8')) as { tracker: Record<string, unknown> }).tracker;

describe('what gh still needs', () => {
  it('without gh: install it, sign in, and for a Project let it use Projects', async () => {
    const steps = await signInSteps(true, probe(false, null, null));
    expect(steps.map((s) => s.command ?? s.link)).toEqual(['https://cli.github.com', 'gh auth login', 'gh auth refresh -s project']);
  });

  it('gh not signed in: gh auth login', async () => {
    expect((await signInSteps(false, probe(true, null, null))).map((s) => s.command)).toEqual(['gh auth login']);
  });

  it('signed in without the Projects right: only for a Project', async () => {
    expect(await signInSteps(false, probe(true, 't', ['repo']))).toEqual([]);
    expect((await signInSteps(true, probe(true, 't', ['repo', 'read:org']))).map((s) => s.command)).toEqual(['gh auth refresh -s project']);
    expect(await signInSteps(true, probe(true, 't', ['repo', 'project']))).toEqual([]);
    // A token that does not say its rights is tried as it is.
    expect(await signInSteps(true, probe(true, 't', null))).toEqual([]);
  });

  it('a call without gh signed in is a sign-in problem, in the shared shape', async () => {
    const t = new GithubTracker(fakeGithub({ refused: true }).calls, { repo: REPO, from: 'issues', labels: [], stages: {}, anyone: false, readOnly: false });
    await expect(t.whoAmI()).rejects.toMatchObject({ kind: 'sign-in' });
  });
});

describe('connecting GitHub', () => {
  it('is in the tracker list, and a GitHub remote picks it with its repo', () => {
    expect(trackerModule('github')?.label).toBe('GitHub');
    expect(guessTracker(['git@github.com:octo/shop.git'])).toMatchObject({ module: { name: 'github' }, values: { repo: 'octo/shop', from: 'issues' } });
  });

  it('saves Issues with labels and an assignee, for the whole team, with no token', async () => {
    const mod = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo']));
    await mod.save(root, { repo: 'https://github.com/Octo/Shop.git', from: 'issues', labels: 'ready, squad', assignee: '@me' });
    // GitHub's own spelling of the repo, and the mark that lets squad-kit write there.
    expect(saved()).toEqual({ type: 'github', workspace: 'octo', project: 'shop', options: { from: 'issues', updates: 'on', labels: 'ready, squad', assignee: '@me' } });
    expect(mod.read(root)).toMatchObject({ values: { repo: REPO, from: 'issues', labels: 'ready, squad', assignee: '@me' }, hasSecret: false });
    expect(mod.open(root)?.abilities.sprints).toBe(false);
  });

  it('saves a Project with the best Status for each step, and its iterations as sprints', async () => {
    const mod = githubTrackerModule(fakeGithub().calls);
    await mod.save(root, { repo: REPO, from: 'project', board: '2', status: 'Todo', 'stage-resolved': 'In Progress' });
    expect(saved().options).toEqual({
      from: 'project',
      updates: 'on',
      board: 'octo/2',
      boardId: BOARD_ID,
      boardTitle: 'Shop board',
      status: 'Todo',
      'stage-not-started': 'Todo',
      'stage-in-progress': 'In Progress',
      'stage-resolved': 'In Progress',
      'stage-closed': 'Done',
      sprints: 'Iteration',
    });
    const t = mod.open(root)!;
    expect(t.abilities.sprints).toBe(true);
    expect(t.identity).toBe(`${REPO}/project/${BOARD_ID}`);
  });

  it('refuses what is not there, and saves nothing', async () => {
    const mod = githubTrackerModule(fakeGithub().calls);
    await expect(mod.save(root, { repo: 'shop', from: 'issues' })).rejects.toThrow(/owner\/name/);
    await expect(mod.save(root, { repo: 'octo/nope', from: 'issues' })).rejects.toThrow(/no repository octo\/nope/);
    await expect(mod.save(root, { repo: REPO, from: 'project', board: '9' })).rejects.toThrow(/no Project 9/);
    await expect(mod.save(root, { repo: REPO, from: 'project', board: '2', status: 'Shipping' })).rejects.toThrow(/has no Status "Shipping"/);
    await expect(mod.save(root, { repo: REPO, from: 'project', board: '2', view: 'Mine' })).rejects.toThrow(/no view called "Mine"/);
    expect(saved().type).toBe('none');
  });

  it('a Project without the Projects right says the gh command', async () => {
    const mod = githubTrackerModule(fakeGithub({ noProjectScope: true }).calls);
    await expect(mod.save(root, { repo: REPO, from: 'project', board: '2' })).rejects.toThrow('gh auth refresh -s project');
  });

  it('takes a Project typed as its address, and stories from anyone when chosen', async () => {
    const mod = githubTrackerModule(fakeGithub().calls);
    await mod.save(root, { repo: REPO, from: 'project', board: 'https://github.com/orgs/octo/projects/2/views/1', anyone: 'yes' });
    expect(saved().options).toMatchObject({ board: 'octo/2', anyone: 'yes' });
    expect(mod.read(root).values).toMatchObject({ board: 'octo/2', anyone: 'yes' });
  });

  it('lists every open Project of the owner, page after page, the newest first', async () => {
    const lists = await githubTrackerModule(fakeGithub({ boards: 150 }).calls).choices!({ repo: REPO, from: 'project' });
    const numbers = lists.board!.map((b) => b.value);
    expect(numbers[0]).toBe('octo/2');
    expect(numbers).toContain('octo/248');
    expect(numbers).not.toContain('octo/100');
    expect(numbers.length).toBe(101);
  });

  it("gives the owner's open Projects, then the board's views and Status options", async () => {
    const mod = githubTrackerModule(fakeGithub().calls);
    expect(await mod.choices!({ repo: REPO, from: 'issues' })).toEqual({});
    expect(await mod.choices!({ repo: REPO, from: 'project' })).toEqual({ board: [{ value: 'octo/2', label: '#2 Shop board' }] });
    const lists = await mod.choices!({ repo: REPO, from: 'project', board: 'octo/2' });
    expect(lists.view!.map((c) => c.value)).toEqual(['', 'Board', 'Ready']);
    expect(lists.status!.map((c) => c.label)).toEqual(['Any status', 'Todo', 'In Progress', 'Done']);
    expect(lists['stage-in-progress']![0]).toEqual({ value: '', label: 'In Progress (best fit)' });
  });
});

describe('squad config set tracker --type github --field …', () => {
  it('reads key=value pairs, keeping a value with = in it whole', () => {
    expect(parseFields(['repo=octo/shop', 'status=Ready = go'])).toEqual({ repo: 'octo/shop', status: 'Ready = go' });
    expect(() => parseFields(['octo/shop'])).toThrow(/key=value/);
  });

  it('saves and checks the settings given, and names the sign-in', async () => {
    const mod = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo', 'project']));
    await setTrackerFromModule(root, mod, ['repo=octo/shop', 'from=project', 'board=2'], false);
    expect(saved()).toMatchObject({ type: 'github', workspace: 'octo', project: 'shop', options: { from: 'project', board: 'octo/2' } });
  });

  it('refuses a setting the tracker does not have', async () => {
    const mod = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo']));
    await expect(setTrackerFromModule(root, mod, ['repository=octo/shop'], false)).rejects.toThrow(/no setting "repository"/);
  });

  it('without gh, says the steps and saves nothing', async () => {
    const mod = githubTrackerModule(fakeGithub().calls, probe(false, null, null));
    await expect(setTrackerFromModule(root, mod, ['repo=octo/shop'], false)).rejects.toThrow(/Do the steps above/);
    expect(saved().type).toBe('none');
  });
});

describe('a GitHub setup from before this version', () => {
  const old = () => {
    const config = buildPaths(root).configFile;
    saveConfig(config, { ...DEFAULT_CONFIG, tracker: { type: 'github', workspace: 'octo', project: 'shop' } });
  };

  it('only reads, and Settings says to connect again; connecting turns writes on', async () => {
    old();
    const mod = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo']));
    expect(mod.read(root).note).toBe('Connect again to let squad-kit update GitHub.');
    const t = mod.open(root)!;
    expect(t.abilities.create).toBe(false);
    expect((await t.list()).map((r) => r.ref)).toEqual(['#40', '#11', '#10']);
    await expect(t.comment('octo/shop#40', 'x')).rejects.toMatchObject({ kind: 'sign-in' });
    await setTrackerFromModule(root, mod, ['repo=octo/shop', 'from=issues'], false);
    expect(mod.read(root).note).toBeUndefined();
    expect(mod.open(root)!.abilities.create).toBe(true);
    await expect(mod.open(root)!.comment('octo/shop#40', 'x')).resolves.toBeUndefined();
  });

  it('squad doctor names the same steps as Settings, then who is signed in, and the read-only line', async () => {
    old();
    const missing = githubTrackerModule(fakeGithub().calls, probe(false, null, null));
    expect(await trackerSignInCheck(root, missing)).toMatchObject({ status: 'fail', detail: expect.stringContaining('gh auth login'), fixHint: 'gh auth login' });
    const ready = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo']));
    expect(await trackerSignInCheck(root, ready)).toMatchObject({ status: 'ok' });
    expect(await trackerReachCheck(root, ready)).toMatchObject({ status: 'warn', detail: 'GitHub as momen. Connect again to let squad-kit update GitHub.' });
    await ready.save(root, { repo: REPO, from: 'issues' });
    expect(await trackerReachCheck(root, ready)).toMatchObject({ status: 'ok', detail: 'GitHub as momen' });
    expect(await trackerReachCheck(root, githubTrackerModule(fakeGithub({ refused: true }).calls))).toMatchObject({ status: 'fail' });
    const board = githubTrackerModule(fakeGithub().calls, probe(true, 't', ['repo']));
    await board.save(root, { repo: REPO, from: 'project', board: '2' });
    expect(await trackerSignInCheck(root, board)).toMatchObject({ status: 'fail', fixHint: 'gh auth refresh -s project' });
  });
});

describe('switching trackers', () => {
  it("drops the other tracker's own settings, both ways", async () => {
    await githubTrackerModule(fakeGithub().calls).save(root, { repo: REPO, from: 'project', board: '2' });
    azureTracker.save(root, { organization: 'momenysr', project: 'Mawid', token: 'x'.repeat(52) });
    expect(saved()).toEqual({ type: 'azure', workspace: 'momenysr', project: 'Mawid' });
    await githubTrackerModule(fakeGithub().calls).save(root, { repo: REPO, from: 'issues' });
    expect(saved()).toEqual({ type: 'github', workspace: 'octo', project: 'shop', options: { from: 'issues', updates: 'on' } });
  });

  it('a tracker given without its token is saved but never said to be connected', async () => {
    await expect(setTrackerFromModule(root, azureTracker, ['organization=momenysr', 'project=Mawid'], false)).rejects.toThrow(
      /saved, but squad-kit cannot connect to Azure DevOps yet: it needs the token\. Run squad config set tracker --type azure/,
    );
    expect(saved()).toMatchObject({ type: 'azure', workspace: 'momenysr', project: 'Mawid' });
  });
});

describe('sending a breakdown to GitHub', () => {
  const breakdown = (): Breakdown => ({
    id: 'BR-1',
    title: 'RoomFlow',
    status: 'approved',
    source: { file: 'source/b.md', name: 'b.md', kind: 'markdown', bytes: 10, addedBy: 'Momen', addedAt: '2026-11-04T08:00:00.000Z' },
    questions: [],
    decided: [],
    leftOut: [],
    approved: { by: 'Momen', at: '2026-11-04T09:00:00.000Z' },
    createdAt: '2026-11-04T08:00:00.000Z',
    createdBy: 'Momen',
    owner: 'Momen',
    next: { epic: 2, feature: 2, story: 3 },
    epics: [
      {
        key: 'E-1',
        title: 'Front desk',
        goal: 'Staff check guests in and out.',
        features: [
          {
            key: 'F-1',
            title: 'Arrivals',
            summary: 'Guests arrive.',
            stories: [
              { key: 'S-1', title: 'Check in', story: 'As staff, I check a guest in.', criteria: [{ given: 'a booking', when: 'I check in', then: 'the room is taken' }], size: 'S', dependsOn: [] },
              { key: 'S-2', title: 'Check out', story: 'As staff, I check a guest out.', criteria: [{ given: 'a guest', when: 'I check out', then: 'the room is free' }], size: 'S', dependsOn: ['S-1'] },
            ],
          },
        ],
        stories: [],
      },
    ],
  });

  it('makes issues with sub-issues under their parents and "blocked by" for the order, then changes the same ones', async () => {
    const fake = fakeGithub({ types: ['Task', 'Bug', 'Feature'] });
    const tracker = new GithubTracker(fake.calls, { repo: REPO, from: 'project', labels: [], board: { owner: 'octo', number: 2, id: BOARD_ID, title: 'Shop board' }, stages: {}, anyone: false, readOnly: false });
    const b = breakdown();
    const result = await sendBreakdown(b, tracker, { save: () => undefined, by: 'Momen' });
    expect(result).toMatchObject({ created: 4, linked: 1 });
    expect(result.error).toBeUndefined();
    const issue = (key: string) => {
      const part = key === 'E-1' ? b.epics[0]! : key === 'F-1' ? b.epics[0]!.features[0]! : b.epics[0]!.features[0]!.stories.find((s) => s.key === key)!;
      // The breakdown keeps each issue's whole id, owner/repo#N.
      expect(part.tracker!.id).toMatch(/^octo\/shop#\d+$/);
      return fake.issues.get(part.tracker!.id)!;
    };
    expect(issue('E-1')).toMatchObject({ labels: ['squad-kit', 'BR-1', 'epic'] });
    expect(issue('F-1')).toMatchObject({ type: 'Feature', parent: fake.key(issue('E-1').number) });
    expect(issue('S-2')).toMatchObject({ labels: ['squad-kit', 'BR-1', 'story'], parent: fake.key(issue('F-1').number), blockedBy: [fake.key(issue('S-1').number)] });
    expect(issue('S-2').body).toContain('**Done when**\n\n**Given** a guest');
    expect(fake.items.filter((i) => i.status === 'Todo').length).toBe(6);

    b.epics[0]!.features[0]!.stories[1]!.title = 'Check a guest out';
    const again = await sendBreakdown(b, tracker, { save: () => undefined, by: 'Momen' });
    expect(again).toMatchObject({ created: 0, updated: 1, linked: 0 });
    expect(issue('S-2').title).toBe('Check a guest out');
  });
});
