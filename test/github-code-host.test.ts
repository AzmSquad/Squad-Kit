import { describe, it, expect, afterEach } from 'vitest';
import { githubCodeHost } from '../src/modules/github/code-host.js';
import { githubForks } from '../src/modules/github/forks.js';
import { ghSignIn } from '../src/modules/github/sign-in.js';
import { ModuleError } from '../src/modules/errors.js';
import { CODE_HOSTS, forkHostFor } from '../src/modules/registry.js';
import type { RepoHost } from '../src/modules/code-host/types.js';
import { fakeGh, fakeGitHub, pullJson, repoJson, type Answer, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * GitHub as a code host (ADR-008), with GitHub's REST made up: the person's own repo (open, wait for the checks, merge,
 * the branch goes), a copy of someone else's repo (the pull request goes there, and squad-kit never merges it), the
 * review written as comments on lines (ADR-007), the owner's notes and the answers, and the person's own copy (fork).
 */

let undo: (() => void)[] = [];
let gh: FakeGitHub;

afterEach(() => {
  gh?.done();
  for (const u of undo.reverse()) u();
  undo = [];
});

function signedIn(answer: (c: Call) => Answer): RepoHost {
  undo.push(fakeGh('ready'));
  gh = fakeGitHub(answer);
  return githubCodeHost.repoFor('/tmp/x', 'https://github.com/me/app.git')!;
}

const route = (c: Call, method: string, path: string) => c.method === method && c.path.split('?')[0] === path;

describe('the sign-in, through GitHub\'s own tool', () => {
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
    const host = signedIn((c) => (route(c, 'GET', '/user') ? { body: { login: 'me' } } : undefined));
    expect(host.repo).toBe('me/app');
    expect(githubCodeHost.repoFor('/tmp/x', 'https://dev.azure.com/o/p/_git/r')).toBeNull();
    expect(await ghSignIn()).toMatchObject({ state: 'ready', account: 'me' });
    expect(CODE_HOSTS.map((m) => m.name)).toContain('github');
    expect(forkHostFor('https://github.com/me/app')?.label).toBe('GitHub');
  });

  it("git push signs in through gh's credential helper, and no token is in its environment", () => {
    const host = signedIn(() => undefined);
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

  it('a protected branch refusing the push is known', () => {
    const host = signedIn(() => undefined);
    expect(host.refusedPush('remote: error: GH006: Protected branch update failed for refs/heads/main.')).toBe(true);
    expect(host.refusedPush('! [rejected] main -> main (fetch first)')).toBe(false);
  });
});

describe('your own repo', () => {
  it('opens the pull request into the base, finds it again by owner:branch, and says where it stands', async () => {
    const host = signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: c.path.includes('state=open') ? [pullJson('me/app', 7)] : [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { mergeable: false, mergeableState: 'dirty' }) };
      return undefined;
    });
    expect(await host.contribution!()).toBeNull();
    expect(await host.openPullRequest({ source: 'squad/ap-1', target: 'main', title: 'Book a room', description: 'Done when…', items: [] })).toEqual({ id: 7, url: 'https://github.com/me/app/pull/7' });
    expect(gh.sent('POST', '/repos/me/app/pulls')[0]!.body).toMatchObject({ head: 'squad/ap-1', base: 'main', title: 'Book a room' });
    expect(await host.findPullRequest('squad/ap-1')).toMatchObject({ id: 7 });
    expect(gh.sent('GET', '/repos/me/app/pulls?')[0]!.path).toContain('head=me%3Asquad%2Fap-1');
    expect(await host.mergeState(7)).toBe('clash');
  });

  it('waits while the checks run, then merges with a merge commit and deletes the branch', async () => {
    let looks = 0;
    const host = signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) {
        looks += 1;
        return { body: pullJson('me/app', 7, looks < 3 ? { mergeableState: 'unstable' } : {}) };
      }
      if (route(c, 'GET', '/repos/me/app/commits/headsha/check-runs')) return { body: { check_runs: [{ name: 'test', status: looks < 3 ? 'in_progress' : 'completed', conclusion: looks < 3 ? null : 'success' }] } };
      if (route(c, 'GET', '/repos/me/app/commits/headsha/status')) return { body: { statuses: [] } };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'abc123' } };
      if (route(c, 'DELETE', '/repos/me/app/git/refs/heads/squad/ap-1')) return { status: 204 };
      return undefined;
    });
    expect(await host.merge(7, 'Merge Book a room (AP-1)')).toEqual({ commit: 'abc123' });
    expect(looks).toBe(3);
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')[0]!.body).toEqual({ merge_method: 'merge', commit_title: 'Merge Book a room (AP-1)', sha: 'headsha' });
    expect(gh.sent('DELETE', '/repos/me/app/git/refs/heads/squad/ap-1')).toHaveLength(1);
  });

  it('a failed check, a clash and a branch rule that wants a review are said plainly, and nothing merges', async () => {
    let pr = pullJson('me/app', 7);
    let runs = [{ name: 'lint', status: 'completed', conclusion: 'failure' }];
    const host = signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pr };
      if (route(c, 'GET', '/repos/me/app/commits/headsha/check-runs')) return { body: { check_runs: runs } };
      if (route(c, 'GET', '/repos/me/app/commits/headsha/status')) return { body: { statuses: [] } };
      return undefined;
    });
    await expect(host.merge(7, 'm')).rejects.toThrow(/GitHub's check "lint" failed on pull request 7/);
    runs = [];
    pr = pullJson('me/app', 7, { mergeableState: 'blocked' });
    await expect(host.merge(7, 'm')).rejects.toThrow(/branch rule on main asks for more.*never goes around it/);
    pr = pullJson('me/app', 7, { mergeable: false, mergeableState: 'dirty' });
    const clash = await host.merge(7, 'm').catch((e: unknown) => e);
    expect(clash).toBeInstanceOf(ModuleError);
    expect((clash as ModuleError).kind).toBe('clash');
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/merge')).toHaveLength(0);
  });

  it('behind a base that the branch rule wants new: GitHub brings the base in first, then it merges', async () => {
    let updated = false;
    const host = signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, updated ? {} : { mergeableState: 'behind' }) };
      if (c.path.includes('/commits/headsha/')) return { body: { check_runs: [], statuses: [] } };
      if (route(c, 'PUT', '/repos/me/app/pulls/7/update-branch')) {
        updated = true;
        return { status: 202, body: {} };
      }
      if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) return { body: { merged: true, sha: 'm1' } };
      return { status: 204 };
    });
    expect(await host.merge(7, 'm')).toEqual({ commit: 'm1' });
    expect(gh.sent('PUT', '/repos/me/app/pulls/7/update-branch')[0]!.body).toEqual({ expected_head_sha: 'headsha' });
  });

  it('still waiting when the time is up: not merged, and said so', async () => {
    const host = signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { mergeableState: 'unstable' }) };
      if (c.path.includes('/check-runs')) return { body: { check_runs: [{ name: 'e2e', status: 'queued', conclusion: null }] } };
      if (c.path.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    const at = Date.now;
    let t = 0;
    Date.now = () => at() + (t += 30);
    try {
      await expect(host.merge(7, 'm')).rejects.toThrow('Pull request 7 is still waiting on GitHub for its checks (e2e), so it is not merged yet.');
    } finally {
      Date.now = at;
    }
  });
});

