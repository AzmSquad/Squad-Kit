import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTicket } from '../src/board/actions.js';
import { allStories, findItem, readBreakdown, readBreakdownState } from '../src/board/requirements.js';
import { breakdownDir } from '../src/board/requirements-paths.js';
import { epicPreview, importEpic } from '../src/board/epic-import.js';
import { itemHash, parseCriteria, sectionOf } from '../src/board/epic-text.js';
import { storyAsk } from '../src/board/story-ask.js';
import { epicBoard, type EpicBoard } from './support/epic.js';

/**
 * Build all on an epic or a feature (ADR-013): the preview the dialog shows, and the run it makes: the tracker's own
 * structure with every part's link from the start, Given/When/Then criteria read as "done when", the tracker's needs,
 * an item on the board kept on its ticket, and closed items left out with why.
 */

let e: EpicBoard;

beforeEach(async () => {
  e = await epicBoard();
});

afterEach(() => {
  fs.rmSync(e.tmp, { recursive: true, force: true });
});

describe('Given/When/Then criteria', () => {
  it('reads them on one line or on several, with And lines, bold words and list marks', () => {
    expect(parseCriteria('**Given** a booking\n**And** a free room\n**When** I check in\n**Then** the room is mine')).toEqual([{ given: 'a booking and a free room', when: 'I check in', then: 'the room is mine' }]);
    expect(parseCriteria('- Given a free slot, when I hold it, then it is mine for 10 minutes.\n- Given a held slot, when 10 minutes pass, then it is free again')).toEqual([
      { given: 'a free slot', when: 'I hold it', then: 'it is mine for 10 minutes' },
      { given: 'a held slot', when: '10 minutes pass', then: 'it is free again' },
    ]);
    expect(parseCriteria('Scenario 1:\nGiven a room that is free when nobody holds it\nWhen I hold it\nThen it is mine')).toEqual([{ given: 'a room that is free when nobody holds it', when: 'I hold it', then: 'it is mine' }]);
  });

  it('leaves anything else to the Analyst', () => {
    expect(parseCriteria('Cheap rooms first.')).toEqual([]);
    expect(parseCriteria('')).toEqual([]);
    expect(parseCriteria('Given a room\nThen it shows')).toEqual([]);
    expect(parseCriteria(`${'A long note about the page. '.repeat(5)}Given a room, when I open it, then it shows`)).toEqual([]);
  });
});

describe('the Build all preview', () => {
  it('lists the stories in build order with their needs and features, and what is left out, making nothing', async () => {
    const p = await epicPreview(e.bp, e.tracker, 'AB#120', { sprint: 'Mawid\\Sprint 14' });
    expect(p.root).toEqual({ id: '120', ref: 'AB#120', title: 'Booking', type: 'Epic', level: 'epic', url: 'https://tracker.example/items/120' });
    expect(p.stories.map((s) => s.ref)).toEqual(['AB#123', 'AB#124', 'AB#126', 'AB#127']);
    expect(p.stories[1]).toMatchObject({ title: 'Filter by price', feature: 'Search', needs: ['AB#123'], inSprint: false, isBug: false });
    expect(p.stories[0]!.inSprint).toBe(true);
    expect(p.stories[3]!.feature).toBeUndefined();
    expect(p.leftOut).toEqual([{ ref: 'AB#125', title: 'Old holding', why: 'Closed on Azure DevOps' }]);
    expect(p.sprint).toEqual({ name: 'Sprint 14', count: 1 });
    expect(p.atOnce).toBeGreaterThan(0);
    expect(p.estimate).toMatchObject({ rough: true });
    expect(p.run).toBeUndefined();
    expect(fs.existsSync(path.join(e.bp.squadDir, 'requirements'))).toBe(false);
  });

  it('puts what a story needs before it, whatever the tracker order', async () => {
    await e.tracker.linkDepends('126', ['127']);
    expect((await epicPreview(e.bp, e.tracker, '120')).stories.map((s) => s.ref)).toEqual(['AB#123', 'AB#124', 'AB#127', 'AB#126']);
  });

  it('says plainly when the item is a story, or not one of the tracker at all', async () => {
    await expect(epicPreview(e.bp, e.tracker, 'AB#126')).rejects.toThrow('AB#126 (User Story) is not an epic or a feature. Start it on its own from the Backlog.');
    await expect(epicPreview(e.bp, e.tracker, 'PAY-1')).rejects.toThrow('"PAY-1" is not an item on Azure DevOps.');
  });
});

