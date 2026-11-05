import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { boardPaths, draftRelease, readRelease, readTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import * as actions from '../src/board/actions.js';
import { putBackInRelease, resumeCutRelease, takeOutOfRelease } from '../src/board/release-tidy.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { addWorktree } from '../src/engine/git.js';
import { cleanBranches, oldBranches } from '../src/engine/branches.js';
import { readJournal } from '../src/engine/release-resume.js';
import { releaseGoingOut } from '../src/board/lock.js';
import { mountDependsApi } from '../src/console/api/depends.js';
import { buildPaths, chooseProject } from '../src/core/paths.js';
import { runRelease } from '../src/commands/board.js';
import { runBranches } from '../src/commands/depends.js';

/**
 * The release fixes of E5: take a ticket out of the next release before it is made, delete old ticket branches after a
 * release (here always, on the remote only when asked, never unmerged ones), and a release cut off by a restart is
 * finished or rolled back on the next start. Real git repos with a bare remote, as the other release tests use.
 */

let tmp: string;
let project: string;
let remote: string;
let bp: BoardPaths;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tries = (cmd: string, cwd: string) => {
  try {
    return sh(cmd, cwd);
  } catch {
    return null;
  }
};
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tidy-'));
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

/** A ticket whose proof waits for you, with one file written in its copy. */
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
    releaseNote: `**${file}.**`,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    ...extra,
  };
  writeTicket(bp, t);
  return t;
}

function accepted(id: string, file: string, text: string, extra: Partial<Ticket> = {}): Ticket {
  proofReady(id, file, text, extra);
  return actions.approve(bp, id);
}

