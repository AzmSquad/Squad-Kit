import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, listReleases, readMeta, readRelease, readTicket, writeMeta, writeRelease, writeTicket, type BoardPaths } from '../src/board/store.js';
import { runRelease } from '../src/commands/board.js';
import { buildPaths } from '../src/core/paths.js';
import type { Ticket } from '../src/board/types.js';
import '../src/engine/live.js';
import * as actions from '../src/board/actions.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { addWorktree } from '../src/engine/git.js';
import { pushWords } from '../src/engine/release.js';

/**
 * A teammate pushed main before a release reached it, or main takes no direct pushes. Real git, with two clones of one
 * bare remote. Push again used to fail the same way for good, in git's own words.
 */

let tmp: string;
let project: string;
let remote: string;
let mate: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, dir);

function teammatePushes(file: string, text: string) {
  sh('git pull -q origin main', mate);
  fs.writeFileSync(path.join(mate, file), text);
  commit(mate, `teammate changed ${file}`);
  sh('git push -q origin main', mate);
}

function proofReady(id: string, file: string, text: string) {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, file), text);
  const t: Ticket = {
    id,
    title: `Change ${file}`,
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
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-push-'));
  project = path.join(tmp, 'app');
  remote = path.join(tmp, 'remote.git');
  mate = path.join(tmp, 'mate');
  fs.mkdirSync(project);
  sh(`git init -q --bare -b main ${remote}`, tmp);
  sh(`git init -q -b main && git remote add origin ${remote}`, project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.4.2' }, null, 2));
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  commit(project, 'start');
  sh('git push -q origin main', project);
  sh(`git clone -q ${remote} ${mate}`, tmp);
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

describe('a teammate pushed main while the release was being made', () => {
  it('merges the two and goes out, keeping both, with no force', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    teammatePushes('theirs.txt', 'theirs\n');
    const mateTip = sh('git rev-parse main', remote);

    const r = await actions.releaseVersion(bp);
    expect(r.unpushed).toBeUndefined();
    expect(r.log?.map((l) => l.text).join('\n')).toContain('had newer work from a teammate, so the release was merged with it');
    // Nothing of the teammate's was lost: their commit is still under the new main.
    expect(() => sh(`git merge-base --is-ancestor ${mateTip} main`, remote)).not.toThrow();
    sh('git fetch -q origin', project);
    expect(sh('git show origin/main:one.txt', project)).toBe('one');
    expect(sh('git show origin/main:theirs.txt', project)).toBe('theirs');
    // This computer's main has both too, so the next ticket builds on them.
    expect(sh('git rev-parse main', project)).toBe(sh('git rev-parse main', remote));
    expect(fs.readFileSync(path.join(project, 'theirs.txt'), 'utf8')).toBe('theirs\n');
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done' });
    // The tag names the release itself.
    expect(sh(`git rev-parse ${r.version}^{commit}`, remote)).not.toBe(mateTip);
    expect(sh('git tag', remote)).toBe(r.version);
  }, 60_000);

  it('Push again settles it too, when the remote was down first and a teammate pushed meanwhile', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    sh(`git remote set-url origin ${path.join(tmp, 'gone.git')}`, project);
    const first = await actions.releaseVersion(bp);
    expect(first.unpushed).toHaveLength(1);
    expect(first.unpushed![0]!.plain).toMatch(/could not reach your team's shared copy of the code/);
    sh(`git remote set-url origin ${remote}`, project);
    teammatePushes('theirs.txt', 'theirs\n');

    const r = await actions.pushReleaseAgain(bp, first.version);
    expect(r.unpushed).toBeUndefined();
    expect(sh('git rev-parse main', project)).toBe(sh('git rev-parse main', remote));
    expect(fs.readFileSync(path.join(project, 'theirs.txt'), 'utf8')).toBe('theirs\n');
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done' });
  }, 60_000);

  it('a real clash stops in plain words with what an engineer does, and nothing is forced', async () => {
    proofReady('AP-1', 'limit.txt', 'limit = 3\n');
    actions.approve(bp, 'AP-1');
    teammatePushes('limit.txt', 'limit = 9\n');
    const mateTip = sh('git rev-parse main', remote);

    const r = await actions.releaseVersion(bp);
    expect(r.status).toBe('released');
    const u = r.unpushed![0]!;
expect(u.plain).toMatch(/changes the same lines as this release/);
    // The person reads no git command; the engineer's line has it.
    expect(u.plain).not.toMatch(/git |release\//);
    expect(u.error).toContain(`git merge release/${r.version}`);
    expect(sh('git rev-parse main', remote)).toBe(mateTip);
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');

    // An engineer settles it by hand: Push again finds the release there and sends the tag.
    sh('git fetch -q origin && git merge -q --no-edit -X ours origin/main', project);
    sh('git push -q origin main', project);
    const again = await actions.pushReleaseAgain(bp, r.version);
    expect(again.unpushed).toBeUndefined();
    expect(readTicket(bp, 'AP-1')!.stage).toBe('done');
  }, 60_000);
});

describe('main takes no direct pushes', () => {
  beforeEach(() => {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "error: GH006: Protected branch update failed for refs/heads/main."; exit 1; fi\ndone\n', { mode: 0o755 });
  });

  it('says so plainly and keeps the release on its own branch for a pull request', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const r = await actions.releaseVersion(bp);
    const u = r.unpushed![0]!;
    expect(u.plain).toMatch(/only takes changes after a review/);
    expect(u.plain).not.toMatch(/git |rejected|hook declined|pull request|branch|release\//);
    expect(u.error).toMatch(/git push failed/);
    expect(u.error).toContain(`The release is on the branch release/${r.version}: open a pull request from it into main.`);
    expect(sh(`git rev-parse release/${r.version}`, remote)).toBe(u.commit);
    expect(r.log?.find((l) => !l.ok)?.text).toContain(`--push-again`);
  }, 60_000);

  const markSent = (version: string, body: unknown) => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(project) });
    return a.request(`/api/v1/releases/${version}/mark-sent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };

  async function refusedRelease() {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const r = await actions.releaseVersion(bp);
    expect(r.unpushed).toHaveLength(1);
    return r;
  }

  it('It reached it another way needs a reason, and nothing changes without one', async () => {
    const r = await refusedRelease();
    const res = await markSent(r.version, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Write how it got there/);
    expect(readRelease(bp, r.version)!.unpushed).toHaveLength(1);
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');
  }, 60_000);

  it('not on the remote: it warns, and only a second yes closes the tickets, on the record', async () => {
    const r = await refusedRelease();
    const res = await markSent(r.version, { reason: 'Sara squashed it' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`squad-kit looked in your team's shared copy of the code and did not find ${r.version} there. A merge by hand can look like this too, so you can still mark it. Its tickets close if you do.`);
    expect(readRelease(bp, r.version)!.unpushed).toHaveLength(1);
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');

    const yes = await markSent(r.version, { reason: 'Sara squashed it', anyway: true });
    expect(yes.status).toBe(200);
    expect(readRelease(bp, r.version)!.unpushed).toBeUndefined();
    const log = readRelease(bp, r.version)!.log!;
    expect(log.at(-2)?.text).toBe('Momen said it reached the shared copy of the code another way: Sara squashed it. squad-kit did not find it there');
    // Marking it sends nothing, and the record says what stayed here.
    expect(log.at(-1)).toMatchObject({ ok: false, text: expect.stringMatching(new RegExp(`only on this computer.*git push origin ${r.version}`)) });
    expect(sh('git tag -l', remote)).toBe('');
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done', status: `Released in ${r.version}` });
    await expect(actions.pushReleaseAgain(bp, r.version)).rejects.toThrow('is pushed already');
  }, 60_000);

  it('on the remote: one press, after looking', async () => {
    const r = await refusedRelease();
    // An engineer gets it in by hand, with the protection off.
    fs.rmSync(path.join(remote, 'hooks', 'pre-receive'));
    sh(`git push -q origin ${r.unpushed![0]!.commit}:refs/heads/main`, project);
    const res = await markSent(r.version, { reason: 'merged by hand' });
    expect(res.status).toBe(200);
    expect(readRelease(bp, r.version)!.log?.at(-2)?.text).toBe('Momen said it reached the shared copy of the code another way: merged by hand. squad-kit found it there');
    expect(readTicket(bp, 'AP-1')!.stage).toBe('done');
  }, 60_000);

  it('the remote cannot be reached: it says so plainly, and does not mark it without a second yes', async () => {
    const r = await refusedRelease();
    fs.rmSync(remote, { recursive: true, force: true });
    const res = await markSent(r.version, { reason: 'merged by hand' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`squad-kit could not reach your team's shared copy of the code, so it cannot check that ${r.version} is there. Its tickets close if you mark it. Do that only if you are sure.`);
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');
    const yes = await markSent(r.version, { reason: 'merged by hand', anyway: true });
    expect(yes.status).toBe(200);
    expect(readRelease(bp, r.version)!.log?.at(-2)?.text).toBe('Momen said it reached the shared copy of the code another way: merged by hand. squad-kit could not check that');
  }, 60_000);

  it('the terminal takes the version with or without the v, and says when a word does nothing', async () => {
    const r = await refusedRelease();
    const plain = r.version.replace(/^v/, '');
    const said: string[] = [];
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((words) => {
      said.push(String(words));
      return true;
    });
    const cwd = process.cwd();
    process.chdir(project);
    try {
      await expect(runRelease(plain, { markSent: true })).rejects.toThrow(/Say how it got there/);
      await expect(runRelease(plain, { pushAgain: true, reason: 'by hand', anyway: true })).rejects.toThrow(/still not pushed/);
      expect(said.filter((m) => m.includes('only counts with --mark-sent'))).toHaveLength(2);
      await runRelease(plain, { markSent: true, reason: "Sara's merge", anyway: true });
    } finally {
      process.chdir(cwd);
      err.mockRestore();
    }
    expect(readRelease(bp, r.version)!.unpushed).toBeUndefined();
    // Marking it sends nothing, and the person is told what stayed here.
    expect(said.some((m) => m.includes('only on this computer'))).toBe(true);
  }, 60_000);

  it('the terminal asks the same: a reason, and --anyway for the second yes', async () => {
    const r = await refusedRelease();
    const cwd = process.cwd();
    process.chdir(project);
    try {
      await expect(runRelease(r.version, { markSent: true })).rejects.toThrow(/Say how it got there/);
      await expect(runRelease(r.version, { markSent: true, reason: 'by hand' })).rejects.toThrow(/did not find .* there.*--anyway/s);
      expect(readRelease(bp, r.version)!.unpushed).toHaveLength(1);
      await runRelease(r.version, { markSent: true, reason: 'by hand', anyway: true });
    } finally {
      process.chdir(cwd);
    }
    expect(readRelease(bp, r.version)!.unpushed).toBeUndefined();
    expect(readTicket(bp, 'AP-1')!.stage).toBe('done');
  }, 60_000);
});

