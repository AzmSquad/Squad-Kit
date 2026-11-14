import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RepoHost } from '../src/modules/code-host/types.js';
import type { Ticket } from '../src/board/types.js';

/**
 * A code host whose sign-in gives short-lived tokens (ADR-011): a release asks for git's sign-in right before each
 * push, never once at the start, so a long release never pushes with a token that ended on the way. Here each answer of
 * the host's gitEnv() is a new value (a git trace file of its own), and real git shows which push got which.
 */

let tmp = '';
let hostOn = false;
let asked = 0;
const host: RepoHost = {
  host: 'example',
  label: 'Example Repos',
  repo: 'app',
  abilities: { attachImages: false },
  gitEnv: async () => {
    asked++;
    return { GIT_TRACE: path.join(tmp, `sign-in-${asked}.log`) };
  },
  findPullRequest: async () => null,
  openPullRequest: async () => ({ id: 7, url: 'https://code.example.test/pr/7' }),
  attachImage: async () => '',
  updateDescription: async () => undefined,
  mergeState: async () => 'mergeable',
  merge: async () => ({ commit: '' }),
  close: async () => undefined,
  refusedPush: () => false,
};
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => (hostOn ? host : null),
}));

const { boardPaths, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-fresh-sign-in-')));
  hostOn = false;
  asked = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a release with a short-lived code host sign-in', () => {
  it('asks for it right before each push: the base and the tag each get the newest one', async () => {
    const project = path.join(tmp, 'app');
    const remote = path.join(tmp, 'remote.git');
    fs.mkdirSync(project);
    sh(`git init -q --bare -b main ${remote}`, tmp);
    sh(`git init -q -b main && git remote add origin ${remote}`, project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.4.2' }, null, 2));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start && git push -q origin main', project);
    const bp = boardPaths(path.join(project, '.squad'));
    writeMeta(bp, {
      project: 'App',
      key: 'AP',
      nextNumber: 2,
      engine: 'live',
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
    const wt = addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(wt.dir, 'one.txt'), 'one\n');
    const t: Ticket = {
      id: 'AP-1',
      title: 'Add one',
      ask: '',
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'review',
      status: '',
      waiting: { kind: 'proof', summary: '' },
      createdAt: new Date().toISOString(),
      createdBy: 'Momen',
      activity: [],
      worktree: wt.dir,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    };
    writeTicket(bp, t);
    // Merged here first, with no code host; the host's sign-in counts from the release on.
    actions.approve(bp, 'AP-1');
    hostOn = true;
    const r = await actions.releaseVersion(bp, 'v1.5.0');
    expect(sh('git rev-parse refs/tags/v1.5.0', remote)).toBeTruthy();
    expect(r.unpushed ?? []).toEqual([]);
    // Which sign-in each push went out with: the trace file of the gitEnv() answer it got.
    const pushedWith = (what: RegExp) =>
      fs
        .readdirSync(tmp)
        .filter((f) => /^sign-in-\d+\.log$/.test(f) && what.test(fs.readFileSync(path.join(tmp, f), 'utf8')))
        .map((f) => Number(/\d+/.exec(f)![0]));
    const base = pushedWith(/push origin \S+:refs\/heads\/main/);
    const tag = pushedWith(/push origin refs\/tags\/v1\.5\.0/);
    expect(base).toHaveLength(1);
    expect(tag).toHaveLength(1);
    // Each push asked anew, and the tag, sent last, got the newest of all.
    expect(tag[0]).toBeGreaterThan(base[0]!);
    expect(tag[0]).toBe(asked);
  });
});
