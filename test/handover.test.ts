import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/** ADR-001, cases 1 and 2: a ticket handed to a teammate, who carries on from its pushed branch on a new computer. */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    fs.appendFileSync(path.join(opts.cwd, 'hours.ts'), '// finished\n');
    return { ok: true, structured: { summary: 'Finished' }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listDecisions, listTickets, readMeta, readTicket, updateTicket, writeDecision, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { commitTicketDocs, hideSquadFromGit } = await import('../src/engine/project-git.js');
const { carryOn, pickUpPushed } = await import('../src/engine/handover.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { isMine, ownerOf } = await import('../src/board/owner.js');
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

/** Runs as the person on one computer: squad-kit's folder on that computer is its own. */
function on(home: string): void {
  process.env.SQUAD_KIT_HOME = home;
}

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-handover-')));
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
    map: [{ area: 'Pages', detail: 'Static HTML' }],
    lessons: [],
    commands: { test: 'true' },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', summary: 'A small shop page.' },
  });
  hideSquadFromGit(bp);
  writeDecision(bp, { id: 'STACK.1', title: 'Plain HTML', why: 'Small', options: ['Plain HTML'], chosen: 'Plain HTML', from: 'Project scan', approvedBy: 'Momen', date: new Date().toISOString(), checkedBy: null, tickets: [] });
});