describe("a copy of someone else's repo", () => {
  const fork = (extra: (c: Call) => Answer = () => undefined) =>
    signedIn((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app', { fork: 'team/app' }) };
      if (route(c, 'POST', '/repos/team/app/pulls')) return { status: 201, body: pullJson('team/app', 31) };
      if (route(c, 'GET', '/repos/team/app/pulls/31')) return { body: pullJson('team/app', 31, { headRepo: 'me/app' }) };
      return extra(c);
    });

  it('sends the pull request to the repo it came from, as owner:branch into its default branch, and never merges it', async () => {
    const host = fork();
    expect(await host.contribution!()).toEqual({ into: 'team/app', base: 'main' });
    expect(await host.openPullRequest({ source: 'squad/ap-1', target: 'develop', title: 'Book a room', description: 'd', items: [] })).toEqual({ id: 31, url: 'https://github.com/team/app/pull/31' });
    expect(gh.sent('POST', '/repos/team/app/pulls')[0]!.body).toMatchObject({ head: 'me:squad/ap-1', base: 'main', maintainer_can_modify: true });
    expect(await host.mergeState(31)).toBe('mergeable');
    await expect(host.merge(31, 'm')).rejects.toThrow('Pull request 31 is in team/app: its owner merges it, never squad-kit.');
    expect(gh.sent('PUT', '/repos/team/app/pulls/31/merge')).toHaveLength(0);
  });

  it("squad-kit's own code with an upstream remote sends it there too", async () => {
    undo.push(fakeGh('ready'));
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/squad-kit')) return { body: repoJson('me/squad-kit') };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit')) return { body: repoJson('AzmSquad/squad-kit', { push: false }) };
      return undefined;
    });
    const host = githubCodeHost.repoFor('/tmp/x', 'https://github.com/me/squad-kit.git', 'https://github.com/AzmSquad/squad-kit.git')!;
    expect(await host.contribution!()).toEqual({ into: 'AzmSquad/squad-kit', base: 'main' });
  });

  it("the main repo itself, with no right to push: make your own copy first", async () => {
    const host = signedIn((c) => (route(c, 'GET', '/repos/me/app') ? { body: repoJson('me/app', { push: false }) } : undefined));
    await expect(host.contribution!()).rejects.toThrow("You can't send changes to me/app itself. Make your own copy of it (a fork) on GitHub first");
  });

  it("the owner's notes: only people who can change the repo, never the signed-in person's own or a bot's", async () => {
    const who = (login: string, a = 'OWNER', type = 'User') => ({ user: { login, type }, author_association: a });
    const host = fork((c) => {
      if (route(c, 'GET', '/user')) return { body: { login: 'me' } };
      if (route(c, 'GET', '/repos/team/app/pulls/31/comments'))
        return {
          body: [
            { id: 1, body: 'Use the shared date helper here.', path: 'src/book.ts', line: 12, html_url: 'u1', created_at: '2026-11-13T10:01:00Z', ...who('lead') },
            { id: 2, body: 'Fixed in abc.', path: 'src/book.ts', line: 12, html_url: 'u2', created_at: '2026-11-13T10:02:00Z', ...who('me', 'CONTRIBUTOR') },
            { id: 3, body: 'Drive-by', path: 'src/book.ts', line: 3, html_url: 'u3', created_at: '2026-11-13T10:03:00Z', ...who('stranger', 'NONE') },
          ],
        };
      if (route(c, 'GET', '/repos/team/app/pulls/31/reviews'))
        return {
          body: [
            { id: 9, body: '', state: 'CHANGES_REQUESTED', html_url: 'r9', submitted_at: '2026-11-13T10:04:00Z', ...who('lead') },
            { id: 10, body: 'Looks good', state: 'APPROVED', html_url: 'r10', submitted_at: '2026-11-13T10:05:00Z', ...who('lead') },
          ],
        };
      if (route(c, 'GET', '/repos/team/app/issues/31/comments')) return { body: [{ id: 5, body: 'CI says hi', html_url: 'c5', created_at: '2026-11-13T10:00:00Z', ...who('ci-bot', 'MEMBER', 'Bot') }] };
      if (c.method === 'POST') return { status: 201, body: { id: 99 } };
      return undefined;
    });
    const notes = await host.ownerNotes!(31);
    expect(notes).toEqual([
      { id: 'line:1', kind: 'line', who: 'lead', text: 'Use the shared date helper here.', file: 'src/book.ts', line: 12, url: 'u1', at: '2026-11-13T10:01:00Z' },
      { id: 'review:9', kind: 'review', who: 'lead', text: 'Asked for changes.', url: 'r9', at: '2026-11-13T10:04:00Z', changes: true },
    ]);
    await host.answerNote!(31, notes[0]!, 'Fixed in 1a2b3c4.');
    await host.answerNote!(31, notes[1]!, 'Fixed in 1a2b3c4.');
    expect(gh.sent('POST', '/repos/team/app/pulls/31/comments/1/replies')[0]!.body).toEqual({ body: 'Fixed in 1a2b3c4.' });
    expect(gh.sent('POST', '/repos/team/app/issues/31/comments')[0]!.body).toEqual({ body: '> Asked for changes.\n\nFixed in 1a2b3c4.' });
  });
});

describe('the review in the pull request (ADR-007)', () => {
  it('a comment per note on its line, else on its file, else on the pull request; fixed ones resolved; written again, nothing doubles', async () => {
    const written: { id: number; body: string }[] = [];
    let next = 100;
    const host = signedIn((c) => {
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
    expect(githubForks.newIssuePage('AzmSquad/squad-kit', 'A design studio', 'Draw screens & export')).toBe('https://github.com/AzmSquad/squad-kit/issues/new?title=A+design+studio&body=Draw+screens+%26+export');
  });

  it('a repo whose owners allow no copies says so plainly', async () => {
    undo.push(fakeGh('ready'));
    gh = fakeGitHub((c) => (route(c, 'POST', '/repos/AzmSquad/private/forks') ? { status: 403, body: { message: 'Forking is disabled for this repository' } } : undefined));
    await expect(githubForks.makeFork('AzmSquad/private')).rejects.toThrow('GitHub did not make your copy of AzmSquad/private: Forking is disabled for this repository. Its owners may not allow copies of it.');
  });
});
