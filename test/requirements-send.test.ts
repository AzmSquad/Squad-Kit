import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { Tracker } from '../src/modules/tracker/types.js';

// The project's tracker, as the registry would open it: set by each test.
let projectTracker: Tracker | null = null;
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  trackerFor: () => projectTracker,
}));

const { boardPaths, readTicket, writeMeta } = await import('../src/board/store.js');
const { breakdownView, findItem, readBreakdown, readBreakdownState, updateBreakdown, updateBreakdownState, writeBreakdown } = await import('../src/board/requirements.js');
const { renameBreakdown, startStory } = await import('../src/board/requirements-actions.js');
const { planSend } = await import('../src/board/requirements-sync.js');
const { requestSend, runSend, sendPreview, sendsDue, startSends } = await import('../src/board/requirements-send.js');
const { demoTracker, DemoTracker } = await import('../src/board/demo-tracker.js');
const { mountRequirementsApi } = await import('../src/console/api/requirements.js');
const { buildPaths } = await import('../src/core/paths.js');
const { setPaymentChoice } = await import('../src/core/settings.js');
const { LiveSquad } = await import('../src/engine/live.js');
type Breakdown = import('../src/board/requirements-types.js').Breakdown;
type BreakdownStory = import('../src/board/requirements-types.js').BreakdownStory;
type BreakdownView = import('../src/board/requirements-types.js').BreakdownView;
type BoardPaths = import('../src/board/store.js').BoardPaths;

/**
 * Send to the tracker as the squad's job: what the dialog says first, the send saving item by item with its progress,
 * edits made meanwhile kept, a send cut off carrying on with no doubles, the tickets of stories that started linked to
 * their items, a renamed breakdown changing nothing there, and only a tracker that can make items offered.
 */

let tmp: string;
let bp: BoardPaths;
let tracker: InstanceType<typeof DemoTracker>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-send-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, {
    project: 'RoomFlow',
    key: 'RO',
    nextNumber: 30,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Business analyst' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
  });
  tracker = demoTracker({ levels: { project: 'RoomFlow' }, start: 120 });
  projectTracker = tracker;
  setPaymentChoice('subscription');
});

