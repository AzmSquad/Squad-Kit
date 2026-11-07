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
import { mergeSettings } from '../src/engine/project-git.js';
import { holdRelease } from '../src/board/lock.js';

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

function updateTicketRelease(id: string, version: string) {
  writeTicket(bp, { ...readTicket(bp, id)!, release: version });
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

describe('a version number already on the remote', () => {
  it('a teammate released the same number: this one takes the next, and their tag does not move', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    expect(readRelease(bp, 'v1.5.0')!.tickets).toEqual(['AP-1']);
    sh('git -c user.name=t -c user.email=t@t tag -a v1.5.0 -m theirs && git push -q origin v1.5.0', mate);
    const theirs = sh('git rev-parse refs/tags/v1.5.0', remote);

    const r = await actions.releaseVersion(bp, 'v1.5.0');
    expect(r.version).toBe('v1.6.0');
    expect(r.from).toBe('v1.5.0');
    expect(r.log![0]!.text).toBe('A teammate already released v1.5.0, so this one went out as v1.6.0.');
    expect(sh('git rev-parse refs/tags/v1.5.0', remote)).toBe(theirs);
    expect(sh('git rev-parse refs/tags/v1.6.0', remote)).toBeTruthy();
    expect(readRelease(bp, 'v1.5.0')).toBeNull();
    expect(readTicket(bp, 'AP-1')!.release).toBe('v1.6.0');
    expect(sh('git show v1.6.0:package.json', remote)).toContain('"version": "1.6.0"');
  });

  it('every number up to the next free one is gone around, and a patch stays a patch', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const draft = readRelease(bp, 'v1.5.0')!;
    writeRelease(bp, { ...draft, version: 'v1.5.1', from: 'v1.5.0' });
    fs.rmSync(path.join(bp.releasesDir, 'v1.5.0.md'));
    updateTicketRelease('AP-1', 'v1.5.1');
    for (const v of ['v1.5.1', 'v1.5.2']) sh(`git -c user.name=t -c user.email=t@t tag -a ${v} -m theirs && git push -q origin ${v}`, mate);
    expect((await actions.releaseVersion(bp, 'v1.5.1')).version).toBe('v1.5.3');
  });

  it('a release going out, or one cut off half-way, keeps its number though its tag is there', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    sh('git -c user.name=t -c user.email=t@t tag -a v1.5.0 -m mine && git push -q origin v1.5.0', mate);
    const free = holdRelease(bp, 'v1.5.0');
    await expect(actions.releaseVersion(bp, 'v1.5.0')).rejects.toThrow('v1.5.0 is going out right now');
    free();
    expect(readRelease(bp, 'v1.5.0')).not.toBeNull();
    expect(readTicket(bp, 'AP-1')!.release).toBe('v1.5.0');
  });

  it('with no answer from the remote the number stands, and a tag is never forced over a teammate\'s', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const r = await actions.releaseVersion(bp, 'v1.5.0');
    expect(r.version).toBe('v1.5.0');
    const mine = sh('git rev-parse refs/tags/v1.5.0', remote);
    // The tag this computer holds is moved by hand, as a mistake would: Push again does not move the remote's.
    fs.writeFileSync(path.join(project, 'x.txt'), 'x\n');
    commit(project, 'after');
    sh('git -c user.name=t -c user.email=t@t tag -f -a v1.5.0 -m moved', project);
    writeRelease(bp, { ...readRelease(bp, 'v1.5.0')!, unpushed: [{ repo: '.', remote: 'origin', base: 'main', commit: sh('git rev-parse HEAD', project), tag: 'v1.5.0', error: 'x', plain: 'y' }] });
    const again = await actions.pushReleaseAgain(bp, 'v1.5.0');
    expect(sh('git rev-parse refs/tags/v1.5.0', remote)).toBe(mine);
    expect(again.unpushed?.[0]?.plain).toBe('A teammate released this version number while this release went out, so the shared copy did not take it. The release is safe on this computer. An engineer can see what to do below.');
  });
});

