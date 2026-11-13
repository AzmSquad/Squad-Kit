import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import { buildPaths } from '../src/core/paths.js';
import { forgetSetUp, journeyOf, storyStep } from '../src/engine/contribution/journey.js';
import { oneAtATime, setUpForMe } from '../src/engine/contribution/set-up.js';
import { contributeChecklist, makeMyCopy } from '../src/engine/contribution/checklist.js';
import { pullRequestTrack } from '../src/engine/contribution/track.js';
import { mountContributionApi } from '../src/console/api/contribution.js';
import { fakeGh, fakeGitHub, repoJson, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * The bar on every page of a contribution to squad-kit's own code: Set up, Your idea, Built and checked, Pull request,
 * Owner's review, Merged. The step is the engine's, read from the stories; only Set up asks the code host (made up
 * here). And the pull request's own steps, from Looks right to the owner's merge, and "Do both for me".
 */

let tmp = '';
let project = '';
let gh: FakeGitHub | undefined;
let undo: (() => void)[] = [];
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const route = (c: Call, method: string, p: string) => c.method === method && c.path.split('?')[0] === p;
const SELF = { name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' } };

/** squad-kit's own code (or another project), cloned from a GitHub address that git reaches in a folder. */
function clone(origin: string, pkg: object = SELF): BoardPaths {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-journey-')));
  const remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'squad-kit');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  sh('git add -A && git commit -qm start', project);
  sh(`git remote add origin ${origin} && git config url.${remote}.insteadOf ${origin} && git push -q origin main`, project);
  const bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'squad-kit',
    key: 'SK',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Sara', role: 'Contributor' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  forgetSetUp(bp);
  return bp;
}

function story(id: string, o: Partial<Ticket> = {}, at = '2026-11-13T09:00:00Z'): Ticket {
  return {
    id,
    title: `Story ${id}`,
    ask: 'Show the version in the side menu',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'tickets',
    status: '',
    waiting: null,
    createdAt: at,
    createdBy: 'Sara',
    activity: [{ at, who: 'you', text: 'Wrote it' }],
    ...o,
  } as Ticket;
}

const PR = { id: 14, url: 'https://github.com/AzmSquad/squad-kit/pull/14', repo: 'AzmSquad/squad-kit', host: 'github' };

/**
 * GitHub as Sara sees it: signed in, and AzmSquad/squad-kit is a repo she cannot push to, until she has her copy (or she
 * is one of its maintainers). Her copy can be behind or ahead of it, and GitHub's sync can refuse.
 */
function github(o: { copy?: boolean; behind?: number; ahead?: number; maintainer?: boolean; syncRefused?: boolean } = {}) {
  let made = Boolean(o.copy);
  gh = fakeGitHub((c) => {
    if (route(c, 'GET', '/user')) return { body: { login: 'sara' } };
    if (route(c, 'GET', '/repos/AzmSquad/squad-kit')) return { body: repoJson('AzmSquad/squad-kit', { push: Boolean(o.maintainer) }) };
    if (route(c, 'POST', '/repos/AzmSquad/squad-kit/forks')) {
      made = true;
      return { status: 202, body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
    }
    if (made && route(c, 'GET', '/repos/sara/squad-kit')) return { body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
    if (made && route(c, 'GET', '/repos/sara/squad-kit/branches/main')) return { body: { name: 'main' } };
    if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...sara:main')) return { body: { ahead_by: o.ahead ?? 0, behind_by: o.behind ?? 0 } };
    if (route(c, 'POST', '/repos/sara/squad-kit/merge-upstream')) return o.syncRefused ? { status: 409, body: { message: 'There are merge conflicts' } } : { body: { merge_type: 'fast-forward' } };
    return undefined;
  });
}

afterEach(() => {
  gh?.done();
  gh = undefined;
  for (const u of undo.reverse()) u();
  undo = [];
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the journey of a contribution', () => {
  it("each story's step comes from its own record", () => {
    expect(storyStep(story('SK-1'))).toBe(1);
    expect(storyStep(story('SK-1', { stage: 'specs', waiting: { kind: 'plan', summary: 'Approve the plan' } }))).toBe(1);
    expect(storyStep(story('SK-1', { stage: 'implement' }))).toBe(2);
    expect(storyStep(story('SK-1', { stage: 'review', waiting: { kind: 'proof', summary: 'Check the proof' } }))).toBe(2);
    expect(storyStep(story('SK-1', { stage: 'review', squad: { phase: 'publish', nextAt: '' } }))).toBe(3);
    expect(storyStep(story('SK-1', { stage: 'release', mergedAt: '2026-11-13T10:00:00Z' }))).toBe(3);
    const sent = { into: 'AzmSquad/squad-kit', base: 'main', since: '2026-11-13T10:03:00Z' };
    expect(storyStep(story('SK-1', { pr: PR, contribution: { ...sent, state: 'waiting' } }))).toBe(4);
    expect(storyStep(story('SK-1', { pr: PR, contribution: { ...sent, state: 'notes' } }))).toBe(4);
    expect(storyStep(story('SK-1', { pr: PR, stage: 'implement', contribution: { ...sent, state: 'fixing' } }))).toBe(4);
    expect(storyStep(story('SK-1', { pr: PR, mergedAt: '2026-11-13T11:40:00Z', contribution: { ...sent, state: 'merged' } }))).toBe(6);
  });

  it('another project has no journey', async () => {
    undo.push(fakeGh('missing'));
    const bp = clone('https://github.com/sara/app.git', { name: 'app' });
    expect(await journeyOf(bp)).toMatchObject({ self: false });
  });

  it('no story yet: Set up until the checklist is done, then Your idea', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    github();
    expect(await journeyOf(bp)).toMatchObject({ self: true, at: 0, line: 'Set up: step 1 of 6.' });
    gh?.done();
    github({ copy: true });
    sh('git remote set-url origin https://github.com/sara/squad-kit.git', project);
    sh(`git config url.${path.join(tmp, 'remote.git')}.insteadOf https://github.com/sara/squad-kit.git`, project);
    // Kept a minute: asked again only once forgotten (after Make my copy or Bring it up to date).
    expect((await journeyOf(bp)).at).toBe(0);
    forgetSetUp(bp);
    expect(await journeyOf(bp)).toMatchObject({ at: 1, steps: ['Set up', 'Your idea', 'Built and checked', 'Pull request', "Owner's review", 'Merged'] });
  });

  it("with stories: the person's open story that moved last, or one story asked for by name", async () => {
    undo.push(fakeGh('missing'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    const sent = { into: 'AzmSquad/squad-kit', base: 'main', since: '2026-11-13T10:03:00Z' };
    writeTicket(bp, story('SK-1', { pr: PR, mergedAt: '2026-11-13T11:40:00Z', contribution: { ...sent, state: 'merged' } }, '2026-11-13T08:00:00Z'));
    writeTicket(bp, story('SK-2', { pr: { ...PR, id: 15 }, contribution: { ...sent, state: 'notes' } }, '2026-11-13T10:00:00Z'));
    writeTicket(bp, story('SK-3', { stage: 'implement' }, '2026-11-13T09:00:00Z'));
    writeTicket(bp, story('SK-4', { createdBy: 'Omar', owner: 'Omar' }, '2026-11-13T12:00:00Z'));
    expect(await journeyOf(bp)).toMatchObject({ self: true, at: 4, ticket: 'SK-2', line: "Owner's review (SK-2): step 5 of 6." });
    expect(await journeyOf(bp, 'SK-1')).toMatchObject({ at: 6, ticket: 'SK-1', line: 'SK-1 is merged by the owner. Every step is done.' });
    expect(await journeyOf(bp, 'SK-3')).toMatchObject({ at: 2, ticket: 'SK-3' });
    const app = new Hono();
    mountContributionApi(app, { paths: buildPaths(project) });
    expect(await (await app.request('/api/v1/contribute/journey?ticket=SK-3')).json()).toMatchObject({ at: 2, ticket: 'SK-3' });
  });

  it("the pull request's steps, from Looks right to the owner's merge, with the catch-up line once merged", () => {
    undo.push(fakeGh('missing'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    const activity = [
      { at: '2026-11-13T10:02:00Z', who: 'you', text: 'Checked the proof. Looks right' },
      { at: '2026-11-13T10:03:00Z', who: 'release', text: 'Opened pull request 14 in AzmSquad/squad-kit, into main. Its owner merges it' },
    ] as Ticket['activity'];
    const sent = { into: 'AzmSquad/squad-kit', base: 'main', since: '2026-11-13T10:03:00Z' };
    const waiting = story('SK-3', { pr: PR, branch: 'squad/sk-3', activity, contribution: { ...sent, state: 'waiting' } });
    expect(pullRequestTrack(bp, waiting)).toEqual({
      steps: [
        { id: 'looks-right', state: 'done', at: '2026-11-13T10:02:00Z' },
        { id: 'pushed', state: 'done', at: '2026-11-13T10:03:00Z' },
        { id: 'opened', state: 'done', at: '2026-11-13T10:03:00Z' },
        { id: 'review', state: 'now' },
        { id: 'merged', state: 'later' },
      ],
      copy: 'sara/squad-kit',
      branch: 'squad/sk-3',
      host: 'GitHub',
    });
    const merged = story('SK-3', {
      pr: PR,
      branch: 'squad/sk-3',
      mergedAt: '2026-11-13T11:40:00Z',
      activity: [...activity, { at: '2026-11-13T11:41:00Z', who: 'release', text: 'Your copy sara/squad-kit took one change from AzmSquad/squad-kit' }],
      contribution: { ...sent, state: 'merged', since: '2026-11-13T11:40:00Z' },
    });
    const t = pullRequestTrack(bp, merged)!;
    expect(t.steps.slice(3)).toEqual([
      { id: 'review', state: 'done' },
      { id: 'merged', state: 'done', at: '2026-11-13T11:40:00Z' },
    ]);
    expect(t.catchUp).toBe('Your copy sara/squad-kit took one change from AzmSquad/squad-kit');
    expect(pullRequestTrack(bp, story('SK-4'))).toBeNull();
  });

  it('Do both for me: makes the copy, then brings this computer up to date with it', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    // The copy GitHub makes is reached in the same folder too: nothing goes to the real GitHub.
    sh(`git config --add url.${path.join(tmp, 'remote.git')}.insteadOf https://github.com/sara/squad-kit.git`, project);
    github();
    const r = await setUpForMe(bp);
    expect(r.line).toBe(
      'Made your own copy, sara/squad-kit. origin is your copy now, and upstream is AzmSquad/squad-kit. Your copy sara/squad-kit was up to date with AzmSquad/squad-kit.',
    );
    expect(sh('git config --get remote.origin.url', project)).toBe('https://github.com/sara/squad-kit.git');
    expect(r.checklist.items.find((i) => i.id === 'copy')?.state).toBe('done');
    expect(gh!.sent('POST', '/repos/AzmSquad/squad-kit/forks')).toHaveLength(1);
    // Pressed again: the copy is not made twice; it is only brought up to date again.
    expect((await setUpForMe(bp)).line).toMatch(/^Your copy sara\/squad-kit was up to date/);
    expect(gh!.sent('POST', '/repos/AzmSquad/squad-kit/forks')).toHaveLength(1);
  });

  it('Do both for me: the copy is made but GitHub refuses the sync: the copy is said, with the reason, never hidden', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    sh(`git config --add url.${path.join(tmp, 'remote.git')}.insteadOf https://github.com/sara/squad-kit.git`, project);
    github({ behind: 3, syncRefused: true });
    const r = await setUpForMe(bp);
    expect(r.line).toMatch(/^Made your own copy, sara\/squad-kit\. origin is your copy now, and upstream is AzmSquad\/squad-kit\. It was not brought up to date: GitHub could not bring main of your copy up to date/);
    expect(sh('git config --get remote.origin.url', project)).toBe('https://github.com/sara/squad-kit.git');
    expect(r.checklist.items.find((i) => i.id === 'up-to-date')).toMatchObject({ state: 'todo', count: 3 });
  });

  it('one at a time: a second press while GitHub makes the copy is told to wait, and upstream is added once', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    github();
    let release!: () => void;
    const first = oneAtATime(bp, () => new Promise<void>((done) => (release = done)));
    await expect(oneAtATime(bp, async () => 'second')).rejects.toThrow('squad-kit is already making your copy or bringing it up to date. Wait a moment, then look again.');
    release();
    await first;
    expect(await oneAtATime(bp, async () => 'after')).toBe('after');
    // An upstream remote there already (a run that stopped halfway): it stays as it is, and is not added again.
    sh('git remote add upstream https://github.com/AzmSquad/squad-kit.git', project);
    expect((await makeMyCopy(bp)).line).toBe('Made your own copy, sara/squad-kit. origin is your copy now.');
    expect(sh('git remote', project).split('\n').sort()).toEqual(['origin', 'upstream']);
  });

  it("a copy with changes of its own stops nothing: ready to write an idea, and both wordings say the same", async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    sh('git remote add upstream https://github.com/AzmSquad/squad-kit.git', project);
    github({ copy: true, ahead: 2 });
    const c = await contributeChecklist(bp);
    const ahead = 'main of your copy has 2 changes that AzmSquad/squad-kit does not have. squad-kit leaves them as they are, and you can still write your idea. To match AzmSquad/squad-kit, send them as a pull request, or ask an engineer.';
    expect(c).toMatchObject({ ready: true, left: 0, line: `Ready: your stories go as pull requests. ${ahead}` });
    expect(c.items.find((i) => i.id === 'up-to-date')).toMatchObject({ state: 'blocked', count: 2, line: ahead });
    expect((await setUpForMe(bp)).line).toBe(ahead);
    expect((await journeyOf(bp)).at).toBe(1);
  });

  it("a maintainer's clone needs no copy: Do both for me has nothing to do, and says so", async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    github({ maintainer: true });
    expect((await setUpForMe(bp)).line).toBe('Nothing to do: your copy is set up.');
    expect(gh!.sent('POST', '/repos/AzmSquad/squad-kit/forks')).toHaveLength(0);
  });

  it('closed by the owner: its own state on the bar and the track; left closed, it is no longer followed', async () => {
    undo.push(fakeGh('missing'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    const sent = { into: 'AzmSquad/squad-kit', base: 'main', since: '2026-11-13T12:00:00Z' };
    const waiting = { kind: 'stuck' as const, summary: 'The owner closed the pull request without merging' };
    writeTicket(bp, story('SK-1', { pr: PR, contribution: { ...sent, state: 'closed' }, waiting }, '2026-11-13T10:00:00Z'));
    writeTicket(bp, story('SK-2', { stage: 'implement' }, '2026-11-13T09:00:00Z'));
    expect(await journeyOf(bp, 'SK-1')).toMatchObject({ at: 4, closed: true, line: 'SK-1: the owner closed its pull request without merging it.' });
    expect((await journeyOf(bp)).ticket).toBe('SK-1');
    expect(pullRequestTrack(bp, { ...story('SK-1'), pr: PR, contribution: { ...sent, state: 'closed' } } as Ticket)!.steps.slice(3)).toEqual([
      { id: 'review', state: 'closed', at: '2026-11-13T12:00:00Z' },
      { id: 'merged', state: 'later' },
    ]);
    // Leave it closed: the story ends there, and the bar follows the next one.
    writeTicket(bp, story('SK-1', { pr: PR, contribution: { ...sent, state: 'closed' } }, '2026-11-13T10:00:00Z'));
    expect(await journeyOf(bp)).toMatchObject({ at: 2, ticket: 'SK-2' });
    expect((await journeyOf(bp)).closed).toBeUndefined();
  });
});
