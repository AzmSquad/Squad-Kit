import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Delete and Archive (build plan phase 8). Delete takes every part of a ticket that is not merged away, after its
 * squad stopped, and keeps its cost in Usage; a delete cut off half-way finishes when it runs again. Archive takes a
 * merged ticket off the board and Unarchive brings it back.
 */

/** Runs the squad started; with `block` on, each waits until it is stopped, like a long step. */
const runs: { opts: RunOptions; filesThere?: boolean }[] = [];
let block = false;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    const run: (typeof runs)[number] = { opts };
    runs.push(run);
    if (!block) return { ok: true, structured: { questions: [] }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // The delete must wait for this: the ticket is still all there when the run ends.
    run.filesThere = fs.existsSync(path.join(bp.ticketsDir, 'AP-1', 'ticket.md'));
    return { ok: false, error: 'You stopped the squad.', text: '', sessionId: opts.resume ?? opts.sessionId ?? '' } as RunResult;
  },
}));

const store = await import('../src/board/store.js');
const { boardPaths, listDecisions, listTickets, readMeta, readTicket, ticketDir, ticketMediaDir, ticketStateFile, updateTicket, writeDecision, writeMeta, writeRelease, writeTicket } = store;
const { archiveTicket, deletePlan, deleteTicket, unarchiveTicket } = await import('../src/engine/delete.js');
const { addSnapshot, addWorktree, commitAll, worktreeRoot } = await import('../src/engine/git.js');
const { commitTicketDocs, hideSquadFromGit } = await import('../src/engine/project-git.js');
const { pickUpPushed } = await import('../src/engine/handover.js');
const { LiveSquad, agentRuns } = await import('../src/engine/live.js');
const { boardUsage } = await import('../src/board/usage.js');
const { holdRelease } = await import('../src/board/lock.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { buildPaths } = await import('../src/core/paths.js');
const { mountApi } = await import('../src/console/api/index.js');
type Ticket = import('../src/board/types.js').Ticket;
type BoardPaths = import('../src/board/store.js').BoardPaths;

let tmp: string;
let bare: string;
let project: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const at = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  runs.length = 0;
  block = false;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-delete-')));
  bare = path.join(tmp, 'remote.git');
  project = path.join(tmp, 'app');
  sh(`git init -q --bare -b main "${bare}"`, tmp);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>Shop</h1>\n');
  sh(`git init -q -b main && git add -A && git commit -q -m start && git remote add origin "${bare}" && git push -q origin main`, project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 10,
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
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function ticket(id: string, over: Partial<Ticket> = {}): Ticket {
  const t: Ticket = {
    id,
    title: `Ticket ${id}`,
    ask: 'Owners set their hours',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: 'Stopped, needs you',
    waiting: null,
    createdAt: at(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [],
    ...over,
  };
  writeTicket(bp, t);
  return readTicket(bp, id)!;
}

/** A ticket the Builder worked on: its copy of the code, a commit on its branch, and work not committed yet. */
function built(id: string, over: Partial<Ticket> = {}): Ticket {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'hours.ts'), 'export const hours = 1;\n');
  commitAll(wt.dir, `${id}: hours`);
  fs.writeFileSync(path.join(wt.dir, 'draft.ts'), '// not committed\n');
  return ticket(id, { worktree: wt.dir, branch: wt.branch, baseCommit: wt.baseCommit, ...over });
}

const usage = (cost: number) => [{ role: 'builder' as const, step: 'build', level: 'strongest' as const, model: 'Opus', runs: 2, inputTokens: 1000, outputTokens: 100, costUsd: cost }];
const decision = (id: string, from: string, over: Record<string, unknown> = {}) =>
  writeDecision(bp, { id, title: `Decision ${id}`, why: 'Simple', options: ['A'], chosen: 'A', from, approvedBy: 'Momen', date: at(), checkedBy: null, tickets: [from], ...over });
const branches = () => sh('git branch --list "squad/*"', project);

describe('Delete', () => {
  it('removes every part of a ticket that is not merged, and its cost stays in Usage', async () => {
    const mainBefore = sh('git rev-parse main', project);
    const t = built('AP-1', {
      source: { type: 'azure', ref: 'AB#7', id: '7' },
      sessions: { intake: 'session-intake-1', build: 'session-build-1' },
      proof: [{ criterion: 'Hours show', before: 'ap-1-before-1.png', after: 'ap-1-after-1.png', beforeLabel: 'Before', afterLabel: 'After', more: [{ after: 'named-extra.png' }, { after: 'shared-extra.png' }] }],
      trackerQueue: [{ kind: 'started' }],
      usage: usage(1.5),
      follows: ['STACK.1'],
      decision: { title: 'Hours in one file', options: [{ name: 'One file', note: '', chosen: true }], why: 'Simple', adr: 'AP-1.1', replaces: 'STACK.2' },
    });
    ticket('AP-2', { usage: usage(0.25), proof: [{ criterion: 'x', before: 'shared.png', after: 'shared.png', beforeLabel: 'Before', afterLabel: 'After', more: [{ after: 'shared-extra.png' }] }] });
    decision('STACK.1', 'Project scan', { tickets: ['AP-1'] });
    decision('STACK.2', 'Project scan', { tickets: [], replacedBy: 'AP-1.1' });
    decision('AP-1.1', 'AP-1', { replaces: 'STACK.2', buildsOn: ['STACK.1'] });
    writeMeta(bp, { ...readMeta(bp), impactChecks: [{ adr: 'AP-1.1', status: 'pending' }] });
    fs.mkdirSync(bp.chatsDir, { recursive: true });
    for (const s of ['session-intake-1', 'session-build-1', 'session-other-9']) fs.writeFileSync(path.join(bp.chatsDir, `${s}.jsonl`), '{}\n');
    fs.mkdirSync(bp.proofDir, { recursive: true });
    for (const f of ['ap-1-before-1.png', 'ap-1-after-1.png', 'ap-1-after-2.png', 'shared.png', 'shared-extra.png', 'named-extra.png', 'ap-10-after-1.png']) fs.writeFileSync(path.join(bp.proofDir, f), 'png');
    fs.mkdirSync(ticketMediaDir(bp, 'AP-1'), { recursive: true });
    fs.writeFileSync(path.join(ticketMediaDir(bp, 'AP-1'), 'note.ogg'), 'voice');
    const before = addSnapshot(project, 'ap-1-before', t.baseCommit!);
    const total = boardUsage(bp).total;

    const plan = deletePlan(bp, 'AP-1');
    expect(plan.refused).toBeUndefined();
    expect(plan.summary).toBe('Ticket AP-1 · Stopped, needs you · never merged');
    expect(plan.removes).toEqual([
      'The ticket, its spec, notes and questions',
      'Its copy of the code and the branch squad/ap-1',
      'Its agent conversations and screenshots',
      'An update for the tracker that was not sent yet',
      'Its decision AP-1.1, "Decision AP-1.1". It never reached main.',
    ]);
    expect(plan.stays).toEqual([
      'Your main code and every other ticket',
      'Decision STACK.2, "Decision STACK.2". It is a rule again, as it was before AP-1.1 replaced it.',
      'The story AB#7 in Azure DevOps. Only the link to it is removed.',
      'The cost it used, still counted in Usage',
    ]);
    expect(plan.command).toBe('squad delete AP-1');

    const r = await deleteTicket(bp, 'AP-1');
    expect(r).toMatchObject({ id: 'AP-1', notes: [] });
    // The ticket in both homes.
    expect(readTicket(bp, 'AP-1')).toBeNull();
    expect(fs.existsSync(ticketDir(bp, 'AP-1'))).toBe(false);
    expect(fs.existsSync(ticketStateFile(bp, 'AP-1'))).toBe(false);
    expect(fs.existsSync(ticketMediaDir(bp, 'AP-1'))).toBe(false);
    // Its copy (with the work not committed), the "before" copy left behind, and the branch.
    expect(fs.existsSync(t.worktree!)).toBe(false);
    expect(fs.existsSync(before)).toBe(false);
    expect(branches()).toBe('');
    expect(sh('git worktree list', project)).not.toContain(worktreeRoot(project));
    // Its conversations and screenshots, never another ticket's.
    expect(fs.readdirSync(bp.chatsDir)).toEqual(['session-other-9.jsonl']);
    expect(fs.readdirSync(bp.proofDir).sort()).toEqual(['ap-10-after-1.png', 'shared-extra.png', 'shared.png']);
    // Its decision goes with every link to it: the one it replaced is a rule again.
    const ds = listDecisions(bp);
    expect(ds.map((d) => d.id).sort()).toEqual(['STACK.1', 'STACK.2']);
    expect(ds.find((d) => d.id === 'STACK.1')!.tickets).toEqual([]);
    expect(ds.find((d) => d.id === 'STACK.2')!.replacedBy).toBeUndefined();
    expect(readMeta(bp).impactChecks).toEqual([]);
    // Every other ticket and the base stay as they were; the cost does not drop.
    expect(listTickets(bp).map((x) => x.id)).toEqual(['AP-2']);
    expect(sh('git rev-parse main', project)).toBe(mainBefore);
    const after = boardUsage(bp);
    expect(after.total).toEqual(total);
    expect(after.deleted).toEqual({ tickets: 1, total: { runs: 2, inputTokens: 1000, outputTokens: 100, costUsd: 1.5 } });
    expect(readMeta(bp).deleted).toEqual([expect.objectContaining({ id: 'AP-1', title: 'Ticket AP-1', by: 'Momen' })]);
  });

  it('refuses with a plain reason, and leaves the ticket as it was', async () => {
    ticket('AP-1', { stage: 'release', mergedAt: at(), release: 'v1.1.0' });
    ticket('AP-2', { owner: 'Ali' });
    ticket('AP-3', { stage: 'release', release: 'v1.2.0', status: 'Opening the pull request' });
    writeRelease(bp, { version: 'v1.2.0', status: 'draft', from: 'v1.1.0', tickets: ['AP-3'], notes: '', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } });
    sh('git branch squad/ap-4 && git switch -q squad/ap-4', project);
    ticket('AP-4');

    expect(deletePlan(bp, 'AP-1')).toMatchObject({ archive: true, refused: expect.stringMatching(/AP-1 is merged already: its code is in main.*Archive it/) });
    await expect(deleteTicket(bp, 'AP-1')).rejects.toThrow(/merged already/);
    await expect(deleteTicket(bp, 'AP-2')).rejects.toThrow("AP-2 is Ali's. Only Ali can delete it.");
    await expect(deleteTicket(bp, 'AP-3')).rejects.toThrow('AP-3 is in v1.2.0, the release being made, so it cannot be deleted.');
    const free = holdRelease(bp, 'v1.2.0');
    try {
      await expect(deleteTicket(bp, 'AP-3')).rejects.toThrow('v1.2.0 is going out right now with AP-3. Wait for it to finish.');
    } finally {
      free();
    }
    await expect(deleteTicket(bp, 'AP-4')).rejects.toThrow('Your project folder is on squad/ap-4. Switch it back to main first');
    await expect(deleteTicket(bp, 'AP-9')).rejects.toThrow('No ticket AP-9 on this board.');
    for (const id of ['AP-1', 'AP-2', 'AP-3', 'AP-4']) expect(readTicket(bp, id)?.deleting).toBeUndefined();
    expect(branches()).toContain('squad/ap-4');
  });

  it.skipIf(process.getuid?.() === 0)('a delete cut off half-way says so, keeps the cost once, and finishes when it runs again', async () => {
    const t = built('AP-1', { usage: usage(2) });
    decision('STACK.1', 'Project scan', { tickets: ['AP-1'] });
    const total = boardUsage(bp).total;
    // The project's decisions folder cannot be written: the delete stops on the way.
    fs.chmodSync(bp.decisionsDir, 0o555);
    try {
      await expect(deleteTicket(bp, 'AP-1')).rejects.toThrow(/AP-1 is not fully deleted yet: .*Delete it again to finish/);
    } finally {
      fs.chmodSync(bp.decisionsDir, 0o755);
    }
    const half = readTicket(bp, 'AP-1')!;
    expect(half.status).toBe('Delete did not finish');
    expect(half.deleting).toMatchObject({ by: 'Momen', error: expect.any(String) });
    expect(deletePlan(bp, 'AP-1').unfinished).toBe(half.deleting!.error);
    // The parts before it are gone; the cost is counted once, on the ticket itself.
    expect(fs.existsSync(t.worktree!)).toBe(false);
    expect(branches()).toBe('');
    expect(boardUsage(bp).total).toEqual(total);
    // Cut off just after its line was saved, before its files went: still counted once.
    writeMeta(bp, { ...readMeta(bp), deleted: [{ id: 'AP-1', title: half.title, at: half.deleting!.at, by: 'Momen', usage: half.usage }] });
    expect(boardUsage(bp).total).toEqual(total);

    await deleteTicket(bp, 'AP-1');
    expect(readTicket(bp, 'AP-1')).toBeNull();
    expect(listDecisions(bp)[0]!.tickets).toEqual([]);
    expect(readMeta(bp).deleted).toHaveLength(1);
    expect(boardUsage(bp).total).toEqual(total);

    // Cut off after its files went, with only this computer's state left: running it again clears that too.
    fs.mkdirSync(bp.stateDir, { recursive: true });
    fs.writeFileSync(ticketStateFile(bp, 'AP-5'), `deleting:\n  at: '${at()}'\n  by: Momen\n`);
    await deleteTicket(bp, 'AP-5');
    expect(fs.existsSync(ticketStateFile(bp, 'AP-5'))).toBe(false);
  });

  // Pushes twice and fetches: on a busy machine it takes longer than the default limit.
  it('keeps a pushed branch unless asked, and that branch does not bring the ticket back', { timeout: 60_000 }, async () => {
    for (const id of ['AP-1', 'AP-3']) {
      const t = built(id, { handedOver: { from: 'Ali', to: 'Momen', at: '2026-11-01T10:00:00.000Z' }, story: 'As an owner, I want hours.' });
      commitTicketDocs(bp, t, 'handed over');
      sh(`git push -q origin ${t.branch}`, t.worktree!);
    }
    const plan = deletePlan(bp, 'AP-1');
    expect(plan.pushed).toEqual({ remote: 'origin', branch: 'squad/ap-1', why: 'squad-kit pushed it when the ticket was handed over.' });
    expect(plan.remote).toBe(false);
    expect(plan.stays).toContain("The branch squad/ap-1 on origin, with a note that you deleted AP-1, so teammates' boards show it as deleted.");
    expect(deletePlan(bp, 'AP-1', { remote: true }).removes).toContain('The branch squad/ap-1 on origin');

    const kept = await deleteTicket(bp, 'AP-1');
    expect(sh('git ls-remote --heads origin squad/ap-1', project)).toContain('squad/ap-1');
    // The branch stays, with the delete's note in place of the ticket's files, so teammates' boards see it.
    expect(kept.notes).toEqual(["Left a note on squad/ap-1 on origin, so teammates' boards show AP-1 as deleted"]);
    expect(sh('git ls-tree -r --name-only squad/ap-1 .squad/tickets/AP-1/', bare)).toBe('.squad/tickets/AP-1/deleted.md');
    expect(sh('git show squad/ap-1:hours.ts', bare)).toContain('hours');
    // The board looks for pushed tickets now and then: a deleted one stays deleted.
    expect(pickUpPushed(bp).map((p) => p.id)).toEqual([]);
    expect(readTicket(bp, 'AP-1')).toBeNull();

    const r = await deleteTicket(bp, 'AP-3', { remote: true });
    expect(r.notes).toEqual(['Deleted squad/ap-3 on origin']);
    expect(sh('git ls-remote --heads origin squad/ap-3', project)).toBe('');
    expect(sh('git for-each-ref refs/remotes/origin/squad/ap-3', project)).toBe('');
  });

  it('a decision another ticket follows stays, and the dialog says so', async () => {
    built('AP-1', { decision: { title: 'Hours', options: [], why: '', adr: 'AP-1.1' } });
    decision('AP-1.1', 'AP-1', { tickets: ['AP-1', 'AP-2'] });
    ticket('AP-2', { stage: 'specs', follows: ['AP-1.1'] });
    const plan = deletePlan(bp, 'AP-1');
    expect(plan.warnings).toContain('AP-2 builds on its decision AP-1.1.');
    expect(plan.stays).toContain('Its decision AP-1.1, "Decision AP-1.1", because AP-2 follows it');
    expect(plan.removes.join('\n')).not.toContain('AP-1.1');
    await deleteTicket(bp, 'AP-1');
    expect(listDecisions(bp)).toEqual([expect.objectContaining({ id: 'AP-1.1', tickets: ['AP-2'] })]);
    expect(readTicket(bp, 'AP-2')!.follows).toEqual(['AP-1.1']);
  });

  it('stops the running agent first and waits for it, with no stuck card', async () => {
    block = true;
    const t = built('AP-1', { stage: 'tickets', live: true, status: 'Analyst is reading the ticket', squad: { phase: 'analyst-read', nextAt: at() } });
    const stop = new LiveSquad(bp).start(30);
    try {
      for (let i = 0; i < 200 && !runs.length; i += 1) await sleep(25);
      expect(runs).toHaveLength(1);
      expect(agentRuns().find((r) => r.root === bp.root)?.keys).toContain('AP-1');
      expect(deletePlan(bp, 'AP-1').warnings).toContain('The squad is working on it. Delete stops it first and waits for it.');
      await deleteTicket(bp, 'AP-1', { waitMs: 10_000 });
      expect(runs[0]!.filesThere).toBe(true);
      expect(readTicket(bp, 'AP-1')).toBeNull();
      expect(fs.existsSync(t.worktree!)).toBe(false);
      expect(agentRuns().find((r) => r.root === bp.root)?.keys ?? []).toEqual([]);
      // Nothing starts again on it.
      await sleep(150);
      expect(runs).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('waits for a squad in another window to say it stopped, and says so when it does not', async () => {
    built('AP-1');
    built('AP-2');
    // Another process holds the board: its squad must stop the ticket's runs before anything goes.
    fs.mkdirSync(bp.localDir, { recursive: true });
    fs.writeFileSync(bp.pidFile, String(process.ppid));
    await expect(deleteTicket(bp, 'AP-1', { waitMs: 300 })).rejects.toThrow('AP-1 is not fully deleted yet: The squad did not stop in time.');
    expect(readTicket(bp, 'AP-1')).toMatchObject({ status: 'Delete did not finish', deleting: { error: 'The squad did not stop in time' } });
    expect(fs.existsSync(readTicket(bp, 'AP-1')!.worktree!)).toBe(true);
    // That squad sees the mark, stops what runs and says so: the delete goes on.
    const squad = new LiveSquad(bp);
    const deleting = deleteTicket(bp, 'AP-2', { waitMs: 5000 });
    await sleep(50);
    (squad as unknown as { tick(): void }).tick();
    expect(readTicket(bp, 'AP-2')?.deleting?.stopped).toBeTruthy();
    await deleting;
    expect(readTicket(bp, 'AP-2')).toBeNull();
  });

  it('works through the board API', async () => {
    built('AP-1');
    const app = new Hono();
    mountApi(app, { paths: buildPaths(project) });
    const plan = (await (await app.request('/api/v1/tickets/AP-1/delete')).json()) as { removes: string[]; command: string };
    expect(plan.removes).toContain('Its copy of the code and the branch squad/ap-1');
    expect(plan.command).toBe('squad delete AP-1');
    const res = await app.request('/api/v1/tickets/AP-1/delete', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(readTicket(bp, 'AP-1')).toBeNull();
    const again = await app.request('/api/v1/tickets/AP-1/delete', { method: 'POST' });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'No ticket AP-1 on this board.' });
  });
});

describe('Archive', () => {
  it('takes a merged ticket off the board, shows it under Show archived, and Unarchive brings it back', async () => {
    ticket('AP-1', { stage: 'release', mergedAt: at(), release: 'v1.1.0', status: 'Merged into main · goes out in v1.1.0' });
    ticket('AP-2', { stage: 'review' });
    const app = new Hono();
    mountApi(app, { paths: buildPaths(project) });
    const board = async () => (await (await app.request('/api/v1/board')).json()) as { tickets: Ticket[]; archived: Ticket[]; stats: { open: number } };

    expect(() => archiveTicket(bp, 'AP-2')).toThrow('AP-2 is not merged yet, so it stays on the board. Delete it instead if you no longer want it.');
    const res = await app.request('/api/v1/tickets/AP-1/archive', { method: 'POST' });
    expect(res.status).toBe(200);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.archived).toEqual({ by: 'Momen', at: expect.any(String) });
    // Its history stays: the ticket is in .squad/, merged as before.
    expect(fs.readFileSync(path.join(ticketDir(bp, 'AP-1'), 'ticket.md'), 'utf8')).toContain('archived:');
    expect(t.mergedAt).toBeTruthy();
    let b = await board();
    expect(b.tickets.map((x) => x.id)).toEqual(['AP-2']);
    expect(b.archived.map((x) => x.id)).toEqual(['AP-1']);
    expect(b.stats.open).toBe(1);
    // Archived twice is still archived once.
    expect(archiveTicket(bp, 'AP-1').archived).toEqual(t.archived);

    await app.request('/api/v1/tickets/AP-1/archive', { method: 'POST', body: JSON.stringify({ undo: true }), headers: { 'content-type': 'application/json' } });
    expect(readTicket(bp, 'AP-1')!.archived).toBeUndefined();
    b = await board();
    expect(b.tickets.map((x) => x.id)).toEqual(['AP-1', 'AP-2']);
    expect(b.archived).toEqual([]);
    expect(() => unarchiveTicket(bp, 'AP-1')).toThrow('AP-1 is not archived.');
  });

  it('on the sample board, an accepted ticket counts as merged', () => {
    const demo = boardPaths(path.join(tmp, 'demo', '.squad'));
    seedDemoBoard(demo);
    expect(archiveTicket(demo, 'SK-143').archived).toBeTruthy();
    expect(deletePlan(demo, 'SK-147')).toMatchObject({ archive: true });
    const plan = deletePlan(demo, 'SK-150');
    expect(plan.refused).toBeUndefined();
    expect(plan.removes).toEqual(['The ticket, its spec, notes and questions']);
  });
});

describe('a ticket being deleted', () => {
  it('is left alone by the squad, and its tracker updates are not sent', async () => {
    const t = ticket('AP-1', { live: true, squad: { phase: 'analyst-read', nextAt: at() }, trackerQueue: [{ kind: 'started' }] });
    updateTicket(bp, t.id, (x) => (x.deleting = { at: at(), by: 'Momen' }));
    const squad = new LiveSquad(bp) as unknown as { tick(): void };
    squad.tick();
    await sleep(150);
    const after = readTicket(bp, 'AP-1')!;
    expect(runs).toHaveLength(0);
    expect(after.trackerQueue).toEqual([{ kind: 'started' }]);
    expect(after.deleting?.stopped).toBeTruthy();
  });
});
