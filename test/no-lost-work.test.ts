import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, draftRelease, readRelease, readTicket, writeMeta, writeRelease, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import * as actions from '../src/board/actions.js';
import { releaseGoingOut } from '../src/board/lock.js';
import { MergeClash, addWorktree as makeCopyOf, mergeIntoBase } from '../src/engine/git.js';
import { addWorktree } from './support/copy.js';
import { LiveSquad } from '../src/engine/live.js';
import { checkGitVersion } from '../src/commands/doctor-engine.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { buildPaths } from '../src/core/paths.js';

/**
 * No lost work: a ticket accepted while a release goes out stays in main and goes out next time; a push that fails
 * keeps the release open; "the newest code" is the team's; and only a real clash is called one.
 */

let tmp: string;
let project: string;
let remote: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);
const contains = (cwd: string, a: string, b: string) => {
  try {
    sh(`git merge-base --is-ancestor ${a} ${b}`, cwd);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lost-'));
  project = path.join(tmp, 'app');
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(project);
  sh(`git init -q --bare -b main ${remote}`, tmp);
  sh(`git init -q -b main && git remote add origin ${remote}`, project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.4.2' }, null, 2));
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  commit(project, 'start');
  sh('git push -q origin main', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 9,
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
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket whose proof waits for you, with one file changed in its copy. */
function proofReady(id: string, file: string, text: string, extra: Partial<Ticket> = {}): Ticket {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, file), text);
  const t: Ticket = {
    id,
    title: `Add ${file}`,
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: 'Proof ready to check',
    waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    ...extra,
  };
  writeTicket(bp, t);
  return t;
}

/** Someone else pushes to the remote's main from their own clone. */
function teammatePushes(file: string, text: string): string {
  const other = path.join(tmp, `other-${file}`);
  sh(`git clone -q ${remote} ${other}`, tmp);
  fs.writeFileSync(path.join(other, file), text);
  commit(other, `teammate adds ${file}`);
  sh('git push -q origin main', other);
  return sh('git rev-parse HEAD', other);
}

describe('a release and "Looks right" at the same time', () => {
  it.each([
    ['your checkout is on main', false],
    ['your checkout is on another branch', true],
  ])('a ticket accepted while the release goes out stays in main and goes out next time (%s)', async (_, elsewhere) => {
    if (elsewhere) sh('git checkout -q -b my-work', project);
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    proofReady('AP-2', 'two.txt', 'two\n');

    // The release runs up to its first wait (the push is done, main not moved yet); then you press Looks right.
    const going = actions.releaseVersion(bp);
    expect(releaseGoingOut(bp)).toBe('v1.5.0');
    const accepted = actions.approve(bp, 'AP-2');
    expect(accepted.release).toBe('v1.6.0');
    expect(accepted.mergedAt).toBeTruthy();
    const mergedTwo = sh('git rev-parse main', project);

    const release = await going;
    expect(releaseGoingOut(bp)).toBeNull();
    expect(release.tickets).toEqual(['AP-1']);
    expect(readRelease(bp, 'v1.5.0')).toMatchObject({ status: 'released', tickets: ['AP-1'] });
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done', status: 'Released in v1.5.0' });
    // Not dropped: AP-2 waits in the next release.
    expect(draftRelease(bp)).toMatchObject({ version: 'v1.6.0', from: 'v1.5.0', tickets: ['AP-2'] });
    expect(readTicket(bp, 'AP-2')).toMatchObject({ stage: 'release', release: 'v1.6.0' });
    // Not taken out of main: main has AP-2 and the release.
    expect(contains(project, mergedTwo, 'main')).toBe(true);
    expect(contains(project, 'v1.5.0', 'main')).toBe(true);
    expect(sh('git show main:two.txt', project)).toBe('two');
    expect(release.log?.some((l) => l.ok && /accepted while the release went out, so the release was merged into it/.test(l.text))).toBe(true);
    // The remote got the release itself, not AP-2.
    expect(sh('git rev-parse main', remote)).toBe(sh('git rev-parse v1.5.0^{commit}', project));
    if (!elsewhere) expect(fs.readFileSync(path.join(project, 'two.txt'), 'utf8')).toBe('two\n');
  }, 30_000);

  it('a ticket written into the release while it goes out is not dropped or marked released: it waits for the next one', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const going = actions.releaseVersion(bp);
    // As a squad-kit that does not know the lock would: straight into the release that is going out.
    const r = readRelease(bp, 'v1.5.0')!;
    writeRelease(bp, { ...r, tickets: [...r.tickets, 'AP-2'] });
    proofReady('AP-2', 'two.txt', 'two\n', { stage: 'release', waiting: null, release: 'v1.5.0', status: 'Ready for v1.5.0' });
    await going;
    expect(readRelease(bp, 'v1.5.0')!.tickets).toEqual(['AP-1']);
    expect(draftRelease(bp)).toMatchObject({ version: 'v1.6.0', tickets: ['AP-2'] });
    expect(readTicket(bp, 'AP-2')).toMatchObject({ stage: 'release', release: 'v1.6.0', status: 'Ready for v1.6.0' });
  }, 30_000);

  it('one release at a time', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const going = actions.releaseVersion(bp);
    await expect(actions.releaseVersion(bp, 'v1.5.0')).rejects.toThrow('v1.5.0 is going out right now. Wait for it to finish.');
    await going;
    expect(releaseGoingOut(bp)).toBeNull();
  }, 30_000);
});