afterEach(() => {
  process.env.SQUAD_KIT_HOME = ownHome;
  // A git step the squad started may still be writing in the repo for a moment: try again rather than fail.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A ticket the Builder started on, with some work in its copy that is not committed yet. */
function building(): Ticket {
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
    waiting: { kind: 'stuck', summary: 'The squad stopped and needs you' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [{ at: new Date().toISOString(), who: 'builder', text: 'Started building' }],
    story: 'As an owner, I want to set opening hours.',
    criteria: [{ given: 'a day', when: 'I save it', then: 'it is kept' }],
    specApproved: { by: 'Momen', at: new Date().toISOString() },
    decision: { title: 'Hours in one file', options: [{ name: 'One file', note: '', chosen: true }], why: 'Simple', adr: 'AP-1.1' },
    follows: ['STACK.1'],
    steps: [{ title: 'Add the hours file', status: 'done' }, { title: 'Show the hours', status: 'todo' }],
    gates: { checks: 'pending', review: 'pending', proof: 'pending' },
    sessions: { build: 'session-on-a' },
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
  };
  writeTicket(bp, t);
  writeDecision(bp, { id: 'AP-1.1', title: 'Hours in one file', why: 'Simple', options: ['One file'], chosen: 'One file', from: id, approvedBy: 'Momen', date: new Date().toISOString(), checkedBy: null, tickets: [id] });
  commitTicketDocs(bp, t, 'spec and design approved');
  fs.writeFileSync(path.join(wt.dir, 'hours.ts'), 'export const hours = { mon: "9-5" };\n');
  return readTicket(bp, id)!;
}

/** Someone clones the project into a new folder, on a computer with an empty squad-kit folder, and opens the board. */
function cloneOnB(name = 'Sara Ali'): { root: string; bpB: BoardPaths; did: string[] } {
  const root = path.join(tmp, 'clone');
  sh(`git clone -q "${bare}" "${root}"`, tmp);
  sh(`git config user.name "${name}" && git config user.email s@s`, root);
  on(homeB);
  // As `squad console` does: a folder without squad-kit's settings gets them first.
  if (!fs.existsSync(path.join(root, '.squad', 'config.yaml'))) setupProject(root);
  const setup = ensureLiveBoard(boardPaths(path.join(root, '.squad')), 'clone');
  // The fake AI tool stands in for the direct runner.
  writeMeta(setup.bp, { ...readMeta(setup.bp), runner: 'direct' });
  return { root, bpB: setup.bp, did: setup.did };
}

describe('an owner on each ticket', () => {
  it('is the person who made it, kept in ticket.md so the team sees it', () => {
    const t = actions.createTicket(bp, { title: 'Holidays' });
    expect(t.owner).toBe('Momen');
    expect(fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8')).toMatch(/^owner: Momen$/m);
    fs.rmSync(bp.localDir, { recursive: true, force: true });
    expect(readTicket(bp, t.id)!.owner).toBe('Momen');
  });

  it('falls back to who made it for a ticket from before owners, and matches names loosely', () => {
    expect(ownerOf({ createdBy: 'Momen' })).toBe('Momen');
    expect(isMine({ createdBy: 'Momen', owner: ' sara ' }, { user: { name: 'Sara', role: '' } })).toBe(true);
    expect(isMine({ createdBy: 'Momen' }, { user: { name: 'Sara', role: '' } })).toBe(false);
  });
});

describe('hand over', () => {
  it('saves the work so far and the documents on the branch, pushes it, and names the new owner', async () => {
    building();
    const t = await actions.handOver(bp, id, { to: 'Sara', note: 'The hours file is done' });
    expect(t.owner).toBe('Sara');
    expect(t.handedOver).toMatchObject({ from: 'Momen', to: 'Sara' });
    expect(t.waiting).toBeNull();
    expect(t.squad).toBeNull();
    expect(t.status).toBe('With Sara');
    expect(t.notes!.at(-1)).toMatchObject({ by: 'Momen', text: 'The hours file is done' });
    // On the remote: the code so far, and the documents that name Sara.
    expect(sh('git log --format=%s squad/ap-1', bare).split('\n').slice(0, 2)).toEqual(['AP-1: handed over to Sara', 'Opening hours (AP-1): work so far']);
    expect(sh('git show squad/ap-1:hours.ts', bare)).toContain('9-5');
    expect(sh('git show squad/ap-1:.squad/tickets/AP-1/ticket.md', bare)).toMatch(/^owner: Sara$/m);
    expect(sh('git show squad/ap-1:.squad/decisions/AP-1.1.md', bare)).toContain('Hours in one file');
    // Nothing released yet, so the branch carries the settings, rules, knowledge and the decisions it follows.
    expect(sh('git show squad/ap-1:.squad/config.yaml', bare)).toContain(bp.projectId);
    expect(sh('git show squad/ap-1:.squad/knowledge/project.md', bare)).toContain('A small shop page.');
    expect(sh('git show squad/ap-1:.squad/decisions/STACK.1.md', bare)).toContain('Plain HTML');
    // Your own folder is never touched.
    expect(sh('git status --porcelain', project)).toBe('');
  });

  it('waits for running work, and only the owner hands over', async () => {
    building();
    updateTicket(bp, id, (x) => {
      x.live = true;
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
    });
    await expect(actions.handOver(bp, id, { to: 'Sara' })).rejects.toThrow(/working right now.*Stop/);
    updateTicket(bp, id, (x) => {
      x.live = false;
      x.squad = null;
    });
    await expect(actions.handOver(bp, id, { to: ' ' })).rejects.toThrow(/name/);
    await expect(actions.handOver(bp, id, { to: 'momen' })).rejects.toThrow(/yours already/);
    updateTicket(bp, id, (x) => (x.owner = 'Ali'));
    await expect(actions.handOver(bp, id, { to: 'Sara' })).rejects.toThrow(/Ali's/);
  });

  it('gives a ticket that is not built yet its branch, so the spec travels too', async () => {
    const t = actions.createTicket(bp, { title: 'Holidays' });
    updateTicket(bp, t.id, (x) => {
      x.live = false;
      x.squad = null;
      x.stage = 'specs';
      x.story = 'As an owner, I want holidays.';
      x.waiting = { kind: 'spec', summary: 'The spec is ready' };
    });
    const after = await actions.handOver(bp, t.id, { to: 'Sara' });
    expect(after.worktree).toBeUndefined();
    expect(after.branch).toBe(`squad/${t.id.toLowerCase()}`);
    expect(sh(`git show ${after.branch}:.squad/tickets/${t.id}/spec.md`, bare)).toContain('I want holidays');
  });

  it("stops this computer's squad on it: someone else's ticket never runs here", async () => {
    building();
    updateTicket(bp, id, (x) => {
      x.owner = 'Sara';
      x.waiting = null;
      x.squad = { phase: 'build', nextAt: new Date(0).toISOString() };
    });
    const squad = new LiveSquad(bp) as unknown as { tick(): void; running: Set<string>; pickingUp: boolean };
    squad.tick();
    expect(squad.running.has(id)).toBe(false);
    // The tick also looks for pushed branches in the background; let it finish before the repo goes.
    await vi.waitFor(() => expect(squad.pickingUp).toBe(false), { timeout: 15_000 });
  });
});

// Each one clones, hands over and runs squad steps with real git: on a busy machine that takes longer than the default 5 s.
describe('a new computer', { timeout: 20_000 }, () => {
  it('shows the same board from a clone, and the handed-over ticket carries on from its pushed branch', async () => {
    building();
    await actions.handOver(bp, id, { to: 'Sara' });
    const { root, bpB, did } = cloneOnB();
    // The same board: the project's id and settings, the decisions, the knowledge, so no new read of the project.
    expect(bpB.projectId).toBe(bp.projectId);
    expect(bpB.localDir.startsWith(homeB)).toBe(true);
    const meta = readMeta(bpB);
    expect(meta.user.name).toBe('Sara');
    expect(meta.commands).toEqual({ test: 'true' });
    expect(meta.scan?.status).toBe('done');
    expect(listDecisions(bpB).map((d) => d.id).sort()).toEqual(['AP-1.1', 'STACK.1']);
    expect(did.join('\n')).toMatch(/Picked up AP-1 from squad\/ap-1: Momen handed it over to you/);
    // The ticket, with its documents, owner and stage; none of the first computer's chats or progress.
    const t = readTicket(bpB, id)!;
    expect(listTickets(bpB).map((x) => x.id)).toEqual([id]);
    expect(t).toMatchObject({ owner: 'Sara', stage: 'implement', story: 'As an owner, I want to set opening hours.' });
    expect(t.sessions).toBeUndefined();
    expect(t.squad?.phase).toBe('pick-up');
    expect(t.activity[0]!.text).toMatch(/Chats, live progress and screenshots stayed on Momen's computer/);

    // Its copy of the code comes from the pushed branch, with the work so far.
    const squad = new LiveSquad(bpB) as unknown as { step(id: string, phase: string): Promise<void> };
    await squad.step(id, 'pick-up');
    const copy = readTicket(bpB, id)!;
    expect(copy.worktree!.startsWith(homeB)).toBe(true);
    expect(fs.readFileSync(path.join(copy.worktree!, 'hours.ts'), 'utf8')).toContain('9-5');
    expect(copy.baseCommit).toBe(sh('git rev-parse main', root));
    expect(copy.squad?.phase).toBe('build');

    // The Builder starts a fresh chat from the spec, the design and the code.
    await squad.step(id, 'build');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.sessionId).toBeTruthy();
    expect(calls[0]!.prompt).toMatch(/partly built already[\s\S]*hours\.ts/);
    const built = readTicket(bpB, id)!;
    expect(built.stage).toBe('test');
    expect(built.activity.some((a) => a.text === 'Started again from the spec, the design and the work so far')).toBe(true);
  });

  it('keeps the carried project files out of the merge: they reach the base with the release', async () => {
    building();
    await actions.handOver(bp, id, { to: 'Sara' });
    const { root, bpB } = cloneOnB();
    const squad = new LiveSquad(bpB) as unknown as { step(id: string, phase: string): Promise<void> };
    await squad.step(id, 'pick-up');
    updateTicket(bpB, id, (x) => {
      x.stage = 'review';
      x.squad = null;
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    actions.approve(bpB, id);
    expect(readTicket(bpB, id)!.mergedAt).toBeTruthy();
    expect(sh('git show main:hours.ts', root)).toContain('9-5');
    expect(sh('git show main:.squad/tickets/AP-1/ticket.md', root)).toMatch(/^owner: Sara$/m);
    expect(sh('git ls-tree --name-only main -- .squad/config.yaml .squad/knowledge .squad/decisions/STACK.1.md', root)).toBe('');
    expect(sh('git show main:.squad/decisions/AP-1.1.md', root)).toContain('Hours in one file');
  });

  it('after a release the base has the project files: the branch carries only the ticket, the clone the rest', async () => {
    // What a release commit puts on the base: the settings and what the project knows.
    sh('git add -f .squad/config.yaml .squad/knowledge .squad/decisions && git commit -q -m "release v0.1.0" && git push -q origin main', project);
    building();
    await actions.handOver(bp, id, { to: 'Sara' });
    expect(sh('git ls-tree -r --name-only squad/ap-1 -- .squad', bare).split('\n').filter((f) => !f.includes('/tickets/AP-1/'))).toEqual([
      '.squad/config.yaml',
      '.squad/decisions/AP-1.1.md',
      '.squad/decisions/STACK.1.md',
      '.squad/knowledge/project.md',
    ]);
    expect(sh('git diff --name-only main squad/ap-1 -- .squad', bare).split('\n').filter((f) => !f.includes('/tickets/AP-1/'))).toEqual(['.squad/decisions/AP-1.1.md']);
    const { bpB, did } = cloneOnB();
    expect(bpB.projectId).toBe(bp.projectId);
    expect(did[0]).toMatch(/^This computer: new for this project. The board comes from .squad\/: 1 ticket and 2 decisions/);
    expect(readTicket(bpB, id)).toMatchObject({ owner: 'Sara', squad: { phase: 'pick-up' } });
  });

  it('follows the base once the work is merged and pushed, and never lets the old branch roll it back', async () => {
    building();
    await actions.handOver(bp, id, { to: 'Sara' });
    const { root, bpB } = cloneOnB();
    const squad = new LiveSquad(bpB) as unknown as { step(id: string, phase: string): Promise<void> };
    await squad.step(id, 'pick-up');
    updateTicket(bpB, id, (x) => {
      x.stage = 'review';
      x.squad = null;
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    actions.approve(bpB, id);
    sh('git push -q origin main', root);
    // A third person clones: main has the accepted ticket; the old hand over branch is still on the remote.
    const third = path.join(tmp, 'third');
    sh(`git clone -q "${bare}" "${third}" && git -C "${third}" config user.name Ali`, tmp);
    on(path.join(tmp, 'home-c'));
    const bpC = boardPaths(path.join(third, '.squad'));
    fs.writeFileSync(bpC.configFile, `${sh('git show squad/ap-1:.squad/config.yaml', bare)}\n`);
    ensureLiveBoard(boardPaths(bpC.squadDir), 'third');
    expect(readTicket(boardPaths(bpC.squadDir), id)).toMatchObject({ stage: 'release', owner: 'Sara' });
    // The first computer sees Sara's accepted work once she pushed it, from the base.
    on(homeA);
    sh('git fetch -q origin', project);
    expect(pickUpPushed(bp)).toEqual([{ id, branch: 'main', kind: 'follow', mine: false }]);
    expect(readTicket(bp, id)).toMatchObject({ stage: 'release', owner: 'Sara', status: 'With Sara' });
    expect(pickUpPushed(bp)).toEqual([]);
  });

  it("shows someone else's ticket with its owner, and leaves it to them", async () => {
    building();
    await actions.handOver(bp, id, { to: 'Ali' });
    const { bpB } = cloneOnB('Sara');
    const t = readTicket(bpB, id)!;
    expect(t.owner).toBe('Ali');
    expect(t.status).toBe('With Ali');
    expect(t.squad).toBeNull();
  });

  it('a ticket handed back carries on from the newest work on the first computer too', async () => {
    building();
    await actions.handOver(bp, id, { to: 'Sara' });
    const { bpB } = cloneOnB();
    const squad = new LiveSquad(bpB) as unknown as { step(id: string, phase: string): Promise<void> };
    await squad.step(id, 'pick-up');
    await squad.step(id, 'build');
    updateTicket(bpB, id, (x) => {
      x.live = false;
      x.squad = null;
    });
    await actions.handOver(bpB, id, { to: 'Momen' });

    on(homeA);
    sh('git fetch -q origin', project);
    expect(pickUpPushed(bp)).toEqual([{ id, branch: 'squad/ap-1', kind: 'handed', mine: true, from: 'Sara' }]);
    const back = readTicket(bp, id)!;
    expect(back.owner).toBe('Momen');
    expect(back.sessions).toBeUndefined();
    expect(back.squad?.phase).toBe('pick-up');
    // The copy on this computer moved on to the work done on the other one.
    expect(fs.readFileSync(path.join(back.worktree!, 'hours.ts'), 'utf8')).toContain('// finished');
    // Nothing new: nothing to pick up again.
    expect(pickUpPushed(bp)).toEqual([]);
  });
});

describe('where a ticket carries on from its documents alone', () => {
  const base = { id, title: 'X', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', status: '', waiting: null, createdAt: '', createdBy: 'M', activity: [] } as unknown as Ticket;
  it('waits for you, or runs the next step, as the stage and the documents say', () => {
    expect(carryOn({ ...base, stage: 'tickets' }, false).phase).toBe('analyst-read');
    expect(carryOn({ ...base, stage: 'specs', questions: [{ id: 'q1', from: 'analyst', text: '?', options: ['a'] }] }, false).waiting?.kind).toBe('questions');
    expect(carryOn({ ...base, stage: 'specs', questions: [], story: 'S' }, false).waiting?.kind).toBe('spec');
    expect(carryOn({ ...base, stage: 'specs', story: 'S', specApproved: { by: 'M', at: '' } }, false).phase).toBe('plan-write');
    expect(carryOn({ ...base, stage: 'specs', story: 'S', specApproved: { by: 'M', at: '' }, steps: [{ title: 'a', status: 'todo' }] }, false).waiting?.kind).toBe('plan');
    expect(carryOn({ ...base, stage: 'implement' }, false).phase).toBe('pick-up');
    expect(carryOn({ ...base, stage: 'implement' }, true).phase).toBe('build');
    expect(carryOn({ ...base, stage: 'review', gates: { checks: 'pass', review: 'pass', proof: 'pass' } }, true).phase).toBe('proof');
    expect(carryOn({ ...base, stage: 'release' }, true).phase).toBeUndefined();
  });
});
