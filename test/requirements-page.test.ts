import { describe, expect, it } from 'vitest';
import type { BreakdownEstimate, BreakdownRow, BreakdownStory, BreakdownView, StoryProgress } from '../console-ui/src/api/requirements-types.js';
import {
  MAP,
  afterTitle,
  buildEstimate,
  builtWords,
  changedWords,
  chipKind,
  clockWords,
  decidedWho,
  estimateLine,
  findPart,
  atWords,
  firstScale,
  fitScale,
  foundWords,
  fromWords,
  halfCheck,
  keptChecks,
  leftOutAsk,
  leftWords,
  mapLayout,
  moveTargets,
  needExample,
  openAtFirst,
  parentKey,
  placeWords,
  pluralType,
  popPlace,
  readSteps,
  refShort,
  refWords,
  requirementsWaiting,
  sendCountWords,
  sendStep,
  sendStepWords,
  sizeWords,
  statusChip,
  timeWords,
  waitingOn,
} from '../console-ui/src/lib/requirements.js';

/** The Requirements page's words and shapes, worked out from a breakdown without a browser. */

const story = (key: string, dependsOn: string[] = [], extra: Partial<BreakdownStory> = {}): BreakdownStory => ({
  key,
  title: `Story ${key}`,
  story: '',
  criteria: [{ given: 'a', when: 'b', then: 'c' }],
  size: 'M',
  dependsOn,
  ...extra,
});

function view(over: Partial<BreakdownView> = {}): BreakdownView {
  return {
    id: 'BR-1',
    title: 'RoomFlow BRD v2',
    status: 'ready',
    source: { file: 'source/RoomFlow BRD v2.docx', name: 'RoomFlow BRD v2.docx', kind: 'docx', bytes: 100, addedBy: 'Sara', addedAt: '2026-11-04T09:00:00Z' },
    questions: [],
    epics: [
      {
        key: 'E-1',
        title: 'Online booking',
        features: [
          { key: 'F-1', title: 'Find a room', stories: [story('S-1'), story('S-2', ['S-1'])] },
          { key: 'F-2', title: 'Book and hold a slot', stories: [story('S-4', ['S-1']), story('S-5', ['S-4'])] },
        ],
        stories: [],
      },
      { key: 'E-2', title: 'Payments', features: [], stories: [story('S-9'), story('S-14', ['S-9'])] },
    ],
    decided: [],
    leftOut: [],
    createdAt: '2026-11-04T09:00:00Z',
    createdBy: 'Sara',
    owner: 'Sara',
    next: { epic: 3, feature: 3, story: 15 },
    state: { activity: [] },
    estimate: { stories: 6, minutes: 360, parallel: 2, basedOn: 9, rough: false, payment: 'api-key', costUsd: 140 },
    progress: ['S-1', 'S-2', 'S-4', 'S-5', 'S-9', 'S-14'].map((key): StoryProgress => ({ key, state: 'not-started', line: 'Not started' })),
    counts: { epics: 2, features: 2, stories: 6, merged: 0, building: 0, needsYou: 0 },
    mine: true,
    ...over,
  };
}

const estimate = (e: Partial<BreakdownEstimate>): BreakdownEstimate => ({ stories: 20, minutes: 360, parallel: 2, basedOn: 9, rough: false, payment: 'api-key', costUsd: 140, ...e });

describe('the status chip', () => {
  it('says where the breakdown is, in the plan words', () => {
    expect(statusChip(view({ status: 'reading' }))).toEqual({ text: 'Analyst reading', tone: 'ok' });
    expect(statusChip(view())).toEqual({ text: 'Ready for you to approve', tone: 'you' });
    expect(statusChip(view({ status: 'failed' })).tone).toBe('bug');
  });

  it('tells building continuously, paused and built apart once approved', () => {
    const approved = view({ status: 'approved' });
    expect(statusChip(approved).text).toBe('Approved');
    expect(statusChip({ ...approved, state: { activity: [], build: { on: true, by: 'Sara', at: '' } } }).text).toBe('Building continuously');
    expect(statusChip({ ...approved, state: { activity: [], build: { on: false, by: 'Sara', at: '' } } }).text).toBe('Paused');
    expect(statusChip({ ...approved, counts: { ...approved.counts, merged: 6 } }).text).toBe('Built');
  });
});

