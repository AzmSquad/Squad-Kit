import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readTicket, updateTicket } from '../src/board/store.js';
import type { Breakdown } from '../src/board/requirements-types.js';
import { allStories, findItem, readBreakdown, readBreakdownState, updateBreakdown, updateBreakdownState } from '../src/board/requirements.js';
import { addItem, approveBreakdown, removeItem } from '../src/board/requirements-actions.js';
import { fillBuildQueue, type QueueRoom } from '../src/board/requirements-build.js';
import { requestSend } from '../src/board/requirements-send.js';
import { breakdownDir } from '../src/board/requirements-paths.js';
import { importEpic } from '../src/board/epic-import.js';
import { lookAgainNow, lookForNew } from '../src/board/epic-run.js';
import { addTrackerStories } from '../src/board/epic-new.js';
import { sectionOf } from '../src/board/epic-text.js';
import { recentLines } from '../src/core/app-log.js';
import { setParallelLimit } from '../src/core/settings.js';
import { epicBoard, type EpicBoard } from './support/epic.js';

/**
 * A run from the tracker while it builds (ADR-013): approve turns Build continuously on; each story is read again
 * before it starts (changed there: it waits for you; closed: it leaves the run); the epic and its features move forward
 * in the tracker, never back, and a move that fails is logged and stops nothing; new stories under the epic are listed
 * and join only when the person adds them.
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

/** A run read and filled in by hand, ready to approve: every story has its "done when". */
async function ready(ref = 'AB#120'): Promise<Breakdown> {
  const b = await importEpic(e.bp, e.tracker, ref);
  updateBreakdownState(e.bp, b.id, (s) => (s.job = { step: 'draft', status: 'done' }));
  return updateBreakdown(e.bp, b.id, (x) => {
    for (const { story } of allStories(x)) if (!story.criteria.length) story.criteria = [{ given: 'a guest', when: `they ${story.title.toLowerCase()}`, then: 'it works' }];
    x.status = 'ready';
  });
}

const ticketOf = (b: Breakdown, key: string) => findItem(readBreakdown(e.bp, b.id)!, key)?.story?.ticket;

function merge(id: string): void {
  updateTicket(e.bp, id, (t) => {
    t.mergedAt = new Date().toISOString();
    t.stage = 'release';
    t.squad = null;
  });
}

describe('approving a run from the tracker', () => {
  it('turns Build continuously on, with a line, and starts the stories in order', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    const state = readBreakdownState(e.bp, b.id);
    expect(state.build).toMatchObject({ on: true, by: 'Momen' });
    expect(state.activity[0]!.text).toMatch(/^Turned on Build continuously, \d at a time: each story builds and merges by itself/);
    const [turn] = await fillBuildQueue(e.bp, room());
    // S-2 needs S-1: it waits until S-1 merges.
    expect(turn!.started).toHaveLength(3);
    expect(ticketOf(b, 'S-2')).toBeUndefined();
    const t = readTicket(e.bp, ticketOf(b, 'S-1')!)!;
    expect(t).toMatchObject({ track: 'auto', source: { type: 'azure', id: '123', ref: 'AB#123' } });
    expect(t.ask).toContain('As a guest, I want to search free rooms');
    expect(t.ask).toContain(`From AB#120 Booking › Search › AB#123, on Azure DevOps, built with ${b.id}.`);
  });

  it('has nothing to send: its items are in the tracker already', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    expect(() => requestSend(e.bp, b.id)).toThrow(`${b.id} came from Azure DevOps: its items are there already, so there is nothing to send.`);
  });
});

