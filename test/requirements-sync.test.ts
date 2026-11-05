import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Breakdown, BreakdownStory } from '../src/board/requirements-types.js';
import { applySendChange, linkTickets, planSend, sendBreakdown, storySource, type SendChange } from '../src/board/requirements-sync.js';
import { demoTracker, type DemoTracker } from '../src/board/demo-tracker.js';
import { boardPaths, readTicket, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { flushTracker } from '../src/engine/sync.js';

/** Sending a breakdown to the tracker: what the plan makes, changes and links, and how a send carries on. */

const story = (key: string, title: string, dependsOn: string[] = [], ref?: BreakdownStory['ref']): BreakdownStory => ({
  key,
  title,
  story: `As a guest, I want to ${title.toLowerCase()}, so that my stay is easy.`,
  criteria: [{ given: 'a free room', when: `I ${title.toLowerCase()}`, then: 'it is saved' }],
  size: 'M',
  dependsOn,
  ...(ref ? { ref } : {}),
});

function breakdown(): Breakdown {
  return {
    id: 'BR-1',
    title: 'RoomFlow BRD v2',
    status: 'approved',
    source: { file: 'source/RoomFlow BRD v2.docx', name: 'RoomFlow BRD v2.docx', kind: 'docx', bytes: 1000, addedBy: 'Momen', addedAt: '2026-11-04T08:00:00.000Z' },
    questions: [],
    decided: [],
    leftOut: [],
    approved: { by: 'Momen', at: '2026-11-04T09:00:00.000Z' },
    createdAt: '2026-11-04T08:00:00.000Z',
    createdBy: 'Momen',
    owner: 'Momen',
    next: { epic: 3, feature: 3, story: 6 },
    epics: [
      {
        key: 'E-1',
        title: 'Booking',
        goal: 'Guests book rooms online.',
        ref: { section: '3', title: 'Booking', page: 5 },
        stories: [],
        features: [
          { key: 'F-1', title: 'Search', summary: 'Find a free room.', stories: [story('S-1', 'Search rooms'), story('S-2', 'Filter by price')] },
          { key: 'F-2', title: 'Holding', summary: 'Hold a room while paying.', stories: [story('S-3', 'Hold a slot', ['S-1', 'S-2'], { section: '3.4', title: 'Holding a slot', page: 7 })] },
        ],
      },
      // A small part of the BRD: no features, the stories sit straight under the epic.
      { key: 'E-2', title: 'Front desk', goal: 'Staff check guests in and out.', features: [], stories: [story('S-4', 'Check in'), story('S-5', 'Check out', ['S-4'])] },
    ],
  };
}

const find = (b: Breakdown, key: string) => {
  for (const e of b.epics) {
    if (e.key === key) return e;
    for (const f of e.features) {
      if (f.key === key) return f;
      const s = f.stories.find((x) => x.key === key);
      if (s) return s;
    }
    const s = e.stories.find((x) => x.key === key);
    if (s) return s;
  }
  throw new Error(key);
};

/** A send whose every save is kept, as a file would keep it. */
async function send(b: Breakdown, tracker: DemoTracker, more: Partial<Parameters<typeof sendBreakdown>[2]> = {}) {
  const saves: Breakdown[] = [];
  const result = await sendBreakdown(b, tracker, { save: (x) => saves.push(structuredClone(x)), by: 'Momen', ...more });
  return { result, saves, stored: saves.at(-1) ?? b };
}

const itemOf = (tracker: DemoTracker, b: Breakdown, key: string) => tracker.items.get(find(b, key).tracker!.id)!;

describe('planning a send', () => {
  it('makes everything on the first send: epics, then features, then stories, each after its parent', () => {
    const plan = planSend(breakdown(), 'azure');
    expect(plan.items.map((i) => `${i.action} ${i.key}${i.parent ? ` under ${i.parent}` : ''}`)).toEqual([
      'create E-1',
      'create E-2',
      'create F-1 under E-1',
      'create F-2 under E-1',
      'create S-1 under F-1',
      'create S-2 under F-1',
      'create S-3 under F-2',
      'create S-4 under E-2',
      'create S-5 under E-2',
    ]);
    expect(plan.links).toEqual([
      { key: 'S-3', on: ['S-1', 'S-2'], hash: expect.stringMatching(/^[0-9a-f]{8}$/) },
      { key: 'S-5', on: ['S-4'], hash: expect.stringMatching(/^[0-9a-f]{8}$/) },
    ]);
    expect(plan.counts).toEqual({
      epics: { all: 2, new: 2, changed: 0, unchanged: 0 },
      features: { all: 2, new: 2, changed: 0, unchanged: 0 },
      stories: { all: 5, new: 5, changed: 0, unchanged: 0 },
      storiesUnderEpic: 2,
      links: 3,
      new: 9,
      changed: 0,
      unchanged: 0,
    });
  });

  it('gives each item its text: the story, Done when, its place in the BRD and where it came from', () => {
    const plan = planSend(breakdown(), 'azure');
    const s3 = plan.items.find((i) => i.key === 'S-3')!;
    expect(s3.title).toBe('Hold a slot');
    expect(s3.markdown).toBe(
      'As a guest, I want to hold a slot, so that my stay is easy.\n\nFrom the BRD: 3.4 Holding a slot, page 7\n\nMade by squad-kit from BR-1, S-3.',
    );
    expect(s3.acceptance).toBe('**Given** a free room\n**When** I hold a slot\n**Then** it is saved');
    expect(plan.items[0]!.markdown).toBe('Guests book rooms online.\n\nFrom the BRD: 3 Booking, page 5\n\nMade by squad-kit from BR-1, E-1.');
    expect(plan.items.find((i) => i.key === 'F-1')).toMatchObject({ markdown: 'Find a free room.\n\nMade by squad-kit from BR-1, F-1.' });
    expect(plan.items.find((i) => i.key === 'F-1')!.acceptance).toBeUndefined();
  });

  it('skips the features level when a breakdown has none', () => {
    const b = breakdown();
    b.epics = [b.epics[1]!];
    const plan = planSend(b, 'azure');
    expect(plan.items.map((i) => `${i.key}${i.parent ? ` under ${i.parent}` : ''}`)).toEqual(['E-2', 'S-4 under E-2', 'S-5 under E-2']);
    expect(plan.counts.features.all).toBe(0);
    expect(plan.counts.storiesUnderEpic).toBe(2);
  });

  it('treats items sent to another tracker as new to this one', () => {
    const b = breakdown();
    find(b, 'E-1').tracker = { module: 'other', id: '1', ref: 'X-1', url: '', type: 'Epic', sentHash: 'abc', sentAt: '' };
    expect(planSend(b, 'azure').items[0]).toMatchObject({ key: 'E-1', action: 'create' });
  });
});

describe('sending a breakdown', () => {
  let tracker: DemoTracker;
  beforeEach(() => {
    tracker = demoTracker({ baseUrl: 'https://boards.example/items/' });
  });

  it('saves right after each item with its tracker link filled in, then the links, then the send', async () => {
    const b = breakdown();
    const changes: SendChange[] = [];
    const progress: string[] = [];
    const parts: unknown[] = [];
    const result = await sendBreakdown(b, tracker, {
      save: (_b, c) => changes.push(structuredClone(c)),
      progress: (d, of, p) => {
        progress.push(`${d}/${of}`);
        parts.push(p);
      },
      by: 'Sara',
    });
    // The dialog's units: 9 items, and 3 links (S-3 needs S-1 and S-2, S-5 needs S-4).
    expect(result).toEqual({ done: 12, of: 12, created: 9, updated: 0, linked: 3 });
    expect(changes.map((c) => ('key' in c ? c.key : 'sent'))).toEqual(['E-1', 'E-2', 'F-1', 'F-2', 'S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-3', 'S-5', 'sent']);
    expect(changes[0]).toEqual({
      key: 'E-1',
      tracker: { module: 'azure', id: '120', ref: 'AB#120', url: 'https://boards.example/items/120', type: 'Epic', sentHash: expect.stringMatching(/^[0-9a-f]{12}$/), sentAt: expect.any(String) },
    });
    expect(progress[0]).toBe('0/12');
    expect(progress.at(-1)).toBe('12/12');
    expect(parts[9]).toEqual({ items: { done: 9, of: 9 }, links: { done: 0, of: 3 } });
    expect(parts.at(-1)).toEqual({ items: { done: 9, of: 9 }, links: { done: 3, of: 3 } });
    expect(b.sent).toEqual({ module: 'azure', at: expect.any(String), by: 'Sara' });
    // A story's links are kept in its hash once they are made.
    expect(find(b, 'S-3').tracker!.sentHash).toMatch(/^[0-9a-f]{12}:[0-9a-f]{8}$/);

    // In the tracker: each item under its parent, the stories of a small part straight under the epic, tagged.
    expect(itemOf(tracker, b, 'S-3')).toMatchObject({ type: 'User Story', parent: find(b, 'F-2').tracker!.id, tags: ['squad-kit', 'BR-1'] });
    expect(itemOf(tracker, b, 'S-4').parent).toBe(find(b, 'E-2').tracker!.id);
    expect(itemOf(tracker, b, 'F-1').parent).toBe(find(b, 'E-1').tracker!.id);
    expect(itemOf(tracker, b, 'S-3').acceptance).toContain('**When** I hold a slot');
  });

  it('turns needs into dependency links, read back as what a story depends on', async () => {
    const b = breakdown();
    await send(b, tracker);
    const got = await tracker.get(find(b, 'S-3').tracker!.id);
    expect(got.dependsOn.map((d) => d.ref)).toEqual([find(b, 'S-1').tracker!.ref, find(b, 'S-2').tracker!.ref]);
  });

  it('makes no doubles on a second send, and sends nothing when nothing changed', async () => {
    const { stored } = await send(breakdown(), tracker);
    const plan = planSend(stored, 'azure');
    expect(plan.items).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.counts).toMatchObject({ new: 0, changed: 0, unchanged: 9, links: 3 });
    const writes = tracker.log.length;
    const again = await send(stored, tracker);
    expect(again.result).toMatchObject({ done: 0, of: 0, created: 0 });
    expect(tracker.log).toHaveLength(writes);
    expect(tracker.items.size).toBe(9);
    expect(again.stored.sent).toBeTruthy();
  });

  it('updates only the story that changed', async () => {
    const { stored } = await send(breakdown(), tracker);
    find(stored, 'S-2').title = 'Filter by price and stars';
    const plan = planSend(stored, 'azure');
    expect(plan.items.map((i) => `${i.action} ${i.key}`)).toEqual(['update S-2']);
    expect(plan.counts).toMatchObject({ new: 0, changed: 1, unchanged: 8, stories: { all: 5, new: 0, changed: 1, unchanged: 4 } });
    const writes = tracker.log.length;
    const { result } = await send(stored, tracker);
    expect(result).toMatchObject({ created: 0, updated: 1, linked: 0 });
    expect(tracker.log.slice(writes)).toEqual([`update ${find(stored, 'S-2').tracker!.id}`]);
    expect(itemOf(tracker, stored, 'S-2').title).toBe('Filter by price and stars');
    expect(planSend(stored, 'azure').items).toEqual([]);
  });

  it('replaces the parent of a moved story', async () => {
    const { stored } = await send(breakdown(), tracker);
    const e1 = stored.epics[0]!;
    const moved = e1.features[0]!.stories.splice(1, 1)[0]!;
    e1.features[1]!.stories.push(moved);
    expect(planSend(stored, 'azure').items).toMatchObject([{ action: 'update', key: 'S-2', parent: 'F-2' }]);
    await send(stored, tracker);
    expect(itemOf(tracker, stored, 'S-2').parent).toBe(find(stored, 'F-2').tracker!.id);
  });

  it('adds a new need as a link only, without updating the story', async () => {
    const { stored } = await send(breakdown(), tracker);
    (find(stored, 'S-5') as BreakdownStory).dependsOn.push('S-1');
    const plan = planSend(stored, 'azure');
    expect(plan.items).toEqual([]);
    expect(plan.links).toMatchObject([{ key: 'S-5', on: ['S-4', 'S-1'] }]);
    const writes = tracker.log.length;
    await send(stored, tracker);
    expect(tracker.log.slice(writes)).toEqual([`link ${find(stored, 'S-5').tracker!.id} ${find(stored, 'S-1').tracker!.id}`]);
  });

  it('never deletes: a part removed from the breakdown stays in the tracker', async () => {
    const { stored } = await send(breakdown(), tracker);
    const gone = find(stored, 'S-2').tracker!.id;
    stored.epics[0]!.features[0]!.stories.splice(1, 1);
    (find(stored, 'S-3') as BreakdownStory).dependsOn = ['S-1'];
    const plan = planSend(stored, 'azure');
    expect(plan.items).toEqual([]);
    expect(plan.counts.stories.all).toBe(4);
    await send(stored, tracker);
    expect(tracker.items.size).toBe(9);
    expect(tracker.items.get(gone)!.title).toBe('Filter by price');
    expect(itemOf(tracker, stored, 'S-3').dependsOn).toContain(gone);
  });

  it('a send cut off half-way keeps what was made, and the next one carries on without doubles', async () => {
    tracker.breakAfter(4);
    const first = await send(breakdown(), tracker);
    expect(first.result).toMatchObject({ done: 4, of: 12, created: 4 });
    expect(first.result.error).toBe('Could not make S-1 "Search rooms" in Azure DevOps: Azure DevOps did not answer. 4 of 12 are sent. Send again carries on from there.');
    expect(first.stored.sent).toBeUndefined();
    expect(['E-1', 'E-2', 'F-1', 'F-2'].map((k) => Boolean(find(first.stored, k).tracker))).toEqual([true, true, true, true]);
    expect(find(first.stored, 'S-1').tracker).toBeUndefined();
    expect(tracker.items.size).toBe(4);

    tracker.mend();
    const second = await send(first.stored, tracker);
    expect(second.result).toEqual({ done: 8, of: 8, created: 5, updated: 0, linked: 3 });
    expect(tracker.items.size).toBe(9);
    expect(new Set([...tracker.items.values()].map((w) => w.title)).size).toBe(9);
    expect(planSend(second.stored, 'azure').items).toEqual([]);
  });

  it('a send cut off between making an item and saving it finds that item next time, and makes no double', async () => {
    let making: string | null = null;
    const saves: Breakdown[] = [];
    // The board closes right after the tracker made S-1, before its link was saved.
    const first = await sendBreakdown(breakdown(), tracker, {
      save: (x, c) => {
        if ('key' in c && c.key === 'S-1') throw new Error('The board closed');
        saves.push(structuredClone(x));
      },
      making: (k) => (making = k),
    });
    expect(first.error).toMatch(/^Could not make S-1/);
    expect(making).toBe('S-1');
    const made = [...tracker.items.values()].find((w) => w.title === 'Search rooms')!;
    expect(tracker.items.size).toBe(5);
    const stored = saves.at(-1)!;
    expect(find(stored, 'S-1').tracker).toBeUndefined();

    // The next send looks for S-1 by its tag and its line, uses it, and makes the rest.
    const second = await send(stored, tracker, { cutOff: 'S-1', making: (k) => (making = k) });
    expect(second.result).toMatchObject({ created: 5, found: 1 });
    expect(find(second.stored, 'S-1').tracker!.id).toBe(made.id);
    expect(tracker.items.size).toBe(9);
    expect(making).toBeNull();
    expect([...tracker.items.values()].filter((w) => w.title === 'Search rooms')).toHaveLength(1);
  });

  it('a send cut off before the links makes them next time', async () => {
    tracker.breakAfter(9);
    const first = await send(breakdown(), tracker);
    expect(first.result).toMatchObject({ done: 9, created: 9, linked: 0 });
    expect(first.result.error).toMatch(/^Could not link S-3 to the stories it needs in Azure DevOps/);
    tracker.mend();
    const plan = planSend(first.stored, 'azure');
    expect(plan.items).toEqual([]);
    expect(plan.links.map((l) => l.key)).toEqual(['S-3', 'S-5']);
    await send(first.stored, tracker);
    expect(itemOf(tracker, first.stored, 'S-5').dependsOn).toEqual([find(first.stored, 'S-4').tracker!.id]);
    expect(tracker.items.size).toBe(9);
  });

  it('stops between two items when asked, and carries on later', async () => {
    const stop = new AbortController();
    const first = await send(breakdown(), tracker, { progress: (done) => done === 6 && stop.abort(), signal: stop.signal });
    expect(first.result).toMatchObject({ done: 6, stopped: true });
    expect(first.result.error).toBeUndefined();
    expect(tracker.items.size).toBe(6);
    const second = await send(first.stored, tracker);
    expect(second.result).toMatchObject({ created: 3, linked: 3 });
    expect(tracker.items.size).toBe(9);
  });

  it('a problem before anything is made says nothing was sent', async () => {
    tracker.levels = async () => {
      throw new Error('The project has no User Story type.');
    };
    const { result } = await send(breakdown(), tracker);
    expect(result.error).toBe('Could not read the item types Azure DevOps uses: The project has no User Story type. Nothing was sent yet.');
    expect(tracker.items.size).toBe(0);
  });

  it('sends only an approved breakdown, to a tracker that can make items', async () => {
    const b = breakdown();
    delete b.approved;
    await expect(send(b, tracker)).rejects.toThrow('Approve BR-1 before sending it to Azure DevOps.');
    const readOnly = demoTracker();
    (readOnly.abilities as { create: boolean }).create = false;
    await expect(send(breakdown(), readOnly)).rejects.toThrow('squad-kit cannot make items in Azure DevOps.');
  });

  it('a save can merge into a fresh copy, so edits made during the send are kept', async () => {
    const fresh = breakdown();
    let renamed = false;
    await sendBreakdown(breakdown(), tracker, {
      save: (_b, change) => {
        if (!renamed) {
          // The person renames a story while the send runs.
          find(fresh, 'S-5').title = 'Check out and pay';
          renamed = true;
        }
        applySendChange(fresh, change);
      },
    });
    expect(find(fresh, 'S-5').title).toBe('Check out and pay');
    expect(fresh.sent?.by).toBe('Momen');
    expect(['E-1', 'F-2', 'S-3', 'S-5'].every((k) => find(fresh, k).tracker?.ref.startsWith('AB#'))).toBe(true);
    // The rename was not sent yet: the next send updates that one story.
    expect(planSend(fresh, 'azure').items.map((i) => `${i.action} ${i.key}`)).toEqual(['update S-5']);
  });
});

