import { describe, it, expect, afterEach } from 'vitest';
import { githubCodeHost } from '../src/modules/github/code-host.js';
import { githubForks } from '../src/modules/github/forks.js';
import { checkGh, ghSignIn, ghState } from '../src/modules/github/sign-in.js';
import { useMergePace } from '../src/modules/github/merge.js';
import { ModuleError } from '../src/modules/errors.js';
import { CODE_HOSTS, forkHostFor, remoteKind } from '../src/modules/registry.js';
import type { RepoHost } from '../src/modules/code-host/types.js';
import { fakeGh, fakeGitHub, pullJson, repoJson, type Answer, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * GitHub as a code host (ADR-008), with GitHub's REST made up: the team's own repo, a fork too (open, one look at the
 * merge, the branch goes), squad-kit's own code sending its pull request to the main repo (never merged by squad-kit),
 * the review written as comments on lines (ADR-007), the owner's notes and the answers, and the person's own copy.
 */

let undo: (() => void)[] = [];
let gh: FakeGitHub;

afterEach(() => {
  gh?.done();
  for (const u of undo.reverse()) u();
  undo = [];
});

async function signedIn(answer: (c: Call) => Answer, upstream?: string, network?: string[][]): Promise<RepoHost> {
  undo.push(fakeGh('ready'));
  await checkGh();
  gh = fakeGitHub(answer, network ? { network } : {});
  return githubCodeHost.repoFor('/tmp/x', 'https://github.com/me/app.git', upstream)!;
}

const route = (c: Call, method: string, path: string) => c.method === method && c.path.split('?')[0] === path;
const noChecks = (c: Call) => (c.path.includes('/check-runs') ? { body: { check_runs: [] } } : c.path.endsWith('/status') ? { body: { statuses: [] } } : undefined);

describe("the sign-in, through GitHub's own tool", () => {
  it('is a host only for a GitHub remote with gh signed in; missing or signed out gives none, with the steps', async () => {
    undo.push(fakeGh('missing'));
    expect(githubCodeHost.repoFor('/tmp/x', 'https://github.com/me/app.git')).toBeNull();
    expect((await ghSignIn()).state).toBe('missing');
    expect((await ghSignIn()).steps[0]).toMatch(/Install GitHub's tool/);
    undo.pop()!();
    undo.push(fakeGh('signed-out'));
    expect(githubCodeHost.repoFor('/tmp/x', 'git@github.com:me/app.git')).toBeNull();
    expect((await ghSignIn()).steps[0]).toBe('Sign in: open a terminal and run gh auth login.');
    undo.pop()!();
    const host = await signedIn((c) => (route(c, 'GET', '/user') ? { body: { login: 'me' } } : undefined));
    expect(host.repo).toBe('me/app');
    expect(githubCodeHost.repoFor('/tmp/x', 'https://dev.azure.com/o/p/_git/r')).toBeNull();
    expect(await ghSignIn()).toMatchObject({ state: 'ready', account: 'me' });
    expect(CODE_HOSTS.map((m) => m.name)).toContain('github');
    expect(forkHostFor('https://github.com/me/app')?.label).toBe('GitHub');
    expect(remoteKind('git@github.com:me/app.git')).toBe('github');
    // An Azure Repos remote is Azure's own kind, for Microsoft's tool on the Tools page (ADR-011).
    expect(remoteKind('https://dev.azure.com/o/p/_git/r')).toBe('azure');
    expect(remoteKind('https://gitlab.com/o/r.git')).toBeNull();
  });

  it('never holds the board up: before gh answers, a quick guess from its files stands in, then gh decides', async () => {
    undo.push(fakeGh('ready'));
    // Its hosts file says signed in, so the guess is ready at once, and gh's own answer comes beside.
    expect(ghState()).toBe('ready');
    expect(await checkGh()).toBe('ready');
    undo.pop()!();
    undo.push(fakeGh('signed-out'));
    expect(ghState()).toBe('signed-out');
  });

  it("gh that does not answer is never a sign-out: the last answer stays, else 'unknown', and squad-kit still tries", async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const before = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-dies-'));
    undo.push(() => {
      process.env.PATH = before;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // gh is killed before it answers: no exit code, so no answer.
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    undo.push(fakeGh('ready'));
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    const { forgetGhState } = await import('../src/modules/github/sign-in.js');
    forgetGhState();
    expect(await checkGh()).toBe('unknown');
    expect(githubCodeHost.repoFor('/tmp/x', 'https://github.com/me/app.git')).not.toBeNull();
    // A gh that cannot even start (not a program) is no answer either.
    // Not runnable at all (the mode of a file already there stays, so it is set here): Linux runs a runnable file that
    // is no program through sh, and would skip one it cannot run for the next gh on the PATH, like a CI runner's own.
    fs.writeFileSync(path.join(dir, 'gh'), 'not a program');
    fs.chmodSync(path.join(dir, 'gh'), 0o644);
    process.env.PATH = dir;
    forgetGhState();
    expect(await checkGh()).toBe('unknown');
    // After a real answer, a missing one keeps it.
    process.env.PATH = before;
    undo.push(fakeGh('signed-out'));
    expect(await checkGh()).toBe('signed-out');
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    const { ghState } = await import('../src/modules/github/sign-in.js');
    expect(ghState(Date.now() + 120_000)).toBe('signed-out');
  });

  it("git push signs in through gh's credential helper, and no token is in its environment", async () => {
    const host = await signedIn(() => undefined);
    const env = host.gitEnv();
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    });
    expect(JSON.stringify(env)).not.toContain('test-token');
    expect(host.abilities.attachImages).toBe(false);
  });

  it('a protected branch refusing the push is known', async () => {
    const host = await signedIn(() => undefined);
    expect(host.refusedPush('remote: error: GH006: Protected branch update failed for refs/heads/main.')).toBe(true);
    expect(host.refusedPush('! [rejected] main -> main (fetch first)')).toBe(false);
  });
});

describe('the team\'s own repo, a fork too', () => {
  it('a fork is the team\'s own repo: the pull request stays in it, and squad-kit merges it', async () => {
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      return undefined;
    });
    expect(await host.contribution!()).toBeNull();
    expect(await host.openPullRequest({ source: 'squad/ap-1', target: 'main', title: 'Book a room', description: 'd', items: [] })).toMatchObject({ id: 7 });
    expect(gh.sent('POST', '/repos/me/app/pulls')[0]!.body).toMatchObject({ head: 'squad/ap-1', base: 'main' });
    expect(gh.calls.some((c) => c.path.startsWith('/repos/team/app'))).toBe(false);
  });

  it('opens the pull request into the base, finds it again by the owner GitHub names, and says where it stands', async () => {
    const host = await signedIn((c) => {
      // The account was renamed: GitHub's own name for it counts, not the old one in the remote's address.
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me-renamed/app') };
      if (route(c, 'GET', '/repos/me-renamed/app/pulls')) return { body: c.path.includes('state=open') ? [pullJson('me-renamed/app', 7)] : [] };
      if (route(c, 'POST', '/repos/me-renamed/app/pulls')) return { status: 201, body: pullJson('me-renamed/app', 7) };
      if (route(c, 'GET', '/repos/me-renamed/app/pulls/7')) return { body: pullJson('me-renamed/app', 7, { mergeable: false, mergeableState: 'dirty' }) };
      return undefined;
    });
    expect(await host.openPullRequest({ source: 'squad/ap-1', target: 'main', title: 'Book a room', description: 'Done when…', items: [] })).toEqual({ id: 7, url: 'https://github.com/me-renamed/app/pull/7' });
    expect(await host.findPullRequest('squad/ap-1')).toMatchObject({ id: 7 });
    expect(gh.sent('GET', '/repos/me-renamed/app/pulls?')[0]!.path).toContain('head=me-renamed%3Asquad%2Fap-1');
    expect(await host.mergeState(7)).toBe('clash');
    expect(await host.pushable!()).toBe(true);
  });

  it('one look: checks still running is a wait, not a merge; once they pass it merges with a merge commit and the branch goes', async () => {
    let running = true;
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, running ? { mergeableState: 'unstable' } : {}) };
      if (c.path.includes('/check-runs')) return { body: { check_runs: [{ name: 'test', status: running ? 'in_progress' : 'completed', conclusion: running ? null : 'success' }] } };
      if (c.path.endsWith('/status')) return { body: { statuses: [] } };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'abc123' } };
      if (route(c, 'DELETE', '/repos/me/app/git/refs/heads/squad/ap-1')) return { status: 204 };
      return undefined;
    });
    expect(await host.mergeState(7)).toBe('waiting');
    const wait = await host.merge(7, 'm').catch((e: unknown) => e as ModuleError);
    expect(wait).toMatchObject({ kind: 'waiting', message: 'Pull request 7 waits for its checks on GitHub (test).' });
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(0);
    running = false;
    expect(await host.mergeState(7)).toBe('mergeable');
    expect(await host.merge(7, 'Merge Book a room (AP-1)')).toEqual({ commit: 'abc123' });
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')[0]!.body).toEqual({ merge_method: 'merge', commit_title: 'Merge Book a room (AP-1)', sha: 'headsha' });
    expect(gh.sent('DELETE', '/repos/me/app/git/refs/heads/squad/ap-1')).toHaveLength(1);
  });

  it('a new pull request with no checks yet gets 2 minutes for them to appear before squad-kit merges it', async () => {
    // A fixed clock: the pull request's age is never read from the real time.
    const now = Date.parse('2026-11-13T12:00:00Z');
    let created = new Date(now - 30_000).toISOString();
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { createdAt: created }) };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'm1' } };
      return noChecks(c) ?? { status: 204 };
    });
    useMergePace({ stepMs: 0, graceMs: 2 * 60_000, sleep: async () => undefined, now: () => now });
    expect(await host.mergeState(7)).toBe('waiting');
    await expect(host.merge(7, 'm')).rejects.toMatchObject({ kind: 'waiting', message: 'Pull request 7 is new: squad-kit gives its checks a moment to start.' });
    created = new Date(now - 3 * 60_000).toISOString();
    expect(await host.merge(7, 'm')).toEqual({ commit: 'm1' });
  });

  it('a failed check and a draft are said plainly; a branch rule that wants a review is a wait; a clash is a clash', async () => {
    let pr = pullJson('me/app', 7);
    let runs = [{ name: 'lint', status: 'completed', conclusion: 'failure' }];
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pr };
      if (c.path.includes('/check-runs')) return { body: { check_runs: runs } };
      if (c.path.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    await expect(host.merge(7, 'm')).rejects.toMatchObject({ kind: 'other', message: expect.stringMatching(/GitHub's check "lint" failed on pull request 7/) });
    runs = [];
    pr = pullJson('me/app', 7, { mergeableState: 'blocked' });
    await expect(host.merge(7, 'm')).rejects.toMatchObject({ kind: 'waiting', message: expect.stringMatching(/waits for what the branch rule on main asks/) });
    expect(await host.mergeState(7)).toBe('waiting');
    pr = { ...pullJson('me/app', 7), draft: true } as typeof pr;
    await expect(host.merge(7, 'm')).rejects.toThrow('Pull request 7 is a draft on GitHub, so squad-kit does not merge it.');
    pr = pullJson('me/app', 7, { mergeable: false, mergeableState: 'dirty' });
    await expect(host.merge(7, 'm')).rejects.toMatchObject({ kind: 'clash' });
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(0);
  });

  it('behind a base the rule wants new: GitHub brings it in once; behind again is a plain stop, never a loop', async () => {
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/8')) return { body: pullJson('me/app', 8, { mergeableState: 'behind' }) };
      if (route(c, 'PUT', '/repos/me/app/pulls/8/update-branch')) return { status: 202, body: {} };
      return noChecks(c);
    });
    await expect(host.merge(8, 'm')).rejects.toMatchObject({ kind: 'waiting', message: 'GitHub is bringing the newest main into pull request 8, so its checks run again.' });
    await expect(host.merge(8, 'm')).rejects.toMatchObject({ kind: 'other', message: expect.stringMatching(/^main moved on GitHub again after squad-kit brought it into pull request 8 once/) });
    expect(gh.sent('PUT', '/repos/me/app/pulls/8/update-branch')).toHaveLength(1);
  });

  it("a repo the person can't push to says so, so the engine merges on the computer instead", async () => {
    const host = await signedIn((c) => (route(c, 'GET', '/repos/me/app') ? { body: repoJson('me/app', { push: false }) } : undefined));
    expect(await host.pushable!()).toBe(false);
    expect(await host.contribution!()).toBeNull();
  });
});

