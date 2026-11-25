import { describe, it, expect } from 'vitest';
import type { EpicPreviewStory } from '../../console-ui/src/api/epic-types.js';
import type { BreakdownView } from '../../console-ui/src/api/requirements-types.js';
import { buildCommand, fromTracker, holdsWords, needFrom, previewLines, runLine, runReadSteps, squadTimeWords } from '../../console-ui/src/lib/epic-run.js';
import { stopTag } from '../../console-ui/src/lib/requirements.js';

/** Build all on the Backlog, its dialog, and a run's words on the Requirements screens, without React. */

const story = (id: string, extra: Partial<EpicPreviewStory> = {}): EpicPreviewStory => ({ id, ref: `AB#${id}`, title: `Story ${id}`, type: 'User Story', isBug: false, state: 'New', needs: [], ...extra });
const tracker = { module: 'azure', id: '2001', ref: 'AB#2001', url: 'https://dev.azure.com/o/p/_workitems/edit/2001', type: 'Epic', label: 'Azure DevOps' };

type RunView = Pick<BreakdownView, 'status' | 'source' | 'questions' | 'state' | 'counts'>;
const run = (over: Partial<RunView> = {}): RunView => ({
  status: 'reading',
  source: { file: 'source/tracker.md', name: 'AB#2001', kind: 'tracker', bytes: 10, addedBy: 'Sara', addedAt: '2026-11-24T10:00:00Z', tracker },
  questions: [],
  state: { activity: [], job: { step: 'read', status: 'running', now: 'Reading AB#2014' } },
  counts: { epics: 1, features: 2, stories: 6, merged: 0, building: 0, needsYou: 0 },
  ...over,
});

describe('the Build all command', () => {
  it('names the item, and the sprint only when only its stories are ticked', () => {
    expect(buildCommand('AB#2001')).toBe('squad backlog build AB#2001');
    expect(buildCommand('PAY-40', 'Sprint 14')).toBe('squad backlog build PAY-40 --sprint "Sprint 14"');
    // A GitHub issue starts with #, which a shell would read as a comment.
    expect(buildCommand('#12')).toBe('squad backlog build "#12"');
  });
});

describe('a group on the Backlog', () => {
  it('says what it holds, bugs apart', () => {
    expect(holdsWords([{ isBug: false }, { isBug: false }, { isBug: true }])).toBe('2 stories, 1 bug');
    expect(holdsWords([{ isBug: false }])).toBe('1 story');
    expect(holdsWords([{ isBug: true }, { isBug: true }])).toBe('2 bugs');
  });

  it('says where its run is: building, paused, getting ready or all merged', () => {
    const r = { id: 'BR-2', approved: true, on: true, stories: 6, merged: 2, building: 2, needsYou: 1 };
    expect(runLine(r)).toEqual({ state: 'Building', merged: '2 of 6 merged', pct: 33, live: true, you: '1 needs you' });
    expect(runLine({ ...r, on: false }).state).toBe('Paused');
    expect(runLine({ ...r, approved: false, on: false, merged: 0, building: 0, needsYou: 0 })).toMatchObject({ state: 'Getting ready', you: '', live: false });
    // Approved and paused before anything started: paused, not getting ready.
    expect(runLine({ ...r, on: false, merged: 0, building: 0, needsYou: 0 }).state).toBe('Paused');
    expect(runLine({ ...r, merged: 6, building: 0, needsYou: 0 })).toMatchObject({ state: 'All merged', live: false, pct: 100 });
    expect(runLine({ ...r, needsYou: 2 }).you).toBe('2 need you');
  });
});

describe('the Build all list', () => {
  const stories = [
    story('2040', { feature: 'Top up', inSprint: true }),
    story('2041', { feature: 'Top up', needs: ['2040'], inSprint: true }),
    story('2045', { feature: 'Send money' }),
    story('2046', { feature: 'Send money', needs: ['AB#2045', 'AB#2099'] }),
  ];

  it('numbers the stories in order, with a feature line where the feature changes, and needs by number', () => {
    const lines = previewLines(stories, false, 'Azure DevOps');
    expect(lines.map((l) => (l.kind === 'feature' ? `F ${l.title}` : `${l.n} ${l.story.ref} ${l.needs}`.trim()))).toEqual([
      'F Top up',
      '1 AB#2040',
      '2 AB#2041 needs 1 · from Azure DevOps',
      'F Send money',
      '3 AB#2045',
      // A need outside the list keeps its ref.
      '4 AB#2046 needs 3, AB#2099 · from Azure DevOps',
    ]);
  });

  it('keeps only the sprint\'s stories when that is ticked, numbered again', () => {
    const lines = previewLines(stories, true, 'Jira');
    expect(lines.filter((l) => l.kind === 'story').map((l) => (l.kind === 'story' ? l.n : 0))).toEqual([1, 2]);
    expect(lines.some((l) => l.kind === 'feature' && l.title === 'Send money')).toBe(false);
  });

  it('says the estimate in squad time, with the cost when there is one', () => {
    expect(squadTimeWords({ minutes: 540, rough: false })).toBe('About 9 hours of squad time');
    expect(squadTimeWords({ minutes: 45, costUsd: 12.4, rough: true })).toBe('About 45 min and $12 of squad time, a rough guess');
  });
});

describe('a run on the Requirements screens', () => {
  it('is told apart from a document', () => {
    expect(fromTracker(run())).toBe(true);
    expect(fromTracker({ source: { kind: 'docx' } })).toBe(false);
  });

  it("says where a need came from, and nothing for a BRD's", () => {
    const s = { needsFrom: { 'S-1': 'tracker', 'S-4': 'analyst' } as const };
    expect(needFrom(run(), s, 'S-1')).toBe('from Azure DevOps');
    expect(needFrom(run(), s, 'S-4')).toBe('added by the Analyst');
    expect(needFrom(run(), s, 'S-9')).toBe('');
    expect(needFrom({ source: { ...run().source, kind: 'pdf' } }, s, 'S-1')).toBe('');
  });

  it('reads as a run while the Analyst reads: the stories, not a document', () => {
    const steps = runReadSteps(run());
    expect(steps.map((s) => [s.title, s.state])).toEqual([
      ['Copied 6 stories from Azure DevOps', 'done'],
      ['Reading all 6 stories', 'now'],
      ['Questions for you', 'todo'],
      ['Filling the gaps', 'todo'],
    ]);
    expect(steps[1]!.sub).toBe('Reading AB#2014.');
    expect(JSON.stringify(steps)).not.toMatch(/BRD|document|page/i);
  });

  it('says a stop in a story\'s words', () => {
    expect(stopTag('gap', true)).toBe('Missing in the story');
    expect(stopTag('clash', true)).toBe('Two stories clash');
    expect(stopTag('gap')).toBe('Missing in the BRD');
    expect(stopTag('clash')).toBe('Two parts clash');
  });
});