describe('tickets of sent stories', () => {
  let tmp: string;
  let bp: BoardPaths;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-sync-'));
    bp = boardPaths(path.join(tmp, '.squad'));
    writeMeta(bp, {
      project: 'RoomFlow',
      key: 'RO',
      nextNumber: 30,
      engine: 'live',
      user: { name: 'Momen', role: 'Business analyst' },
      roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
      tools: [],
      speed: 1,
      map: [],
      lessons: [],
      commands: {},
      git: { base: 'main', remote: 'origin' },
      scan: { status: 'done', empty: false },
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const start = (b: Breakdown, key: string) => {
    const s = find(b, key) as BreakdownStory;
    const t = actions.createTicket(bp, { title: s.title, fromBreakdown: { id: b.id, item: s.key, story: s.story, criteria: s.criteria, approvedBy: 'Momen' } });
    s.ticket = t.id;
    return t.id;
  };

  it('a ticket started before the send gets its story item as source, and its tracker updates then go out', async () => {
    const tracker = demoTracker();
    const b = breakdown();
    const id = start(b, 'S-1');
    expect(readTicket(bp, id)!.source).toEqual({ type: 'manual' });
    await sendBreakdown(b, tracker, { save: () => {} });

    expect(linkTickets(bp, b)).toEqual([id]);
    const link = find(b, 'S-1').tracker!;
    const t = readTicket(bp, id)!;
    expect(t.source).toEqual(storySource(link));
    expect(t.source).toEqual({ type: 'azure', id: link.id, ref: link.ref, url: link.url, itemType: 'User Story' });
    expect(t.activity[0]!.text).toBe(`Linked to ${link.ref} on Azure DevOps, where BR-1 › S-1 was sent`);
    expect(t.trackerQueue).toEqual([{ kind: 'started' }]);

    // Today's tracker updates now reach the story's item.
    await flushTracker(bp, id, tracker);
    const item = tracker.items.get(link.id)!;
    expect(item.state).toBe('Active');
    expect(item.comments).toEqual([`squad-kit started work on this as ticket **${id}**.`]);

    // Linked once only.
    expect(linkTickets(bp, b)).toEqual([]);
  });

  it('leaves alone tickets that have a tracker source, belong to another story, or are not started', async () => {
    const tracker = demoTracker();
    const b = breakdown();
    const pulled = start(b, 'S-1');
    updateTicket(bp, pulled, (x) => (x.source = { type: 'azure', id: '7', ref: 'AB#7' }));
    const other = start(b, 'S-2');
    updateTicket(bp, other, (x) => (x.breakdown = { id: 'BR-2', item: 'S-2' }));
    await sendBreakdown(b, tracker, { save: () => {} });
    expect(linkTickets(bp, b)).toEqual([]);
    expect(readTicket(bp, pulled)!.source.ref).toBe('AB#7');
  });

  it('on a demo board the ticket is linked, and no update is queued', async () => {
    writeMeta(bp, { ...(await import('../src/board/store.js')).readMeta(bp), engine: 'demo' });
    const b = breakdown();
    const id = start(b, 'S-4');
    await sendBreakdown(b, demoTracker(), { save: () => {} });
    expect(linkTickets(bp, b)).toEqual([id]);
    expect(readTicket(bp, id)!.trackerQueue).toBeUndefined();
  });
});