describe("squad-kit's own code: the pull request goes to the main repo", () => {
  it('into the upstream, as owner:branch into its default branch, and squad-kit never merges it', async () => {
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
        if (route(c, 'GET', '/repos/team/app')) return { body: repoJson('team/app', { push: false }) };
        if (route(c, 'POST', '/repos/team/app/pulls')) return { status: 201, body: pullJson('team/app', 31) };
        if (route(c, 'GET', '/repos/team/app/pulls/31')) return { body: pullJson('team/app', 31, { headRepo: 'me/app' }) };
        return noChecks(c);
      },
      'https://github.com/team/app',
      [['me/app', 'team/app']],
    );
    expect(await host.contribution!()).toEqual({ into: 'team/app', base: 'main' });
    expect(await host.openPullRequest({ source: 'squad/ap-1', target: 'develop', title: 'Book a room', description: 'd', items: [] })).toEqual({ id: 31, url: 'https://github.com/team/app/pull/31' });
    expect(gh.sent('POST', '/repos/team/app/pulls')[0]!.body).toMatchObject({ head: 'me:squad/ap-1', base: 'main', maintainer_can_modify: true });
    await expect(host.merge(31, 'm')).rejects.toThrow('Pull request 31 is in team/app: its owner merges it, never squad-kit.');
    expect(gh.sent('PUT', '/repos/team/app/pulls/31/merge')).toHaveLength(0);
  });

  it("a maintainer's own clone of the main repo: the pull request opens there, from its branch, and squad-kit never merges it", async () => {
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { push: true }) };
        if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 12) };
        return undefined;
      },
      'https://github.com/me/app.git',
    );
    expect(await host.contribution!()).toEqual({ into: 'me/app', base: 'main' });
    await host.openPullRequest({ source: 'squad/sk-1', target: 'main', title: 't', description: 'd', items: [] });
    expect(gh.sent('POST', '/repos/me/app/pulls')[0]!.body).toMatchObject({ head: 'squad/sk-1', base: 'main' });
    await expect(host.merge(12, 'm')).rejects.toThrow('Pull request 12 is in me/app: its owner merges it, never squad-kit.');
  });

  it('the upstream wins over GitHub\'s own parent, a copy of a copy too', async () => {
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'friend/app' }) };
        if (route(c, 'GET', '/repos/AzmSquad/app')) return { body: repoJson('AzmSquad/app') };
        return undefined;
      },
      'https://github.com/AzmSquad/app.git',
    );
    expect(await host.contribution!()).toEqual({ into: 'AzmSquad/app', base: 'main' });
  });

  it('GitHub refuses a pull request between repos that are not copies of each other', async () => {
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
        if (route(c, 'GET', '/repos/stranger/app')) return { body: repoJson('stranger/app') };
        return undefined;
      },
      'https://github.com/stranger/app',
    );
    await expect(host.openPullRequest({ source: 'b', target: 'main', title: 't', description: 'd', items: [] })).rejects.toThrow(/GitHub said 422: Validation Failed: head me:b is not in the same network/);
  });

  it("the owner's notes: only people with write access, never the person's own or a bot's; replies go to the thread's first note", async () => {
    const who = (login: string, a = 'NONE', type = 'User') => ({ user: { login, type }, author_association: a });
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
        if (route(c, 'GET', '/repos/team/app')) return { body: repoJson('team/app', { push: false }) };
        if (route(c, 'GET', '/user')) return { body: { login: 'me' } };
        if (route(c, 'GET', '/repos/team/app/collaborators/lead/permission')) return { body: { permission: 'write', role_name: 'maintain' } };
        if (route(c, 'GET', '/repos/team/app/collaborators/stranger/permission')) return { body: { permission: 'read', role_name: 'read' } };
        if (route(c, 'GET', '/repos/team/app/collaborators/old-member/permission')) return { status: 403, body: { message: 'Must have push access' } };
        if (route(c, 'GET', '/repos/team/app/pulls/31/comments'))
          return {
            body: [
              { id: 70, body: 'Why this name?', path: 'src/book.ts', line: 3, html_url: 'u0', created_at: '2026-11-13T10:00:00Z', ...who('stranger') },
              { id: 71, in_reply_to_id: 70, body: 'Use the shared date helper, @stranger.', path: 'src/book.ts', line: 3, html_url: 'u1', created_at: '2026-11-13T10:01:00Z', ...who('lead') },
              { id: 72, body: 'Fixed in abc.', path: 'src/book.ts', line: 3, html_url: 'u2', created_at: '2026-11-13T10:02:00Z', ...who('me') },
              { id: 73, body: 'Tidy this.', path: 'src/a.ts', line: 9, html_url: 'u3', created_at: '2026-11-13T10:03:00Z', ...who('old-member', 'MEMBER') },
            ],
          };
        if (route(c, 'GET', '/repos/team/app/pulls/31/reviews')) return { body: [{ id: 9, body: '', state: 'CHANGES_REQUESTED', html_url: 'r9', submitted_at: '2026-11-13T10:04:00Z', ...who('lead') }] };
        if (route(c, 'GET', '/repos/team/app/issues/31/comments')) return { body: [{ id: 5, body: 'CI says hi', html_url: 'c5', created_at: '2026-11-13T09:00:00Z', ...who('ci-bot', 'MEMBER', 'Bot') }] };
        if (c.method === 'POST') return { status: 201, body: { id: 99 } };
        return undefined;
      },
      'https://github.com/team/app',
    );
    const notes = await host.ownerNotes!(31);
    expect(notes.map((n) => [n.id, n.who, n.thread ?? null])).toEqual([
      ['line:71', 'lead', 'line:70'],
      ['line:73', 'old-member', null],
      ['review:9', 'lead', null],
    ]);
    // Asked once per person in one look.
    expect(gh.sent('GET', '/repos/team/app/collaborators/lead/permission')).toHaveLength(1);
    await host.answerNote!(31, notes[0]!, 'Fixed in 1a2b3c4.');
    await host.answerNote!(31, { id: 'comment:5', kind: 'comment', who: 'lead', text: 'Ping @someone about this' }, 'Fixed in 1a2b3c4.');
    expect(gh.sent('POST', '/repos/team/app/pulls/31/comments/70/replies')[0]!.body).toEqual({ body: 'Fixed in 1a2b3c4.' });
    // Quoting never pings anyone again.
    expect(gh.sent('POST', '/repos/team/app/issues/31/comments')[0]!.body).toEqual({ body: '> Ping @​someone about this\n\nFixed in 1a2b3c4.' });
  });

  it('reads every page of a long talk', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: 1000 + i, body: `Note ${i}.`, path: 'a.ts', line: i + 1, html_url: `u${i}`, created_at: `2026-11-13T10:${String(i % 60).padStart(2, '0')}:00Z`, user: { login: 'lead' }, author_association: 'OWNER' }));
    const host = await signedIn(
      (c) => {
        if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
        if (route(c, 'GET', '/repos/team/app')) return { body: repoJson('team/app', { push: false }) };
        if (route(c, 'GET', '/user')) return { body: { login: 'me' } };
        if (c.path.includes('/permission')) return { body: { permission: 'admin' } };
        if (route(c, 'GET', '/repos/team/app/pulls/31/comments')) return { body: c.path.includes('page=1&') || c.path.endsWith('page=1') ? many.slice(0, 100) : many.slice(100) };
        if (c.method === 'GET') return { body: [] };
        return undefined;
      },
      'https://github.com/team/app',
    );
    expect(await host.ownerNotes!(31)).toHaveLength(130);
    expect(gh.sent('GET', '/repos/team/app/pulls/31/comments').map((c) => c.path.split('?')[1])).toEqual(['per_page=100&page=1', 'per_page=100&page=2']);
  });
});