describe('before a story starts', () => {
  it('holds a story changed in the tracker since the approval, with its new words, until you read it', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    e.tracker.items.get('123')!.description = 'As a guest, I want to search free rooms by date, so that I can book one.';
    const [turn] = await fillBuildQueue(e.bp, room());
    expect(turn!.started).toEqual([]);
    expect(turn!.held).toBe(`AB#123 changed on Azure DevOps since you approved. No new story starts until you read it (S-1) and press Build continuously again: squad requirements build ${b.id}.`);
    const after = readBreakdown(e.bp, b.id)!;
    expect(findItem(after, 'S-1')!.story!.story).toBe('As a guest, I want to search free rooms by date, so that I can book one.');
    const state = readBreakdownState(e.bp, b.id);
    expect(state.rewritten).toEqual(['S-1']);
    expect(state.build).toMatchObject({ heldFor: 'review' });
    expect(sectionOf(fs.readFileSync(path.join(breakdownDir(e.bp, b.id), 'source', 'tracker.md'), 'utf8'), 'AB#123')).toContain('search free rooms by date');
    // The next turn holds too, in the same words a rewritten story gets.
    const [next] = await fillBuildQueue(e.bp, room());
    expect(next!.held).toBe('S-1 changed or joined after you approved. No new story starts until you read it and press Build continuously again.');
  });

  it('leaves out a story closed in the tracker, and the stories that needed it go on', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    await e.tracker.moveTo('123', 'closed');
    await fillBuildQueue(e.bp, room());
    const after = readBreakdown(e.bp, b.id)!;
    expect(findItem(after, 'S-1')).toBeNull();
    expect(after.leftOut).toContainEqual({ text: 'AB#123 Search rooms', why: 'Closed on Azure DevOps after you approved', ref: { section: 'AB#123' } });
    expect(findItem(after, 'S-2')!.story!.dependsOn).toEqual([]);
    expect(readBreakdownState(e.bp, b.id).activity.map((a) => a.text)).toContain('Left AB#123 Search rooms out of the run: it is closed on Azure DevOps');
    // S-2 needed only S-1: it starts on the next turn.
    await fillBuildQueue(e.bp, room());
    expect(ticketOf(b, 'S-2')).toBeTruthy();
  });
});

describe('the epic and its features in the tracker', () => {
  it('move forward as their stories start and merge, never back, and only once', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    expect(['120', '121', '122'].map((id) => e.tracker.items.get(id)!.state)).toEqual(['Active', 'Active', 'Active']);
    const writes = e.tracker.log.length;
    await fillBuildQueue(e.bp, room());
    expect(e.tracker.log.slice(writes).filter((w) => / (120|121|122) /.test(`${w} `))).toEqual([]);
    // Holding's one story merges: Holding is resolved; the epic waits for all of its stories.
    merge(ticketOf(b, 'S-3')!);
    await fillBuildQueue(e.bp, room());
    expect(e.tracker.items.get('122')!.state).toBe('Resolved');
    expect(e.tracker.items.get('120')!.state).toBe('Active');
    expect(readBreakdownState(e.bp, b.id).trackerMoved).toEqual({ '120': 'in-progress', '121': 'in-progress', '122': 'resolved' });
    for (const k of ['S-1', 'S-4']) merge(ticketOf(b, k)!);
    await fillBuildQueue(e.bp, room());
    merge(ticketOf(b, 'S-2')!);
    await fillBuildQueue(e.bp, room());
    expect(['120', '121'].map((id) => e.tracker.items.get(id)!.state)).toEqual(['Resolved', 'Resolved']);
  });

  it('logs a move the tracker refuses, says so once, and stops nothing', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    e.tracker.breakAfter(0, 'Azure DevOps said no');
    const [turn] = await fillBuildQueue(e.bp, room());
    expect(turn!.started).toHaveLength(3);
    expect(recentLines(50).some((l) => l.includes(`${b.id}: could not move AB#120 to in-progress on Azure DevOps: Azure DevOps said no`))).toBe(true);
    await fillBuildQueue(e.bp, room());
    const lines = readBreakdownState(e.bp, b.id).activity.filter((a) => a.text.startsWith('Could not move AB#120'));
    expect(lines).toHaveLength(1);
    expect(readBreakdownState(e.bp, b.id).trackerMoved).toBeUndefined();
    // Once the tracker takes it again, the move is made at the next look.
    e.tracker.mend();
    lookAgainNow(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    expect(e.tracker.items.get('120')!.state).toBe('Active');
  });

  it('moves only the epic above a feature run to in progress, never to resolved', async () => {
    const b = await ready('AB#122');
    approveBreakdown(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    merge(ticketOf(b, 'S-1')!);
    await fillBuildQueue(e.bp, room());
    expect(e.tracker.items.get('122')!.state).toBe('Resolved');
    expect(e.tracker.items.get('120')!.state).toBe('Active');
  });
});

