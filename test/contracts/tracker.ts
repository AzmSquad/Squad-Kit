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
      const { tracker, story, comments } = make();
      await tracker.comment(story, '**Plan approved**\n\n1. Given a day\n2. Then it is saved');
      const saved = comments(story);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toContain('Plan approved');
      expect(saved[0]).not.toContain('**');
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