describe('the run from an epic', () => {
  it('mirrors the tracker: the epic, its features and their stories, each linked from the start, nothing to send', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    expect(b.source).toMatchObject({ kind: 'tracker', file: 'source/tracker.md', name: 'AB#120 Booking', tracker: { module: 'azure', id: '120', ref: 'AB#120', type: 'Epic', label: 'Azure DevOps', url: 'https://tracker.example/items/120' } });
    expect(b.status).toBe('reading');
    const read = readBreakdown(e.bp, b.id)!;
    expect(read.epics.map((x) => [x.key, x.title, x.tracker?.ref])).toEqual([['E-1', 'Booking', 'AB#120']]);
    expect(read.epics[0]!.features.map((f) => [f.key, f.title, f.tracker?.ref, f.stories.map((s) => `${s.key} ${s.tracker?.ref}`)])).toEqual([
      ['F-1', 'Search', 'AB#121', ['S-1 AB#123', 'S-2 AB#124']],
      ['F-2', 'Holding', 'AB#122', ['S-3 AB#126']],
    ]);
    expect(read.epics[0]!.stories.map((s) => `${s.key} ${s.tracker?.ref}`)).toEqual(['S-4 AB#127']);
    for (const { story } of allStories(read)) expect(story.tracker!.sentHash).toBe(itemHash(await e.tracker.get(story.tracker!.id)));
    expect(read.next).toEqual({ epic: 2, feature: 3, story: 5 });
    // The job reads the whole epic once, from the copy of every item's words.
    expect(readBreakdownState(e.bp, b.id).job).toMatchObject({ step: 'read', status: 'pending' });
    const copy = fs.readFileSync(path.join(breakdownDir(e.bp, b.id), 'source', 'tracker.md'), 'utf8');
    expect(sectionOf(copy, 'AB#124')).toContain('**Needs first:** AB#123');
    expect(sectionOf(copy, 'AB#125')).toBeNull();
    expect(fs.readdirSync(path.join(breakdownDir(e.bp, b.id), 'text'))).toEqual(['part-01.md']);
  });

  it('reads Given/When/Then criteria as "done when", and leaves other criteria for the Analyst', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    expect(findItem(b, 'S-1')!.story!.criteria).toEqual([
      { given: 'two free rooms', when: 'I search for tonight', then: 'both show' },
      { given: 'no free room', when: 'I search', then: 'it says none are free' },
    ]);
    expect(findItem(b, 'S-2')!.story!.criteria).toEqual([]);
  });

  it("keeps the tracker's needs inside the run, marked as the tracker's", async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    expect(findItem(b, 'S-2')!.story).toMatchObject({ dependsOn: ['S-1'], needsFrom: { 'S-1': 'tracker' } });
    expect(findItem(b, 'S-1')!.story!.dependsOn).toEqual([]);
  });

  it('leaves out a closed item, with why, and keeps an item already on the board on its ticket', async () => {
    const t = createTicket(e.bp, { title: 'Hold a slot', ask: 'x', source: { type: 'azure', id: '126', ref: 'AB#126' } });
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    expect(b.leftOut).toEqual([{ text: 'AB#125 Old holding', why: 'Closed on Azure DevOps', ref: { section: 'AB#125' } }]);
    expect(allStories(b).map((p) => p.story.tracker!.ref)).not.toContain('AB#125');
    expect(findItem(b, 'S-3')!.story!.ticket).toBe(t.id);
    expect((await epicPreview(e.bp, e.tracker, 'AB#120')).stories.find((s) => s.ref === 'AB#126')!.onBoard).toBe(t.id);
  });

  it('runs an item once: Build all again names the run there is', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    expect((await epicPreview(e.bp, e.tracker, 'AB#120')).run).toBe(b.id);
    await expect(importEpic(e.bp, e.tracker, 'AB#120')).rejects.toThrow(`AB#120 has a run already: ${b.id}. New stories under it show there with Add to the run.`);
  });

  it('takes only the stories of a sprint when asked, leaving the others out with why', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120', { onlySprint: 'Mawid\\Sprint 14' });
    expect(allStories(b).map((p) => p.story.tracker!.ref)).toEqual(['AB#123']);
    expect(b.leftOut.map((l) => `${l.text}: ${l.why}`)).toEqual(['AB#125 Old holding: Closed on Azure DevOps', 'AB#124 Filter by price: Not in Sprint 14', 'AB#126 Hold a slot: Not in Sprint 14', 'AB#127 Show the version: Not in Sprint 14']);
    expect(b.epics[0]!.features.map((f) => f.title)).toEqual(['Search']);
  });

  it("gives each story's ticket its item's own words and where it sits", async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    const place = allStories(b).find((p) => p.story.key === 'S-2')!;
    const ask = storyAsk(e.bp, b, place);
    expect(ask).toContain('As a guest, I want to filter by price.');
    expect(ask).toContain('**Acceptance criteria**\n\nCheap rooms first.');
    expect(ask).toContain(`From AB#120 Booking › Search › AB#124, on Azure DevOps, built with ${b.id}.`);
  });
});

describe('the run from a feature', () => {
  it('sits under its own epic, linked to it, with only its own stories', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#121');
    expect(b.source.tracker).toMatchObject({ id: '121', ref: 'AB#121', type: 'Feature' });
    expect(b.title).toBe('Search');
    expect(b.epics.map((x) => [x.title, x.tracker?.ref])).toEqual([['Booking', 'AB#120']]);
    expect(b.epics[0]!.features.map((f) => [f.title, f.tracker?.ref, f.stories.map((s) => s.tracker?.ref)])).toEqual([['Search', 'AB#121', ['AB#123', 'AB#124']]]);
    expect(b.epics[0]!.stories).toEqual([]);
    expect((await epicPreview(e.bp, e.tracker, 'AB#121')).root.level).toBe('feature');
  });

  it('takes the feature as its own epic part when it sits under none', async () => {
    const lone = await e.tracker.createItem({ level: 'feature', title: 'Reports', markdown: 'x' });
    await e.tracker.createItem({ level: 'story', title: 'Daily report', markdown: 'x', parent: lone.id });
    const b = await importEpic(e.bp, e.tracker, lone.ref);
    expect(b.epics[0]).toMatchObject({ title: 'Reports' });
    expect(b.epics[0]!.tracker).toBeUndefined();
    expect(b.epics[0]!.features[0]!.tracker?.ref).toBe(lone.ref);
  });

  it('has nothing to build when every story under it is finished', async () => {
    await e.tracker.moveTo('123', 'resolved');
    await e.tracker.moveTo('124', 'closed');
    await expect(importEpic(e.bp, e.tracker, 'AB#121')).rejects.toThrow('AB#121 has no open stories under it, so there is nothing to build.');
  });
});
