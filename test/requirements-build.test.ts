import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { Breakdown, BreakdownStory } from '../src/board/requirements-types.js';
import type { Ticket } from '../src/board/types.js';
import { findItem, readBreakdown, readBreakdownState, storyProgress, writeBreakdown } from '../src/board/requirements.js';
import { buildingBreakdowns, fillBuildQueue, placesLeft, setBuild, type QueueRoom } from '../src/board/requirements-build.js';
import { monthKey, monthsFile } from '../src/board/usage.js';
import { limitText, type LimitPause } from '../src/engine/usage-limit.js';
import { setParallelLimit } from '../src/core/settings.js';
import { LiveSquad } from '../src/engine/live.js';

/**
 * Build continuously: the next stories start in the tree's order once what they need is merged, under the parallel
 * limit; a story that waits for the person frees its place and only the stories that need it wait; the month's
 * budget and the usage limit hold the queue with a reason; every story merged turns it off; a restart carries on;
 * and only the owner's squad builds.
 */

let tmp: string;
let bp: BoardPaths;

function meta(user = 'Momen', more: Partial<ReturnType<typeof readMeta>> = {}) {
  writeMeta(bp, {
    project: 'Case portal',
    key: 'RO',
    nextNumber: 20,
    engine: 'live',
    runner: 'direct',
    user: { name: user, role: 'Business analyst' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    ...more,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-build-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  meta();
  setParallelLimit(2);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const story = (key: string, title: string, dependsOn: string[] = []): BreakdownStory => ({
  key,
  title,
  story: `As a guest, I want to ${title.toLowerCase()}, so that my stay is easy.`,
  criteria: [{ given: 'a free room', when: `I ${title.toLowerCase()}`, then: 'it is saved' }],
  size: 'M',
  dependsOn,
});

/** S-1 … S-6 in the tree's order. S-2 needs S-1, S-4 needs S-3, S-5 needs S-2 and S-4. */
function breakdown(owner = 'Momen', status: Breakdown['status'] = 'approved'): Breakdown {
  const b: Breakdown = {
    id: 'BR-1',
    title: 'RoomFlow BRD v2',
    status,
    source: { file: 'source/pasted.md', name: 'Pasted text', kind: 'pasted', bytes: 10, addedBy: owner, addedAt: new Date().toISOString() },
    questions: [],
    decided: [],
    leftOut: [],
    ...(status === 'approved' ? { approved: { by: owner, at: new Date().toISOString() } } : {}),
    createdAt: new Date().toISOString(),
    createdBy: owner,
    owner,
    next: { epic: 3, feature: 3, story: 7 },
    epics: [
      {
        key: 'E-1',
        title: 'Booking',
        stories: [],
        features: [
          { key: 'F-1', title: 'Search', stories: [story('S-1', 'Search rooms'), story('S-2', 'Filter by price', ['S-1'])] },
          { key: 'F-2', title: 'Holding', stories: [story('S-3', 'Hold a slot'), story('S-4', 'Refund on cancel', ['S-3'])] },
        ],
      },
      { key: 'E-2', title: 'Front desk', features: [], stories: [story('S-5', 'Check in', ['S-2', 'S-4']), story('S-6', 'Check out')] },
    ],
  };
  writeBreakdown(bp, b);
  return b;
}

const room = (more: Partial<QueueRoom> = {}): QueueRoom => ({ free: () => Infinity, pause: null, payment: async () => 'subscription', ...more });

/** The story's ticket. */
function ticketOf(key: string): Ticket {
  return readTicket(bp, findItem(readBreakdown(bp, 'BR-1')!, key)!.story!.ticket!)!;
}

function merge(key: string): void {
  updateTicket(bp, ticketOf(key).id, (t) => {
    t.mergedAt = new Date().toISOString();
    t.stage = 'release';
    t.squad = null;
  });
}

function started(): string[] {
  const b = readBreakdown(bp, 'BR-1')!;
  return ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6'].filter((k) => findItem(b, k)!.story!.ticket);
}

describe('Build continuously, the switch', () => {
  it('turns on only for an approved breakdown of mine, and Pause turns it off', () => {
    breakdown('Momen', 'ready');
    expect(() => setBuild(bp, 'BR-1', true)).toThrow('Approve BR-1 first. Nothing is built before the breakdown is approved.');
    breakdown();
    setBuild(bp, 'br-1', true);
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, by: 'Momen' });
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe('Turned on Build continuously, 2 at a time');
    setBuild(bp, 'BR-1', false);
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: false, by: 'Momen' });
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe('Paused Build continuously. The stories building now carry on; no new one starts');
  });

  it("is only the owner's: someone else's breakdown never builds on this computer", async () => {
    breakdown('Sara');
    expect(() => setBuild(bp, 'BR-1', true)).toThrow("BR-1 is Sara's. Only their squad builds it.");
    // Even with the switch on in the state file, this squad leaves it alone.
    fs.mkdirSync(path.join(bp.localDir, 'requirements'), { recursive: true });
    fs.writeFileSync(path.join(bp.localDir, 'requirements', 'BR-1.yaml'), `activity: []\nbuild: { on: true, by: Sara, at: '${new Date().toISOString()}' }\n`);
    expect(buildingBreakdowns(bp)).toEqual([]);
    expect(await fillBuildQueue(bp, room())).toEqual([]);
    expect(listTickets(bp)).toEqual([]);
  });
});