describe('new stories under the epic', () => {
  it('are listed for you, never joining by themselves, and join with Add to the run', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    await fillBuildQueue(e.bp, room());
    const fresh = await e.tracker.createItem({ level: 'story', title: 'Pay at the desk', markdown: 'As a guest, I want to pay at the desk.', parent: '122' });
    lookAgainNow(e.bp, b.id);
    await lookForNew(e.bp, readBreakdown(e.bp, b.id)!, room());
    const state = readBreakdownState(e.bp, b.id);
    expect(state.trackerNew).toEqual([{ id: fresh.id, ref: fresh.ref, title: 'Pay at the desk' }]);
    expect(state.activity[0]!.text).toBe(`1 new story on Azure DevOps under AB#120: ${fresh.ref}. It joins the run only when you add it`);
    expect(allStories(readBreakdown(e.bp, b.id)!).some((p) => p.story.tracker?.id === fresh.id)).toBe(false);
    const after = await addTrackerStories(e.bp, b.id, e.tracker);
    const added = allStories(after).find((p) => p.story.tracker?.id === fresh.id)!;
    expect(added.story.key).toBe('S-5');
    expect(added.feature?.title).toBe('Holding');
    const s = readBreakdownState(e.bp, b.id);
    expect(s.trackerNew).toBeUndefined();
    expect(s.rewritten).toEqual(['S-5']);
    expect(s.job).toMatchObject({ step: 'redo', status: 'pending', item: 'S-5' });
    expect(sectionOf(fs.readFileSync(path.join(breakdownDir(e.bp, b.id), 'source', 'tracker.md'), 'utf8'), fresh.ref)).toContain('pay at the desk');
    // It waits for you to read it before anything new starts.
    const [turn] = await fillBuildQueue(e.bp, room());
    expect(turn!.held).toMatch(/^S-5 changed or joined after you approved/);
  });

  it('a story in a feature the run does not have yet comes with its feature', async () => {
    const b = await ready();
    approveBreakdown(e.bp, b.id);
    const feature = await e.tracker.createItem({ level: 'feature', title: 'Payments', markdown: 'x', parent: '120' });
    await e.tracker.createItem({ level: 'story', title: 'Pay online', markdown: 'x', parent: feature.id });
    lookAgainNow(e.bp, b.id);
    await lookForNew(e.bp, readBreakdown(e.bp, b.id)!, room());
    const after = await addTrackerStories(e.bp, b.id, e.tracker);
    expect(after.epics[0]!.features.map((f) => [f.key, f.title, f.tracker?.ref, f.stories.map((x) => x.title)])).toContainEqual(['F-3', 'Payments', feature.ref, ['Pay online']]);
  });

  it('a story you took out of the run never comes back as new', async () => {
    const b = await ready();
    const out = allStories(b).at(-1)!.story;
    removeItem(e.bp, b.id, out.key);
    lookAgainNow(e.bp, b.id);
    await lookForNew(e.bp, readBreakdown(e.bp, b.id)!, room());
    expect(readBreakdownState(e.bp, b.id).trackerNew).toBeUndefined();
  });

  it('takes no new parts made here: they are made in the tracker and come in as new stories', async () => {
    const b = await ready();
    expect(() => addItem(e.bp, b.id, { level: 'story', title: 'Pay at the desk', under: b.epics[0]!.features[0]!.key })).toThrow(`${b.id} mirrors AB#120 on Azure DevOps. Add the story there`);
  });

  it('Add to the run says so when nothing waits to join', async () => {
    const b = await ready();
    await expect(addTrackerStories(e.bp, b.id, e.tracker)).rejects.toThrow(`No new stories on Azure DevOps wait to join ${b.id}.`);
  });
});
