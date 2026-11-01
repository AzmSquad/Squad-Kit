import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { addWorktree } from '../src/engine/git.js';
import { commitTicketDocs, hideSquadFromGit } from '../src/engine/project-git.js';
import type { Ticket } from '../src/board/types.js';

/** ADR-001 for a project whose `.squad/` sits inside its one repo. */

let tmp: string;
let project: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-docs-git-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', project);
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
    git: { base: 'main', remote: '' },
  });
  hideSquadFromGit(bp);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ticketInProgress(): Ticket {
  const wt = addWorktree(project, 'AP-1', 'main');
  const t: Ticket = {
    id: 'AP-1',
    title: 'Opening hours',
    ask: 'Owners set their hours',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: 'Building',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    story: 'As an owner, I want to set opening hours.',
    criteria: [{ given: 'a day', when: 'I save it', then: 'it is kept' }],
    specApproved: { by: 'Momen', at: new Date().toISOString() },
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
  };
  writeTicket(bp, t);
  return t;
}

describe('the project documents in git', () => {
  it('keeps .squad out of git status, without touching .gitignore', () => {
    ticketInProgress();
    expect(sh('git status --porcelain', project)).toBe('');
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('/.squad/');
  });

  it('commits the ticket on its own branch at each big moment, and its history shows them', () => {
    const t = ticketInProgress();
    expect(commitTicketDocs(bp, t, 'spec and design approved')).toBeTruthy();
    // Nothing new: nothing to commit.
    expect(commitTicketDocs(bp, t, 'spec and design approved')).toBeNull();

    fs.writeFileSync(path.join(t.worktree!, 'hours.ts'), 'export const hours = 1;\n');
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    actions.approve(bp, t.id);

    const log = sh('git log --format=%s main -- .squad/tickets/AP-1', project).split('\n');
    expect(log).toEqual(['Opening hours (AP-1)', 'AP-1: spec and design approved']);
    expect(sh('git show main:.squad/tickets/AP-1/spec.md', project)).toContain('**Given** a day, **when** I save it, **then** it is kept');
    expect(sh('git show main:.squad/tickets/AP-1/ticket.md', project)).toContain('stage: release');
    expect(readTicket(bp, t.id)!.mergedAt).toBeTruthy();
    // squad-kit's own files came through the merge as the board has them; nothing outside .squad changed.
    expect(readTicket(bp, t.id)!.activity.length).toBeGreaterThan(0);
    expect(sh("git status --porcelain --untracked-files=all -- . ':(exclude).squad'", project)).toBe('');
  });

  it('the release carries the project files, and leaves the checkout clean', async () => {
    const t = ticketInProgress();
    fs.writeFileSync(path.join(t.worktree!, 'hours.ts'), 'export const hours = 1;\n');
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.releaseNote = '**Hours.** Set opening hours.';
    });
    actions.approve(bp, t.id);
    const release = await actions.releaseVersion(bp);
    expect(sh('git log --format=%s -1 main', project)).toBe(`release ${release.version}`);
    expect(sh(`git show main:.squad/releases/${release.version}.md`, project)).toContain('Set opening hours');
    expect(sh('git show main:.squad/tickets/AP-1/ticket.md', project)).toContain('stage: done');
    expect(sh('git status --porcelain --untracked-files=all', project)).toBe('');
  });

  it('commits nothing when "Put project documents in git" is off', () => {
    writeMeta(bp, { ...readMeta(bp), documentsInGit: false });
    const t = ticketInProgress();
    expect(commitTicketDocs(bp, t, 'spec and design approved')).toBeNull();
    expect(sh('git log --format=%s squad/ap-1', project)).toBe('start');
  });
});
