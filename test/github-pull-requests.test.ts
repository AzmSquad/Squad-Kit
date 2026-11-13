import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, readTicket, requireTicket, updateTicket, writeMeta } from '../src/board/store.js';
import { createTicket, decideStuck } from '../src/board/actions.js';
import { mergeWait } from '../src/board/auto.js';
import { opensPullRequest, publishTicket } from '../src/engine/sync.js';
import { lookAtContribution, lookAtContributions } from '../src/engine/contribution/look.js';
import { checkMerge } from '../src/engine/merged-outside.js';
import { sendAsOf } from '../src/engine/send-as-pr.js';
import { mountContributionApi } from '../src/console/api/contribution.js';
import { buildPaths } from '../src/core/paths.js';
import { StepError } from '../src/board/problem.js';
import { fakeGh, fakeGitHub, pullJson, repoJson, type Answer, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * A story's pull request on GitHub, from Looks right to the end (ADR-008), with GitHub's REST made up and git pushing to
 * a folder that stands in for the repo on GitHub. Your own repo: open, merge, the review written in. A copy of someone
 * else's repo: the pull request goes to theirs and waits for its owner; the owner's notes come back, Fix these sends the
 * fix to the same pull request and answers each one; merged or closed by the owner.
 */

let tmp: string;
let project: string;
let remote: string;
let bp: ReturnType<typeof boardPaths>;
let gh: FakeGitHub | undefined;
let undo: (() => void)[] = [];
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const route = (c: Call, method: string, p: string) => c.method === method && c.path.split('?')[0] === p;

/** A project whose origin is `https://github.com/<repo>.git`, pushed for real to a folder that stands in for it. */
function setUp(repo: string, pkg: object = { name: 'app' }): void {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-pr-')));
  remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(project, 'book.ts'), 'export const fee = 500;\n');
  sh('git add -A && git commit -qm start', project);
  const url = `https://github.com/${repo}.git`;
  sh(`git remote add origin ${url} && git config url.${remote}.insteadOf ${url} && git push -q origin main`, project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
}

/** Accepted: its branch has the work, and the squad is about to send it. */
function accepted(): string {
  const t = createTicket(bp, { title: 'Book a room' });
  const branch = `squad/${t.id.toLowerCase()}`;
  sh(`git checkout -q -b ${branch} && echo "export const fee = 450;" > book.ts && git commit -qam "lower the fee" && git checkout -q main`, project);
  updateTicket(bp, t.id, (x) => {
    x.stage = 'release';
    x.branch = branch;
    x.live = true;
    x.squad = { phase: 'publish', nextAt: new Date().toISOString() };
  });
  return t.id;
}

beforeEach(() => {
  undo.push(fakeGh('ready'));
});

afterEach(() => {
  gh?.done();
  gh = undefined;
  for (const u of undo.reverse()) u();
  undo = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const remoteHas = (branch: string) => sh(`git rev-parse --verify -q refs/heads/${branch} || true`, remote);

describe('your own repo on GitHub', () => {
  it('Looks right opens the pull request, waits for nothing, merges it, and writes the review in', async () => {
    setUp('me/app');
    const id = accepted();
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { merged: gh!.sent('PUT', '/repos/me/app/pulls/7/merge').length > 0, head: `squad/${id.toLowerCase()}` }) };
      if (c.path.includes('/commits/headsha/')) return { body: { check_runs: [], statuses: [] } };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'abc123' } };
      if (c.method === 'DELETE') return { status: 204 };
      if (c.method === 'GET' && c.path.includes('/comments')) return { body: [] };
      return undefined;
    });
    expect(opensPullRequest(bp, requireTicket(bp, id))).toBe(true);
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(t.pr).toEqual({ id: 7, url: 'https://github.com/me/app/pull/7', repo: 'me/app', host: 'github' });
    expect(t.mergedAt).toBeTruthy();
    expect(t.contribution).toBeUndefined();
    expect(t.status).toMatch(/^Merged into main/);
    expect(remoteHas(t.branch!)).not.toBe('');
    expect(gh.sent('POST', '/repos/me/app/pulls')[0]!.body).toMatchObject({ head: t.branch, base: 'main', title: 'Book a room' });
    expect(gh.sent('DELETE', `/repos/me/app/git/refs/heads/${t.branch}`)).toHaveLength(1);
    expect(t.reviewPosted).toMatchObject({ ok: true, pr: 7 });
  });

  it("a branch rule that wants a person's review: the pull request waits, said plainly, and nothing merges", async () => {
    setUp('me/app');
    const id = accepted();
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { mergeableState: 'blocked' }) };
      if (c.path.includes('/commits/headsha/')) return { body: { check_runs: [], statuses: [] } };
      return undefined;
    });
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(t.mergedAt).toBeUndefined();
    expect(t.status).toBe('PR 7 is waiting in GitHub · next release');
    expect(t.activity[0]!.text).toMatch(/open but not merged yet: The branch rule on main asks for more/);
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(0);
  });

  it('a clash on GitHub gives the clash card its way: publishTicket says clash', async () => {
    setUp('me/app');
    const id = accepted();
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { mergeable: false, mergeableState: 'dirty' }) };
      return undefined;
    });
    expect(await publishTicket(bp, id)).toEqual({ clash: true });
  });

  it("GitHub says no to the sign-in: the stop says how to sign in again with GitHub's tool", async () => {
    setUp('me/app');
    const id = accepted();
    gh = fakeGitHub(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const err = await publishTicket(bp, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).message).toBe("squad-kit could not sign in to GitHub, so the pull request did not open. Sign in again with GitHub's tool: open a terminal and run gh auth login. If gh is not on this computer, install it from cli.github.com first. Then press Try again.");
    expect((err as StepError).detail).toBe('GitHub said 401: Bad credentials');
  });
});