describe('take a ticket out of the next release', () => {
  it('its code stays in main, the tag leaves it out, and it goes out with the next release', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    accepted('AP-2', 'two.txt', 'two\n');
    expect(draftRelease(bp)?.tickets).toEqual(['AP-1', 'AP-2']);

    const r = takeOutOfRelease(bp, 'v1.5.0', 'AP-2');
    expect(r).toMatchObject({ tickets: ['AP-1'], out: ['AP-2'] });
    expect(readTicket(bp, 'AP-2')!.status).toBe('Taken out of v1.5.0 · goes out in the release after it');
    // Nothing in git changed yet.
    expect(sh('git show main:two.txt', project)).toBe('two');

    const release = await actions.releaseVersion(bp);
    expect(release.tickets).toEqual(['AP-1']);
    expect(release.log?.some((l) => l.text === 'Left AP-2 Add two.txt out: its code stays in main and goes out with the next release')).toBe(true);
    // The tag is the release without AP-2; main (here and on the remote) keeps it.
    expect(sh('git show v1.5.0:one.txt', project)).toBe('one');
    expect(tries('git show v1.5.0:two.txt', project)).toBeNull();
    expect(sh('git show v1.5.0:CHANGELOG.md', project)).not.toContain('two.txt');
    expect(sh('git show main:two.txt', remote)).toBe('two');
    expect(sh('git show main:two.txt', project)).toBe('two');
    expect(sh('git rev-parse v1.5.0^{commit}', remote)).toBe(sh('git rev-parse v1.5.0^{commit}', project));
    expect(fs.readFileSync(path.join(project, 'two.txt'), 'utf8')).toBe('two\n');

    expect(readTicket(bp, 'AP-1')!.stage).toBe('done');
    expect(readTicket(bp, 'AP-2')).toMatchObject({ stage: 'release', release: 'v1.6.0', status: 'Merged into main · goes out in v1.6.0' });
    expect(draftRelease(bp)).toMatchObject({ version: 'v1.6.0', tickets: ['AP-2'] });

    // Next time it goes out, from main as it is.
    const next = await actions.releaseVersion(bp);
    expect(next.tickets).toEqual(['AP-2']);
    expect(sh('git show v1.6.0:two.txt', project)).toBe('two');
  }, 60_000);

  it('put back before the release; refused when it is not there, the only one, needed, or cannot be left out', () => {
    accepted('AP-1', 'one.txt', 'one\n');
    expect(() => takeOutOfRelease(bp, 'v1.5.0', 'AP-1')).toThrow('AP-1 is the only ticket in v1.5.0');
    accepted('AP-2', 'two.txt', 'two\n', { dependsOn: ['AP-1'] });
    expect(() => takeOutOfRelease(bp, 'v1.5.0', 'AP-1')).toThrow('AP-2 in this release depends on AP-1. Take it out first, or keep AP-1 in.');
    expect(() => takeOutOfRelease(bp, 'v1.5.0', 'AP-7')).toThrow('AP-7 is not in v1.5.0.');

    takeOutOfRelease(bp, 'v1.5.0', 'AP-2');
    const back = putBackInRelease(bp, 'v1.5.0', 'ap-2');
    expect(back.tickets).toEqual(['AP-1', 'AP-2']);
    expect(back.out).toBeUndefined();
    expect(readTicket(bp, 'AP-2')!.status).toBe('Merged into main · goes out in v1.5.0');
    expect(() => putBackInRelease(bp, 'v1.5.0', 'AP-2')).toThrow('AP-2 was not taken out of v1.5.0.');

    // Later work changed the same lines: AP-1 can no longer be left out on its own.
    accepted('AP-3', 'limit.txt', 'limit = 3\n');
    accepted('AP-4', 'limit.txt', 'limit = 4\n', { title: 'Raise the limit again' });
    expect(() => takeOutOfRelease(bp, 'v1.5.0', 'AP-3')).toThrow('AP-3 cannot be left out: work merged into main after it changed the same lines. Keep it in v1.5.0.');
    expect(draftRelease(bp)?.tickets).toContain('AP-3');
  }, 60_000);

  it('on the sample board, and one REST call each', async () => {
    const demo = boardPaths(path.join(tmp, 'demo', '.squad'));
    seedDemoBoard(demo);
    const app = new Hono();
    mountDependsApi(app, { paths: buildPaths(path.join(tmp, 'demo')) });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    let res = await post('/api/v1/releases/v2.4.0/take-out', { ticket: 'SK-147' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tickets: ['SK-143'], out: ['SK-147'] });
    const out = await (await app.request('/api/v1/releases/v2.4.0/out')).json();
    // The sample SK-147 is accepted, so its code is merged into main already.
    expect(out).toEqual([{ id: 'SK-147', title: 'Export case lists to PDF', merged: true }]);
    await actions.releaseVersion(demo);
    expect(readRelease(demo, 'v2.4.0')!.tickets).toEqual(['SK-143']);
    expect(readTicket(demo, 'SK-147')).toMatchObject({ stage: 'release', release: 'v2.5.0' });
    res = await post('/api/v1/releases/v2.5.0/put-back', { ticket: 'SK-147' });
    expect(res.status).toBe(400);
  });
});

