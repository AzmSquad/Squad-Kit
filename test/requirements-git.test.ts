import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { addWorktree } from './support/copy.js';
import { commitTicketDocs, hideSquadFromGit } from '../src/engine/project-git.js';
import { findItem, updateBreakdown, writeBreakdown } from '../src/board/requirements.js';
import type { Breakdown } from '../src/board/requirements-types.js';
import type { Ticket } from '../src/board/types.js';

/**
 * The breakdown in git: its folder goes into its stories' commits the way a ticket's own documents do, so it is in
 * git once the first story merges, and stories built side by side never clash on it.
 */

let tmp: string;
let project: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-git-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
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
  const crit = [{ given: 'a room', when: 'I book it', then: 'it is mine' }];
  const b: Breakdown = {
    id: 'BR-1',
    title: 'RoomFlow BRD v2',
    status: 'approved',
    source: { file: 'source/pasted.md', name: 'Pasted text', kind: 'pasted', bytes: 20, addedBy: 'Momen', addedAt: new Date().toISOString() },
    questions: [],
    decided: [],
    leftOut: [],
    approved: { by: 'Momen', at: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    next: { epic: 2, feature: 1, story: 4 },
    epics: [
      {
        key: 'E-1',
        title: 'Booking',
        features: [],
        stories: ['Search rooms', 'Book a room', 'Cancel a booking'].map((title, i) => ({ key: `S-${i + 1}`, title, story: title, criteria: crit, size: 'M' as const, dependsOn: [] })),
      },
    ],
  };
  writeBreakdown(bp, b);
  fs.mkdirSync(path.join(bp.squadDir, 'requirements', 'BR-1', 'source'), { recursive: true });
  fs.writeFileSync(path.join(bp.squadDir, 'requirements', 'BR-1', 'source', 'pasted.md'), '# RoomFlow BRD v2\n\nGuests book rooms.\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A story's ticket in progress, in its own copy of the code from main. */
function story(n: number): Ticket {
  const id = `AP-${n}`;
  const wt = addWorktree(project, id, 'main');
  const t: Ticket = {
    id,
    title: `Story ${n}`,
    ask: `Story ${n}`,
    kind: 'feature',
    track: 'auto',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: 'Building',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    story: `Story ${n}`,
    criteria: [{ given: 'a room', when: 'I book it', then: 'it is mine' }],
    specApproved: { by: 'Momen', at: new Date().toISOString() },
    breakdown: { id: 'BR-1', item: `S-${n}` },
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
  };
  writeTicket(bp, t);
  updateBreakdown(bp, 'BR-1', (x) => (findItem(x, `S-${n}`)!.story!.ticket = id));
  return t;
}

/** Built and accepted: its code and its documents merge into main. */
function accept(t: Ticket): Ticket {
  fs.writeFileSync(path.join(t.worktree!, `story-${t.id}.ts`), `export const id = '${t.id}';\n`);
  updateTicket(bp, t.id, (x) => {
    x.stage = 'review';
    x.waiting = { kind: 'proof', summary: 'The proof is ready' };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
  });
  actions.approve(bp, t.id);
  return readTicket(bp, t.id)!;
}

const inMain = (file: string) => sh(`git show main:.squad/requirements/BR-1/${file}`, project);

// Real git worktrees and merges: slow on a busy machine.
const SLOW = 90_000;

describe('the breakdown in git', () => {
  it("goes into a story's commits, and is in main once the first story merges", async () => {
    const t = story(1);
    expect(await commitTicketDocs(bp, t, 'plan approved')).toBeTruthy();
    expect(sh('git show --name-only --format= squad/ap-1', project).split('\n')).toEqual(expect.arrayContaining(['.squad/requirements/BR-1/breakdown.yaml', '.squad/requirements/BR-1/source/pasted.md']));
    expect(sh('git ls-tree -r --name-only main', project)).not.toContain('requirements');
    expect(accept(t).mergedAt).toBeTruthy();
    expect(inMain('breakdown.yaml')).toContain('ticket: AP-1');
    expect(inMain('source/pasted.md')).toContain('Guests book rooms.');
  }, SLOW);

  it('never clashes when two stories built side by side both carry it', async () => {
    const a = story(1);
    const b = story(2);
    await commitTicketDocs(bp, a, 'plan approved');
    await commitTicketDocs(bp, b, 'plan approved');
    expect(accept(a).mergedAt).toBeTruthy();
    const first = inMain('breakdown.yaml');
    // The breakdown changed since; B's copy started before main had one, so B keeps main's.
    updateBreakdown(bp, 'BR-1', (x) => (findItem(x, 'S-2')!.story!.title = 'Book a room now'));
    const b2 = accept(b);
    expect(b2.waiting).toBeNull();
    expect(b2.mergedAt).toBeTruthy();
    expect(inMain('breakdown.yaml')).toBe(first);
    // A story that starts from main as it is now brings the newer copy.
    const c = story(3);
    expect(accept(c).mergedAt).toBeTruthy();
    expect(inMain('breakdown.yaml')).toContain('title: Book a room now');
    expect(inMain('breakdown.yaml')).toContain('ticket: AP-3');
  }, SLOW);

  it("keeps the remote's newer copy when the team merged a story elsewhere, so the pull request never clashes on it", async () => {
    // The team's main, on the remote, already has the breakdown (a story merged from another computer); this
    // computer's main does not have it yet.
    const remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main ${remote}`, tmp);
    sh(`git remote add origin ${remote} && git push -q origin main`, project);
    const other = path.join(tmp, 'other');
    sh(`git clone -q ${remote} ${other}`, tmp);
    fs.mkdirSync(path.join(other, '.squad', 'requirements', 'BR-1'), { recursive: true });
    fs.writeFileSync(path.join(other, '.squad', 'requirements', 'BR-1', 'breakdown.yaml'), 'id: BR-1\ntitle: As the team merged it\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "S-9 from another computer" && git push -q origin main', other);
    sh('git fetch -q origin', project);
    expect(sh('git ls-tree -r --name-only main', project)).not.toContain('requirements');

    const t = story(1);
    expect(await commitTicketDocs(bp, t, 'plan approved')).toBeTruthy();
    // The branch carries the remote's copy, not this computer's newer one: the two agree, so they merge cleanly.
    expect(sh('git show squad/ap-1:.squad/requirements/BR-1/breakdown.yaml', project)).toBe('id: BR-1\ntitle: As the team merged it');
    expect(() => sh('git merge-tree --write-tree origin/main squad/ap-1', project)).not.toThrow();
  }, SLOW);

  it('adds nothing when the project keeps its documents out of git', async () => {
    writeMeta(bp, { ...readMeta(bp), documentsInGit: false });
    const t = story(1);
    expect(await commitTicketDocs(bp, t, 'plan approved')).toBeNull();
    expect(accept(t).mergedAt).toBeTruthy();
    expect(sh('git ls-tree -r --name-only main', project)).not.toContain('.squad');
  }, SLOW);
});