describe('the main repo itself, with no right to push', () => {
  it('stops before any push, in plain words: make your own copy first', async () => {
    setUp('team/app');
    const id = accepted();
    gh = fakeGitHub((c) => (route(c, 'GET', '/repos/team/app') ? { body: repoJson('team/app', { push: false }) } : undefined));
    const err = await publishTicket(bp, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect((err as Error).message).toBe("You can't send changes to team/app itself. Make your own copy of it (a fork) on GitHub first, then try again.");
    expect(remoteHas(requireTicket(bp, id).branch!)).toBe('');
  });
});

describe("a copy of someone else's repo: the owner merges", () => {
  let state: { merged?: boolean; closed?: boolean } = {};
  let lines: object[] = [];
  const answers = () => gh!.sent('POST', '/repos/team/app/pulls/31/comments/');

  function forkRoutes(extra: (c: Call) => Answer = () => undefined): void {
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
      if (route(c, 'GET', '/repos/team/app/pulls')) return { body: gh!.calls.some((x) => x.method === 'POST' && x.path === '/repos/team/app/pulls') ? [pullJson('team/app', 31)] : [] };
      if (route(c, 'POST', '/repos/team/app/pulls')) return { status: 201, body: pullJson('team/app', 31) };
      if (route(c, 'PATCH', '/repos/team/app/pulls/31')) return { body: pullJson('team/app', 31) };
      if (route(c, 'GET', '/repos/team/app/pulls/31')) return { body: pullJson('team/app', 31, { merged: state.merged, state: state.merged || state.closed ? 'closed' : 'open', headRepo: 'me/app' }) };
      if (route(c, 'GET', '/user')) return { body: { login: 'me' } };
      if (route(c, 'GET', '/repos/team/app/pulls/31/comments')) return { body: lines };
      if (route(c, 'GET', '/repos/team/app/pulls/31/reviews') || route(c, 'GET', '/repos/team/app/issues/31/comments')) return { body: [] };
      if (c.method === 'POST' && c.path.includes('/comments')) return { status: 201, body: { id: 500 } };
      return extra(c);
    });
  }

  beforeEach(() => {
    state = {};
    lines = [];
  });

  it('Looks right pushes to your copy and opens the pull request into theirs; the story waits for the owner, never merged here', async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes();
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(gh!.sent('POST', '/repos/team/app/pulls')[0]!.body).toMatchObject({ head: `me:${t.branch}`, base: 'main' });
    expect(remoteHas(t.branch!)).not.toBe('');
    expect(t.pr).toMatchObject({ id: 31, repo: 'team/app', host: 'github' });
    expect(t.contribution).toMatchObject({ into: 'team/app', base: 'main', state: 'waiting' });
    expect(t.status).toBe('Waiting for the owner to merge');
    expect(t.mergedAt).toBeUndefined();
    expect(t.live).toBe(false);
    expect(t.release).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Opened pull request 31 in team/app, into main. Its owner merges it, never squad-kit: the story waits, and squad-kit watches it on GitHub');
    expect(gh!.calls.some((c) => c.path.endsWith('/merge'))).toBe(false);
    // On the Builds by itself track, squad-kit never tries to merge it either.
    updateTicket(bp, id, (x) => (x.track = 'auto'));
    expect(mergeWait(requireTicket(bp, id))).toBeNull();
  });

  it("the owner's notes come back as a wait; Fix these sends the fix to the same pull request and answers each one", async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes();
    await publishTicket(bp, id);
    expect((await lookAtContribution(bp, id)).found).toBe('open');
    lines = [{ id: 71, body: 'Keep the fee at 500 for members.', path: 'book.ts', line: 1, html_url: 'https://github.com/team/app/pull/31#c71', created_at: '2026-11-13T10:00:00Z', user: { login: 'lead', type: 'User' }, author_association: 'OWNER' }];
    expect(await lookAtContributions(bp)).toEqual([id]);
    let t = requireTicket(bp, id);
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'The owner asked for changes on the pull request' });
    expect(t.stuck).toMatchObject({ kind: 'owner-notes', points: ['book.ts line 1, lead: Keep the fee at 500 for members.'] });
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Fix these', 'Answer them yourself']);
    expect(t.contribution!.state).toBe('notes');
    // A second look adds nothing new.
    await lookAtContribution(bp, id);
    expect(requireTicket(bp, id).contribution!.notes).toHaveLength(1);

    // Fix these, from the board.
    const app = new Hono();
    mountContributionApi(app, { paths: buildPaths(project) });
    const view = (await (await app.request(`/api/v1/tickets/${id}/pull-request/fix`, { method: 'POST' })).json()) as { state: string; notes: { state: string }[] };
    expect(view).toMatchObject({ state: 'fixing', notes: [{ state: 'fixing' }] });
    t = requireTicket(bp, id);
    expect(t.squad?.phase).toBe('fix');
    expect(t.stage).toBe('implement');
    expect(t.changeRequest).toMatch(/^Fix what the owner asked in the pull request\n/);
    expect(t.changeRequest).toContain('1. book.ts line 1 (lead):\nKeep the fee at 500 for members.');

    // The Builder fixed it; checks, review and Looks right passed: it goes out again.
    sh(`git checkout -q ${t.branch} && echo "export const fee = 500;" > book.ts && git commit -qam "keep the member fee" && git checkout -q main`, project);
    const sha = sh(`git rev-parse --short ${t.branch}`, project);
    updateTicket(bp, id, (x) => {
      x.stage = 'release';
      x.squad = { phase: 'publish', nextAt: new Date().toISOString() };
    });
    await publishTicket(bp, id);
    t = requireTicket(bp, id);
    expect(gh!.calls.filter((c) => c.method === 'POST' && c.path === '/repos/team/app/pulls')).toHaveLength(1);
    expect(gh!.sent('PATCH', '/repos/team/app/pulls/31')).toHaveLength(1);
    expect(answers().map((c) => [c.path, c.body])).toEqual([['/repos/team/app/pulls/31/comments/71/replies', { body: `Fixed in ${sha}.` }]]);
    expect(t.contribution).toMatchObject({ state: 'waiting', notes: [{ id: 'line:71', state: 'fixed', fixedIn: sha, answered: true }] });
    expect(t.activity[0]!.text).toBe(`Sent the fix to pull request 31 in team/app, and answered the note "Fixed in ${sha}". It waits for the owner to merge it`);
    expect(t.status).toBe('Waiting for the owner to merge');
  });

  it('Answer them yourself: the story waits for the owner again, and the notes stay with you', async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes();
    await publishTicket(bp, id);
    lines = [{ id: 72, body: 'Why?', path: 'book.ts', line: 1, html_url: 'u', created_at: '2026-11-13T10:00:00Z', user: { login: 'lead', type: 'User' }, author_association: 'MEMBER' }];
    await lookAtContribution(bp, id);
    const t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ waiting: null, status: 'Waiting for the owner to merge', contribution: { state: 'waiting', notes: [{ state: 'left' }] } });
    expect(t.stuck).toBeUndefined();
  });

  it('merged by the owner: the story is done, your copy catches up, and Check again says so', async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes((c) => {
      if (route(c, 'GET', '/repos/team/app/compare/main...me:main')) return { body: { ahead_by: 0, behind_by: 1 } };
      if (route(c, 'POST', '/repos/me/app/merge-upstream')) return { body: { merge_type: 'fast-forward' } };
      return undefined;
    });
    await publishTicket(bp, id);
    state.merged = true;
    const r = await checkMerge(bp, id);
    expect(r).toMatchObject({ found: 'merged', merged: [id], line: `team/app merged pull request 31. ${id} is done.` });
    const t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.status).toBe('Merged by the owner');
    expect(t.contribution!.state).toBe('merged');
    expect(gh!.sent('POST', '/repos/me/app/merge-upstream')).toHaveLength(1);
    expect(t.activity.map((a) => a.text)).toContain('Your copy me/app took one change from team/app');
    expect(t.reviewPosted).toMatchObject({ ok: true, pr: 31 });
  });

  it('closed by the owner without merging: the story says so, with Send it again and Leave it closed', async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes();
    await publishTicket(bp, id);
    state.closed = true;
    expect((await lookAtContribution(bp, id)).found).toBe('closed');
    let t = requireTicket(bp, id);
    expect(t.status).toBe('Closed by the owner without merging');
    expect(t.stuck).toMatchObject({ kind: 'owner-closed', question: "team/app closed pull request 31 without merging it. Nothing here changed: the work stays on the story's branch and in its copy." });
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Send it again', 'Leave it closed']);
    t = decideStuck(bp, id, 0);
    expect(t.squad?.phase).toBe('publish');
    updateTicket(bp, id, (x) => {
      x.squad = null;
      x.live = false;
    });
    await lookAtContribution(bp, id).catch(() => undefined);
    expect(readTicket(bp, id)!.contribution!.state).toBe('closed');
  });

  it('closed, and left closed: the story ends, not merged', async () => {
    setUp('me/app');
    const id = accepted();
    forkRoutes();
    await publishTicket(bp, id);
    state.closed = true;
    await lookAtContribution(bp, id);
    const t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ waiting: null, status: 'Closed by the owner, left as it is', live: false });
    expect(t.mergedAt).toBeUndefined();
  });
});

describe("gh missing on squad-kit's own code: the 1.3.16 box is the way, with the steps", () => {
  it('no pull request opens by itself; the merged story shows the push, the page and how to let squad-kit do it', () => {
    undo.push(fakeGh('missing'));
    setUp('me/squad-kit', { name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' } });
    const id = accepted();
    expect(opensPullRequest(bp, requireTicket(bp, id))).toBe(false);
    updateTicket(bp, id, (x) => {
      x.mergedAt = '2026-11-13T10:00:00.000Z';
      x.squad = null;
    });
    expect(sendAsOf(bp, requireTicket(bp, id))).toMatchObject({
      push: `git push origin squad/${id.toLowerCase()}`,
      into: 'AzmSquad/squad-kit',
      letSquadKit: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'squad-kit then sends your next stories as pull requests by itself.'],
    });
  });
});