describe('the shared settings, with two people', () => {
  /** The first release shares the settings; the teammate has them from there on. */
  async function shared() {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    await actions.releaseVersion(bp);
    sh('git pull -q origin main', mate);
  }
  const teammateSets = (change: (text: string) => string) => {
    const file = path.join(mate, '.squad', 'config.yaml');
    fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "their setting" && git push -q origin main', mate);
  };
  const atRemote = (v: string) => sh(`git show ${v}:.squad/config.yaml`, remote);

  it("one person's change does not take away a teammate's: each goes through", async () => {
    await shared();
    teammateSets((t) => t.replace(/commands: \{\}/, 'commands:\n    test: npm test'));
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty' });
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const r = await actions.releaseVersion(bp);
    const text = atRemote(r.version);
    expect(text).toContain('test: npm test');
    expect(text).toContain('quality: thrifty');
    expect(r.log!.map((l) => l.text).join('\n')).not.toContain('A teammate changed');
    // This computer has the teammate's setting too.
    expect(readMeta(bp).commands?.test).toBe('npm test');
    expect(readMeta(bp).quality).toBe('thrifty');
  });

  it('a project released by an older version keeps what this computer changed since then', async () => {
    await shared();
    // An older version kept no note of what it last shared: what the checkout holds says the same.
    fs.rmSync(path.join(bp.localDir, 'config-shared.yaml'));
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty' });
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const r = await actions.releaseVersion(bp);
    expect(atRemote(r.version)).toContain('quality: thrifty');
    expect(readMeta(bp).quality).toBe('thrifty');
    expect(r.log!.map((l) => l.text).join('\n')).not.toContain('A teammate changed');
  });

  it("both changed the same one: the team's stays, here too, and the release says so in plain words", async () => {
    await shared();
    teammateSets((t) => t.replace(/commands: \{\}/, 'commands:\n    test: their test'));
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'my test' } });
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const r = await actions.releaseVersion(bp);
    expect(atRemote(r.version)).toContain('test: their test');
    expect(atRemote(r.version)).not.toContain('my test');
    expect(r.log!.map((l) => l.text)).toContain('A teammate changed how the project is tested and run too, so theirs stays, here as well. You can look at it in Settings.');
    expect(readMeta(bp).commands?.test).toBe('their test');
  });

  it('the next ticket number is the higher of the two, and each computer keeps its own project id', async () => {
    await shared();
    teammateSets((t) => t.replace(/nextNumber: \d+/, 'nextNumber: 90').replace(/^  id: .*$/m, '  id: their-id'));
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const before = readMeta(bp).id;
    const r = await actions.releaseVersion(bp);
    expect(readMeta(bp).nextNumber).toBe(90);
    expect(readMeta(bp).id).toBe(before);
    expect(atRemote(r.version)).toContain('id: their-id');
  });

  it('the first time, with nothing shared before: only a setting that differs is said, never the id', async () => {
    teammatePushes('x.txt', 'x');
    fs.mkdirSync(path.join(mate, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(mate, '.squad', 'config.yaml'), fs.readFileSync(bp.configFile, 'utf8').replace(/^  id: .*$/m, '  id: their-id').replace(/commands: \{\}/, 'commands:\n    test: their test'));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "their settings" && git push -q origin main', mate);
    sh('git fetch -q origin', project);
    const seen = mergeSettings(bp, sh('git show origin/main:.squad/config.yaml', project));
    expect(seen.theirsStayed).toEqual(['how the project is tested and run']);
  });

  it("a teammate's copy that cannot be read is never mixed in", async () => {
    await shared();
    const mine = fs.readFileSync(bp.configFile, 'utf8');
    expect(mergeSettings(bp, 'board: [not closed', { fetched: true }).text).toBe(mine);
    expect(fs.readFileSync(bp.configFile, 'utf8')).toBe(mine);
  });

  it("at a fetch a teammate's new setting comes in, and a clash waits for the release to say so", async () => {
    await shared();
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty' });
    teammateSets((t) => t.replace(/commands: \{\}/, 'commands:\n    test: npm test').replace(/nextNumber: \d+/, 'nextNumber: 50').replace(/^(\s+)engine: live$/m, '$1engine: live\n$1quality: best'));
    sh('git fetch -q origin', project);
    const seen = mergeSettings(bp, sh('git show origin/main:.squad/config.yaml', project), { fetched: true });
    expect(readMeta(bp).commands?.test).toBe('npm test');
    expect(readMeta(bp).nextNumber).toBe(50);
    expect(readMeta(bp).quality).toBe('thrifty');
    expect(seen.theirsStayed).toEqual(['the Quality setting']);
  });
});

