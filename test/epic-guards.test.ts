import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createTicket, startFromTracker } from '../src/board/actions.js';
import { listTickets, updateTicket } from '../src/board/store.js';
import type { Breakdown } from '../src/board/requirements-types.js';
import { allStories, approveProblems, findItem, readBreakdown, readBreakdownState, redoHolding, updateBreakdown, updateBreakdownState } from '../src/board/requirements.js';
import { approveBreakdown, editItem } from '../src/board/requirements-actions.js';
import { fillBuildQueue, setBuild, type QueueRoom } from '../src/board/requirements-build.js';
import { epicPreview, importEpic } from '../src/board/epic-import.js';
import { lookAgainNow, lookForNew } from '../src/board/epic-run.js';
import { addTrackerStories } from '../src/board/epic-new.js';
import { approvedWords } from '../src/commands/requirements-new.js';
import { setParallelLimit } from '../src/core/settings.js';
import { epicBoard, type EpicBoard } from './support/epic.js';

/**
 * What keeps a run from the tracker safe (ADR-013): no item is built twice (another run's story is left out, a ticket on
 * the board is used again, Start on the Backlog refuses a story that sits in a run); a story already on the board needs
 * no "done when" to approve; the check before a story starts never holds without a way out; a paused or finished run
 * is still followed; a story whose criteria changed shape is filled in again; and a fill of new stories holds only them.
 */

let e: EpicBoard;

beforeEach(async () => {
  e = await epicBoard();
  setParallelLimit(5);
});

afterEach(() => {
  fs.rmSync(e.tmp, { recursive: true, force: true });
});

const room = (more: Partial<QueueRoom> = {}): QueueRoom => ({ free: () => Infinity, pause: null, payment: async () => 'subscription', tracker: () => e.tracker, ...more });

/** A run with every story given its "done when", ready to approve. */
async function ready(ref = 'AB#120'): Promise<Breakdown> {
  const b = await importEpic(e.bp, e.tracker, ref);
  updateBreakdownState(e.bp, b.id, (s) => (s.job = { step: 'draft', status: 'done' }));
  return updateBreakdown(e.bp, b.id, (x) => {
    for (const { story } of allStories(x)) if (!story.criteria.length && !story.ticket) story.criteria = [{ given: 'a guest', when: 'they try it', then: 'it works' }];
    x.status = 'ready';
  });
}

const story = (b: Breakdown, key: string) => findItem(readBreakdown(e.bp, b.id)!, key)?.story;
const merge = (id: string) =>
  updateTicket(e.bp, id, (t) => {
    t.mergedAt = new Date().toISOString();
    t.stage = 'release';
    t.squad = null;
  });

describe('no item is built twice', () => {
  it('a story another run holds is left out of a new one, in the preview and in the run', async () => {
    const first = await importEpic(e.bp, e.tracker, 'AB#121');
    const p = await epicPreview(e.bp, e.tracker, 'AB#120');
    expect(p.stories.map((s) => s.ref)).toEqual(['AB#126', 'AB#127']);
    expect(p.leftOut).toContainEqual({ ref: 'AB#123', title: 'Search rooms', why: `In ${first.id} already` });
    const second = await importEpic(e.bp, e.tracker, 'AB#120');
    expect(allStories(second).map((x) => x.story.tracker?.ref)).toEqual(['AB#126', 'AB#127']);
    expect(second.leftOut).toContainEqual({ text: 'AB#124 Filter by price', why: `In ${first.id} already`, ref: { section: 'AB#124' } });
  });

  it('Start on the Backlog refuses a story that sits in a run, and the terminal pull is the same call', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    await expect(startFromTracker(e.bp, e.tracker, 'AB#124')).rejects.toThrow(`AB#124 is in ${b.id}, the run of AB#120: it starts from there.`);
    expect(listTickets(e.bp)).toEqual([]);
  });

  it('a story whose item came on the board after the import carries on on that ticket, never a second one', async () => {
    const b = await ready();
    const pulled = createTicket(e.bp, { title: 'Hold a slot', ask: 'x', source: { type: 'azure', id: '126', ref: 'AB#126' } });
    approveBreakdown(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    expect(story(b, 'S-3')!.ticket).toBe(pulled.id);
    expect(listTickets(e.bp).filter((t) => t.source.id === '126')).toHaveLength(1);
    expect(readBreakdownState(e.bp, b.id).activity.map((a) => a.text)).toContain(`S-3 is on the board already as ${pulled.id}, from AB#126: it carries on there`);
  });

  it('Add to the run leaves out a new story another breakdown holds, with why', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    const fresh = await e.tracker.createItem({ level: 'story', title: 'Pay at the desk', markdown: 'x', parent: '122' });
    const other = await importEpic(e.bp, e.tracker, 'AB#122');
    // Not new for the first run: the other one builds it.
    lookAgainNow(e.bp, b.id);
    await lookForNew(e.bp, readBreakdown(e.bp, b.id)!, room());
    expect(readBreakdownState(e.bp, b.id).trackerNew).toBeUndefined();
    updateBreakdownState(e.bp, b.id, (s) => (s.trackerNew = [{ id: fresh.id, ref: fresh.ref, title: 'Pay at the desk' }]));
    await expect(addTrackerStories(e.bp, b.id, e.tracker)).rejects.toThrow(`Nothing was added: ${fresh.ref} is in ${other.id} already.`);
    expect(readBreakdown(e.bp, b.id)!.leftOut).toContainEqual({ text: `${fresh.ref} Pay at the desk`, why: `In ${other.id} already`, ref: { section: fresh.ref } });
  });
});