describe('the queue', () => {
  it('starts the next stories in the order of their needs, never more than the parallel limit', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    const [turn] = await fillBuildQueue(bp, room());
    // S-1 and S-3 need nothing; S-6 does not either, but two places are taken.
    expect(started()).toEqual(['S-1', 'S-3']);
    expect(turn).toMatchObject({ id: 'BR-1', started: ['RO-20', 'RO-21'] });
    expect(ticketOf('S-1')).toMatchObject({ track: 'auto', breakdown: { id: 'BR-1', item: 'S-1' } });
    expect(readBreakdownState(bp, 'BR-1').activity[0]).toMatchObject({ who: 'squad', text: 'Started S-3 as RO-21' });
    // Nothing more while both build.
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-3']);
    // S-1 merges: its place goes to S-2, next in the tree's order.
    merge('S-1');
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-2', 'S-3']);
    expect(ticketOf('S-2').dependsOn).toEqual([ticketOf('S-1').id]);
  });

  it("lets a story that waits for the person free its place; the stories that need it wait", async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    await fillBuildQueue(bp, room());
    // S-3 stops for a clash. S-4 needs it, so S-6 takes the free place.
    updateTicket(bp, ticketOf('S-3').id, (t) => {
      t.live = false;
      t.squad = null;
      t.waiting = { kind: 'ask', summary: 'Two parts clash' };
      t.agentQuestion = { from: 'architect', text: 'Which refund rule?', options: ['Full', 'None'], kind: 'clash', at: new Date().toISOString() };
    });
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-3', 'S-6']);
    const b = readBreakdown(bp, 'BR-1')!;
    const progress = new Map(storyProgress(bp, b, readBreakdownState(bp, 'BR-1')).map((p) => [p.key, p]));
    expect(progress.get('S-3')).toMatchObject({ state: 'needs-you', stop: 'clash', line: 'Needs you: two parts clash' });
    expect(progress.get('S-4')).toMatchObject({ state: 'waits', waitsOn: ['S-3'] });
    // S-1 and S-6 merge: S-2 starts; S-4 and S-5 still wait, and the hold says for what.
    merge('S-1');
    merge('S-6');
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-2', 'S-3', 'S-6']);
    const [turn] = await fillBuildQueue(bp, room());
    expect(turn!.held).toBe('The next stories wait for S-2 and S-3 to merge. S-3 needs you.');
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, heldFor: 'waits', held: 'The next stories wait for S-2 and S-3 to merge. S-3 needs you.' });
  });

  it('lets a story whose merge waits (an approver, or the checkout) free its place, and says what it waits for', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    await fillBuildQueue(bp, room());
    // S-3 is accepted, and its pull request waits for a person to approve it: nothing runs for it.
    updateTicket(bp, ticketOf('S-3').id, (t) => {
      t.stage = 'release';
      t.live = false;
      t.squad = null;
      t.release = 'v0.1.0';
      t.pr = { id: 7, url: 'https://code.example.test/pr/7', repo: 'app', host: 'example' };
    });
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-3', 'S-6']);
    const progress = () => new Map(storyProgress(bp, readBreakdown(bp, 'BR-1')!, readBreakdownState(bp, 'BR-1')).map((p) => [p.key, p]));
    expect(progress().get('S-3')).toEqual({ key: 'S-3', state: 'needs-you', line: 'Waits for someone to approve the pull request', ticket: ticketOf('S-3').id, stop: 'other' });
    // S-1 merged, but the person's own checkout could not move; S-6 merges.
    updateTicket(bp, ticketOf('S-1').id, (t) => {
      t.stage = 'release';
      t.live = false;
      t.squad = null;
      t.release = 'v0.1.0';
      t.branch = 'squad/ro-20';
    });
    merge('S-6');
    expect(progress().get('S-1')).toMatchObject({ state: 'needs-you', line: 'Waits to merge: your own copy of the code has changes in the same files', stop: 'other' });
    const [turn] = await fillBuildQueue(bp, room());
    expect(turn!.started).toEqual([]);
    expect(turn!.held).toBe('The next stories wait for S-1 and S-3 to merge. S-3 waits for someone to approve its pull request. S-1 waits to merge: your own copy of the code has changes in the same files.');
    // Not a problem that holds the queue: neither counts as a story that stopped on one.
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, heldFor: 'waits' });
  });

  it("holds at this month's budget with a reason, and goes on once the person lets it", async () => {
    meta('Momen', { budget: { monthUsd: 50 } });
    fs.mkdirSync(path.dirname(monthsFile(bp)), { recursive: true });
    fs.writeFileSync(monthsFile(bp), JSON.stringify({ [monthKey()]: { runs: 9, costUsd: 52 } }));
    breakdown();
    setBuild(bp, 'BR-1', true);
    const apiKey = room({ payment: async () => 'api-key' });
    const [turn] = await fillBuildQueue(bp, apiKey);
    expect(turn!.started).toEqual([]);
    const words = "This month's budget is used up: $52.00 of $50.00. No new story starts. Raise the budget in Settings, or press Build continuously again to go on this month.";
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, held: words, heldFor: 'budget' });
    // A subscription has no budget to hold it.
    expect((await fillBuildQueue(bp, room()))[0]!.started).toHaveLength(2);

    // Again on an API key: the person presses Build continuously again, and it goes on this month.
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    await fillBuildQueue(bp, apiKey);
    expect(readBreakdownState(bp, 'BR-1').build?.heldFor).toBe('budget');
    setBuild(bp, 'BR-1', true);
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, budgetOk: monthKey() });
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe("Let it go on past this month's budget");
    const [on] = await fillBuildQueue(bp, apiKey);
    expect(on!.started).toHaveLength(2);
    expect(readBreakdownState(bp, 'BR-1').build?.held).toBeUndefined();
    // Its stories do not stop at their own budget card either.
    expect(readTicket(bp, on!.started[0]!)!.budgetOk).toEqual({ month: monthKey() });
  });

  it('holds for the usage limit, and carries on when it resets', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    const pause: LimitPause = { name: 'Claude', since: new Date().toISOString(), resetsAt: new Date(Date.now() + 3_600_000).toISOString(), until: new Date(Date.now() + 3_630_000).toISOString() };
    const [turn] = await fillBuildQueue(bp, room({ pause }));
    expect(turn).toMatchObject({ started: [], held: limitText(pause) });
    expect(readBreakdownState(bp, 'BR-1').build?.heldFor).toBe('limit');
    await fillBuildQueue(bp, room());
    expect(started()).toEqual(['S-1', 'S-3']);
    expect(readBreakdownState(bp, 'BR-1').build?.held).toBeUndefined();
  });

  it("keeps the squad's own limit: no place there, no new story", async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    await fillBuildQueue(bp, room({ free: () => 1 }));
    expect(started()).toEqual(['S-1']);
    await fillBuildQueue(bp, room({ free: () => 0 }));
    expect(started()).toEqual(['S-1']);
  });

  it('holds when two stories stopped on something that is not one of the three stops', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    await fillBuildQueue(bp, room());
    for (const k of ['S-1', 'S-3']) {
      updateTicket(bp, ticketOf(k).id, (t) => {
        t.squad = null;
        t.waiting = { kind: 'stuck', summary: 'Claude Code did not start' };
        t.stuck = { question: 'Claude Code did not start.', options: [] };
      });
    }
    const [turn] = await fillBuildQueue(bp, room());
    expect(turn).toMatchObject({ started: [], held: 'S-1 and S-3 stopped on a problem. No new story starts until you settle one of them.' });
  });

  it('turns itself off once every story is merged, and says to send the release', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    let last;
    for (let i = 0; i < 8 && !last?.done; i += 1) {
      [last] = await fillBuildQueue(bp, room({ free: () => 6 }));
      for (const k of started()) if (!ticketOf(k).mergedAt) merge(k);
    }
    expect(started()).toHaveLength(6);
    expect(last).toMatchObject({ id: 'BR-1', started: [], done: true });
    expect(await fillBuildQueue(bp, room())).toEqual([]);
    const s = readBreakdownState(bp, 'BR-1');
    expect(s.build).toMatchObject({ on: false });
    expect(s.activity[0]).toMatchObject({ who: 'squad', text: 'All 6 stories are merged. Send the release out from Releases.' });
    expect(() => setBuild(bp, 'BR-1', true)).toThrow('Every story of BR-1 is merged. Nothing is left to build.');
  });

  it('a restart carries on: the switch is in the state file, and the live squad picks it up', async () => {
    breakdown();
    setBuild(bp, 'BR-1', true);
    await fillBuildQueue(bp, room());
    merge('S-1');
    // The board closed and opened again: a new live squad, the same files.
    const squad = new LiveSquad(bp) as unknown as { tick(): void; queueing: boolean };
    squad.tick();
    for (let i = 0; i < 50 && squad.queueing; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(started()).toEqual(['S-1', 'S-2', 'S-3']);
    // Pause: nothing new starts, the stories building carry on.
    setBuild(bp, 'BR-1', false);
    merge('S-3');
    squad.tick();
    for (let i = 0; i < 50 && squad.queueing; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(started()).toEqual(['S-1', 'S-2', 'S-3']);
    expect(ticketOf('S-2').stage).toBe('tickets');
  });

  it("counts the app's one limit in the live squad: the tickets running elsewhere and this project's own on the go", () => {
    const m = readMeta(bp);
    const going = (id: string, more: Partial<Ticket> = {}): Ticket => ({
      id,
      title: id,
      ask: id,
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'implement',
      status: 'Building',
      waiting: null,
      createdAt: new Date().toISOString(),
      createdBy: 'Momen',
      activity: [],
      squad: { phase: 'build', nextAt: new Date().toISOString() },
      ...more,
    });
    const tickets = [going('RO-1'), going('RO-2', { waiting: { kind: 'ask', summary: 'Two parts clash' } }), going('RO-3', { squad: null }), going('RO-4', { createdBy: 'Sara', owner: 'Sara' })];
    writeTicket(bp, tickets[0]!);
    expect(placesLeft(3, tickets, m, 0, false)).toBe(2);
    expect(placesLeft(3, tickets, m, 2, false)).toBe(0);
    expect(placesLeft(3, tickets, m, 0, true)).toBe(0);
  });
});