describe('a push that fails keeps the release open', () => {
  it('keeps the tickets and the tracker item open until Push again sends it', async () => {
    proofReady('AP-1', 'one.txt', 'one\n', { source: { type: 'azure', id: '35', ref: 'AB#35' } });
    actions.approve(bp, 'AP-1');
    sh(`git remote set-url origin ${path.join(tmp, 'gone.git')}`, project);

    const release = await actions.releaseVersion(bp);
    expect(release.status).toBe('released');
    expect(release.unpushed).toEqual([{ repo: '.', remote: 'origin', base: 'main', commit: expect.any(String), tag: 'v1.5.0', error: expect.stringMatching(/git push failed/), plain: expect.stringMatching(/could not reach your team's shared copy of the code/) }]);
    expect(release.log?.find((l) => !l.ok)?.text).toMatch(/could not reach your team's shared copy of the code, so the release is only on this computer\..*squad release v1\.5\.0 --push-again/);
    const head = release.unpushed![0]!.commit;
    // Kept on this computer only, like the log.
    expect(readRelease(bp, 'v1.5.0')!.unpushed).toHaveLength(1);
    expect(fs.readFileSync(path.join(bp.releasesDir, 'v1.5.0.md'), 'utf8')).not.toContain('unpushed');
    // The next tickets still build on the release.
    expect(sh('git rev-parse main', project)).toBe(head);
    let t = readTicket(bp, 'AP-1')!;
    expect(t).toMatchObject({ stage: 'release', status: 'In v1.5.0 · not sent yet' });
    expect(t.trackerQueue ?? []).not.toContainEqual({ kind: 'released', version: 'v1.5.0' });

    // Still unreachable: it stays open, with git's new reason.
    const again = await actions.pushReleaseAgain(bp, 'v1.5.0');
    expect(again.unpushed?.[0]?.error).toMatch(/git push failed/);
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');

    // Back online: Push again on the board sends it, and only then the tickets and the tracker item close.
    sh(`git remote set-url origin ${remote}`, project);
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(project) });
    const res = await a.request('/api/v1/releases/v1.5.0/push', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unpushed?: unknown }).unpushed).toBeUndefined();
    expect(sh('git rev-parse main', remote)).toBe(head);
    expect(sh('git tag', remote)).toBe('v1.5.0');
    t = readTicket(bp, 'AP-1')!;
    expect(t).toMatchObject({ stage: 'done', status: 'Released in v1.5.0' });
    expect(t.trackerQueue).toContainEqual({ kind: 'released', version: 'v1.5.0' });
    expect(readRelease(bp, 'v1.5.0')!.unpushed).toBeUndefined();
    await expect(actions.pushReleaseAgain(bp, 'v1.5.0')).rejects.toThrow('v1.5.0 is pushed already. Nothing is left to send.');
  }, 30_000);

  it('Push again still works after a later release took its commit to the remote: only the tag was left', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    sh(`git remote set-url origin ${path.join(tmp, 'gone.git')}`, project);
    const first = await actions.releaseVersion(bp);
    expect(first.unpushed).toHaveLength(1);
    sh(`git remote set-url origin ${remote}`, project);
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const second = await actions.releaseVersion(bp);
    expect(second.version).toBe('v1.6.0');
    expect(second.unpushed).toBeUndefined();

    const again = await actions.pushReleaseAgain(bp, 'v1.5.0');
    expect(again.unpushed).toBeUndefined();
    expect(sh('git tag', remote).split('\n')).toEqual(['v1.5.0', 'v1.6.0']);
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done', status: 'Released in v1.5.0' });
  }, 30_000);
});