describe('the review in the pull request (ADR-007)', () => {
  it('a comment per note on its line, else on its file, else on the pull request; fixed ones resolved; written again, nothing doubles', async () => {
    const written: { id: number; body: string }[] = [];
    let next = 100;
    const host = await signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { merged: true, state: 'closed' }) };
      if (route(c, 'GET', '/repos/me/app/pulls/7/comments') || route(c, 'GET', '/repos/me/app/issues/7/comments')) return { body: written };
      if (route(c, 'POST', '/repos/me/app/pulls/7/comments')) {
        // Line 40 is not in the change; the whole file is.
        if (c.body!.line === 40) return { status: 422, body: { message: 'Validation Failed: line must be part of the diff' } };
        if (c.body!.path === 'gone.ts') return { status: 422, body: { message: 'Validation Failed: path could not be resolved' } };
        written.push({ id: next, body: String(c.body!.body) });
        return { status: 201, body: { id: next++ } };
      }
      if (route(c, 'POST', '/repos/me/app/issues/7/comments')) {
        written.push({ id: next, body: String(c.body!.body) });
        return { status: 201, body: { id: next++ } };
      }
      if (route(c, 'POST', '/graphql')) {
        const nodes = [100, 101].map((n) => ({ id: `T${n}`, isResolved: false, comments: { nodes: [{ databaseId: n }] } }));
        if (String(c.body!.query).startsWith('query')) return { body: { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } } };
        return { body: { data: { resolveReviewThread: { thread: { id: 'x' } } } } };
      }
      return undefined;
    });
    const review = {
      threads: [
        { key: 'AP-1#1', file: 'src/a.ts', line: 3, text: 'Name it clearly.\n\nFixed in `abc1234`', state: 'fixed' as const },
        { key: 'AP-1#2', file: 'src/a.ts', line: 40, text: 'A long function.\n\nOpen', state: 'open' as const },
        { key: 'AP-1#3', file: 'gone.ts', line: 1, text: 'Gone file.\n\nOpen', state: 'open' as const },
        { key: 'AP-1#4', text: 'The whole change.\n\nWent past. Later.', state: 'past' as const },
      ],
      approval: { key: 'AP-1#looks-right', text: '**Momen** pressed Looks right.' },
    };
    expect(await host.postReview!(7, review)).toEqual({ threads: 4 });
    const lines = gh.sent('POST', '/repos/me/app/pulls/7/comments');
    expect(lines.map((c) => [c.body!.path, c.body!.line ?? c.body!.subject_type, c.body!.side ?? null])).toEqual([
      ['src/a.ts', 3, 'RIGHT'],
      ['src/a.ts', 40, 'RIGHT'],
      ['src/a.ts', 'file', null],
      ['gone.ts', 1, 'RIGHT'],
      ['gone.ts', 'file', null],
    ]);
    expect(lines[0]!.body!.body).toContain('<!-- squad-kit:AP-1#1 -->');
    const issue = gh.sent('POST', '/repos/me/app/issues/7/comments').map((c) => String(c.body!.body));
    expect(issue[0]).toMatch(/^`gone.ts` line 1\n\nGone file\./);
    expect(issue[2]).toContain('pressed Looks right');
    // Only the fixed note's thread is resolved: the open one stays open.
    expect(gh.sent('POST', '/graphql').filter((c) => String(c.body!.query).startsWith('mutation')).map((c) => c.body!.variables)).toEqual([{ id: 'T100' }]);
    const before = gh.calls.filter((c) => c.method === 'POST').length;
    await host.postReview!(7, review);
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path !== '/graphql').length).toBe(before - 2);
  });
});