describe('the estimate', () => {
  it('reads like the canvas before building, with dollars only for an API key', () => {
    expect(estimateLine(estimate({}))).toBe('About $140 and 6 hours to build, 2 at a time (based on 9 finished tickets)');
    expect(estimateLine(estimate({ costUsd: undefined, payment: 'subscription' }))).toBe('About 6 hours to build, 2 at a time (based on 9 finished tickets)');
    expect(buildEstimate(estimate({}))).toBe('20 stories, about $140 and 6 hours, 2 at a time, based on 9 finished tickets');
    expect(buildEstimate(estimate({ rough: true, basedOn: 0 }))).toContain('a rough guess');
  });

  it('counts what is left while it builds', () => {
    expect(leftWords(estimate({ stories: 11, minutes: 180, costUsd: 60 }))).toBe('About 3 hours and $60 left');
    expect(leftWords(estimate({ stories: 0 }))).toBe('Every story is merged');
    expect(timeWords(45)).toBe('45 min');
    expect(timeWords(150)).toBe('2.5 hours');
    expect(timeWords(60 * 1.1)).toBe('66 min');
  });
});

describe("the Analyst's steps", () => {
  it('shows the read live: the page, what it found, and the bar', () => {
    const v = view({ status: 'reading', state: { activity: [], job: { step: 'read', status: 'running', startedAt: '2026-11-04T09:00:00Z', at: { done: 18, of: 31, unit: 'page' }, found: { epics: 3, features: 6, stories: 0 }, usualSeconds: 480 } } });
    const steps = readSteps(v);
    expect(steps.map((s) => s.state)).toEqual(['done', 'now', 'todo', 'todo']);
    expect(steps[1]!.sub).toBe('Page 18 of 31. Found 3 epics and 6 features so far.');
    expect(steps[1]!.bar).toEqual({ done: 18, of: 31 });
    // Before the first part is opened, it reads as the first part, not "Part 0".
    expect(atWords({ done: 0, of: 1, unit: 'part' })).toBe('Part 1 of 1');
    expect(fromWords('BR-03')).toBe('From BR-03');
    expect(fromWords('7')).toBe('From section 7');
    expect(clockWords(v.state.job, Date.parse('2026-11-04T09:04:00Z'))).toBe('4 min so far, usually about 8 min for 31 pages');
  });

  it('marks the questions as now, then the draft, and where it stopped', () => {
    expect(readSteps(view({ status: 'questions' })).map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo']);
    const drafting = readSteps(view({ status: 'drafting', state: { activity: [], job: { step: 'draft', status: 'running', now: 'Writing the stories of Payments (epic 2 of 3)' } } }));
    expect(drafting.map((s) => s.state)).toEqual(['done', 'done', 'done', 'now']);
    expect(drafting[3]!.sub).toBe('Writing the stories of Payments (epic 2 of 3).');
    expect(readSteps(view({ status: 'failed', state: { activity: [], job: { step: 'read', status: 'failed' } } })).map((s) => s.state)).toEqual(['done', 'failed', 'todo', 'todo']);
    expect(foundWords({ epics: 3, features: 7, stories: 8 })).toBe('Found 3 epics, 7 features and 8 stories so far.');
  });
});

describe('places in the tree and the document', () => {
  it('finds a part with its epic and feature, and where it can move', () => {
    const v = view();
    const s4 = findPart(v, 'S-4')!;
    expect(s4.level).toBe('story');
    expect(placeWords(s4)).toBe('Online booking › Book and hold a slot');
    expect(parentKey(s4)).toBe('F-2');
    expect(moveTargets(v, s4).map((t) => t.key)).toEqual(['F-1', 'F-2', 'E-1', 'E-2']);
    expect(moveTargets(v, findPart(v, 'F-1')!).map((t) => t.key)).toEqual(['E-1', 'E-2']);
    expect(parentKey(findPart(v, 'S-9')!)).toBe('E-2');
    expect(sizeWords(v.epics[0]!)).toBe('2 features, 4 stories');
    expect(sizeWords(v.epics[1]!)).toBe('2 stories');
    expect(refWords({ section: '3.4', title: 'Holding a slot', page: 7 })).toBe('3.4 Holding a slot, page 7');
    expect(refShort({ section: '4.2', title: 'Refunds', page: 18 })).toBe('4.2, page 18');
  });

  it('knows which stories wait for one, and opens the parts that need a look first', () => {
    const v = view({ status: 'approved' });
    expect(waitingOn(v, 'S-4')).toEqual(['S-5']);
    expect(waitingOn(v, 'S-1')).toEqual(['S-2', 'S-4']);
    expect([...openAtFirst(v)]).toEqual(['E-1', 'F-1', 'F-2']);
    const live = view({ progress: v.progress.map((p) => (p.key === 'S-14' ? { ...p, state: 'needs-you' } : p)) });
    expect([...openAtFirst(live)]).toEqual(['E-2']);
    expect([...openAtFirst(v, 'S-14')]).toContain('E-2');
  });
});

describe('the map', () => {
  it('puts each epic over its features and stacks the stories, with a column for stories straight under an epic', () => {
    const l = mapLayout(view());
    const box = (k: string) => l.boxes.find((b) => b.key === k)!;
    expect(box('E-1').w).toBe(2 * MAP.col + MAP.gap);
    expect(box('F-2').x).toBe(box('F-1').x + MAP.col + MAP.gap);
    expect(box('S-2').y - box('S-1').y).toBe(MAP.storyStep);
    // Payments has no features: its stories hang from the epic in one column.
    expect(box('S-9').x).toBe(box('E-2').x);
    expect(box('E-2').x).toBe(box('E-1').x + box('E-1').w + MAP.epicGap);
    expect(l.width).toBeGreaterThan(box('E-2').x + box('E-2').w);
    expect(l.lines.length).toBeGreaterThan(4);
  });

  it('puts the needs-you note under the columns it would cover, and grows the map to hold it', () => {
    const l = mapLayout(view());
    const s1 = l.boxes.find((b) => b.key === 'S-1')!;
    const place = popPlace(l, s1);
    // The note spans F-1 and F-2: it sits below the last story of both, not over S-2 or S-5.
    const below = Math.max(...l.boxes.filter((b) => b.level === 'story' && b.x < place.left + MAP.popW && b.x + b.w > place.left).map((b) => b.y + b.h));
    expect(place.top).toBeGreaterThan(below);
    expect(place.height).toBeGreaterThanOrEqual(place.top + MAP.popH);
    expect(place.left + MAP.popW).toBeLessThanOrEqual(l.width);
  });

  it('wraps a long breakdown into rows, and keeps the needs-you note to its own row', () => {
    const one = mapLayout(view());
    const box = (l: typeof one, k: string) => l.boxes.find((b) => b.key === k)!;
    expect(new Set(one.boxes.map((b) => b.row))).toEqual(new Set([0]));
    // Too narrow for both epics: Payments starts a second row under the first one's lowest story.
    const two = mapLayout(view(), box(one, 'E-2').x + 10);
    expect(box(two, 'E-2').row).toBe(1);
    expect(box(two, 'E-2').x).toBe(MAP.pad);
    const firstRowBottom = Math.max(...two.boxes.filter((b) => b.row === 0).map((b) => b.y + b.h));
    expect(box(two, 'E-2').y).toBe(firstRowBottom + MAP.epicGap);
    expect(box(two, 'S-9').y).toBeGreaterThan(box(two, 'E-2').y);
    expect(two.width).toBeLessThan(one.width);
    expect(two.height).toBeGreaterThan(one.height);
    // A note on the first row stays in that row: it is not pushed below the second row's stories.
    expect(popPlace(two, box(two, 'S-1')).top).toBe(firstRowBottom + 14);
    expect(popPlace(two, box(two, 'S-1')).top).toBeLessThan(box(two, 'E-2').y);
  });

  it('opens the map readable: its full width, but never smaller than 60%', () => {
    expect(firstScale({ width: 800 }, { width: 1000 })).toBe(1);
    expect(firstScale({ width: 1600 }, { width: 1200 })).toBe(0.75);
    expect(firstScale({ width: 4600 }, { width: 1200 })).toBe(0.6);
  });

  it('colours stories by where they are and fits the room', () => {
    expect(['merged', 'released', 'building', 'needs-you', 'waits', 'not-started'].map((s) => chipKind(s as StoryProgress['state']))).toEqual(['m', 'm', 'b', 'y', 'w', 'w']);
    expect(fitScale({ width: 2000, height: 500 }, { width: 1000, height: 800 })).toBe(0.5);
    expect(fitScale({ width: 500, height: 300 }, { width: 1000, height: 800 })).toBe(1);
  });
});

describe('send and decided words', () => {
  it('names the item types and what changes', () => {
    expect(pluralType('User Story')).toBe('User stories');
    expect(pluralType('Product Backlog Item')).toBe('Product backlog items');
    expect(pluralType('Epic')).toBe('Epics');
    expect(sendCountWords({ all: 3, new: 3, changed: 0, unchanged: 0 }, true)).toBe('new');
    expect(sendCountWords({ all: 7, new: 1, changed: 2, unchanged: 4 }, false)).toBe('1 new, 2 changed');
    expect(sendCountWords({ all: 7, new: 0, changed: 0, unchanged: 7 }, false)).toBe('no changes');
    expect(needExample(view())).toBe('S-2 needs S-1');
  });

  it('says who decided', () => {
    expect(decidedWho({ id: 'd1', text: 'x', by: 'analyst', at: '', item: 'S-4' })).toBe('S-4 · Analyst');
    expect(decidedWho({ id: 'd2', text: 'x', by: 'answer', at: '', item: 'S-10' })).toBe('S-10 · from your answer');
    expect(decidedWho({ id: 'd1', text: 'x', by: 'architect', at: '', item: 'S-14', ticket: 'RO-31' })).toBe('S-14 · RO-31 · Architect');
  });
});

describe('the sidebar count', () => {
  it('counts my questions and the stories that need me', () => {
    const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
      id: 'BR-1',
      title: 'x',
      status: 'ready',
      source: { name: 'x.docx', kind: 'docx' },
      counts: { epics: 1, features: 1, stories: 2, merged: 0, building: 0, needsYou: 0 },
      building: false,
      createdAt: '',
      owner: 'Sara',
      ...over,
    });
    const rows = [row({ status: 'questions' }), row({ status: 'approved', counts: { epics: 1, features: 1, stories: 2, merged: 0, building: 1, needsYou: 2 } }), row({ status: 'questions', owner: 'Omar' })];
    expect(requirementsWaiting(rows, 'sara')).toBe(3);
    expect(requirementsWaiting([row({})], 'Sara')).toBe(0);
  });
});

