import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { addWorktree } from '../src/engine/git.js';
import { keyFor } from '../src/engine/setup.js';
import { findNestedRepos } from '../src/engine/repos.js';

let tmp: string;
let project: string;
let remote: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-release-'));
  project = path.join(tmp, 'app');
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(project);
  sh(`git init -q --bare -b main ${remote}`, tmp);
  sh(`git init -q -b main && git remote add origin ${remote}`, project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.4.2' }, null, 2));
  commit(project, 'start');
  sh('git push -q origin main', project);
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

describe('live release', () => {
  it('commits on proof, then merges, tags and pushes on release', async () => {
    const wt = addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(wt.dir, 'hello.txt'), 'hello\n');
    writeTicket(bp, {
      id: 'AP-1',
      title: 'Say hello',
      ask: 'A hello file',
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
      releaseNote: '**Hello.** A hello file.',
      gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    });

    actions.approve(bp, 'AP-1');
    expect(readTicket(bp, 'AP-1')!.release).toBe('v1.5.0');
    // Merge on accept: main has the change right away, so the next ticket starts from it. Nothing is pushed yet.
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1 main', project)).toBe('Merge Say hello (AP-1)');
    expect(fs.existsSync(path.join(project, 'hello.txt'))).toBe(true);
    expect(sh('git log --format=%s -1 main', remote)).toBe('start');
    const next = addWorktree(project, 'AP-2', 'main');
    expect(fs.existsSync(path.join(next.dir, 'hello.txt'))).toBe(true);

    const release = await actions.releaseVersion(bp);
    expect(release.from).toBe('v1.4.2');
    expect(release.log?.every((l) => l.ok)).toBe(true);
    expect(sh('git tag', remote)).toBe('v1.5.0');
    expect(sh('git log --format=%s main', remote).split('\n')[0]).toBe('release v1.5.0');
    expect(fs.readFileSync(path.join(project, 'CHANGELOG.md'), 'utf8')).toContain('**Hello.** A hello file.');
    expect(JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version).toBe('1.5.0');
    expect(fs.existsSync(wt.dir)).toBe(false);
  });
});

describe('workspace helpers', () => {
  it('makes short ticket keys from project names', () => {
    expect(keyFor('moj-taqadi')).toBe('MT');
    expect(keyFor('Leave requests')).toBe('LR');
    expect(keyFor('shop')).toBe('SH');
  });

  it('finds code repos one level down', () => {
    const api = path.join(project, 'api');
    fs.mkdirSync(api);
    sh('git init -q -b development', api);
    expect(findNestedRepos(project).map((r) => [r.path, r.base])).toEqual([['api', 'development']]);
  });
});