describe('old ticket branches after a release', () => {
  it('go on this computer at once; on the remote only when asked; never one with work that is not in main', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    // Its branch is on the remote too (a hand over, or a pull request).
    sh('git push -q origin squad/ap-1', project);
    // An open ticket's branch always stays.
    const open = addWorktree(project, 'AP-5', 'main');
    writeTicket(bp, { ...proofReady('AP-9', 'nine.txt', 'nine\n'), stage: 'implement', waiting: null, branch: open.branch });

    const release = await actions.releaseVersion(bp);
    expect(tries('git rev-parse --verify -q refs/heads/squad/ap-1', project)).toBeNull();
    expect(release.log?.some((l) => l.text === 'Deleted the old ticket branches on this computer: squad/ap-1')).toBe(true);
    expect(release.log?.some((l) => l.text === 'Their branches on origin stay (1). To delete them there too: squad branches --clean --remote')).toBe(true);
    expect(sh('git ls-remote --heads origin squad/ap-1', project)).toContain('refs/heads/squad/ap-1');
    expect(sh('git branch --list "squad/*"', project)).toContain('squad/ap-5');

    // Asked for: the remote one goes too, through REST as on the board.
    expect(oldBranches(bp).remote.map((b) => `${b.remote}/${b.branch}`)).toEqual(['origin/squad/ap-1']);
    const app = new Hono();
    mountDependsApi(app, { paths: buildPaths(project) });
    const res = await app.request('/api/v1/branches/clean', { method: 'POST', body: JSON.stringify({ remote: true }), headers: { 'content-type': 'application/json' } });
    expect(((await res.json()) as { deleted: string[] }).deleted).toEqual(['origin/squad/ap-1']);
    expect(sh('git ls-remote --heads origin squad/ap-1', project)).toBe('');
  }, 60_000);

  it('a released ticket whose branch has new work keeps it, here and on the remote', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    await actions.releaseVersion(bp);
    // Someone adds work on the old branch after the release.
    sh('git branch squad/ap-1 main', project);
    const late = addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(late.dir, 'late.txt'), 'late\n');
    commit(late.dir, 'late work');
    sh(`git worktree remove --force ${late.dir}`, project);
    sh('git push -q origin squad/ap-1', project);

    const plan = oldBranches(bp);
    expect(plan.here).toEqual([]);
    expect(plan.remote).toEqual([]);
    expect(plan.kept).toEqual([
      { branch: 'squad/ap-1', why: 'it has work that is not in main' },
      { branch: 'origin/squad/ap-1', why: 'it has work that is not in origin/main' },
    ]);
    const done = cleanBranches(bp, { remote: true });
    expect(done.deleted).toEqual([]);
    expect(sh('git rev-parse --verify -q refs/heads/squad/ap-1', project)).toBeTruthy();
    expect(sh('git ls-remote --heads origin squad/ap-1', project)).toContain('squad/ap-1');
  }, 60_000);
});

/**
 * The release runs in a separate process, which is killed (with every git it started) at a hook: as when the app
 * closes or the computer restarts half-way.
 */
