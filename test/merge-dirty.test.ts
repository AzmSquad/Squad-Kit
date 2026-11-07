import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import { LiveSquad } from '../src/engine/live.js';
import * as actions from '../src/board/actions.js';
import { mergeWait } from '../src/board/auto.js';
import { recheckMerge } from '../src/engine/sync.js';
import { addWorktree, changedTracked, isLockFile, putBackTracked } from '../src/engine/git.js';

let tmp: string;
let project: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dirty-'));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  bp = boardPaths(path.join(project, '.squad'));
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
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function proofReady() {
  const wt = addWorktree(project, 'AP-1', 'main');
  fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
  writeTicket(bp, {
    id: 'AP-1',
    title: 'Raise the limit',
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
  });
}

describe('merge on accept with your own changes in the checkout', () => {
  it('moves main when your changes are in other files, like the ones squad init wrote', () => {
    proofReady();
    fs.appendFileSync(path.join(project, '.gitignore'), '.squad/runs/\n');
    const t = actions.approve(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(t.status).toMatch(/^Merged into main/);
    expect(sh('git log --format=%s -1 main', project)).toBe('Merge Raise the limit (AP-1)');
    expect(fs.readFileSync(path.join(project, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toContain('.squad/runs/');
  });

  it('leaves main alone when you changed the same file, and does not claim it merged', () => {
    proofReady();
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 9\n');
    const t = actions.approve(bp, 'AP-1');
    expect(t.mergedAt).toBeUndefined();
    expect(t.status).toBe('Waits to merge: your own copy of the code has changes in the same files');
    const said = readTicket(bp, 'AP-1')!.activity.map((a) => a.text).join('\n');
    expect(said).toContain('It goes in once your own copy of the code is free of changes in the same files. squad-kit tries again every few minutes');
    expect(said).not.toMatch(/git |--ff-only|checkout/);
    expect(sh('git log --format=%s -1 main', project)).toBe('start');
    expect(fs.readFileSync(path.join(project, 'limit.txt'), 'utf8')).toBe('limit = 9\n');
  });
});

describe('a merge that could not move main, on Full and Express', () => {
  const held = (track?: 'express') => {
    proofReady();
    if (track) updateTicket(bp, 'AP-1', (x) => (x.track = track));
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 9\n');
    return actions.approve(bp, 'AP-1');
  };

  it('is tried again by the live squad, and goes in once your own copy is free', async () => {
    const t = held();
    expect(t.mergedAt).toBeUndefined();
    expect(mergeWait(t)).toBe('checkout');
    // Still your change in the same file: it waits, and main stays where it is.
    expect(await recheckMerge(bp, 'AP-1')).toBe('waiting');
    expect(sh('git log --format=%s -1 main', project)).toBe('start');
    expect(fs.readFileSync(path.join(project, 'limit.txt'), 'utf8')).toBe('limit = 9\n');
    // You put your change aside: the squad's next turn merges it, with no button.
    sh('git checkout -- limit.txt', project);
    const squad = new LiveSquad(bp) as unknown as { tick(): void };
    squad.tick();
    for (let i = 0; i < 200 && !readTicket(bp, 'AP-1')!.mergedAt; i += 1) await new Promise((r) => setTimeout(r, 10));
    const after = readTicket(bp, 'AP-1')!;
    expect(after.mergedAt).toBeTruthy();
    expect(after.status).toBe('Merged into main · goes out in v0.1.0');
    expect(after.activity[0]!.text).toBe('Merged into main: your own copy of main was free again');
    expect(sh('git log --format=%s -1 main', project)).toBe('Merge Raise the limit (AP-1)');
    expect(fs.readFileSync(path.join(project, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(mergeWait(after)).toBeNull();
  });

  it('works the same on Express', async () => {
    expect(mergeWait(held('express'))).toBe('checkout');
    sh('git checkout -- limit.txt', project);
    expect(await recheckMerge(bp, 'AP-1')).toBe('merged');
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
  });

  it('gets the clash card when newer work in main changed the same lines meanwhile', async () => {
    held();
    sh('git checkout -- limit.txt', project);
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 7\n');
    sh('git add limit.txt && git -c user.name=t -c user.email=t@t commit -qm other', project);
    expect(await recheckMerge(bp, 'AP-1')).toBe('clash');
  });

  it('leaves a ticket with no branch, and a pull request on these tracks, to what they were', async () => {
    const t = held();
    expect(mergeWait({ ...t, branch: undefined })).toBeNull();
    expect(mergeWait({ ...t, pr: { id: 7, url: 'https://code.example.test/pr/7', repo: 'app', host: 'example' } })).toBeNull();
  });
});

describe('your own checkout after the merge', () => {
  const setup = (command: string) => writeMeta(bp, { ...readMeta(bp), commands: { setup: command } });
  const run = (id: string) => (new LiveSquad(bp) as unknown as { localSetup(id: string): Promise<void> }).localSetup(id);

  it('runs the setup there, so new packages and database changes are in place', async () => {
    setup('echo installed > setup.log');
    proofReady();
    const t = actions.approve(bp, 'AP-1');
    expect(t.localSetup).toEqual({ status: 'pending', dir: project, command: 'echo installed > setup.log' });
    await run('AP-1');
    const after = readTicket(bp, 'AP-1')!;
    expect(after.localSetup?.status).toBe('done');
    expect(fs.readFileSync(path.join(project, 'setup.log'), 'utf8')).toBe('installed\n');
    // The exact command is for engineers: on the ticket for the Developer tab, and in the log.
    expect(after.activity[0]!.text).toBe('Your copy is ready');
    expect(after.localSetup?.command).toBe('echo installed > setup.log');
  });

  it('says so when the setup fails, and can try again', async () => {
    setup('echo no network >&2; exit 3');
    proofReady();
    actions.approve(bp, 'AP-1');
    await run('AP-1');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.localSetup).toMatchObject({ status: 'failed', output: expect.stringContaining('no network') });
    expect(t.activity[0]!.text).toBe('Your copy could not be set up');
    expect(actions.setUpLocalCopy(bp, 'AP-1').localSetup?.status).toBe('pending');
  });

  describe('a tracked file the setup rewrites', () => {
    const LOCK = '{ "v": 2 }\n';
    const REWRITE = 'printf "{ \\"v\\": 3 }\\n" > package-lock.json';
    const file = (name: string) => fs.readFileSync(path.join(project, name), 'utf8');
    const changed = () => sh("git diff --name-only HEAD -- . ':!.squad'", project).split('\n').filter(Boolean);
    const merged = (command: string) => {
      fs.writeFileSync(path.join(project, 'package-lock.json'), LOCK);
      fs.writeFileSync(path.join(project, 'notes.txt'), 'mine\n');
      sh('git add package-lock.json notes.txt && git -c user.name=t -c user.email=t@t commit -qm files', project);
      setup(command);
      proofReady();
      actions.approve(bp, 'AP-1');
    };

    it('puts back the lock file it rewrote, so your folder shows no change you did not make', async () => {
      merged(REWRITE);
      await run('AP-1');
      expect(readTicket(bp, 'AP-1')!.localSetup?.status).toBe('done');
      expect(file('package-lock.json')).toBe(LOCK);
      expect(changed()).toEqual([]);
      expect(readTicket(bp, 'AP-1')!.activity[0]!.text).toBe('Your copy is ready');
    });

    it('puts it back when the setup failed too: try again starts clean', async () => {
      merged(`${REWRITE}; exit 3`);
      await run('AP-1');
      expect(readTicket(bp, 'AP-1')!.localSetup?.status).toBe('failed');
      expect(file('package-lock.json')).toBe(LOCK);
    });

    it('never touches your own change: not in another file, and not in the lock file, even when the setup rewrote it too', async () => {
      merged(REWRITE);
      // Your changes, made before the setup ran.
      fs.writeFileSync(path.join(project, 'notes.txt'), 'my own words\n');
      fs.writeFileSync(path.join(project, 'package-lock.json'), '{ "v": "mine" }\n');
      await run('AP-1');
      expect(file('notes.txt')).toBe('my own words\n');
      // It differed before the setup ran, so it is yours: squad-kit cannot tell the two apart and leaves it.
      expect(file('package-lock.json')).toBe('{ "v": 3 }\n');
      expect(changed().sort()).toEqual(['notes.txt', 'package-lock.json']);
    });

    it('only your untouched lock file goes back when you changed something else', async () => {
      merged(REWRITE);
      fs.writeFileSync(path.join(project, 'notes.txt'), 'my own words\n');
      await run('AP-1');
      expect(file('notes.txt')).toBe('my own words\n');
      expect(file('package-lock.json')).toBe(LOCK);
      expect(changed()).toEqual(['notes.txt']);
    });

    it('leaves any other file that changed while it ran: it may be yours, or a database the setup moved on', async () => {
      merged('printf "saved while it ran\\n" > notes.txt');
      await run('AP-1');
      expect(readTicket(bp, 'AP-1')!.localSetup?.status).toBe('done');
      expect(file('notes.txt')).toBe('saved while it ran\n');
      expect(changed()).toEqual(['notes.txt']);
    });
  });

  it('knows a lock file by its name, in any folder, and paths are from the folder it is given', () => {
    for (const f of ['package-lock.json', 'web/pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'Cargo.lock', 'composer.lock', 'go.sum', 'packages.lock.json', 'npm-shrinkwrap.json']) {
      expect(isLockFile(f), f).toBe(true);
    }
    for (const f of ['package.json', 'src/lock.ts', 'go.mod', 'prisma/dev.db', 'notes.txt', 'lockfile.md']) expect(isLockFile(f), f).toBe(false);

    fs.mkdirSync(path.join(project, 'web'));
    fs.writeFileSync(path.join(project, 'web', 'yarn.lock'), 'one\n');
    fs.writeFileSync(path.join(project, 'outside.lock'), 'one\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm files', project);
    fs.writeFileSync(path.join(project, 'web', 'yarn.lock'), 'two\n');
    fs.writeFileSync(path.join(project, 'outside.lock'), 'two\n');
    const web = path.join(project, 'web');
    expect(changedTracked(web)).toEqual(['yarn.lock']);
    expect(putBackTracked(web, { only: isLockFile })).toEqual(['yarn.lock']);
    expect(fs.readFileSync(path.join(web, 'yarn.lock'), 'utf8')).toBe('one\n');
    // Outside the folder it was given: not its business.
    expect(fs.readFileSync(path.join(project, 'outside.lock'), 'utf8')).toBe('two\n');
  });

  it('can be started for a ticket merged before this step existed', () => {
    setup('echo installed > setup.log');
    proofReady();
    actions.approve(bp, 'AP-1');
    writeTicket(bp, { ...readTicket(bp, 'AP-1')!, localSetup: undefined });
    expect(actions.setUpLocalCopy(bp, 'AP-1').localSetup).toEqual({ status: 'pending', dir: project, command: 'echo installed > setup.log' });
    expect(readTicket(bp, 'AP-1')!.localSetup?.status).toBe('pending');
  });

  it('leaves it alone when your checkout is on another branch: its files did not change', () => {
    setup('echo installed > setup.log');
    proofReady();
    sh('git checkout -q -b my-work', project);
    const t = actions.approve(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(t.localSetup).toBeUndefined();
  });
});


describe('bringing the latest main into a ticket that has unsaved work', () => {
  type Bring = { bringInBase(t: ReturnType<typeof readTicket> & object, base: string): Promise<{ baseSha: string; clashes: string[] }> };
  const bring = () => (new LiveSquad(bp) as unknown as Bring).bringInBase(readTicket(bp, 'AP-1')!, 'main');

  function ticketWithWork(ticketLine: string, mainLine: string) {
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\nshift = 1\nnext = no\n');
    sh('git -c user.name=t -c user.email=t@t commit -qam lines', project);
    proofReady();
    const wt = readTicket(bp, 'AP-1')!.worktree!;
    // The Builder's work is not saved yet, like MA-6 when its plan changed.
    fs.writeFileSync(path.join(wt, 'limit.txt'), `${ticketLine}\nshift = 1\nnext = no\n`);
    fs.writeFileSync(path.join(wt, 'hours.txt'), 'open 9-5\n');
    fs.writeFileSync(path.join(project, 'limit.txt'), `limit = 2\nshift = 1\n${mainLine}\n`);
    sh('git -c user.name=t -c user.email=t@t commit -qam "new look"', project);
    return wt;
  }

  it('saves the work first, so main comes in and both changes are kept', async () => {
    const wt = ticketWithWork('limit = 3', 'next = yes');
    const { baseSha, clashes } = await bring();
    expect(clashes).toEqual([]);
    expect(sh('git rev-parse MERGE_HEAD', wt)).toBe(baseSha);
    expect(fs.readFileSync(path.join(wt, 'limit.txt'), 'utf8')).toBe('limit = 3\nshift = 1\nnext = yes\n');
    expect(fs.readFileSync(path.join(wt, 'hours.txt'), 'utf8')).toBe('open 9-5\n');
    expect(sh('git log --format=%s -1', wt)).toBe('Work so far on Raise the limit (AP-1)');
  });

  it('gives the clashing files to the Builder, and the same ones again until they are fixed', async () => {
    const wt = ticketWithWork('limit = 3', 'next = yes');
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 5\nshift = 1\nnext = yes\n');
    sh('git -c user.name=t -c user.email=t@t commit -qam "main limit"', project);
    expect((await bring()).clashes).toEqual(['limit.txt']);
    const head = sh('git rev-parse HEAD', wt);
    expect((await bring()).clashes).toEqual(['limit.txt']);
    expect(sh('git rev-parse HEAD', wt)).toBe(head);
  });
});
