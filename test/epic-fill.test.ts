import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { allKeys, allStories, findItem, readBreakdown, readBreakdownState } from '../src/board/requirements.js';
import { answerBreakdown, approveBreakdown, redoItem } from '../src/board/requirements-actions.js';
import { importEpic } from '../src/board/epic-import.js';
import { addTrackerStories } from '../src/board/epic-new.js';
import { updateBreakdownState } from '../src/board/requirements.js';
import { runBreakdownJob, type AnalystAsk, type AnalystAnswer } from '../src/engine/breakdown-job.js';
import { epicBoard, type EpicBoard } from './support/epic.js';

/**
 * The Analyst's one read of a run from the tracker, and its fill in place of a draft, with a fake Analyst: the read asks
 * the one round of questions for the whole epic, the fill writes a missing "done when", a size and the needs the
 * tracker lacks, each under Decided for you, keeps the structure, and refuses a part the tracker does not have.
 */

let e: EpicBoard;
let asks: AnalystAsk[];
let answers: unknown[];

const run = async (a: AnalystAsk): Promise<AnalystAnswer> => {
  asks.push(a);
  return { text: '', structured: answers.shift(), sessionId: 'read-1' };
};

const READ = { summary: 'Guests find and hold rooms.', epics: [{ title: 'Booking', features: ['Search', 'Holding'] }], questions: [], decided: [] };

const FILL = {
  stories: [
    { key: 'S-1', size: 'S', needs: [], criteria: [{ given: 'a room', when: 'I look', then: 'it shows' }] },
    { key: 'S-2', size: 'M', needs: [], criteria: [{ given: 'rooms at 50 and 90', when: 'I sort by price', then: 'the 50 room shows first' }] },
    { key: 'S-3', size: 'L', needs: [{ key: 'S-1', why: 'a room must be found before it is held' }], criteria: [{ given: 'a free room', when: 'I hold it', then: 'it is mine for 10 minutes' }] },
    { key: 'S-4', size: 'S', needs: [{ key: 'S-9', why: 'made up' }], criteria: [{ given: 'the app', when: 'I open it', then: 'the footer shows the version' }] },
    { key: 'S-77', size: 'M', needs: [], criteria: [{ given: 'a', when: 'b', then: 'c' }] },
  ],
  decided: [{ text: 'Prices show with VAT.', item: 'S-2' }],
};

beforeEach(async () => {
  e = await epicBoard();
  asks = [];
  answers = [];
});

afterEach(() => {
  fs.rmSync(e.tmp, { recursive: true, force: true });
});

describe('the read of a run from the tracker', () => {
  it("reads the epic's copy with the epic brief, and asks the one round of questions for all of it", async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push({ ...READ, questions: [{ kind: 'gap', text: 'Who may hold a room?', options: ['Guests', 'Staff'], refs: [{ section: 'AB#126', title: 'Hold a slot' }] }] });
    await runBreakdownJob(e.bp, b.id, { run });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.prompt).toContain('build a whole epic or\nfeature from their tracker');
    expect(asks[0]!.prompt).toContain('you add no story, split none and join');
    expect(asks[0]!.prompt).toContain('text/part-01.md');
    const after = readBreakdown(e.bp, b.id)!;
    expect(after.status).toBe('questions');
    expect(after.questions[0]).toMatchObject({ id: 'q1', kind: 'gap', text: 'Who may hold a room?' });
  });
});

