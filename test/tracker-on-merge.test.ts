import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Contribution, MergeState, RepoHost } from '../src/modules/code-host/types.js';
import type { Tracker } from '../src/modules/tracker/types.js';
import { BOARD_ID, fakeGithub, type FakeGithub } from './fakes/github.js';

/**
 * A story's tracker item and its pull request: the text names the item as its tracker does and carries the tracker's
 * closing line, and the item closes only once the work is really merged. Its Status still moves at each step.
 */

let host: RepoHost | null = null;
let tracker: Tracker | null = null;
let hostState: MergeState = 'mergeable';
let mergeFails = false;
let checksRun = false;
let into: Contribution | null = null;
const texts: string[] = [];
function fakeHost(): RepoHost {
  return {
    host: 'example',
    label: 'Example Repos',
    repo: 'octo/shop',
    abilities: { attachImages: false },
    gitEnv: () => ({}),
    findPullRequest: async () => null,
    openPullRequest: async (input) => {
      texts.push(input.description);
      return { id: 7, url: 'https://code.example.test/pr/7' };
    },
    attachImage: async () => '',
    updateDescription: async () => undefined,
    mergeState: async () => hostState,
    merge: async () => {
      if (checksRun) throw new ModuleError('Pull request 7 is still waiting for its checks.', 'waiting');
      if (mergeFails) throw new Error('It waits for a required reviewer.');
      hostState = 'merged';
      return { commit: 'm1' };
    },
    close: async () => undefined,
    refusedPush: () => false,
    contribution: async () => into,
  };
}
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => host,
  trackerFor: () => tracker,
}));

const { boardPaths, requireTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { addWorktree } = await import('./support/copy.js');
const { recheckMerge } = await import('../src/engine/sync.js');
const { publishTicket } = await import('../src/engine/publish.js');
const { ModuleError } = await import('../src/modules/errors.js');
const { lookOutside } = await import('../src/engine/merged-outside.js');
const { lookAtContribution } = await import('../src/engine/contribution/look.js');
const { GithubTracker } = await import('../src/modules/github/tracker.js');

let tmp = '';
let project = '';
let bp: ReturnType<typeof boardPaths>;
let fake: FakeGithub;
const S40 = 'octo/shop#40';
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  host = fakeHost();
  hostState = 'mergeable';
  mergeFails = false;
  checksRun = false;
  into = null;
  texts.length = 0;
  fake = fakeGithub();
  tracker = new GithubTracker(fake.calls, {
    repo: 'octo/shop',
    from: 'project',
    labels: [],
    board: { owner: 'octo', number: 2, id: BOARD_ID, title: 'Shop board' },
    stages: {},
    anyone: false,
    readOnly: false,
  });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tracker-merge-')));
  const remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'a.ts'), 'export const a = 1;\n');
  sh('git add -A && git commit -qm start', project);
  sh(`git remote add origin ${remote} && git push -q origin main`, project);
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
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A story pulled from issue #40, built and accepted, ready to go out by pull request. */
function accepted(): string {
  const t = actions.createTicket(bp, { title: 'Hold a slot', source: { type: 'github', ref: '#40', id: S40 } });
  const wt = addWorktree(project, t.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'a.ts'), 'export const a = 2;\n');
  sh('git add -A && git commit -qm build', wt.dir);
  updateTicket(bp, t.id, (x) => {
    x.stage = 'release';
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
  });
  return t.id;
}

const issue = () => fake.issues.get(S40)!;
const status = () => fake.items.find((i) => i.issue === S40)?.status;

describe("a GitHub-tracked story's pull request", () => {
  it('names the item as the tracker does, and closes it with "Closes #40" into its own repo', async () => {
    await publishTicket(bp, accepted());
    expect(texts[0]).toContain('Work item: #40\nCloses #40\n');
    // squad-kit merged it: the work is in, so the issue is closed and its Status moved.
    expect(issue().state).toBe('closed');
    expect(status()).toBe('Done');
  });

  it('a pull request that waits for an approver moves the Status but leaves the issue open, until it merges', async () => {
    mergeFails = true;
    hostState = 'waiting';
    const id = accepted();
    await publishTicket(bp, id);
    expect(status()).toBe('Done');
    expect(issue().state).toBe('open');
    expect(fake.comments.get(S40)?.at(-1)).toContain('waiting to be merged');
    // Approved and merged on the code host: squad-kit sees it, and the issue closes now.
    hostState = 'merged';
    expect((await lookOutside(bp)).merged).toEqual([id]);
    expect(issue().state).toBe('closed');
    expect(fake.comments.get(S40)?.at(-1)).toContain('Merged into **main** by pull request [7]');
  });

  it('a pull request that waits for its checks stays open on GitHub until the squad merges it later', async () => {
    checksRun = true;
    const id = accepted();
    await publishTicket(bp, id);
    expect(status()).toBe('Done');
    expect(issue().state).toBe('open');
    // The checks passed: the squad's next look merges it, and the issue closes.
    checksRun = false;
    expect(await recheckMerge(bp, id)).toBe('merged');
    expect(issue().state).toBe('closed');
  });

  it('a story that builds by itself closes its issue when its waiting pull request merges', async () => {
    mergeFails = true;
    hostState = 'waiting';
    const id = accepted();
    updateTicket(bp, id, (x) => (x.track = 'auto'));
    await publishTicket(bp, id);
    expect(issue().state).toBe('open');
    hostState = 'merged';
    expect(await recheckMerge(bp, id)).toBe('merged');
    expect(issue().state).toBe('closed');
  });

  it("a pull request to another owner's repo says Closes owner/repo#40, and the issue closes only when the owner merges", async () => {
    into = { into: 'upstream/shop', base: 'main' } as Contribution;
    const id = accepted();
    await publishTicket(bp, id);
    expect(texts[0]).toContain('Work item: #40\nCloses octo/shop#40\n');
    expect(requireTicket(bp, id).contribution?.state).toBe('waiting');
    expect(status()).toBe('Done');
    expect(issue().state).toBe('open');
    hostState = 'merged';
    expect((await lookAtContribution(bp, id)).found).toBe('merged');
    expect(issue().state).toBe('closed');
    expect(fake.comments.get(S40)?.at(-1)).toContain('Merged into **main of upstream/shop**');
  });

  it('a tracker that only reads (set up before) adds no closing line', async () => {
    tracker = new GithubTracker(fake.calls, { repo: 'octo/shop', from: 'issues', labels: [], stages: {}, anyone: false, readOnly: true });
    await publishTicket(bp, accepted());
    expect(texts[0]).toContain('Work item: #40\n\n');
    expect(issue().state).toBe('open');
  });
});