describe('after a release, the person\'s folder', () => {
  it('leaves squad-kit files plain to git, and the next merge and release still go through', async () => {
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const first = await actions.releaseVersion(bp);
    // What squad-kit saves all the time: the next number in the settings, a ticket that went out, a decision.
    expect(sh('git ls-files -- .squad/config.yaml', project)).toBe('.squad/config.yaml');
    const tracked = fs.readFileSync(bp.configFile, 'utf8');
    writeMeta(bp, { ...readMeta(bp), nextNumber: 77 });
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toBe(tracked);
    const t = readTicket(bp, 'AP-1')!;
    writeTicket(bp, { ...t, status: 'Changed by squad-kit' });
    fs.appendFileSync(path.join(bp.ticketsDir, 'AP-1', 'ticket.md'), 'More words.\n');
    // An engineer's usual ways out must work on them: hidden files leave a refused pull with nothing to stash or restore.
    expect(sh('git ls-files -v -- .squad', project).split('\n').filter((l) => !l.startsWith('H '))).toEqual([]);
    expect(sh('git status --porcelain', project)).toContain('.squad/config.yaml');
    sh('git diff --quiet -- .squad/config.yaml || git stash push -q -- .squad/config.yaml && git stash pop -q', project);
    expect(readMeta(bp).nextNumber).toBe(77);
    // A change of the person's own still shows.
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 3\n');
    expect(sh('git status --porcelain', project)).toContain('M limit.txt');
    sh('git checkout -- limit.txt', project);

    // The next ticket goes all the way, with this computer's newer copy kept.
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    const second = await actions.releaseVersion(bp);
    expect(second.version).not.toBe(first.version);
    expect(second.unpushed).toBeUndefined();
    expect(readMeta(bp).nextNumber).toBe(77);
    expect(sh(`git show main:.squad/releases/${second.version}.md`, project)).toContain(second.version);
  });
});

describe('the after-release step', () => {
  it('reads in plain words, with no command or its output, whichever way it goes', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { deploy: 'echo boom-from-the-tool; exit 3' } });
    proofReady('AP-1', 'one.txt', 'one\n');
    actions.approve(bp, 'AP-1');
    const failed = await actions.releaseVersion(bp);
    const words = failed.log!.map((l) => l.text).join('\n');
    expect(words).toContain('Your after-release step failed. An engineer can see why in the log.');
    expect(words).not.toMatch(/boom-from-the-tool|pipeline/i);
    expect(words).toContain("Sent to your team's shared copy of the code");
    expect(words).toContain(`Marked the code as ${failed.version}`);
    expect(words).not.toMatch(/\bpushed\b|\borigin\b/i);

    writeMeta(bp, { ...readMeta(bp), commands: { deploy: 'exit 0' } });
    proofReady('AP-2', 'two.txt', 'two\n');
    actions.approve(bp, 'AP-2');
    expect((await actions.releaseVersion(bp)).log!.map((l) => l.text)).toContain('Ran your after-release step');
  });
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