describe('the pipeline', () => {
  it("runs on what reached the remote, with the teammate's work the push merged in", async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    teammatePushes('theirs.txt', 'theirs\n');
    const marker = path.join(tmp, 'deploy-saw');
    writeMeta(bp, { ...readMeta(bp), commands: { deploy: `ls > "${marker}"` } });
    const d = listReleases(bp).find((x) => x.status === 'draft')!;
    writeRelease(bp, { ...d, addons: { ...d.addons, pipeline: true } });
    const r = await actions.releaseVersion(bp);
    expect(r.unpushed).toBeUndefined();
    const saw = fs.readFileSync(marker, 'utf8');
    expect(saw).toContain('theirs.txt');
    expect(saw).toContain('one.txt');
  }, 60_000);
});

describe('the words for a push that failed', () => {
  it.each([
    ['ssh: Could not resolve hostname', /could not reach your team's shared copy of the code/],
    ['fatal: Could not read from remote repository.', /could not reach your team's shared copy of the code/],
    ['git push gave up after 120 seconds. Check the network', /could not reach your team's shared copy of the code/],
    ['remote: HTTP 403', /did not accept this computer's sign-in/],
    ['fatal: Authentication failed for', /did not accept this computer's sign-in/],
    ['! [remote rejected] main -> main (protected branch hook declined)', /only takes changes after a review/],
    ['something else entirely', /An engineer can see why below/],
  ])('%s', (raw, words) => {
    expect(pushWords(raw)).toMatch(words);
    expect(pushWords(raw)).not.toMatch(/origin|main on/);
  });
});