describe('a send in the dialog\'s own units', () => {
  const plan = { items: 30, links: 20 };
  it('counts the items, then says it adds the links, from the squad\'s single count', () => {
    // The squad counts 30 items and then 17 stories' links: 47 in all.
    expect(sendStepWords(sendStep({ done: 14, of: 47 }, plan))).toBe('14 of 30 items');
    expect(sendStep({ done: 14, of: 47 }, plan).pct).toBe(30);
    expect(sendStepWords(sendStep({ done: 35, of: 47 }, plan))).toBe('adding the 20 links');
    expect(sendStepWords(sendStep({ done: 30, of: 30 }, { items: 30, links: 0 }))).toBe('30 of 30 items');
  });

  it('takes separate counts for the links when the squad gives them', () => {
    expect(sendStepWords(sendStep({ done: 12, of: 30, links: { done: 0, of: 20 } }))).toBe('12 of 30 items');
    expect(sendStepWords(sendStep({ done: 30, of: 30, links: { done: 5, of: 20 } }))).toBe('adding the links, 5 of 20');
    expect(sendStep({ done: 30, of: 30, links: { done: 5, of: 20 } }).pct).toBe(70);
    // A count of the items and the links together still splits by what the dialog said.
    expect(sendStepWords(sendStep({ done: 34, of: 50, links: { done: 4, of: 20 } }, plan))).toBe('adding the links, 4 of 20');
  });

  it('shows only the bar when it cannot tell the units apart', () => {
    expect(sendStep({ done: 14, of: 47 }).phase).toBe('unknown');
    expect(sendStepWords(sendStep({ done: 14, of: 47 }))).toBe('');
    // What the dialog said belongs to another send.
    expect(sendStep({ done: 14, of: 47, at: '2026-11-04T10:00:00Z' }, { ...plan, at: '2026-11-03T10:00:00Z' }).phase).toBe('unknown');
    expect(sendStep({ done: 14, of: 47, at: '2026-11-04T10:00:00Z' }, { ...plan, at: '2026-11-04T10:00:00Z' }).phase).toBe('items');
  });
});

