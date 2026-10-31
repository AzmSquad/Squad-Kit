import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readMeta, readTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import { LiveSquad } from '../src/engine/live.js';
import * as actions from '../src/board/actions.js';
import { addWorktree } from '../src/engine/git.js';

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
    expect(t.status).toBe('Ready for v0.1.0 · main not moved yet');
    expect(readTicket(bp, 'AP-1')!.activity[1]!.text).toMatch(/^Could not move main yet\. Your main checkout was not moved .*Run: git merge --ff-only /);
    expect(sh('git log --format=%s -1 main', project)).toBe('start');
    expect(fs.readFileSync(path.join(project, 'limit.txt'), 'utf8')).toBe('limit = 9\n');
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
    expect(after.activity[0]!.text).toMatch(/^Your copy of the code is ready: ran echo installed > setup.log \(\d+ s\)$/);
  });

  it('says so when the setup fails, and can try again', async () => {
    setup('echo no network >&2; exit 3');
    proofReady();
    actions.approve(bp, 'AP-1');
    await run('AP-1');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.localSetup).toMatchObject({ status: 'failed', output: expect.stringContaining('no network') });
    expect(actions.setUpLocalCopy(bp, 'AP-1').localSetup?.status).toBe('pending');
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

