import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { MergeState, RepoHost } from '../src/modules/code-host/types.js';

/**
 * Builds by itself, after the squad's own accept: a pull request that waits for its approver, or a merge that could
 * not move the person's own checkout, is looked at again on a timer. Once the code host merged it (or the checkout is
 * free), the story is merged here too and the next stories start.
 */

/** What the code host says about the pull request, one answer per look. */
const states: MergeState[] = [];
const host: RepoHost = {
  host: 'example',
  label: 'Example Repos',
  repo: 'app',
  abilities: { attachImages: false },
  gitEnv: () => ({}),
  findPullRequest: async () => null,
  openPullRequest: async () => ({ id: 7, url: 'https://code.example.test/pr/7' }),
  attachImage: async () => '',
  updateDescription: async () => undefined,
  mergeState: async () => states.shift() ?? 'waiting',
  merge: async () => ({ commit: '' }),
  close: async () => undefined,
  refusedPush: () => false,
};
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => host,
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { mergeWait } = await import('../src/board/auto.js');
const { recheckMerge } = await import('../src/engine/sync.js');
const { addWorktree } = await import('./support/copy.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);

beforeEach(() => {
  states.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-merge-wait-')));
  const remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'fee.txt'), 'fee = 500\n');
  commit(project, 'start');
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

const STORY = { id: 'BR-1', item: 'S-12', story: 'As a lawyer, I want the fee refunded when a hearing is cancelled.', criteria: [{ given: 'a paid hearing', when: 'it is cancelled', then: 'the fee goes back' }], approvedBy: 'Momen' };

/** A story the squad accepted: its pull request is open and waits for a person to approve it. */
function waitingPr(track: 'auto' | 'full' = 'auto'): string {
  const t = track === 'auto' ? actions.createTicket(bp, { title: 'Refund the fee', fromBreakdown: STORY }) : actions.createTicket(bp, { title: 'Refund the fee' });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'release';
    x.release = 'v0.1.0';
    x.live = false;
    x.squad = null;
    x.branch = `squad/${t.id.toLowerCase()}`;
    x.pr = { id: 7, url: 'https://code.example.test/pr/7', repo: 'app', host: 'example' };
    x.status = 'Waits for someone to approve the pull request';
  });
  return t.id;
}

describe('a pull request that waits for its approver', () => {
  it('is asked about again, and merges here once the code host merged it', async () => {
    const id = waitingPr();
    expect(mergeWait(readTicket(bp, id))).toBe('pr');
    states.push('waiting');
    expect(await recheckMerge(bp, id)).toBe('waiting');
    expect(readTicket(bp, id)!.mergedAt).toBeUndefined();
    // Someone approved and completed it on the code host.
    states.push('merged');
    expect(await recheckMerge(bp, id)).toBe('merged');
    const t = readTicket(bp, id)!;
    expect(t.mergedAt).toBeTruthy();
    expect(t.status).toBe('Merged into main · goes out in v0.1.0');
    expect(t.activity[0]!.text).toBe('Pull request 7 was approved and merged on Example Repos');
    expect(mergeWait(t)).toBeNull();
    // Looked at again, nothing more happens.
    expect(await recheckMerge(bp, id)).toBe('waiting');
  });

  it('a merge a network blip cut off is asked again, when the host says it can merge', async () => {
    const id = waitingPr();
    states.push('mergeable');
    expect(await recheckMerge(bp, id)).toBe('merged');
    expect(readTicket(bp, id)!.mergedAt).toBeTruthy();
  });

  it('says when newer work clashes with it, and leaves other tracks alone', async () => {
    const id = waitingPr();
    states.push('clash');
    expect(await recheckMerge(bp, id)).toBe('clash');
    const full = waitingPr('full');
    expect(mergeWait(readTicket(bp, full))).toBeNull();
    states.push('merged');
    expect(await recheckMerge(bp, full)).toBe('waiting');
    expect(readTicket(bp, full)!.mergedAt).toBeUndefined();
  });

  it('is looked at by the live squad on its turn, beside the work', async () => {
    const id = waitingPr();
    states.push('merged');
    const squad = new LiveSquad(bp) as unknown as { tick(): void; ticketsRunning(): number };
    squad.tick();
    expect(squad.ticketsRunning()).toBe(0);
    for (let i = 0; i < 100 && !readTicket(bp, id)!.mergedAt; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(readTicket(bp, id)!.mergedAt).toBeTruthy();
  });
});

describe('a merge that could not move the checkout', () => {
  it('goes in once the person’s own copy is free of changes in the same files', async () => {
    const t = actions.createTicket(bp, { title: 'Refund the fee', fromBreakdown: STORY });
    const wt = addWorktree(project, t.id, 'main');
    fs.writeFileSync(path.join(wt.dir, 'fee.txt'), 'fee = 500\nrefund = full\n');
    commit(wt.dir, 'refund');
    // The person is editing the same file in their own checkout of main.
    fs.writeFileSync(path.join(project, 'fee.txt'), 'fee = 600\n');
    updateTicket(bp, t.id, (x) => {
      x.stage = 'release';
      x.release = 'v0.1.0';
      x.live = false;
      x.squad = null;
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.status = 'Waits to merge: your own copy of the code has changes in the same files';
    });
    expect(mergeWait(readTicket(bp, t.id))).toBe('checkout');
    expect(await recheckMerge(bp, t.id)).toBe('waiting');
    expect(readTicket(bp, t.id)!.mergedAt).toBeUndefined();
    // They put their change aside: the merge goes in on the next look.
    sh('git checkout -- fee.txt', project);
    expect(await recheckMerge(bp, t.id)).toBe('merged');
    expect(readTicket(bp, t.id)!.activity[0]!.text).toBe('Merged into main: your own copy of main was free again');
    expect(fs.readFileSync(path.join(project, 'fee.txt'), 'utf8')).toContain('refund = full');
  });
});