async function releaseCutAt(marker: string): Promise<void> {
  const script = path.join(tmp, 'release.mts');
  fs.writeFileSync(
    script,
    [
      `import { boardPaths } from ${JSON.stringify(path.join(ROOT, 'src/board/store.ts'))};`,
      `import { releaseVersion } from ${JSON.stringify(path.join(ROOT, 'src/board/actions.ts'))};`,
      'await releaseVersion(boardPaths(process.argv[2]!));',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script, bp.squadDir], { cwd: ROOT, detached: true, stdio: 'ignore', env: process.env });
  const ended = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  for (let i = 0; i < 400 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
  expect(fs.existsSync(marker), 'the release reached the hook').toBe(true);
  process.kill(-child.pid!, 'SIGKILL');
  await ended;
}

function hook(file: string, marker: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\nsleep 60\n`, { mode: 0o755 });
}

describe('a release cut off by a restart', () => {
  it('cut off before it reached the remote: rolled back on the next start, then it goes out again', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    const mainBefore = sh('git rev-parse main', project);
    const remoteBefore = sh('git rev-parse main', remote);
    const marker = path.join(tmp, 'pushing');
    hook(path.join(remote, 'hooks', 'pre-receive'), marker);
    await releaseCutAt(marker);

    // Half-done: a tag here, a release branch, the journal; the remote has nothing.
    expect(sh('git tag', project)).toBe('v1.5.0');
    expect(readJournal(bp)?.version).toBe('v1.5.0');
    expect(sh('git rev-parse main', remote)).toBe(remoteBefore);

    fs.rmSync(path.join(remote, 'hooks', 'pre-receive'));
    const settled = await resumeCutRelease(bp);
    expect(settled).toMatchObject({ version: 'v1.5.0', status: 'draft', tickets: ['AP-1'] });
    expect(settled!.log?.some((l) => l.text.startsWith('Nothing had reached origin yet, so squad-kit undid it'))).toBe(true);
    expect(sh('git tag', project)).toBe('');
    expect(sh('git branch --list "release/*"', project)).toBe('');
    expect(sh('git rev-parse main', project)).toBe(mainBefore);
    expect(readJournal(bp)).toBeNull();
    expect(releaseGoingOut(bp)).toBeNull();
    expect(readTicket(bp, 'AP-1')!.stage).toBe('release');

    const again = await actions.releaseVersion(bp);
    expect(again.status).toBe('released');
    expect(sh('git rev-parse main', remote)).toBe(sh('git rev-parse v1.5.0^{commit}', project));
    expect(sh('git tag', remote)).toBe('v1.5.0');
  }, 60_000);

  it('cut off after main reached the remote: finished on the next start, the tag pushed and main moved here', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    const marker = path.join(tmp, 'received');
    hook(path.join(remote, 'hooks', 'post-receive'), marker);
    await releaseCutAt(marker);

    // The remote's main has the release; its tag and this computer's main do not, and the board still says draft.
    const head = sh('git rev-parse main', remote);
    expect(sh('git log --format=%s -1 main', remote)).toBe('release v1.5.0');
    expect(sh('git tag', remote)).toBe('');
    expect(sh('git rev-parse main', project)).not.toBe(head);
    expect(readRelease(bp, 'v1.5.0')!.status).toBe('draft');

    fs.rmSync(path.join(remote, 'hooks', 'post-receive'));
    const settled = await resumeCutRelease(bp);
    expect(settled).toMatchObject({ version: 'v1.5.0', status: 'released', tickets: ['AP-1'] });
    expect(settled!.log?.[0]?.text).toBe('v1.5.0 was cut off while it went out (the app closed or the computer restarted).');
    expect(settled!.log?.some((l) => l.text === 'It had reached origin already, so squad-kit finished it')).toBe(true);
    expect(sh('git tag', remote)).toBe('v1.5.0');
    expect(sh('git rev-parse v1.5.0^{commit}', remote)).toBe(head);
    expect(sh('git rev-parse main', project)).toBe(head);
    expect(readTicket(bp, 'AP-1')).toMatchObject({ stage: 'done', status: 'Released in v1.5.0' });
    expect(readJournal(bp)).toBeNull();
    expect(sh('git branch --list "release/*"', project)).toBe('');
    // Nothing to do on a second start.
    expect(await resumeCutRelease(bp)).toBeNull();
  }, 60_000);

  it('a release that goes out in one go leaves no journal behind', async () => {
    accepted('AP-1', 'one.txt', 'one\n');
    await actions.releaseVersion(bp);
    expect(readJournal(bp)).toBeNull();
    expect(sh('git branch --list "release/*"', project)).toBe('');
  }, 60_000);
});

describe('terminal commands', () => {
  it('squad release --without and --put-back, and squad branches --clean', async () => {
    chooseProject(project);
    const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    try {
      accepted('AP-1', 'one.txt', 'one\n');
      accepted('AP-2', 'two.txt', 'two\n');
      accepted('AP-3', 'three.txt', 'three\n');
      takeOutOfRelease(bp, 'v1.5.0', 'AP-3');
      expect(readRelease(bp, 'v1.5.0')).toMatchObject({ tickets: ['AP-1', 'AP-2'], out: ['AP-3'] });
      await runRelease(undefined, { putBack: ['ap-3'] });
      expect(readRelease(bp, 'v1.5.0')!.out).toBeUndefined();
      await runRelease('v1.5.0', { without: ['AP-2'], yes: true });
      expect(readRelease(bp, 'v1.5.0')).toMatchObject({ status: 'released', tickets: ['AP-1', 'AP-3'], out: ['AP-2'] });
      expect(tries('git show v1.5.0:two.txt', project)).toBeNull();

      // The released tickets' branches went after the release; a leftover one goes with --clean.
      sh('git branch squad/ap-1 $(git rev-list --max-parents=0 main)', project);
      await runBranches({});
      await runBranches({ clean: true });
      expect(tries('git rev-parse --verify -q refs/heads/squad/ap-1', project)).toBeNull();
      expect(sh('git branch --list "squad/*"', project)).toContain('squad/ap-2');
    } finally {
      chooseProject(null);
      for (const q of quiet) q.mockRestore();
    }
  }, 60_000);
});
