import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModuleError } from '../../src/modules/errors.js';
import type { Tracker } from '../../src/modules/tracker/types.js';

/**
 * The shared tests every tracker module must pass (ADR-002). Each product runs them against its own fake backend.
 */
export interface TrackerFixture {
  tracker: Tracker;
  /** A story in the current sprint, under a feature, with one attachment. */
  story: string;
  /** The comments saved on an item, in the tracker's own format. */
  comments(id: string): string[];
  /** The same tracker with a sign-in the backend refuses. */
  refused: Tracker;
  /** Its own format is Markdown: comments go in as written. */
  keepsMarkdown?: boolean;
}

export function trackerContract(name: string, make: () => TrackerFixture): void {
  describe(`${name} as a tracker`, () => {
    it('writes and reads item ids', () => {
      const { tracker, story } = make();
      expect(tracker.parseRef(tracker.refOf(story))).toBe(story);
      expect(tracker.parseRef('not an item')).toBeNull();
    });

    it('says who is signed in, and refuses a bad sign-in in the shared way', async () => {
      const { tracker, refused } = make();
      expect(await tracker.whoAmI()).toBeTruthy();
      await expect(refused.whoAmI()).rejects.toMatchObject({ kind: 'sign-in' });
      await expect(refused.whoAmI()).rejects.toBeInstanceOf(ModuleError);
    });

    it('lists the backlog and the current sprint', async () => {
      const { tracker, story } = make();
      const all = await tracker.list();
      const row = all.find((r) => r.id === story)!;
      expect(row).toMatchObject({ id: story, ref: tracker.refOf(story), isBug: false });
      expect(row.title).toBeTruthy();
      if (tracker.abilities.sprints) {
        const sprints = await tracker.sprints();
        const current = sprints.find((s) => s.current)!;
        expect(current).toBeTruthy();
        expect((await tracker.list({ sprint: current.path })).map((r) => r.id)).toContain(story);
      }
    });

    it('gets one item as plain text, with what it belongs to and its files', async () => {
      const { tracker, story } = make();
      const item = await tracker.get(story);
      expect(item.ref).toBe(tracker.refOf(story));
      expect(item.description).toBeTruthy();
      expect(item.description).not.toMatch(/<[a-z]/i);
      expect(item.parents.length).toBeGreaterThan(0);
      expect(item.attachments.length).toBeGreaterThan(0);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-contract-')), item.attachments[0]!.name);
      expect(fs.existsSync(await tracker.download(item.attachments[0]!.url, file))).toBe(true);
    });

    it('moves an item forward only', async () => {
      const { tracker, story } = make();
      expect(await tracker.moveTo(story, 'in-progress')).toBeTruthy();
      expect(await tracker.moveTo(story, 'in-progress')).toBeNull();
      expect(await tracker.moveTo(story, 'not-started')).toBeNull();
      expect(await tracker.moveTo(story, 'closed')).toBeTruthy();
    });

    it('takes comments written in Markdown', async () => {
      const { tracker, story, comments, keepsMarkdown } = make();
      await tracker.comment(story, '**Plan approved**\n\n1. Given a day\n2. Then it is saved');
      const saved = comments(story);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toContain('Plan approved');
      if (keepsMarkdown) expect(saved[0]).toBe('**Plan approved**\n\n1. Given a day\n2. Then it is saved');
      else expect(saved[0]).not.toContain('**');
    });

    it('files a bug when it can, and tags items when it can', async () => {
      const { tracker, story } = make();
      if (tracker.abilities.bugs) {
        const bug = await tracker.fileBug({ title: 'Friday shows open', steps: 'Open hours\n\nFriday says open', severity: 'annoying', tags: ['v0.2.0'], related: [story] });
        expect(bug).toMatchObject({ isBug: true, ref: tracker.refOf(bug.id) });
      }
      if (tracker.abilities.tags) await expect(tracker.addTag(story, 'v0.2.0')).resolves.toBeUndefined();
    });

    it('copies the wiki when it has one', async () => {
      const { tracker } = make();
      if (!tracker.abilities.wiki) return;
      const pages = await tracker.wikiPages();
      expect(pages.length).toBeGreaterThan(0);
      expect(pages[0]!.content).toBeTruthy();
    });
  });
}

/** What a tracker that makes items must do (abilities.create): sending a breakdown relies on it. */
export function trackerCreateContract(name: string, make: () => Tracker): void {
  describe(`${name} making items`, () => {
    it('says which item types it uses for each level', async () => {
      const tracker = make();
      expect(tracker.abilities.create).toBe(true);
      const levels = await tracker.levels();
      expect([levels.epic, levels.feature, levels.story, levels.process].every(Boolean)).toBe(true);
    });

    it('makes an epic, a feature under it and a story under that, with its criteria and tags', async () => {
      const tracker = make();
      const levels = await tracker.levels();
      const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'Guests book rooms online.', tags: ['squad-kit', 'BR-1'] });
      expect(epic).toMatchObject({ ref: tracker.refOf(epic.id), type: levels.epic, title: 'Booking', isBug: false });
      const feature = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'Hold a slot while paying.', parent: epic.id });
      const story = await tracker.createItem({
        level: 'story',
        title: 'Hold a slot',
        markdown: 'As a guest, I want to hold a slot, so that nobody takes it.',
        acceptance: '**Given** a free slot\n**When** I hold it\n**Then** it is mine for 10 minutes',
        parent: feature.id,
        tags: ['squad-kit', 'BR-1'],
      });
      const got = await tracker.get(story.id);
      expect(got).toMatchObject({ type: levels.story, title: 'Hold a slot' });
      expect(got.parents.map((p) => p.id)).toEqual([feature.id, epic.id]);
      expect(got.tags).toEqual(expect.arrayContaining(['squad-kit', 'BR-1']));
      expect(`${got.description}\n${got.acceptanceCriteria}`).toContain('I hold it');
    });

    it('changes an item, and a new parent replaces the old one', async () => {
      const tracker = make();
      const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'x' });
      const first = await tracker.createItem({ level: 'feature', title: 'Search', markdown: 'x', parent: epic.id });
      const second = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'x', parent: epic.id });
      const story = await tracker.createItem({ level: 'story', title: 'Hold a slot', markdown: 'x', parent: first.id });
      await tracker.updateItem(story.id, { title: 'Hold a room', markdown: 'As a guest, I want to hold a room.', acceptance: '**Given** a room', parent: second.id });
      const got = await tracker.get(story.id);
      expect(got.title).toBe('Hold a room');
      expect(got.description).toContain('hold a room');
      expect(got.parents.map((p) => p.id)).toEqual([second.id, epic.id]);
    });

    it('adds only the dependency links it does not have, and they show as what the item depends on', async () => {
      const tracker = make();
      const epic = await tracker.createItem({ level: 'epic', title: 'Front desk', markdown: 'x' });
      const checkIn = await tracker.createItem({ level: 'story', title: 'Check in', markdown: 'x', parent: epic.id });
      const pay = await tracker.createItem({ level: 'story', title: 'Pay', markdown: 'x', parent: epic.id });
      const checkOut = await tracker.createItem({ level: 'story', title: 'Check out', markdown: 'x', parent: epic.id });
      await tracker.linkDepends(checkOut.id, [checkIn.id]);
      await tracker.linkDepends(checkOut.id, [checkIn.id, pay.id]);
      await tracker.linkDepends(checkOut.id, [checkIn.id]);
      const got = await tracker.get(checkOut.id);
      expect(got.dependsOn.map((d) => d.ref).sort()).toEqual([tracker.refOf(checkIn.id), tracker.refOf(pay.id)].sort());
    });
  });
}