afterEach(() => {
  projectTracker = null;
  setPaymentChoice('auto');
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

function breakdown(status: Breakdown['status'] = 'approved'): Breakdown {
  const b: Breakdown = {
    id: 'BR-1',
    title: 'RoomFlow BRD v2',
    status,
    source: { file: 'source/pasted.md', name: 'Pasted text', kind: 'pasted', bytes: 10, addedBy: 'Momen', addedAt: new Date().toISOString() },
    questions: [],
    decided: [],
    leftOut: [],
    ...(status === 'approved' ? { approved: { by: 'Momen', at: new Date().toISOString() } } : {}),
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
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

const creates = () => tracker.log.filter((l) => l.startsWith('create')).length;

describe('what Send to the tracker will do', () => {
  it('counts each level for the dialog, and says when nothing was sent before', async () => {
    breakdown();
    const p = await sendPreview(bp, 'BR-1');
    expect(p).toEqual({
      tracker: { module: 'azure', label: 'Azure DevOps', project: 'RoomFlow' },
      levels: { epic: 'Epic', feature: 'Feature', story: 'User Story', process: 'Agile' },
      counts: {
        epics: { all: 2, new: 2, changed: 0, unchanged: 0 },
        features: { all: 2, new: 2, changed: 0, unchanged: 0 },
        stories: { all: 6, new: 6, changed: 0, unchanged: 0 },
        storiesUnderEpic: 2,
        links: 4,
        new: 10,
        changed: 0,
        unchanged: 0,
      },
      items: 10,
      // One for each "S-5 needs S-4", the same as counts.links: the dialog's "4 links".
      links: 4,
      first: true,
    });
    expect(tracker.log).toEqual([]);
  });

  it('offers only a tracker that can make items', async () => {
    breakdown();
    expect(breakdownView(bp, 'BR-1', 'subscription').tracker).toMatchObject({ module: 'azure', label: 'Azure DevOps' });
    projectTracker = Object.assign(Object.create(tracker), { abilities: { ...tracker.abilities, create: false } });
    expect(breakdownView(bp, 'BR-1', 'subscription').tracker).toBeUndefined();
    expect(() => requestSend(bp, 'BR-1')).toThrow('This project has no tracker squad-kit can make items in. Connect one in Settings, then send.');
    projectTracker = null;
    expect(breakdownView(bp, 'BR-1', 'subscription').tracker).toBeUndefined();
  });
});

describe('the send, as a job', () => {
  it('runs item by item, saves its progress and every ref, then says what it did', async () => {
    breakdown('ready');
    expect(() => requestSend(bp, 'BR-1')).toThrow('Approve BR-1 first. Nothing is sent to Azure DevOps before the breakdown is approved.');
    breakdown();
    requestSend(bp, 'BR-1');
    // The dialog's units: 10 items, then 4 links.
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'pending', done: 0, of: 14, items: { done: 0, of: 10 }, links: { done: 0, of: 4 }, by: 'Momen' });
    expect(readBreakdownState(bp, 'BR-1').activity[0]).toMatchObject({ who: 'you', text: 'Sending BR-1 to Azure DevOps: 10 items and 4 links' });
    expect(() => requestSend(bp, 'BR-1')).toThrow('BR-1 is being sent to Azure DevOps now: 0 of 14 done.');
    expect(sendsDue(bp)).toEqual(['BR-1']);

    // Each write sees the progress saved before it.
    const seen: number[] = [];
    const create = tracker.createItem.bind(tracker);
    tracker.createItem = async (input) => {
      seen.push(readBreakdownState(bp, 'BR-1').sync!.done);
      return create(input);
    };
    const r = await runSend(bp, 'BR-1', { tracker });
    expect(r).toMatchObject({ done: 14, of: 14, created: 10, linked: 4 });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const s = readBreakdownState(bp, 'BR-1');
    expect(s.sync).toMatchObject({ status: 'done', done: 14, of: 14, items: { done: 10, of: 10 }, links: { done: 4, of: 4 }, by: 'Momen' });
    expect(s.sync!.making).toBeUndefined();
    expect(s.activity[0]).toMatchObject({ who: 'squad', text: 'Sent to Azure DevOps: 10 new items, 4 links between stories that need each other' });
    const b = readBreakdown(bp, 'BR-1')!;
    expect(b.sent).toMatchObject({ module: 'azure', by: 'Momen' });
    expect(findItem(b, 'S-5')!.story!.tracker).toMatchObject({ module: 'azure', ref: expect.stringMatching(/^AB#\d+$/) });
    expect(sendsDue(bp)).toEqual([]);
    // Sent: the dialog says there is nothing new.
    expect(await sendPreview(bp, 'BR-1')).toMatchObject({ items: 0, links: 0, first: false });
    expect(() => requestSend(bp, 'BR-1')).toThrow('Azure DevOps has BR-1 as it is now. Nothing changed since the last send.');
  });

  it('keeps the edits made while it runs', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    const create = tracker.createItem.bind(tracker);
    tracker.createItem = async (input) => {
      if (input.title === 'Hold a slot') updateBreakdown(bp, 'BR-1', (x) => (findItem(x, 'S-6')!.story!.title = 'Check out early'));
      return create(input);
    };
    await runSend(bp, 'BR-1', { tracker });
    const b = readBreakdown(bp, 'BR-1')!;
    expect(findItem(b, 'S-6')!.story!.title).toBe('Check out early');
    expect(findItem(b, 'S-6')!.story!.tracker).toBeTruthy();
    // The new title goes at the next send, as a change.
    expect(planSend(b, 'azure').items.map((i) => `${i.action} ${i.key}`)).toEqual(['update S-6']);
  });

  it('cut off half-way, carries on where it was and makes no doubles', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    const stop = new AbortController();
    const create = tracker.createItem.bind(tracker);
    tracker.createItem = async (input) => {
      const row = await create(input);
      if (creates() === 4) stop.abort();
      return row;
    };
    const cut = await runSend(bp, 'BR-1', { tracker, signal: stop.signal });
    expect(cut).toMatchObject({ stopped: true, done: 4 });
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'pending', done: 4, of: 14, items: { done: 4, of: 10 } });

    // The board opens again: the squad finds the send due and carries on.
    const jobs = { running: new Set<string>(), stops: new Map<string, AbortController>() };
    startSends(bp, { user: { name: 'Momen', role: 'Business analyst' } }, jobs);
    expect([...jobs.running]).toEqual(['__send:BR-1']);
    for (let i = 0; i < 100 && jobs.running.size; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'done', done: 14, of: 14, items: { done: 10, of: 10 }, links: { done: 4, of: 4 } });
    expect(creates()).toBe(10);
    expect(tracker.items.size).toBe(10);
  });

  it('cut off right after the tracker made an item, finds that item next time instead of making it again', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    const create = tracker.createItem.bind(tracker);
    tracker.createItem = async (input) => {
      const row = await create(input);
      // The answer never came back: the item is made, its link is not saved.
      if (input.title === 'Hold a slot') throw new Error('Azure DevOps did not answer');
      return row;
    };
    const r = await runSend(bp, 'BR-1', { tracker });
    expect(r?.error).toMatch(/^Could not make S-3 "Hold a slot"/);
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'failed', making: 'S-3' });
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-3')!.story!.tracker).toBeUndefined();
    tracker.createItem = create;
    // Send again: S-3 is looked for in the tracker by its tag and its line, and used.
    requestSend(bp, 'BR-1');
    expect(readBreakdownState(bp, 'BR-1').sync!.making).toBe('S-3');
    await runSend(bp, 'BR-1', { tracker });
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'done' });
    expect(readBreakdownState(bp, 'BR-1').sync!.making).toBeUndefined();
    expect(tracker.items.size).toBe(10);
    expect([...tracker.items.values()].filter((w) => w.title === 'Hold a slot')).toHaveLength(1);
  });

  it('a crash mid-send is picked up too, and a tracker problem stops it with the reason', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    updateBreakdownState(bp, 'BR-1', (s) => (s.sync = { ...s.sync!, status: 'running', done: 2 }));
    expect(sendsDue(bp)).toEqual(['BR-1']);
    tracker.breakAfter(3);
    const r = await runSend(bp, 'BR-1', { tracker });
    expect(r?.error).toBe('Could not make F-2 "Holding" in Azure DevOps: Azure DevOps did not answer. 3 of 14 are sent. Send again carries on from there.');
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'failed', error: r!.error });
    tracker.mend();
    requestSend(bp, 'BR-1');
    await runSend(bp, 'BR-1', { tracker });
    expect(readBreakdownState(bp, 'BR-1').sync?.status).toBe('done');
    expect(creates()).toBe(10);
  });

  it('runs in the live squad as __send:BR-1, beside the tickets and outside their limit', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    const squad = new LiveSquad(bp) as unknown as { tick(): void; running: Set<string>; ticketsRunning(): number };
    squad.tick();
    expect([...squad.running]).toContain('__send:BR-1');
    expect(squad.ticketsRunning()).toBe(0);
    for (let i = 0; i < 100 && squad.running.has('__send:BR-1'); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(readBreakdownState(bp, 'BR-1').sync?.status).toBe('done');
  });
});

