import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import { findSquadRoot, requireSquadRoot } from '../src/core/paths.js';
import { runInit } from '../src/commands/init.js';
import { prepareProject } from '../src/engine/setup.js';
import { LiveSquad } from '../src/engine/live.js';
import * as actions from '../src/board/actions.js';
import { ensureRepo, repairCopyLink } from '../src/engine/git.js';
import { addWorktree } from './support/copy.js';

let tmp: string;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-moved-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function liveMeta(bp: BoardPaths) {
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
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
}

describe('a project folder moved with open tickets', () => {
  let project: string;
  let copy: string;

  beforeEach(() => {
    project = path.join(tmp, 'app');
    fs.mkdirSync(project);
    sh('git init -q -b main', project);
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
    const bp = boardPaths(path.join(project, '.squad'));
    liveMeta(bp);
    const wt = addWorktree(project, 'AP-1', 'main');
    copy = wt.dir;
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
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
  });

  it('the copy has lost its link until it is repaired, and Looks right repairs it and merges', () => {
    const moved = path.join(tmp, 'moved-app');
    fs.renameSync(project, moved);
    expect(() => sh('git status', copy)).toThrow();
    const bp = boardPaths(path.join(moved, '.squad'));
    const t = actions.approve(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1 main', moved)).toBe('Merge Raise the limit (AP-1)');
    expect(fs.readFileSync(path.join(moved, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
  });

  it('the squad reconnects open tickets as it starts, and says so on the ticket', () => {
    const moved = path.join(tmp, 'moved-app');
    fs.renameSync(project, moved);
    const bp = boardPaths(path.join(moved, '.squad'));
    const stop = new LiveSquad(bp).start(60_000);
    stop();
    expect(sh('git status --porcelain', copy)).toContain('limit.txt');
    expect(readTicket(bp, 'AP-1')!.activity.map((a) => a.text).join('\n')).toContain("The project's folder moved, so squad-kit reconnected this ticket's copy");
  });

  it('does nothing to a copy that works, and says false for one that is gone', () => {
    expect(repairCopyLink(project, copy)).toBe(true);
    expect(repairCopyLink(project, path.join(tmp, 'nowhere'))).toBe(false);
  });
});

describe('a terminal open in the home folder', () => {
  let home: string;

  beforeEach(() => {
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, 'Documents', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Documents', 'private.txt'), 'private\n');
    vi.stubEnv('HOME', home);
  });

  it('squad init refuses there, so no .squad is made', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    await expect(runInit({ yes: true })).rejects.toThrow(/inside a project folder, not your home folder/);
    expect(fs.existsSync(path.join(home, '.squad'))).toBe(false);
  });

  it('a board command there no longer sends the person to squad init', () => {
    expect(() => requireSquadRoot(home)).toThrow(/Open the terminal in your project folder/);
    expect(() => requireSquadRoot(home)).not.toThrow(/squad init/);
  });

  it('a .squad left in home opens nothing: not home, and not the folders under it', () => {
    fs.mkdirSync(path.join(home, '.squad'));
    fs.writeFileSync(path.join(home, '.squad', 'config.yaml'), 'project:\n  name: home\n');
    expect(findSquadRoot(home)).toBeNull();
    expect(findSquadRoot(path.join(home, 'Documents', 'notes'))).toBeNull();
    // A real project under home still works.
    const app = path.join(home, 'Documents', 'app');
    fs.mkdirSync(path.join(app, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(app, '.squad', 'config.yaml'), 'project:\n  name: app\n');
    expect(findSquadRoot(path.join(app, 'src'))).toBe(app);
  });

  it('setting up home never puts it into git, even with a .squad there already', () => {
    fs.mkdirSync(path.join(home, '.squad'));
    fs.writeFileSync(path.join(home, '.squad', 'config.yaml'), 'project:\n  name: home\n');
    expect(() => prepareProject(home)).toThrow(/inside a project folder/);
    expect(fs.existsSync(path.join(home, '.git'))).toBe(false);
  });

  it('the first commit itself refuses the home folder', () => {
    expect(() => ensureRepo(home, 'home')).toThrow(/not your home folder/);
    expect(fs.existsSync(path.join(home, '.git'))).toBe(false);
  });
});

describe('a project folder that moved while the app runs', () => {
  it('can be added again from Home: the app follows it, and the squad at the old place ends', async () => {
    const { OpenProjects } = await import('../src/console/open-projects.js');
    const { setupProject, ensureLiveBoard } = await import('../src/engine/setup.js');
    const project = path.join(tmp, 'shop');
    fs.mkdirSync(project);
    sh('git init -q -b main', project);
    fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
    setupProject(project);
    ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'Shop');
    const projects = new OpenProjects({ token: 'a'.repeat(64), control: { startedAt: new Date().toISOString(), build: 0, restart: () => undefined }, info: () => ({ pid: process.pid, port: 1, token: 't', startedAt: new Date().toISOString(), version: '1', build: 0 }), remember: false } as never);
    const first = projects.add(project);
    const moved = path.join(tmp, 'shop-moved');
    fs.renameSync(project, moved);
    const again = projects.add(moved);
    expect(again.project.root).toBe(moved);
    expect(again.project.id).toBe(first.project.id);
    expect(projects.all()).toHaveLength(1);
    // Two real copies at once are still refused.
    fs.cpSync(moved, project, { recursive: true });
    expect(() => projects.add(project)).toThrow(/open already/);
    projects.closeAll();
  }, 30_000);
});