describe('the fill', () => {
  it('writes a missing "done when", sizes each story and adds the needs the tracker lacks, each written down', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push(READ, FILL);
    await runBreakdownJob(e.bp, b.id, { run });
    expect(asks.map((a) => a.step)).toEqual(['questions', 'spec']);
    expect(asks[1]!.prompt).toContain('Now fill in these stories: S-1, S-2, S-3, S-4.');
    expect(asks[1]!.resume).toBe('read-1');
    // In the same conversation as the read, the stories' own words still come with the fill, marked as data.
    expect(asks[1]!.prompt).toContain('The stories to fill in, as the tracker has them, between <data> and </data>');
    expect(asks[1]!.prompt).toContain('### S-2 AB#124 Filter by price');
    expect(asks[1]!.prompt).toContain('**Acceptance criteria**\n\nCheap rooms first.');
    const after = readBreakdown(e.bp, b.id)!;
    expect(after.status).toBe('ready');
    // The tracker's own Given/When/Then stay; the ones it lacked are the Analyst's, and say so.
    expect(findItem(after, 'S-1')!.story!.criteria.map((c) => c.then)).toEqual(['both show', 'it says none are free']);
    expect(findItem(after, 'S-2')!.story!.criteria).toEqual([{ given: 'rooms at 50 and 90', when: 'I sort by price', then: 'the 50 room shows first' }]);
    expect(after.decided.map((d) => [d.item, d.text])).toEqual(
      expect.arrayContaining([
        ['S-2', 'Wrote "done when" for AB#124: the tracker had none, so the Analyst wrote 1 from its own words.'],
        ['S-3', 'AB#126 needs AB#123: a room must be found before it is held'],
        ['S-2', 'Prices show with VAT.'],
      ]),
    );
    expect(after.decided.some((d) => d.text.startsWith('Wrote "done when" for AB#123'))).toBe(false);
    expect(findItem(after, 'S-3')!.story).toMatchObject({ size: 'L', dependsOn: ['S-1'], needsFrom: { 'S-1': 'analyst' } });
    expect(findItem(after, 'S-2')!.story).toMatchObject({ dependsOn: ['S-1'], needsFrom: { 'S-1': 'tracker' } });
    expect(findItem(after, 'S-4')!.story!.dependsOn).toEqual([]);
    expect(readBreakdownState(e.bp, b.id).job).toMatchObject({ step: 'draft', status: 'done' });
  });

  it("keeps the tracker's structure and refuses a part the tracker does not have", async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    const keys = allKeys(readBreakdown(e.bp, b.id)!);
    answers.push(READ, FILL);
    await runBreakdownJob(e.bp, b.id, { run });
    const after = readBreakdown(e.bp, b.id)!;
    expect(allKeys(after)).toEqual(keys);
    expect(allStories(after).map((p) => p.story.tracker?.ref)).toEqual(['AB#123', 'AB#124', 'AB#126', 'AB#127']);
    expect(readBreakdownState(e.bp, b.id).activity.map((a) => a.text)).toContain('Left out what the Analyst named that is not in the run: S-77. A run from the tracker keeps its stories as they are');
  });

  it('follows the answers, after the one round of questions', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push({ ...READ, questions: [{ kind: 'gap', text: 'Who may hold a room?', options: ['Guests', 'Staff'] }] });
    await runBreakdownJob(e.bp, b.id, { run });
    answerBreakdown(e.bp, b.id, { q1: { choice: 'Staff' } });
    answers.push(FILL);
    await runBreakdownJob(e.bp, b.id, { run });
    expect(asks[1]!.prompt).toContain('Answer: Staff');
    expect(readBreakdown(e.bp, b.id)!.status).toBe('ready');
  });

  it('stops plainly when the Analyst fills in none of the stories', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push(READ, { stories: [{ key: 'S-50', size: 'M', needs: [] }], decided: [] });
    await runBreakdownJob(e.bp, b.id, { run });
    expect(readBreakdown(e.bp, b.id)!.status).toBe('failed');
    expect(readBreakdownState(e.bp, b.id).job).toMatchObject({ status: 'failed', step: 'draft' });
  });

  it('fills in the stories added after the approval, and a stop leaves the run approved', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push(READ, FILL);
    await runBreakdownJob(e.bp, b.id, { run });
    approveBreakdown(e.bp, b.id);
    const fresh = await e.tracker.createItem({ level: 'story', title: 'Pay at the desk', markdown: 'As a guest, I want to pay at the desk.', parent: '122' });
    updateBreakdownState(e.bp, b.id, (st) => (st.trackerNew = [{ id: fresh.id, ref: fresh.ref, title: 'Pay at the desk' }]));
    await addTrackerStories(e.bp, b.id, e.tracker);
    answers.push({ stories: [{ key: 'S-3', size: 'S', needs: [] }], decided: [] });
    await runBreakdownJob(e.bp, b.id, { run });
    expect(readBreakdown(e.bp, b.id)!.status).toBe('approved');
    expect(readBreakdownState(e.bp, b.id).job).toMatchObject({ step: 'redo', status: 'failed' });
    updateBreakdownState(e.bp, b.id, (st) => (st.job = { ...st.job!, status: 'pending' }));
    answers.push({ stories: [{ key: 'S-5', size: 'S', needs: [{ key: 'S-3', why: 'a held room is paid for' }], criteria: [{ given: 'a held room', when: 'I pay at the desk', then: 'it is booked' }] }], decided: [] });
    await runBreakdownJob(e.bp, b.id, { run });
    expect(asks.at(-1)!.prompt).toContain('Now fill in these stories: S-5.');
    const after = readBreakdown(e.bp, b.id)!;
    expect(after.status).toBe('approved');
    expect(findItem(after, 'S-5')!.story).toMatchObject({ size: 'S', dependsOn: ['S-3'], criteria: [{ then: 'it is booked' }] });
    expect(readBreakdownState(e.bp, b.id).rewritten).toEqual(['S-5']);
  });

  it('a redo fills one part again with your words, and may write again only the "done when" the Analyst wrote', async () => {
    const b = await importEpic(e.bp, e.tracker, 'AB#120');
    answers.push(READ, FILL);
    await runBreakdownJob(e.bp, b.id, { run });
    redoItem(e.bp, b.id, 'F-1', 'Sort by price from high to low too');
    answers.push({
      stories: [
        { key: 'S-1', size: 'M', needs: [], criteria: [{ given: 'x', when: 'y', then: 'z' }] },
        { key: 'S-2', size: 'L', needs: [], criteria: [{ given: 'rooms at 50 and 90', when: 'I sort from high to low', then: 'the 90 room shows first' }] },
      ],
      decided: [],
    });
    await runBreakdownJob(e.bp, b.id, { run });
    expect(asks[2]!.prompt).toContain('Sort by price from high to low too');
    expect(asks[2]!.prompt).toContain('Now fill in these stories: S-1, S-2.');
    const after = readBreakdown(e.bp, b.id)!;
    expect(findItem(after, 'S-2')!.story).toMatchObject({ size: 'L', criteria: [{ then: 'the 90 room shows first' }] });
    expect(findItem(after, 'S-1')!.story!.criteria.map((c) => c.then)).toEqual(['both show', 'it says none are free']);
    expect(readBreakdownState(e.bp, b.id).job).toMatchObject({ step: 'redo', status: 'done', item: 'F-1' });
  });
});
