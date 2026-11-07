import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A ticket a teammate deleted on their computer. Only its owner may delete it; their delete shows on the remote as a
 * note on the branch they kept, or as the branch gone while the ticket never reached main. The other board then shows
 * "Deleted by <owner>", and Remove from my board cleans that computer only, never anyone's unpushed work. Real git,
 * a bare repo as the remote, two squad-kit homes as two computers. No agent runs.
 */

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, structured: { summary: 'Done' }, sessionId: opts.sessionId } as RunResult),
}));

const { boardPaths, readMeta, readTicket, writeDecision, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { addWorktree } = await import('../src/engine/git.js');
const { commitTicketDocs, hideSquadFromGit } = await import('../src/engine/project-git.js');
const { fetchPushed, pickUpPushed } = await import('../src/engine/handover.js');
const { deletePlan, deleteTicket } = await import('../src/engine/delete.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
type Ticket = import('../src/board/types.js').Ticket;
type BoardPaths = import('../src/board/store.js').BoardPaths;

const ownHome = process.env.SQUAD_KIT_HOME;
let tmp: string;
let homeA: string;
let homeB: string;
let bare: string;
let project: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const id = 'AP-1';
const on = (home: string) => void (process.env.SQUAD_KIT_HOME = home);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-teammate-')));
  homeA = path.join(tmp, 'home-a');
  homeB = path.join(tmp, 'home-b');
  bare = path.join(tmp, 'remote.git');
  project = path.join(tmp, 'app');
  sh(`git init -q --bare -b main "${bare}"`, tmp);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>Shop</h1>\n');
  sh(`git init -q -b main && git config user.name "Momen Y" && git config user.email m@m && git add -A && git commit -q -m start && git remote add origin "${bare}" && git push -q origin main`, project);
  on(homeA);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: 'true' },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', summary: 'A small shop page.' },
  });
  hideSquadFromGit(bp);
});