describe('"the newest code" is the team\'s, not an old copy here', () => {
  it('a new copy starts from the remote main when the team moved it on; a project with no remote from its own', async () => {
    const team = teammatePushes('team.txt', 'team\n');
    sh('git fetch -q origin', project);
    const fresh = await makeCopyOf(project, 'AP-1', 'main', 'origin');
    expect(fresh.baseCommit).toBe(team);
    expect(fs.existsSync(path.join(fresh.dir, 'team.txt'))).toBe(true);
    const local = await makeCopyOf(project, 'AP-2', 'main');
    expect(fs.existsSync(path.join(local.dir, 'team.txt'))).toBe(false);
    // The person's own main is left alone.
    expect(fs.existsSync(path.join(project, 'team.txt'))).toBe(false);
  }, 20_000);

  it('when both moved on, the copy gets the work accepted here and the team\'s', async () => {
    teammatePushes('team.txt', 'team\n');
    sh('git fetch -q origin', project);
    fs.writeFileSync(path.join(project, 'here.txt'), 'accepted here\n');
    commit(project, 'accepted here, not pushed yet');
    const before = sh('git rev-parse main', project);
    const wt = await makeCopyOf(project, 'AP-1', 'main', 'origin');
    expect(fs.existsSync(path.join(wt.dir, 'team.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt.dir, 'here.txt'))).toBe(true);
    expect(sh('git rev-parse main', project)).toBe(before);
  }, 20_000);

  it('"Bring in the newest code" fetches the remote main and merges it into the ticket', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    const team = teammatePushes('team.txt', 'team\n');
    const squad = new LiveSquad(bp) as unknown as { updateBase(id: string): Promise<void> };
    await squad.updateBase('AP-1');
    const t = readTicket(bp, 'AP-1')!;
    expect(fs.readFileSync(path.join(t.worktree!, 'team.txt'), 'utf8')).toBe('team\n');
    expect(t.baseCommit).toBe(team);
    expect(t.activity.map((a) => a.text)).toContain('Brought the newest code into this ticket');
    expect(t.squad?.phase).toBe('test');
  }, 20_000);
});

describe('only a real clash is a clash', () => {
  it('changing the same lines as newer work in main brings in the newest code, and moves nothing', () => {
    const wt = proofReady('AP-1', 'limit.txt', 'limit = 3\n').worktree!;
    commit(wt, 'limit 3');
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 5\n');
    commit(project, 'main limit');
    const main = sh('git rev-parse main', project);
    expect(() => mergeIntoBase(project, 'main', 'squad/ap-1', 'm')).toThrow(MergeClash);
    const t = actions.approve(bp, 'AP-1');
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('update-base');
    expect(sh('git rev-parse main', project)).toBe(main);
  }, 20_000);

  describe('with a git older than 2.38', () => {
    let path0: string | undefined;
    beforeEach(() => {
      path0 = process.env.PATH;
      const real = sh('command -v git', tmp);
      const bin = path.join(tmp, 'old-git');
      fs.mkdirSync(bin);
      // git 2.30 has no `merge-tree --write-tree`: it says so and exits 129.
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    --version) echo "git version 2.30.1"; exit 0;;\n    merge-tree) echo "error: unknown option \\\`write-tree'" >&2; exit 129;;\n  esac\ndone\nexec "${real}" "$@"\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${path0}`;
    });
    afterEach(() => {
      process.env.PATH = path0;
    });

    it('is not called a clash: the proof waits, and the error says what to do', () => {
      commit(proofReady('AP-1', 'one.txt', 'one\n').worktree!, 'one');
      let thrown: unknown;
      try {
        mergeIntoBase(project, 'main', 'squad/ap-1', 'm');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(MergeClash);
      expect((thrown as Error).message).toMatch(/^git 2\.30\.1 cannot merge squad\/ap-1 into main: squad-kit needs git 2\.38 or newer\. Update git: on a Mac run brew install git/);
      // Plain words on the button's message; git's own go to the log, and squad doctor says the fix.
      expect(() => actions.approve(bp, 'AP-1')).toThrow(/^The change is saved, but it could not be merged/);
      const t = readTicket(bp, 'AP-1')!;
      expect(t.waiting?.kind).toBe('proof');
      expect(t.stuck).toBeUndefined();
    }, 20_000);

    it('squad doctor says git is too old, with the fix', () => {
      const row = checkGitVersion();
      expect(row).toMatchObject({ id: 'git-version', status: 'fail', detail: 'git 2.30.1 is too old: squad-kit needs git 2.38 or newer to merge accepted work' });
      expect(row.fixHint).toMatch(/brew install git/);
    });
  });

  it('squad doctor is happy with git 2.38 or newer', () => {
    expect(checkGitVersion('2.38.0').status).toBe('ok');
    expect(checkGitVersion('2.41.0 (Apple Git-145)').status).toBe('ok');
    expect(checkGitVersion('3.0').status).toBe('ok');
    expect(checkGitVersion('2.37.9').status).toBe('fail');
    expect(checkGitVersion(null)).toMatchObject({ status: 'fail', detail: 'git does not run here' });
  });
});