describe('after a send', () => {
  it('links the ticket of a story started later to its item, so the item moves forward', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    await runSend(bp, 'BR-1', { tracker });
    const link = findItem(readBreakdown(bp, 'BR-1')!, 'S-1')!.story!.tracker!;
    const t = startStory(bp, 'BR-1', 'S-1');
    expect(t.source).toEqual({ type: 'azure', id: link.id, ref: link.ref, url: link.url, itemType: 'User Story' });
    expect(t.trackerQueue).toEqual([{ kind: 'started' }]);
    expect(t.activity[0]!.text).toBe(`Linked to ${link.ref} on Azure DevOps, where BR-1 › S-1 was sent`);
    expect(readTicket(bp, t.id)!.activity.some((a) => a.text.startsWith('Pulled'))).toBe(false);
  });

  it('a story started before the send gets its item once the send is done', async () => {
    breakdown();
    const t = startStory(bp, 'BR-1', 'S-1');
    expect(t.source).toEqual({ type: 'manual' });
    requestSend(bp, 'BR-1');
    await runSend(bp, 'BR-1', { tracker });
    expect(readTicket(bp, t.id)!.source).toMatchObject({ type: 'azure', itemType: 'User Story' });
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe(`Sent to Azure DevOps: 10 new items, 4 links between stories that need each other. ${t.id} now moves forward there as it builds`);
  });

  it('renaming the breakdown changes no item', async () => {
    breakdown();
    requestSend(bp, 'BR-1');
    await runSend(bp, 'BR-1', { tracker });
    renameBreakdown(bp, 'BR-1', 'RoomFlow BRD v3');
    expect(planSend(readBreakdown(bp, 'BR-1')!, 'azure').items).toEqual([]);
    expect([...tracker.items.values()][0]!.description).toBe('Made by squad-kit from BR-1, E-1.');
  });
});

describe('the view for the page', () => {
  it('says what stops Approve while the breakdown is ready, and nothing once approved', () => {
    const b = breakdown('ready');
    updateBreakdown(bp, b.id, (x) => (findItem(x, 'S-6')!.story!.criteria = []));
    expect(breakdownView(bp, 'BR-1', 'subscription').problems).toEqual(['S-6 has no "done when" yet.']);
    breakdown('approved');
    expect(breakdownView(bp, 'BR-1', 'subscription').problems).toEqual([]);
  });
});

describe('the routes', () => {
  const app = () => {
    const a = new Hono();
    mountRequirementsApi(a, { paths: buildPaths(tmp) });
    return a;
  };
  const call = async (a: Hono, method: string, url: string, body?: unknown) => {
    const r = await a.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  it('build, send and its preview, one call each', async () => {
    breakdown();
    const a = app();
    expect((await call(a, 'GET', '/api/v1/requirements/BR-1/send')).json).toMatchObject({ items: 10, links: 4, first: true });
    const sent = await call(a, 'POST', '/api/v1/requirements/BR-1/send');
    expect((sent.json as unknown as BreakdownView).state.sync).toMatchObject({ status: 'pending', of: 14, items: { done: 0, of: 10 }, links: { done: 0, of: 4 } });
    expect((await call(a, 'POST', '/api/v1/requirements/BR-1/build', { on: 'yes' })).status).toBe(400);
    const on = await call(a, 'POST', '/api/v1/requirements/BR-1/build', { on: true });
    expect((on.json as unknown as BreakdownView).state.build).toMatchObject({ on: true, by: 'Momen' });
    const off = await call(a, 'POST', '/api/v1/requirements/BR-1/build', { on: false });
    expect((off.json as unknown as BreakdownView).state.build).toMatchObject({ on: false });
    expect((await call(a, 'GET', '/api/v1/requirements/waiting')).json).toEqual({ breakdowns: [] });
    // The routes that take any id still work.
    expect((await call(a, 'GET', '/api/v1/requirements/BR-1')).json).toMatchObject({ id: 'BR-1', mine: true });
  });
});