describe('words after the work', () => {
  it('says where the stories are once all are merged, and nothing before', () => {
    const merged = (state: StoryProgress['state']) => view({ counts: { epics: 2, features: 2, stories: 6, merged: 6, building: 0, needsYou: 0 }, progress: view().progress.map((p) => ({ ...p, state })) });
    expect(builtWords(merged('merged'))).toEqual({ text: 'All 6 stories are merged and wait in the next release.', release: true });
    expect(builtWords(merged('released'))).toEqual({ text: 'All 6 stories are merged and went out in a release.', release: false });
    expect(builtWords(view())).toBeNull();
  });

  it('says what a changed decision became', () => {
    expect(changedWords('SK-157', 'c2')).toBe('It became a small change on SK-157. The Analyst writes it into the spec.');
    expect(changedWords('SK-157', 'SK-173')).toBe('SK-157 is merged, so it became a new ticket, SK-173, linked to it.');
  });

  it('does not say the title twice', () => {
    expect(afterTitle('You stopped the Analyst. Nothing is lost: Try again carries on from where it was.', 'You stopped the Analyst')).toBe('Nothing is lost: Try again carries on from where it was.');
    expect(afterTitle('The read timed out.', 'The Analyst stopped')).toBe('The read timed out.');
  });

  it('asks the Analyst to add a part that was left out', () => {
    expect(leftOutAsk({ text: 'A mobile app for parties', why: 'Later phase.', ref: { section: '8', title: 'Later phases', page: 5 } })).toBe('Add the part that was left out: A mobile app for parties (8 Later phases, page 5).');
  });
});

describe('done when, on Save', () => {
  it('drops empty checks and keeps half-written ones for the person to finish', () => {
    const list = [
      { given: 'a', when: 'b', then: 'c' },
      { given: '', when: ' ', then: '' },
      { given: 'a', when: '', then: '' },
    ];
    expect(keptChecks(list)).toEqual([list[0], list[2]]);
    expect(list.map(halfCheck)).toEqual([false, false, true]);
  });
});