describe('approving a run with stories on the board', () => {
  it('asks no "done when" for a story that carries on on its live ticket', async () => {
    createTicket(e.bp, { title: 'Hold a slot', ask: 'x', source: { type: 'azure', id: '126', ref: 'AB#126' } });
    const b = await ready();
    expect(story(b, 'S-3')!.criteria).toEqual([]);
    expect(approveProblems(readBreakdown(e.bp, b.id)!, e.bp)).toEqual([]);
    expect(approveProblems(readBreakdown(e.bp, b.id)!)).toEqual(['S-3 has no "done when" yet.']);
    expect(approveBreakdown(e.bp, b.id).status).toBe('approved');
    expect(approvedWords(e.bp, b)).toBe(`Approved. Building continuously, 5 at a time. Pause: squad requirements build ${b.id} --pause`);
  });
});

describe('the check before a story starts', () => {
  it('reads the item on its own when its group cannot be read, and leaves it out when it is finished there', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    e.tracker.children = async () => {
      throw new Error('the group is gone');
    };
    await e.tracker.moveTo('123', 'closed');
    await fillBuildQueue(e.bp, room());
    expect(story(b, 'S-1')).toBeUndefined();
    expect(readBreakdown(e.bp, b.id)!.leftOut.map((l) => l.text)).toContain('AB#123 Search rooms');
  });

  it('says how to go on when the item cannot be read at all', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    e.tracker.children = async () => {
      throw new Error('the group is gone');
    };
    e.tracker.get = async () => {
      throw new Error('no answer');
    };
    const [turn] = await fillBuildQueue(e.bp, room());
    expect(turn!.started).toEqual([]);
    expect(turn!.held).toMatch(/^Could not read AB#123 on Azure DevOps to check it before it starts: .* It tries again in a moment\./);
    expect(turn!.held).toContain(`Start it yourself: squad requirements start ${b.id} S-1, or take it out of the run: squad requirements remove ${b.id} S-1.`);
  });

  it('a story whose criteria are no longer Given/When/Then loses them, and the Analyst fills it in again', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    e.tracker.items.get('123')!.acceptance = 'Fast search, by date.';
    await fillBuildQueue(e.bp, room());
    expect(story(b, 'S-1')!.criteria).toEqual([]);
    const s = readBreakdownState(e.bp, b.id);
    expect(s.rewritten).toEqual(['S-1']);
    expect(s.job).toMatchObject({ step: 'redo', status: 'pending', item: 'S-1' });
    expect(redoHolding(readBreakdown(e.bp, b.id)!, s.job, 'S-1')).toBe('S-1');
  });
});

describe('a run that is approved and not building', () => {
  it('still shows new stories while paused', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    setBuild(e.bp, b.id, false);
    const fresh = await e.tracker.createItem({ level: 'story', title: 'Pay at the desk', markdown: 'x', parent: '122' });
    lookAgainNow(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    expect(readBreakdownState(e.bp, b.id).trackerNew?.map((n) => n.id)).toEqual([fresh.id]);
  });

  it('tries a resolved move the tracker refused again on later turns, after every story merged', async () => {
    const b = await ready('AB#122');
    approveBreakdown(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    merge(story(b, 'S-1')!.ticket!);
    e.tracker.breakAfter(0, 'Azure DevOps said no');
    await fillBuildQueue(e.bp, room());
    expect(readBreakdownState(e.bp, b.id).build?.on).toBe(false);
    expect(e.tracker.items.get('122')!.state).toBe('Active');
    e.tracker.mend();
    lookAgainNow(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    expect(e.tracker.items.get('122')!.state).toBe('Resolved');
  });
});

describe('new stories being filled in', () => {
  it('hold only themselves: other parts can be changed, and they say what the Analyst fills in', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    updateBreakdownState(e.bp, b.id, (s) => (s.job = { step: 'redo', status: 'running', item: 'S-3,S-4' }));
    const job = readBreakdownState(e.bp, b.id).job;
    const now = readBreakdown(e.bp, b.id)!;
    expect(redoHolding(now, job, 'S-4')).toBe('S-4');
    expect(redoHolding(now, job, 'S-1')).toBeNull();
    expect(editItem(e.bp, b.id, 'S-1', { size: 'S' })).toBeTruthy();
    expect(() => editItem(e.bp, b.id, 'S-3', { size: 'S' })).toThrow('The Analyst is filling in S-3 and S-4. Wait for it, or stop it.');
  });

  it('Add to the run says when it cut needs that went round in a loop', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    const one = await e.tracker.createItem({ level: 'story', title: 'Pay online', markdown: 'x', parent: '122' });
    const two = await e.tracker.createItem({ level: 'story', title: 'Refund online', markdown: 'x', parent: '122' });
    await e.tracker.linkDepends(one.id, [two.id]);
    await e.tracker.linkDepends(two.id, [one.id]);
    updateBreakdownState(e.bp, b.id, (s) => (s.trackerNew = [one, two].map((n) => ({ id: n.id, ref: n.ref, title: n.title }))));
    await addTrackerStories(e.bp, b.id, e.tracker);
    expect(readBreakdownState(e.bp, b.id).activity.map((a) => a.text)).toContain('Took away 1 need from Azure DevOps that went round in a loop');
  });
});
