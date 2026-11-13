import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, listReleases, readTicket, requireTicket, updateTicket, writeMeta } from '../src/board/store.js';
import { approve, createTicket, decideStuck, releaseVersion } from '../src/board/actions.js';
import { mergeWait, mergeWaitWords, PR_HOST_WAITS } from '../src/board/auto.js';
import { opensPullRequest, recheckMerge } from '../src/engine/sync.js';
import { releasePace } from '../src/engine/release-pr.js';
import { fixRoundStopped } from '../src/engine/contribution/actions.js';
import { publishTicket } from '../src/engine/publish.js';
import { lookAtContribution, lookAtContributions } from '../src/engine/contribution/look.js';
import { checkMerge } from '../src/engine/merged-outside.js';
import { sendAsOf } from '../src/engine/send-as-pr.js';
import { mountContributionApi } from '../src/console/api/contribution.js';
import { buildPaths } from '../src/core/paths.js';
import { StepError } from '../src/board/problem.js';
import { checkGh } from '../src/modules/github/sign-in.js';
import { addWorktree } from './support/copy.js';
import { fakeGh, fakeGitHub, pullJson, repoJson, type Answer, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * A story's pull request on GitHub, from Looks right to the end (ADR-008), with GitHub's REST made up and git pushing to
 * a folder that stands in for the repo on GitHub. The team's own repo, a fork too: open, one look at the merge, and the
 * squad looks again while checks run. squad-kit's own code: the pull request goes to the main repo and waits for its
 * owner; the owner's notes come back, Fix these sends the fix to the same pull request and answers only what git shows
 * it fixed; merged, closed, opened again, or sent again by the owner.
 */

let tmp: string;
let project: string;
let remote: string;
let bp: ReturnType<typeof boardPaths>;
let gh: FakeGitHub | undefined;
let undo: (() => void)[] = [];
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const route = (c: Call, method: string, p: string) => c.method === method && c.path.split('?')[0] === p;
const exact = (method: string, p: string) => gh!.calls.filter((c) => c.method === method && c.path === p);
const noChecks = (c: Call) => (c.path.includes('/check-runs') ? { body: { check_runs: [] } } : c.path.endsWith('/status') ? { body: { statuses: [] } } : undefined);
const SELF = { name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/team/app' } };

/** A project whose origin is `https://github.com/<repo>.git`, pushed for real to a folder that stands in for it. */
function setUp(repo: string, pkg: object = { name: 'app' }): void {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-pr-')));
  remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(project, 'book.ts'), 'export const fee = 500;\nexport const rooms = 3;\n');
  fs.writeFileSync(path.join(project, 'other.ts'), Array.from({ length: 10 }, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.squad/\n');
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

/** The squad's work in the story's own copy, at the proof, as the live engine leaves it. */
function atProof(): string {
  const t = createTicket(bp, { title: 'Book a room' });
  const wt = addWorktree(project, t.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'book.ts'), 'export const fee = 450;\nexport const rooms = 3;\n');
  sh('git add -A && git commit -qm "lower the fee"', wt.dir);
  updateTicket(bp, t.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    x.squad = null;
  });
  return t.id;
}

/** Looks right: the story goes to the publish step. */
function accepted(): string {
  const id = atProof();
  approve(bp, id);
  expect(requireTicket(bp, id).squad?.phase).toBe('publish');
  return id;
}

beforeEach(async () => {
  undo.push(fakeGh('ready'));
  await checkGh();
});

afterEach(() => {
  gh?.done();
  gh = undefined;
  for (const u of undo.reverse()) u();
  undo = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const remoteHas = (branch: string) => sh(`git rev-parse --verify -q refs/heads/${branch} || true`, remote);
const mainHere = () => sh('git rev-parse main', project);

describe("the team's own repo on GitHub", () => {
  /** GitHub for me/app: `pull` answers for pull request 7, and the checks are none unless `checks` says. */
  function own(pull: () => object, extra: (c: Call) => Answer = () => undefined, o: { fork?: string; push?: boolean } = {}) {
    gh = fakeGitHub((c) => {
      // The test's own answers first: a dropped connection, a busy GitHub, a release's pull request.
      const first = extra(c);
      if (first) return first;
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', o) };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pull() };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'abc123' } };
      if (c.method === 'DELETE') return { status: 204 };
      if (c.method === 'GET' && c.path.includes('/comments')) return { body: [] };
      if (c.method === 'POST' && c.path.includes('/comments')) return { status: 201, body: { id: 900 } };
      return noChecks(c);
    });
  }

  it('Looks right opens the pull request, merges it at its one look, and writes the review in', async () => {
    setUp('me/app');
    const id = accepted();
    own(() => pullJson('me/app', 7, { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0, head: `squad/${id.toLowerCase()}` }));
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(t.pr).toEqual({ id: 7, url: 'https://github.com/me/app/pull/7', repo: 'me/app', host: 'github' });
    expect(t.mergedAt).toBeTruthy();
    expect(t.status).toMatch(/^Merged into main/);
    expect(remoteHas(t.branch!)).not.toBe('');
    expect(gh!.sent('POST', '/repos/me/app/pulls')[0]!.body).toMatchObject({ head: t.branch, base: 'main', title: 'Book a room' });
    expect(gh!.sent('DELETE', `/repos/me/app/git/refs/heads/${t.branch}`)).toHaveLength(1);
    expect(t.reviewPosted).toMatchObject({ ok: true, pr: 7 });
  });

  it("a fork is the team's own repo: the pull request stays in the fork, and squad-kit merges it", async () => {
    setUp('me/app');
    const id = accepted();
    own(() => pullJson('me/app', 7, { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 }), undefined, { fork: 'team/app' });
    await publishTicket(bp, id);
    expect(requireTicket(bp, id)).toMatchObject({ pr: { repo: 'me/app' }, mergedAt: expect.any(String) });
    expect(requireTicket(bp, id).contribution).toBeUndefined();
    expect(gh!.calls.some((c) => c.path.startsWith('/repos/team/app'))).toBe(false);
  });

  it('checks still running: the step ends at once, the squad looks again, and Check again merges once they pass', async () => {
    setUp('me/app');
    const id = accepted();
    let running = true;
    own(
      () => pullJson('me/app', 7, running ? { mergeableState: 'unstable' } : { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 }),
      (c) => (c.path.includes('/check-runs') ? { body: { check_runs: [{ name: 'e2e', status: running ? 'queued' : 'completed', conclusion: running ? null : 'success' }] } } : undefined),
    );
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    let t = requireTicket(bp, id);
    expect(t.mergedAt).toBeUndefined();
    expect(t.status).toBe(PR_HOST_WAITS);
    expect(t.squad).toBeNull();
    expect(t.activity[0]!.text).toBe('Pull request 7 waits for its checks on GitHub (e2e). squad-kit looks again every few minutes and merges it then');
    // On the Full track too, the squad's own look picks it up (live/waits.ts lookAtMerge).
    expect(mergeWait(t)).toBe('pr');
    expect((await checkMerge(bp, id)).found).toBe('open');
    expect(exact('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(0);
    running = false;
    expect(await checkMerge(bp, id)).toMatchObject({ found: 'merged', merged: [id] });
    t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(exact('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(1);
  });

  it("a branch rule that wants a person's review is a wait; once approved, the squad merges it", async () => {
    setUp('me/app');
    const id = accepted();
    let approved = false;
    own(() => pullJson('me/app', 7, approved ? { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 } : { mergeableState: 'blocked' }));
    await publishTicket(bp, id);
    expect(requireTicket(bp, id).status).toBe(PR_HOST_WAITS);
    approved = true;
    expect((await checkMerge(bp, id)).found).toBe('merged');
    expect(requireTicket(bp, id).mergedAt).toBeTruthy();
  });

  it('a failed check found while it waits: said once, and the wait ends there', async () => {
    setUp('me/app');
    const id = accepted();
    let failed = false;
    own(
      () => pullJson('me/app', 7, { mergeableState: 'unstable' }),
      (c) => (c.path.includes('/check-runs') ? { body: { check_runs: [{ name: 'lint', status: failed ? 'completed' : 'in_progress', conclusion: failed ? 'failure' : null }] } } : undefined),
    );
    await publishTicket(bp, id);
    failed = true;
    await checkMerge(bp, id);
    const t = requireTicket(bp, id);
    expect(t.status).toBe(`PR 7 is waiting in GitHub · ${t.release}`);
    expect(t.activity[0]!.text).toMatch(/^Pull request 7 is open but not merged yet: GitHub's check "lint" failed/);
    expect(mergeWait(t)).toBeNull();
  });

  it('a clash on GitHub gives the clash card its way', async () => {
    setUp('me/app');
    const id = accepted();
    own(() => pullJson('me/app', 7, { mergeable: false, mergeableState: 'dirty' }));
    expect(await publishTicket(bp, id)).toEqual({ clash: true });
  });

  it("a repo the person can't push to merges on this computer, as with no code host, and says why", async () => {
    setUp('me/app');
    const id = accepted();
    const before = mainHere();
    own(() => pullJson('me/app', 7), undefined, { push: false });
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.pr).toBeUndefined();
    expect(mainHere()).not.toBe(before);
    expect(t.activity[0]!.text).toBe("GitHub says you can't push to me/app, so squad-kit merged it on this computer instead, as it does with no code host. It goes out with the release");
    expect(gh!.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a laptop waking from sleep: offline, too many calls or GitHub trouble keep the wait, and it merges once all is well', async () => {
    setUp('me/app');
    const id = accepted();
    let now: 'running' | 'offline' | 'busy' | 'green' = 'offline';
    own(
      () => pullJson('me/app', 7, now === 'green' ? { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 } : { mergeableState: 'unstable' }),
      (c) => {
        if (now === 'offline' && c.path.startsWith('/repos/me/app/pulls/7')) return 'offline';
        if (now === 'busy' && c.path.startsWith('/repos/me/app/pulls/7')) return { status: 502, body: { message: 'Bad gateway' } };
        return c.path.includes('/check-runs') ? { body: { check_runs: [{ name: 'e2e', status: now === 'green' ? 'completed' : 'queued', conclusion: now === 'green' ? 'success' : null }] } } : undefined;
      },
    );
    // Offline right at the merge: a wait, never a stop.
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    let t = requireTicket(bp, id);
    expect(t.status).toBe(PR_HOST_WAITS);
    expect(t.activity[0]!.text).toMatch(/^Pull request 7 is open, not merged yet: GitHub could not be reached: fetch failed\. squad-kit looks again every few minutes/);
    expect(mergeWaitWords('pr', t)).toBe(PR_HOST_WAITS);
    for (const step of ['running', 'offline', 'busy'] as const) {
      now = step;
      expect(await recheckMerge(bp, id)).toBe('waiting');
      expect(requireTicket(bp, id).status).toBe(PR_HOST_WAITS);
    }
    now = 'green';
    expect(await recheckMerge(bp, id)).toBe('merged');
    t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.activity.map((a) => a.text)).toContain('Merged pull request 7 on GitHub once it was ready');
  });

  it('closed on GitHub while it waits: the story says so, with Send it again or Leave it closed, and leaves the release', async () => {
    setUp('me/app');
    const id = accepted();
    let closed = false;
    own(
      () => (closed ? pullJson('me/app', 7, { state: 'closed' }) : pullJson('me/app', 7, { mergeableState: 'blocked' })),
    );
    await publishTicket(bp, id);
    closed = true;
    expect(await recheckMerge(bp, id)).toBe('closed');
    let t = requireTicket(bp, id);
    expect(t).toMatchObject({ status: 'Pull request 7 was closed on GitHub without merging', waiting: { kind: 'stuck' }, stuck: { kind: 'owner-closed' } });
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Send it again', 'Leave it closed']);
    expect(mergeWait(t)).toBeNull();
    t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ status: 'Closed without merging, left as it is', waiting: null });
    expect(t.release).toBeUndefined();
    expect(listReleases(bp).flatMap((r) => r.tickets)).not.toContain(id);
  });

  it('Check again after a stop merges it once it can; on Builds by itself the squad does', async () => {
    setUp('me/app');
    const id = accepted();
    let failed = true;
    own(
      () => pullJson('me/app', 7, failed ? { mergeableState: 'unstable' } : { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 }),
      (c) => (c.path.includes('/check-runs') ? { body: { check_runs: [{ name: 'lint', status: 'completed', conclusion: failed ? 'failure' : 'success' }] } } : undefined),
    );
    await publishTicket(bp, id);
    expect(requireTicket(bp, id).status).toMatch(/^PR 7 is waiting in GitHub/);
    expect(mergeWait(requireTicket(bp, id))).toBeNull();
    failed = false;
    expect(await checkMerge(bp, id)).toMatchObject({ found: 'merged', merged: [id], line: `Merged pull request 7 on GitHub now that it can merge. ${id} is merged.` });

    // Builds by itself: the squad's own look merges it once the check is fixed.
    const auto = accepted();
    updateTicket(bp, auto, (x) => (x.track = 'auto'));
    failed = true;
    own(
      () => pullJson('me/app', 7, failed ? { mergeableState: 'unstable' } : { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 }),
      (c) => (c.path.includes('/check-runs') ? { body: { check_runs: [{ name: 'lint', status: 'completed', conclusion: failed ? 'failure' : 'success' }] } } : undefined),
    );
    await publishTicket(bp, auto);
    expect(mergeWait(requireTicket(bp, auto))).toBe('pr');
    expect(await recheckMerge(bp, auto)).toBe('waiting');
    failed = false;
    expect(await recheckMerge(bp, auto)).toBe('merged');
  });

  it('a release never starts with a pull request still held back, and goes through its own pull request on a branch that takes only those', async () => {
    setUp('me/app');
    const held = accepted();
    let running = true;
    let releasePr = false;
    own(
      () => pullJson('me/app', 7, running ? { mergeableState: 'unstable' } : { merged: exact('PUT', '/repos/me/app/pulls/7/merge').length > 0 }),
      (c) => {
        if (c.path.includes('/commits/headsha/check-runs')) return { body: { check_runs: running ? [{ name: 'e2e', status: 'queued', conclusion: null }] : [] } };
        if (route(c, 'GET', '/repos/me/app/pulls') && c.path.includes('release')) return { body: releasePr ? [pullJson('me/app', 8)] : [] };
        if (route(c, 'POST', '/repos/me/app/pulls') && String(c.body?.head).startsWith('release/')) {
          releasePr = true;
          return { status: 201, body: pullJson('me/app', 8) };
        }
        if (route(c, 'GET', '/repos/me/app/pulls/8')) return { body: pullJson('me/app', 8, { sha: 'relsha', merged: exact('PUT', '/repos/me/app/pulls/8/merge').length > 0 }) };
        // The release's own checks run on its first look, and pass by the next one.
        if (c.path.startsWith('/repos/me/app/commits/relsha/check-runs')) return { body: { check_runs: [{ name: 'e2e', status: exact('GET', c.path).length < 2 ? 'queued' : 'completed', conclusion: exact('GET', c.path).length < 2 ? null : 'success' }] } };
        if (route(c, 'PUT', '/repos/me/app/pulls/8/merge')) return { body: { merged: true, sha: 'rel123' } };
        return undefined;
      },
    );
    await publishTicket(bp, held);
    expect(requireTicket(bp, held).status).toBe(PR_HOST_WAITS);
    await expect(releaseVersion(bp)).rejects.toThrow(`The pull request of ${held} still waits on GitHub: its checks or an approval.`);
    // Nothing of the release was written down or made.
    expect(sh('git tag', project)).toBe('');
    running = false;
    expect(await recheckMerge(bp, held)).toBe('merged');
    // main only takes pull requests: the release goes through its own, and waits for its checks for a while.
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "error: GH006: Protected branch update failed for refs/heads/main."; exit 1; fi\ndone\n', { mode: 0o755 });
    const sleep = releasePace.sleep;
    releasePace.sleep = async () => undefined;
    try {
      const r = await releaseVersion(bp);
      expect(r.unpushed).toBeUndefined();
      expect(r.log?.map((l) => l.text)).toContain('The shared copy only takes pull requests, so the release went through pull request 8');
      expect(sh(`git tag -l ${r.version}`, remote)).toBe(r.version);
      expect(exact('PUT', '/repos/me/app/pulls/8/merge')).toHaveLength(1);
      // It looked twice: once while the checks ran, once when they passed.
      expect(exact('GET', '/repos/me/app/commits/relsha/check-runs?per_page=100')).toHaveLength(2);
    } finally {
      releasePace.sleep = sleep;
    }
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

describe("squad-kit's own code: the main repo's owner merges", () => {
  let state: { merged?: boolean; closed?: boolean; clash?: boolean } = {};
  let lines: object[] = [];
  let gone = new Set<number>();
  let prs = 0;
  const answers = () => gh!.calls.filter((c) => c.method === 'POST' && /\/(comments\/\d+\/replies|issues\/\d+\/comments)$/.test(c.path));
  const owner = (login = 'lead') => ({ user: { login, type: 'User' }, author_association: 'OWNER' });
  const note = (id: number, body: string, file: string, line: number, more: object = {}) => ({ id, body, path: file, line, html_url: `https://github.com/team/app/pull/31#c${id}`, created_at: new Date(Date.UTC(2026, 10, 13, 10) + id * 1000).toISOString(), ...owner(), ...more });

  function mainRoutes(extra: (c: Call) => Answer = () => undefined): void {
    gh = fakeGitHub(
      (c) => {
        const first = extra(c);
        if (first) return first;
        const open = 30 + prs;
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
        if (route(c, 'GET', '/repos/team/app')) return { body: repoJson('team/app', { push: false }) };
        if (route(c, 'GET', '/repos/team/app/pulls')) return { body: prs && !state.closed ? [pullJson('team/app', open)] : [] };
        if (route(c, 'POST', '/repos/team/app/pulls')) {
          prs += 1;
          state = {};
          return { status: 201, body: pullJson('team/app', 30 + prs) };
        }
        if (/^\/repos\/team\/app\/pulls\/\d+$/.test(c.path) && c.method === 'PATCH') return { body: {} };
        if (route(c, 'GET', `/repos/team/app/pulls/${open}`)) return { body: pullJson('team/app', open, { merged: state.merged, state: state.merged || state.closed ? 'closed' : 'open', headRepo: 'me/app', ...(state.clash ? { mergeable: false, mergeableState: 'dirty' } : {}) }) };
        if (route(c, 'GET', '/user')) return { body: { login: 'me' } };
        if (c.path.includes('/permission')) return { body: { permission: c.path.includes('/lead/') ? 'write' : 'read' } };
        if (route(c, 'GET', `/repos/team/app/pulls/${open}/comments`)) return { body: lines };
        if (c.method === 'GET' && (c.path.includes('/reviews') || c.path.includes('/issues/'))) return { body: [] };
        const reply = /\/pulls\/\d+\/comments\/(\d+)\/replies$/.exec(c.path);
        if (reply && gone.has(Number(reply[1]))) return { status: 404, body: { message: 'Not Found' } };
        if (c.method === 'POST' && c.path.includes('/comments')) return { status: 201, body: { id: 500 } };
        return noChecks(c);
      },
      { network: [['me/app', 'team/app']] },
    );
  }

  beforeEach(() => {
    state = {};
    lines = [];
    gone = new Set();
    prs = 0;
  });

  /** Sent: the pull request is open in team/app and waits for its owner. */
  async function sent(): Promise<string> {
    setUp('me/app', SELF);
    const id = accepted();
    mainRoutes();
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    return id;
  }

  /** The Builder's fix in the story's copy, then Looks right, through acceptProof, and the fix goes out. */
  async function fixedAndSent(id: string, change: () => void): Promise<string> {
    const t = requireTicket(bp, id);
    change();
    sh('git add -A && git commit -qm "fix what the owner asked"', t.worktree!);
    updateTicket(bp, id, (x) => {
      x.stage = 'review';
      x.live = false;
      x.squad = null;
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    });
    const main = mainHere();
    approve(bp, id);
    const after = requireTicket(bp, id);
    // Never merged here, and never in this project's release: the fix goes to the same pull request.
    expect(mainHere()).toBe(main);
    expect(after.release).toBeUndefined();
    expect(listReleases(bp).flatMap((r) => r.tickets)).not.toContain(id);
    expect(after.squad?.phase).toBe('publish');
    await publishTicket(bp, id);
    return sh('git rev-parse --short=7 HEAD', t.worktree!);
  }

  it('Looks right sends it to the main repo as owner:branch; the story waits for the owner, never merged here', async () => {
    const id = await sent();
    const t = requireTicket(bp, id);
    expect(gh!.sent('POST', '/repos/team/app/pulls')[0]!.body).toMatchObject({ head: `me:${t.branch}`, base: 'main' });
    expect(remoteHas(t.branch!)).not.toBe('');
    expect(t.pr).toMatchObject({ id: 31, repo: 'team/app', host: 'github' });
    expect(t.contribution).toMatchObject({ into: 'team/app', base: 'main', state: 'waiting', sent: sh(`git rev-parse ${t.branch}`, project) });
    expect(t.status).toBe('Waiting for the owner to merge');
    expect(t.mergedAt).toBeUndefined();
    expect(t.release).toBeUndefined();
    expect(gh!.calls.some((c) => c.path.endsWith('/merge'))).toBe(false);
    updateTicket(bp, id, (x) => (x.track = 'auto'));
    expect(mergeWait(requireTicket(bp, id))).toBeNull();
  });

  it("can't push to the main repo and no copy of one's own: a plain stop that says to make one", async () => {
    setUp('team/app', SELF);
    const id = accepted();
    gh = fakeGitHub((c) => (route(c, 'GET', '/repos/team/app') ? { body: repoJson('team/app', { push: false }) } : undefined));
    const err = await publishTicket(bp, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect((err as Error).message).toBe("You can't send changes to team/app itself. Make your own copy of it first (squad contribute --fork), then press Try again.");
    expect(remoteHas(requireTicket(bp, id).branch!)).toBe('');
  });

  it('notes come back; Fix these goes through acceptProof; only notes whose lines changed get "Fixed in", in their thread', async () => {
    const id = await sent();
    expect((await lookAtContribution(bp, id)).found).toBe('open');
    lines = [
      note(71, 'Keep the fee at 500 for members.', 'book.ts', 1),
      note(72, 'And name it memberFee.', 'book.ts', 1, { in_reply_to_id: 71 }),
      note(73, 'Why 3 rooms?', 'book.ts', 2),
      note(74, 'Tidy this one too.', 'other.ts', 8),
      note(75, 'A stranger says hi.', 'book.ts', 1, owner('stranger')),
    ];
    expect(await lookAtContributions(bp)).toEqual([id]);
    let t = requireTicket(bp, id);
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'The owner asked for changes on the pull request' });
    expect(t.stuck).toMatchObject({ kind: 'owner-notes', points: ['book.ts line 1, lead: Keep the fee at 500 for members.', 'book.ts line 1, lead: And name it memberFee.', 'book.ts line 2, lead: Why 3 rooms?', 'other.ts line 8, lead: Tidy this one too.'] });
    // Fix these, from the board.
    const app = new Hono();
    mountContributionApi(app, { paths: buildPaths(project) });
    const view = (await (await app.request(`/api/v1/tickets/${id}/pull-request/fix`, { method: 'POST' })).json()) as { state: string };
    expect(view.state).toBe('fixing');
    t = requireTicket(bp, id);
    expect(t.squad?.phase).toBe('fix');
    expect(t.changeRequest).toContain('1. book.ts line 1 (lead):\nKeep the fee at 500 for members.');
    // The Builder changed book.ts line 1 only.
    const sha = await fixedAndSent(id, () => fs.writeFileSync(path.join(t.worktree!, 'book.ts'), 'export const memberFee = 500;\nexport const rooms = 3;\n'));
    t = requireTicket(bp, id);
    expect(exact('POST', '/repos/team/app/pulls')).toHaveLength(1);
    expect(gh!.sent('PATCH', '/repos/team/app/pulls/31')).toHaveLength(1);
    // Both notes of the thread are answered on its first note.
    expect(answers().map((c) => [c.path, c.body])).toEqual([
      ['/repos/team/app/pulls/31/comments/71/replies', { body: `Fixed in ${sha}.` }],
      ['/repos/team/app/pulls/31/comments/71/replies', { body: `Fixed in ${sha}.` }],
    ]);
    expect(t.contribution!.notes!.map((n) => [n.id, n.state, n.why ?? null])).toEqual([
      ['line:71', 'fixed', null],
      ['line:72', 'fixed', null],
      ['line:73', 'left', 'It asks a question: answer it yourself on GitHub.'],
      ['line:74', 'left', 'The fix did not change its lines: answer it yourself on GitHub.'],
    ]);
    expect(t.activity[0]!.text).toBe(`Sent the fix to pull request 31 in team/app, and answered 2 notes "Fixed in ${sha}". It waits for the owner to merge it`);
    expect(t.status).toBe('Waiting for the owner to merge');
  });

  it('"Fixed in" reads the round\'s own commits only: the newest base brought in during the round fixes nothing', async () => {
    const id = await sent();
    lines = [note(41, 'Keep the fee.', 'book.ts', 1), note(42, 'Tidy n7.', 'other.ts', 8)];
    await lookAtContribution(bp, id);
    decideStuck(bp, id, 0);
    const t = requireTicket(bp, id);
    // Meanwhile main moved: someone changed other.ts line 8 there, and the round brought it in.
    sh(`git checkout -q main && sed -i.bak 's/n7 = 7/n7 = 70/' other.ts && rm other.ts.bak && git commit -qam "teammate's change" && git checkout -q -`, project);
    sh('git merge -q --no-edit main', t.worktree!);
    const sha = await fixedAndSent(id, () => fs.writeFileSync(path.join(t.worktree!, 'book.ts'), 'export const fee = 500;\nexport const rooms = 3;\n'));
    expect(requireTicket(bp, id).contribution!.notes!.map((n) => [n.id, n.state, n.fixedIn ?? n.why])).toEqual([
      ['line:41', 'fixed', sha],
      ['line:42', 'left', 'The fix did not change its lines: answer it yourself on GitHub.'],
    ]);
  });

  it('a conversation the owner locked: the answer is refused, so the note is left with why, never asked again', async () => {
    const id = await sent();
    lines = [note(43, 'Lower it.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    decideStuck(bp, id, 0);
    mainRoutes((c) => (c.path.endsWith('/comments/43/replies') ? { status: 403, body: { message: 'Conversation is locked' } } : undefined));
    prs = 1;
    const t = requireTicket(bp, id);
    await fixedAndSent(id, () => fs.writeFileSync(path.join(t.worktree!, 'book.ts'), 'export const fee = 300;\nexport const rooms = 3;\n'));
    expect(requireTicket(bp, id).contribution!.notes![0]).toMatchObject({ state: 'left', why: 'squad-kit could not answer it on GitHub: its conversation is locked, or its comment is gone.' });
    const asked = answers().length;
    await lookAtContribution(bp, id);
    expect(answers()).toHaveLength(asked);
  });

  it('a fix round stopped or given up: the pull request is watched again and its notes wait for you again', async () => {
    const id = await sent();
    lines = [note(44, 'Rename it.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    decideStuck(bp, id, 0);
    expect(requireTicket(bp, id).contribution!.state).toBe('fixing');
    expect(await lookAtContributions(bp)).toEqual([]);
    // As the live squad's Stop does, and Stop or back to the plan on a card.
    updateTicket(bp, id, (x) => {
      fixRoundStopped(x);
      x.squad = null;
      x.live = false;
    });
    expect(requireTicket(bp, id).contribution).toMatchObject({ state: 'waiting', notes: [{ id: 'line:44', state: 'new' }] });
    expect(await lookAtContributions(bp)).toEqual([id]);
    expect(requireTicket(bp, id).stuck).toMatchObject({ kind: 'owner-notes', points: ['book.ts line 1, lead: Rename it.'] });
  });

  it("a maintainer's own clone of the main repo: the pull request opens there and waits for its owners, never merged by squad-kit", async () => {
    setUp('team/app', SELF);
    const id = accepted();
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/team/app')) return { body: repoJson('team/app', { push: true }) };
      if (route(c, 'GET', '/repos/team/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/team/app/pulls')) return { status: 201, body: pullJson('team/app', 40) };
      return undefined;
    });
    await publishTicket(bp, id);
    const t = requireTicket(bp, id);
    expect(gh.sent('POST', '/repos/team/app/pulls')[0]!.body).toMatchObject({ head: t.branch, base: 'main' });
    expect(t).toMatchObject({ status: 'Waiting for the owner to merge', contribution: { into: 'team/app', state: 'waiting' } });
    expect(gh.calls.some((c) => c.path.endsWith('/merge'))).toBe(false);
  });

  it("gh that did not answer just now never means a merge here: Looks right still sends the pull request", async () => {
    setUp('me/app', SELF);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-dies-'));
    const before = process.env.PATH;
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    undo.push(() => {
      process.env.PATH = before;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const { forgetGhState } = await import('../src/modules/github/sign-in.js');
    forgetGhState();
    expect(await checkGh()).toBe('unknown');
    const main = mainHere();
    const id = accepted();
    expect(mainHere()).toBe(main);
    expect(requireTicket(bp, id).squad?.phase).toBe('publish');
  });

  it('a deleted note is never asked again: it is left, with why', async () => {
    const id = await sent();
    lines = [note(81, 'Rename the fee.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    decideStuck(bp, id, 0);
    gone.add(81);
    lines = [];
    const t = requireTicket(bp, id);
    await fixedAndSent(id, () => fs.writeFileSync(path.join(t.worktree!, 'book.ts'), 'export const charge = 450;\nexport const rooms = 3;\n'));
    expect(requireTicket(bp, id).contribution!.notes![0]).toMatchObject({ id: 'line:81', state: 'left', why: 'squad-kit could not answer it on GitHub: its conversation is locked, or its comment is gone.' });
    const asked = answers().length;
    await lookAtContribution(bp, id);
    expect(answers()).toHaveLength(asked);
  });

  it('more than 20 notes: 20 go to the Builder, the rest wait for the next card', async () => {
    const id = await sent();
    lines = Array.from({ length: 25 }, (_, i) => note(100 + i, `Note ${i + 1}.`, 'other.ts', (i % 10) + 1));
    await lookAtContribution(bp, id);
    expect(requireTicket(bp, id).stuck!.points).toHaveLength(25);
    decideStuck(bp, id, 0);
    let t = requireTicket(bp, id);
    expect(t.contribution!.notes!.filter((n) => n.state === 'fixing')).toHaveLength(20);
    expect(t.contribution!.notes!.filter((n) => n.state === 'new')).toHaveLength(5);
    expect(t.changeRequest).toContain('20. other.ts line 10');
    expect(t.changeRequest).not.toContain('21. ');
    await fixedAndSent(id, () => fs.writeFileSync(path.join(t.worktree!, 'other.ts'), Array.from({ length: 10 }, (_, i) => `export const m${i} = ${i};`).join('\n') + '\n'));
    await lookAtContribution(bp, id);
    t = requireTicket(bp, id);
    expect(t.stuck!.points).toEqual(['other.ts line 1, lead: Note 21.', 'other.ts line 2, lead: Note 22.', 'other.ts line 3, lead: Note 23.', 'other.ts line 4, lead: Note 24.', 'other.ts line 5, lead: Note 25.']);
  });

  it('Answer them yourself: the story waits for the owner again, and the notes stay with you', async () => {
    const id = await sent();
    lines = [note(91, 'Why?', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    const t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ waiting: null, status: 'Waiting for the owner to merge', contribution: { state: 'waiting', notes: [{ state: 'left', why: 'You answer it yourself.' }] } });
    expect(t.stuck).toBeUndefined();
  });

  it('merged by the owner: done, your copy catches up, and no thread is written into their repo', async () => {
    const id = await sent();
    mainRoutes((c) => {
      if (route(c, 'GET', '/repos/team/app/compare/main...me:main')) return { body: { ahead_by: 0, behind_by: 1 } };
      if (route(c, 'POST', '/repos/me/app/merge-upstream')) return { body: { merge_type: 'fast-forward' } };
      return undefined;
    });
    prs = 1;
    state.merged = true;
    expect(await checkMerge(bp, id)).toMatchObject({ found: 'merged', merged: [id], line: `team/app merged pull request 31. ${id} is done.` });
    const t = requireTicket(bp, id);
    expect(t).toMatchObject({ status: 'Merged by the owner', contribution: { state: 'merged' } });
    expect(t.mergedAt).toBeTruthy();
    expect(gh!.sent('POST', '/repos/me/app/merge-upstream')).toHaveLength(1);
    expect(t.activity.map((a) => a.text)).toContain('Your copy me/app took one change from team/app');
    expect(t.reviewPosted).toBeUndefined();
    expect(gh!.calls.some((c) => c.method === 'POST' && c.path.includes('/repos/team/app/') && c.path.includes('comments'))).toBe(false);
  });

  it('closed, then opened again by the owner: it waits again; a clash there is said once with what to do', async () => {
    const id = await sent();
    state.closed = true;
    expect((await lookAtContribution(bp, id)).found).toBe('closed');
    expect(requireTicket(bp, id).stuck).toMatchObject({ kind: 'owner-closed' });
    state = { clash: true };
    expect((await lookAtContribution(bp, id)).found).toBe('open');
    await lookAtContribution(bp, id);
    const t = requireTicket(bp, id);
    expect(t).toMatchObject({ status: 'Waiting for the owner to merge', waiting: null, contribution: { state: 'waiting', clashTold: 31 } });
    expect(t.activity.filter((a) => a.text.startsWith('Pull request 31 clashes'))).toEqual([expect.objectContaining({ text: `Pull request 31 clashes with newer work in team/app. Bring your copy up to date (squad contribute --sync), then bring the newest code into the story (squad bring-in ${id}): the fix goes to the same pull request` })]);
  });

  it('Send it again: a new pull request; old notes are never answered there and never come back on its card', async () => {
    const id = await sent();
    lines = [note(61, 'Not like this.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    // The person answers on GitHub; then the owner closes it.
    decideStuck(bp, id, 1);
    lines = [note(62, 'Closing for now.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    state.closed = true;
    await lookAtContribution(bp, id);
    const card = requireTicket(bp, id).stuck!;
    expect(card.options.map((o) => o.name)).toEqual(['Send it again', 'Leave it closed']);
    expect(decideStuck(bp, id, 0).squad?.phase).toBe('publish');
    lines = [];
    await publishTicket(bp, id);
    let t = requireTicket(bp, id);
    expect(t.pr!.id).toBe(32);
    expect(t.contribution!.notes!.map((n) => [n.id, n.pr, n.state])).toEqual([
      ['line:61', 31, 'left'],
      ['line:62', 31, 'left'],
    ]);
    expect(t.contribution!.notes![1]!.why).toBe('Its pull request was closed, so squad-kit did not answer it.');
    expect(answers()).toEqual([]);
    lines = [note(63, 'Better. One more thing.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    t = requireTicket(bp, id);
    expect(t.stuck!.points).toEqual(['book.ts line 1, lead: Better. One more thing.']);
  });

  it('closed, and left closed: the story ends, not merged, and squad-kit stops looking', async () => {
    const id = await sent();
    state.closed = true;
    await lookAtContribution(bp, id);
    const t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ waiting: null, status: 'Closed by the owner, left as it is', live: false });
    expect(await lookAtContributions(bp)).toEqual([]);
    expect((await lookAtContribution(bp, id)).line).toBe('Pull request 31 is closed, and you left it closed.');
  });

  it("a fix with GitHub's tool signed out never merges here: the publish step stops with the steps, with no way to skip the pull request", async () => {
    const id = await sent();
    lines = [note(51, 'Lower it more.', 'book.ts', 1)];
    await lookAtContribution(bp, id);
    decideStuck(bp, id, 0);
    undo.push(fakeGh('signed-out'));
    await checkGh();
    const t = requireTicket(bp, id);
    fs.writeFileSync(path.join(t.worktree!, 'book.ts'), 'export const fee = 400;\nexport const rooms = 3;\n');
    sh('git add -A && git commit -qm "lower it more"', t.worktree!);
    updateTicket(bp, id, (x) => {
      x.stage = 'review';
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    });
    const main = mainHere();
    approve(bp, id);
    expect(mainHere()).toBe(main);
    expect(requireTicket(bp, id)).toMatchObject({ squad: { phase: 'publish' } });
    expect(requireTicket(bp, id).release).toBeUndefined();
    const err = (await publishTicket(bp, id).then(() => null, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toBe('squad-kit is not signed in to GitHub on this computer, so it cannot send the pull request. 1. Sign in: open a terminal and run gh auth login. 2. Come back and press Try again.');
    const { wayOptions } = await import('../src/board/actions/decide.js');
    expect(wayOptions({ publish: true, contribution: true }).map((o) => o.do)).toEqual(['retry']);
  });
});

describe("GitHub's tool missing on squad-kit's own code: the 1.3.16 box is the way, with the steps", () => {
  it('no pull request opens by itself; the merged story shows the push, the page and how to let squad-kit do it', async () => {
    undo.push(fakeGh('missing'));
    await checkGh();
    setUp('me/squad-kit', { ...SELF, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' } });
    const id = atProof();
    expect(opensPullRequest(bp, requireTicket(bp, id))).toBe(false);
    updateTicket(bp, id, (x) => {
      x.stage = 'release';
      x.mergedAt = '2026-11-13T10:00:00.000Z';
      x.waiting = null;
    });
    expect(sendAsOf(bp, readTicket(bp, id)!)).toMatchObject({
      push: `git push origin squad/${id.toLowerCase()}`,
      into: 'AzmSquad/squad-kit',
      letSquadKit: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'squad-kit then sends your next stories as pull requests by itself.'],
    });
  });
});