afterEach(() => {
  process.env.SQUAD_KIT_HOME = ownHome;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Momen builds AP-1 a little and hands it over to Sara: its branch, code and documents are on the remote. */
async function handedToSara(): Promise<void> {
  const wt = addWorktree(project, id, 'main');
  const t: Ticket = {
    id,
    title: 'Opening hours',
    ask: 'Owners set their hours',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: 'Stopped, needs you',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [],
    story: 'As an owner, I want to set opening hours.',
    specApproved: { by: 'Momen', at: new Date().toISOString() },
    steps: [{ title: 'Add the hours file', status: 'done' }],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
  };
  writeTicket(bp, t);
  writeDecision(bp, { id: 'AP-1.1', title: 'Hours in one file', why: 'Simple', options: ['One file'], chosen: 'One file', from: id, approvedBy: 'Momen', date: new Date().toISOString(), checkedBy: null, tickets: [id] });
  commitTicketDocs(bp, t, 'spec approved');
  fs.writeFileSync(path.join(wt.dir, 'hours.ts'), 'export const hours = { mon: "9-5" };\n');
  await actions.handOver(bp, id, { to: 'Sara' });
}

/** Sara's computer: a clone of the project, which picks up the ticket handed to her. */
function saraClones(): BoardPaths {
  const root = path.join(tmp, 'clone');
  sh(`git clone -q "${bare}" "${root}"`, tmp);
  sh('git config user.name "Sara Ali" && git config user.email s@s', root);
  on(homeB);
  if (!fs.existsSync(path.join(root, '.squad', 'config.yaml'))) setupProject(root);
  const setup = ensureLiveBoard(boardPaths(path.join(root, '.squad')), 'clone');
  writeMeta(setup.bp, { ...readMeta(setup.bp), runner: 'direct', user: { name: 'Sara', role: 'Developer' } });
  return setup.bp;
}

// Real git with two clones and a remote: on a busy machine each takes longer than the default limit.
describe('a ticket its owner deleted on their computer', { timeout: 60_000 }, () => {
  it('shows as "Deleted by Sara" from the note her delete leaves on the branch, and leaves my board on my say', async () => {
    await handedToSara();
    const bpB = saraClones();
    expect(readTicket(bpB, id)!.owner).toBe('Sara');

    // Sara deletes it, keeping the branch on the remote: her delete leaves a note there instead of the ticket's files.
    const plan = deletePlan(bpB, id);
    expect(plan.stays).toContain("Its saved work in your team's shared copy of the code, with a note that you deleted AP-1, so teammates' boards show it as deleted.");
    const r = await deleteTicket(bpB, id);
    expect(r.notes).toEqual(["Left a note on squad/ap-1 on origin, so teammates' boards show AP-1 as deleted"]);
    expect(sh('git log -1 --format=%s squad/ap-1', bare)).toBe('AP-1: deleted by Sara');
    expect(sh('git show squad/ap-1:.squad/tickets/AP-1/deleted.md', bare)).toMatch(/by: Sara/);
    expect(sh('git ls-tree --name-only squad/ap-1 .squad/tickets/AP-1/', bare)).toBe('.squad/tickets/AP-1/deleted.md');
    // The code on the branch is kept as it was.
    expect(sh('git show squad/ap-1:hours.ts', bare)).toContain('9-5');

    // On my computer: the next look at the remote marks it.
    on(homeA);
    expect(deletePlan(bp, id).refused).toBe("AP-1 is Sara's. Only Sara can delete it.");
    await fetchPushed(bp);
    const t = readTicket(bp, id)!;
    expect(t.ownerDeleted).toMatchObject({ by: 'Sara', how: 'note', branch: 'squad/ap-1' });
    expect(t.status).toBe('Deleted by Sara');
    expect(t.activity[0]!.text).toMatch(/Sara deleted it on their computer/);

    // Remove from my board: this computer's parts only. My branch's commits are all on the remote, so it can go.
    const local = deletePlan(bp, id);
    expect(local).toMatchObject({ local: { by: 'Sara' }, remote: false, command: 'squad delete AP-1' });
    expect(local.refused).toBeUndefined();
    expect(local.removes).toEqual([
      'AP-1 from your board: its files, notes and questions on this computer',
      'Its copy of the code on this computer',
      'Its decision AP-1.1, "Hours in one file", on this computer',
    ]);
    expect(local.stays[0]).toBe("Everything on the remote: squad-kit pushes and deletes nothing there. Sara's delete is theirs.");
    const tip = sh('git rev-parse squad/ap-1', bare);
    const done = await deleteTicket(bp, id);
    expect(done.notes).toEqual([]);
    expect(readTicket(bp, id)).toBeNull();
    expect(sh('git branch --list "squad/*"', project)).toBe('');
    // Nothing changed on the remote, and the person's own folder is untouched.
    expect(sh('git rev-parse squad/ap-1', bare)).toBe(tip);
    expect(sh('git status --porcelain', project)).toBe('');
    expect(readMeta(bp).deleted?.at(-1)).toMatchObject({ id, fromBoard: true });
    // The note on the branch does not bring it back.
    expect(pickUpPushed(bp)).toEqual([]);
  });

  it('shows as deleted when its branch is gone and it never reached main, and keeps my unpushed commits', async () => {
    await handedToSara();
    // My board saw it on the remote.
    await fetchPushed(bp);
    expect(readTicket(bp, id)!.seenOn).toBe('origin/squad/ap-1');

    const bpB = saraClones();
    const r = await deleteTicket(bpB, id, { remote: true });
    expect(r.notes).toEqual(['Deleted squad/ap-1 on origin']);

    on(homeA);
    // A look that could not reach the remote proves nothing.
    sh(`git remote set-url origin "${path.join(tmp, 'nowhere.git')}"`, project);
    await fetchPushed(bp);
    expect(readTicket(bp, id)!.ownerDeleted).toBeUndefined();
    sh(`git remote set-url origin "${bare}"`, project);
    await fetchPushed(bp);
    const t = readTicket(bp, id)!;
    expect(t.ownerDeleted).toMatchObject({ by: 'Sara', how: 'gone', branch: 'squad/ap-1' });
    expect(t.status).toBe('Deleted by Sara');

    // My branch's commits are on no remote now: Remove from my board keeps the branch and says how to drop it.
    const plan = deletePlan(bp, id);
    expect(plan.removes).toContain('Its copy of the code on this computer');
    expect(plan.stays).toContain('The branch squad/ap-1 on this computer, because it has commits that are on no remote. If you no longer need them: git branch -D squad/ap-1');
    const done = await deleteTicket(bp, id);
    expect(done.notes).toEqual(['Kept the branch squad/ap-1 on this computer, because it has commits that are on no remote. If you no longer need them: git branch -D squad/ap-1']);
    expect(readTicket(bp, id)).toBeNull();
    expect(sh('git branch --list "squad/*"', project)).toContain('squad/ap-1');
    expect(sh('git show squad/ap-1:hours.ts', project)).toContain('9-5');
  });

  it('keeps a copy with changes that are not committed', async () => {
    await handedToSara();
    await fetchPushed(bp);
    sh('git push -q origin --delete squad/ap-1', project);
    await fetchPushed(bp);
    const t = readTicket(bp, id)!;
    expect(t.ownerDeleted?.how).toBe('gone');
    fs.writeFileSync(path.join(t.worktree!, 'draft.ts'), '// not committed\n');
    const plan = deletePlan(bp, id);
    expect(plan.removes).not.toContain('Its copy of the code on this computer');
    expect(plan.stays).toContain(`Its copy of the code at ${t.worktree}, because it has changes that are not committed`);
    await deleteTicket(bp, id);
    expect(fs.readFileSync(path.join(t.worktree!, 'draft.ts'), 'utf8')).toContain('not committed');
  });

  it('is theirs again when the branch comes back', async () => {
    await handedToSara();
    await fetchPushed(bp);
    sh('git push -q origin --delete squad/ap-1', project);
    await fetchPushed(bp);
    expect(readTicket(bp, id)!.ownerDeleted?.how).toBe('gone');
    sh('git push -q origin squad/ap-1', project);
    await fetchPushed(bp);
    const t = readTicket(bp, id)!;
    expect(t.ownerDeleted).toBeUndefined();
    expect(t.status).toBe('With Sara');
    expect(deletePlan(bp, id).refused).toBe("AP-1 is Sara's. Only Sara can delete it.");
  });

  it('never marks a ticket the remote never had, nor one that reached main', async () => {
    // Someone else's ticket on this board that was never on the remote (a renamed person, a copied folder).
    writeTicket(bp, { id: 'AP-5', title: 'Never pushed', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: 'With Ali', waiting: null, createdAt: new Date().toISOString(), createdBy: 'Ali', owner: 'Ali', activity: [] });
    // And one that is merged: its files are in main.
    writeTicket(bp, { id: 'AP-6', title: 'Merged', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'release', status: 'Merged', waiting: null, createdAt: new Date().toISOString(), createdBy: 'Ali', owner: 'Ali', activity: [], mergedAt: new Date().toISOString(), seenOn: 'origin/squad/ap-6' });
    await fetchPushed(bp);
    expect(readTicket(bp, 'AP-5')!.ownerDeleted).toBeUndefined();
    expect(readTicket(bp, 'AP-6')!.ownerDeleted).toBeUndefined();
    await expect(deleteTicket(bp, 'AP-5')).rejects.toThrow("AP-5 is Ali's. Only Ali can delete it.");
  });
});