describe("your own copy (fork) of someone else's repo", () => {
  it('makes it and waits until GitHub has it ready; compares, syncs only forward, and fills in the new issue page', async () => {
    let ready = 0;
    let ahead = 0;
    undo.push(fakeGh('ready'));
    gh = fakeGitHub((c) => {
      if (route(c, 'POST', '/repos/AzmSquad/squad-kit/forks')) return { status: 202, body: repoJson('me/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (route(c, 'GET', '/repos/me/squad-kit')) return (ready += 1) < 2 ? { status: 404, body: { message: 'Not Found' } } : { body: repoJson('me/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (route(c, 'GET', '/repos/me/squad-kit/branches/main')) return { body: { name: 'main' } };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...me:main')) return { body: { ahead_by: ahead, behind_by: 4 } };
      if (route(c, 'POST', '/repos/me/squad-kit/merge-upstream')) return { body: { merge_type: 'fast-forward' } };
      return undefined;
    });
    const copy = await githubForks.makeFork('AzmSquad/squad-kit');
    expect(copy).toMatchObject({ repo: 'me/squad-kit', parent: 'AzmSquad/squad-kit', gitUrl: { https: 'https://github.com/me/squad-kit.git', ssh: 'git@github.com:me/squad-kit.git' } });
    expect(gh.sent('POST', '/repos/AzmSquad/squad-kit/forks')[0]!.body).toEqual({ default_branch_only: true });
    expect(await githubForks.compareFork('me/squad-kit', 'AzmSquad/squad-kit', 'main')).toEqual({ behind: 4, ahead: 0 });
    await githubForks.syncFork('me/squad-kit', 'main');
    expect(gh.sent('POST', '/repos/me/squad-kit/merge-upstream')[0]!.body).toEqual({ branch: 'main' });
    ahead = 2;
    await expect(githubForks.syncFork('me/squad-kit', 'main')).rejects.toThrow('main of your copy has 2 changes that AzmSquad/squad-kit does not have');
    expect(gh.sent('POST', '/repos/me/squad-kit/merge-upstream')).toHaveLength(1);
  });

  it('the new issue page is filled in, and a long idea is cut at a word to a safe length, saying so', () => {
    expect(githubForks.newIssuePage('AzmSquad/squad-kit', 'A design studio', 'Draw screens & export')).toEqual({ link: 'https://github.com/AzmSquad/squad-kit/issues/new?title=A+design+studio&body=Draw+screens+%26+export', cut: false });
    const long = githubForks.newIssuePage('AzmSquad/squad-kit', 'Big', 'word '.repeat(4000));
    expect(long.cut).toBe(true);
    expect(long.link.length).toBeLessThanOrEqual(6000);
    expect(decodeURIComponent(long.link.replace(/\+/g, ' '))).toContain('(The rest did not fit in this link. It is in squad-kit: paste it here before you send.)');
  });

  it('a repo whose owners allow no copies says so plainly', async () => {
    undo.push(fakeGh('ready'));
    gh = fakeGitHub((c) => (route(c, 'POST', '/repos/AzmSquad/private/forks') ? { status: 403, body: { message: 'Forking is disabled for this repository' } } : undefined));
    await expect(githubForks.makeFork('AzmSquad/private')).rejects.toMatchObject({ kind: 'other', message: 'GitHub did not make your copy of AzmSquad/private: Forking is disabled for this repository. Its owners may not allow copies of it.' });
  });
});
