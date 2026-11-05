import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { boardPaths, listTickets, updateTicket, writeMeta, writeRelease, writeTicket } from '../src/board/store.js';
import { createTicket } from '../src/board/actions.js';
import type { Breakdown, BreakdownStory } from '../src/board/requirements-types.js';
import {
  ROUGH_STORY,
  breakdownJobs,
  breakdownRows,
  breakdownView,
  estimateBreakdown,
  findItem,
  listBreakdowns,
  nextBreakdownId,
  readBreakdown,
  readBreakdownState,
  storyProgress,
  updateBreakdown,
  updateBreakdownState,
  writeBreakdown,
} from '../src/board/requirements.js';
import {
  SKIP_CHOICE,
  addBreakdown,
  addItem,
  answerBreakdown,
  approveBreakdown,
  approveProblems,
  askAboutQuestion,
  breakdownStopped,
  changeDecided,
  deleteBreakdown,
  editItem,
  findLoop,
  moveItem,
  redoItem,
  removeItem,
  renameBreakdown,
  retryBreakdown,
  skipBreakdownQuestions,
  startStory,
  stopBreakdown,
} from '../src/board/requirements-actions.js';
import { breakdownDir, breakdownFile, breakdownStateFile } from '../src/board/requirements-paths.js';
import { setPaymentChoice } from '../src/core/settings.js';

/**
 * The breakdown from upload to approve: the files in both homes, keys that are never given twice, every edit, the
 * approve checks, the estimate, starting one story as a ticket, and where each story is.
 */

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

function meta(user = 'Momen') {
  writeMeta(bp, {
    project: 'Case portal',
    key: 'RO',
    nextNumber: 20,
    engine: 'live',
    runner: 'direct',
    user: { name: user, role: 'Business analyst' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    parallel: 2,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  meta();
  setPaymentChoice('subscription');
});

afterEach(() => {
  setPaymentChoice('auto');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const crit = (then: string) => ({ given: 'a lawyer', when: 'they act', then });

function story(key: string, title: string, extra: Partial<BreakdownStory> = {}): BreakdownStory {
  return { key, title, story: `As a lawyer, I want ${title.toLowerCase()}, so that it works.`, criteria: [crit('it works')], size: 'M', dependsOn: [], ref: { section: '3.1', title: 'Find a slot', page: 2 }, ...extra };
}

/** A pasted BRD, drafted by hand: E-1 with F-1 (S-1, S-2) and F-2 (S-3), E-2 with S-4 straight under it. */
function ready(status: Breakdown['status'] = 'ready'): Breakdown {
  const b = addBreakdown(bp, { text: '# Case Portal BRD\n\nBook hearings and pay fees.' });
  updateBreakdownState(bp, b.id, (s) => (s.job = { step: 'draft', status: 'done' }));
  return updateBreakdown(bp, b.id, (x) => {
    x.status = status;
    x.epics = [
      {
        key: 'E-1',
        title: 'Book a hearing',
        goal: 'Lawyers book online.',
        features: [
          { key: 'F-1', title: 'Find a slot', stories: [story('S-1', 'Search free slots'), story('S-2', 'See the calendar', { dependsOn: ['S-1'], size: 'S' })] },
          { key: 'F-2', title: 'Book and confirm', stories: [story('S-3', 'Hold a slot', { dependsOn: ['S-1'], size: 'L' })] },
        ],
        stories: [],
      },
      { key: 'E-2', title: 'Pay court fees', features: [], stories: [story('S-4', 'Pay by card', { dependsOn: ['S-3'] })] },
    ];
    x.next = { epic: 3, feature: 3, story: 5 };
    x.decided = [
      { id: 'd1', text: 'A held slot is freed without a warning.', by: 'analyst', at: new Date().toISOString(), item: 'S-3' },
      { id: 'd2', text: 'Receipts are in Arabic and English.', by: 'answer', at: new Date().toISOString() },
    ];
    x.leftOut = [{ text: 'A mobile app', why: 'A later phase.' }];
  });
}

function approved(): Breakdown {
  ready();
  return approveBreakdown(bp, 'BR-1');
}

describe('adding a BRD', () => {
  it('saves pasted text in both homes, its text in parts, and queues the read', () => {
    const b = addBreakdown(bp, { text: '# Case Portal BRD\n\nLawyers book hearings online.' });
    expect(b).toMatchObject({ id: 'BR-1', title: 'Case Portal BRD', status: 'reading', owner: 'Momen', source: { file: 'source/pasted.md', name: 'Pasted text', kind: 'pasted', pages: 1 } });
    expect(fs.existsSync(breakdownFile(bp, 'BR-1'))).toBe(true);
    expect(breakdownFile(bp, 'BR-1')).toBe(path.join(tmp, '.squad', 'requirements', 'BR-1', 'breakdown.yaml'));
    expect(fs.readFileSync(path.join(breakdownDir(bp, 'BR-1'), 'text', 'part-01.md'), 'utf8')).toContain('Lawyers book hearings online.');
    const s = readBreakdownState(bp, 'BR-1');
    expect(breakdownStateFile(bp, 'BR-1').startsWith(bp.localDir)).toBe(true);
    expect(s.job).toMatchObject({ step: 'read', status: 'pending', at: { done: 0, of: 1, unit: 'part' } });
    expect(s.job!.usualSeconds).toBeGreaterThan(0);
    expect(s.activity.map((a) => a.text)).toEqual(['Saved the text', 'Added Pasted text']);
    expect(breakdownJobs(bp, { user: { name: 'Momen', role: '' } }).map((j) => j.id)).toEqual(['BR-1']);
  });

  it('takes a file with the mockups that go with it, named after the file', () => {
    const md = { name: 'RoomFlow BRD v2.md', data: Buffer.from('# RoomFlow\n\nRooms.').toString('base64') };
    const mock = { name: 'booking.png', data: Buffer.from('png').toString('base64') };
    const b = addBreakdown(bp, { file: md, with: [mock] });
    expect(b.title).toBe('RoomFlow BRD v2');
    expect(b.source).toMatchObject({ file: 'source/RoomFlow BRD v2.md', kind: 'markdown', extra: ['source/booking.png'] });
    expect(addBreakdown(bp, { text: 'x', name: 'My BRD' }).id).toBe('BR-2');
  });

  it('saves nothing for a file it cannot read, and says why in plain words', () => {
    expect(() => addBreakdown(bp, {})).toThrow('Add the BRD as a file, or paste its text.');
    expect(() => addBreakdown(bp, { file: { name: 'old.doc', data: 'AA==' } })).toThrow('squad-kit reads PDF, Word (.docx), Markdown and text files');
    expect(() => addBreakdown(bp, { file: { name: 'broken.docx', data: Buffer.from('nope').toString('base64') } })).toThrow('cannot open this Word file');
    expect(() => addBreakdown(bp, { file: { name: 'empty.txt', data: '' } })).toThrow('This file has no text');
    expect(() => addBreakdown(bp, { file: { name: 'big.pdf', data: Buffer.alloc(11 * 1024 * 1024).toString('base64') } })).toThrow('larger than 10 MB');
    expect(() => addBreakdown(bp, { file: { name: 'brd.md', data: 'eA==' }, with: Array.from({ length: 10 }, (_, i) => ({ name: `${i}.png`, data: 'AA==' })) })).toThrow('at most 10 files');
    expect(listBreakdowns(bp)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, '.squad', 'requirements', 'BR-1'))).toBe(false);
  });
});

describe('the store', () => {
  it('keeps page numbers only for a PDF: in other documents a page is a guess', () => {
    const b = ready();
    const withPages = (x: Breakdown) => {
      x.questions = [{ id: 'q1', from: 'analyst', kind: 'gap', text: 'Who pays?', options: [], refs: [{ section: '4.2', page: 3 }] }];
      x.epics[0]!.ref = { section: 'BR-01', title: 'Book', page: 2 };
      x.epics[0]!.features[0]!.stories[0]!.ref = { section: 'BR-02', page: 2 };
      x.leftOut[0]!.ref = { section: '4.2', page: 1 };
    };
    const after = updateBreakdown(bp, b.id, withPages);
    expect(after.questions[0]!.refs).toEqual([{ section: '4.2' }]);
    expect(after.epics[0]!.ref).toEqual({ section: 'BR-01', title: 'Book' });
    expect(readBreakdown(bp, b.id)!.epics[0]!.features[0]!.stories[0]!.ref).toEqual({ section: 'BR-02' });
    expect(readBreakdown(bp, b.id)!.leftOut[0]!.ref).toEqual({ section: '4.2' });
    const pdf = updateBreakdown(bp, b.id, (x) => {
      x.source = { ...x.source, kind: 'pdf' };
      withPages(x);
    });
    expect(pdf.epics[0]!.ref).toEqual({ section: 'BR-01', title: 'Book', page: 2 });
  });

  it('reads back what it wrote, lists breakdowns in order, and gives the next free name', () => {
    const b = ready();
    expect(readBreakdown(bp, 'br-1')).toEqual(b);
    expect(yaml.load(fs.readFileSync(breakdownFile(bp, 'BR-1'), 'utf8'))).toMatchObject({ id: 'BR-1', epics: [{ key: 'E-1' }, { key: 'E-2' }] });
    addBreakdown(bp, { text: 'second' });
    expect(listBreakdowns(bp).map((x) => x.id)).toEqual(['BR-1', 'BR-2']);
    expect(nextBreakdownId(bp)).toBe('BR-3');
    expect(findItem(b, 's-3')).toMatchObject({ level: 'story', epic: { key: 'E-1' }, feature: { key: 'F-2' } });
    expect(findItem(b, 'S-4')).toMatchObject({ level: 'story', epic: { key: 'E-2' } });
    expect(findItem(b, 'S-4')!.feature).toBeUndefined();
    expect(breakdownRows(bp)[0]).toMatchObject({ id: 'BR-1', status: 'ready', counts: { epics: 2, features: 2, stories: 4 }, building: false, owner: 'Momen' });
  });

  it('takes its id from its folder, never from the file, and reads only files in its own source folder', () => {
    ready();
    // A copy of BR-1's folder as BR-2: the file still says BR-1.
    fs.cpSync(breakdownDir(bp, 'BR-1'), path.join(tmp, '.squad', 'requirements', 'BR-2'), { recursive: true });
    expect(readBreakdown(bp, 'BR-2')!.id).toBe('BR-2');
    expect(listBreakdowns(bp).map((b) => b.id)).toEqual(['BR-1', 'BR-2']);
    // Deleting BR-2 removes BR-2 only.
    deleteBreakdown(bp, 'BR-2');
    expect(fs.existsSync(path.join(tmp, '.squad', 'requirements', 'BR-2'))).toBe(false);
    expect(readBreakdown(bp, 'BR-1')).toBeTruthy();
    // A file that names a path as its id, or a document outside its folder, never builds a path.
    const file = path.join(tmp, '.squad', 'requirements', 'BR-3', 'breakdown.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = yaml.load(fs.readFileSync(breakdownFile(bp, 'BR-1'), 'utf8')) as Breakdown;
    fs.writeFileSync(file, yaml.dump({ ...raw, id: '../../../outside' }));
    expect(readBreakdown(bp, 'BR-3')!.id).toBe('BR-3');
    fs.writeFileSync(file, yaml.dump({ ...raw, source: { ...raw.source, file: 'source/../../../../.ssh/id_rsa' } }));
    expect(readBreakdown(bp, 'BR-3')).toBeNull();
    fs.writeFileSync(file, yaml.dump({ ...raw, source: { ...raw.source, file: '/etc/passwd' } }));
    expect(readBreakdown(bp, 'BR-3')).toBeNull();
    fs.writeFileSync(file, yaml.dump({ ...raw, source: { ...raw.source, extra: ['source/mock.png', '../x', 'source/../../y'] } }));
    expect(readBreakdown(bp, 'BR-3')!.source.extra).toEqual(['source/mock.png']);
    expect(() => breakdownDir(bp, '../outside')).toThrow('is not a breakdown id');
    expect(() => breakdownStateFile(bp, 'BR-1/../../x')).toThrow('is not a breakdown id');
    expect(readBreakdown(bp, '../BR-1')).toBeNull();
    expect(readBreakdownState(bp, '../../x')).toEqual({ activity: [] });
  });

  it('never gives a removed key again', () => {
    ready();
    const a = addItem(bp, 'BR-1', { under: 'F-1', title: 'Filter by court' });
    expect(a.key).toBe('S-5');
    removeItem(bp, 'BR-1', 'S-5');
    expect(addItem(bp, 'BR-1', { under: 'E-2', title: 'Refunds' }).key).toBe('S-6');
    expect(addItem(bp, 'BR-1', { under: 'E-2', title: 'Fees', level: 'feature' }).key).toBe('F-3');
    expect(addItem(bp, 'BR-1', { title: 'Reports', goal: 'Staff see use.' }).key).toBe('E-3');
    expect(readBreakdown(bp, 'BR-1')!.next).toEqual({ epic: 4, feature: 4, story: 7 });
  });
});

describe('editing the tree', () => {
  beforeEach(() => ready());

  it('changes a story, a feature and an epic, each with its own fields', () => {
    editItem(bp, 'BR-1', 's-2', { title: 'Judge calendar', size: 'l', criteria: [crit('the days show'), crit('free slots are marked')], needs: ['s-1'] });
    editItem(bp, 'BR-1', 'F-1', { summary: 'Free slots by court.' });
    editItem(bp, 'BR-1', 'E-1', { title: 'Hearings', goal: 'Book online.' });
    const b = readBreakdown(bp, 'BR-1')!;
    expect(findItem(b, 'S-2')!.story).toMatchObject({ title: 'Judge calendar', size: 'L', dependsOn: ['S-1'] });
    expect(findItem(b, 'S-2')!.story!.criteria).toHaveLength(2);
    expect(findItem(b, 'F-1')!.feature!.summary).toBe('Free slots by court.');
    expect(b.epics[0]).toMatchObject({ title: 'Hearings', goal: 'Book online.' });
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe('Edited E-1');
  });

  it('turns down a change that does not fit', () => {
    expect(() => editItem(bp, 'BR-1', 'S-1', { needs: ['S-4'] })).toThrow('That makes a loop: S-1 needs S-4, S-4 needs S-3, S-3 needs S-1. Take one need away.');
    expect(() => editItem(bp, 'BR-1', 'S-1', { needs: ['S-1'] })).toThrow('cannot need itself');
    expect(() => editItem(bp, 'BR-1', 'S-1', { needs: ['F-1'] })).toThrow('F-1 is not a story in BR-1.');
    expect(() => editItem(bp, 'BR-1', 'S-1', { size: 'XL' })).toThrow('A size is S, M or L.');
    expect(() => editItem(bp, 'BR-1', 'S-1', { criteria: [] })).toThrow('at least one "done when"');
    expect(() => editItem(bp, 'BR-1', 'S-1', { criteria: [{ given: 'x', when: '', then: 'y' }] })).toThrow('given, when and then');
    expect(() => editItem(bp, 'BR-1', 'E-1', { size: 'S' })).toThrow('E-1 is an epic: it has no size.');
    expect(() => editItem(bp, 'BR-1', 'S-9', { title: 'x' })).toThrow('BR-1 has no S-9.');
    expect(() => editItem(bp, 'BR-1', 'S-1', { title: ' ' })).toThrow('A title cannot be empty.');
  });

  it('moves a story to another feature or epic, a feature to another epic, and reorders with before', () => {
    moveItem(bp, 'BR-1', 'S-2', { under: 'F-2', before: 'S-3' });
    let b = readBreakdown(bp, 'BR-1')!;
    expect(b.epics[0]!.features[1]!.stories.map((s) => s.key)).toEqual(['S-2', 'S-3']);
    moveItem(bp, 'BR-1', 'S-4', { under: 'F-1' });
    moveItem(bp, 'BR-1', 'F-2', { under: 'E-2' });
    moveItem(bp, 'BR-1', 'E-2', { before: 'E-1' });
    moveItem(bp, 'BR-1', 'S-4', { before: 'S-1' });
    b = readBreakdown(bp, 'BR-1')!;
    expect(b.epics.map((e) => e.key)).toEqual(['E-2', 'E-1']);
    expect(b.epics[0]!.features.map((f) => f.key)).toEqual(['F-2']);
    expect(b.epics[1]!.features[0]!.stories.map((s) => s.key)).toEqual(['S-4', 'S-1']);
    expect(() => moveItem(bp, 'BR-1', 'E-1', { under: 'E-2' })).toThrow('An epic sits at the top');
    expect(() => moveItem(bp, 'BR-1', 'F-1', { under: 'F-2' })).toThrow('A feature goes under an epic.');
    expect(() => moveItem(bp, 'BR-1', 'S-1', { under: 'S-4' })).toThrow('A story goes under a feature or an epic.');
    expect(() => moveItem(bp, 'BR-1', 'S-1', { before: 'S-3' })).toThrow('S-3 is not beside S-1');
    expect(() => moveItem(bp, 'BR-1', 'S-1', {})).toThrow('Say where it goes');
  });

  it("removes a part with what is under it, and takes it out of the other stories' needs and Decided", () => {
    removeItem(bp, 'BR-1', 'F-2');
    const b = readBreakdown(bp, 'BR-1')!;
    expect(findItem(b, 'S-3')).toBeNull();
    expect(findItem(b, 'S-4')!.story!.dependsOn).toEqual([]);
    expect(b.decided.map((d) => d.id)).toEqual(['d2']);
  });

  it('renames it, and can redo a part with the Analyst', () => {
    expect(renameBreakdown(bp, 'BR-1', ' Case Portal ').title).toBe('Case Portal');
    redoItem(bp, 'BR-1', 'e-2', 'Split paying by card from refunds');
    expect(readBreakdownState(bp, 'BR-1').job).toMatchObject({ step: 'redo', status: 'pending', item: 'E-2', ask: 'Split paying by card from refunds' });
    expect(() => editItem(bp, 'BR-1', 'S-4', { title: 'x' })).toThrow('The Analyst is redoing E-2. Wait for it, or stop it.');
    expect(editItem(bp, 'BR-1', 'S-1', { title: 'Search slots' })).toBeTruthy();
    expect(() => redoItem(bp, 'BR-1', 'S-1', 'again')).toThrow('The Analyst is redoing E-2');
  });

  it('is only for the breakdown owner, and only once it is written', () => {
    meta('Sara');
    expect(() => editItem(bp, 'BR-1', 'S-1', { title: 'x' })).toThrow("BR-1 is Momen's. Only they can change it.");
    expect(breakdownView(bp, 'BR-1', 'subscription').mine).toBe(false);
    expect(breakdownJobs(bp, { user: { name: 'Sara', role: '' } })).toEqual([]);
    meta('Momen');
    updateBreakdown(bp, 'BR-1', (x) => (x.status = 'questions'));
    expect(() => editItem(bp, 'BR-1', 'S-1', { title: 'x' })).toThrow("Answer the Analyst's questions first");
  });
});

describe('approving', () => {
  it('checks every story has done-when, every need exists, and no loop', () => {
    ready();
    updateBreakdown(bp, 'BR-1', (x) => {
      findItem(x, 'S-1')!.story!.criteria = [];
      findItem(x, 'S-2')!.story!.dependsOn = ['S-30'];
      findItem(x, 'S-1')!.story!.dependsOn = ['S-4'];
    });
    const b = readBreakdown(bp, 'BR-1')!;
    expect(approveProblems(b)).toEqual(['S-1 has no "done when" yet.', 'S-2 needs S-30, which is not in BR-1.', 'That makes a loop: S-1 needs S-4, S-4 needs S-3, S-3 needs S-1. Take one need away.']);
    expect(findLoop(b)).toEqual(['S-1', 'S-4', 'S-3', 'S-1']);
    expect(() => approveBreakdown(bp, 'BR-1')).toThrow('S-1 has no "done when" yet. (and 2 more) Fix it, then approve.');
  });

  it('approves a ready breakdown once, with who and when', () => {
    ready('questions');
    expect(() => approveBreakdown(bp, 'BR-1')).toThrow("Answer the Analyst's questions first");
    updateBreakdown(bp, 'BR-1', (x) => (x.status = 'ready'));
    const b = approveBreakdown(bp, 'BR-1');
    expect(b.status).toBe('approved');
    expect(b.approved!.by).toBe('Momen');
    expect(() => approveBreakdown(bp, 'BR-1')).toThrow('BR-1 is approved already.');
    // Stories that have not started can still change; the breakdown stays approved.
    expect(editItem(bp, 'BR-1', 'S-2', { size: 'S' }).status).toBe('approved');
  });
});

describe('the questions', () => {
  beforeEach(() => {
    addBreakdown(bp, { text: '# BRD' });
    updateBreakdown(bp, 'BR-1', (x) => {
      x.status = 'questions';
      x.questions = [
        { id: 'q1', from: 'analyst', kind: 'clash', text: 'Refund in full, or keep the fee within 48 hours?', options: ['Refund in full (4.4)', 'Keep the fee (6.3)'] },
        { id: 'q2', from: 'analyst', kind: 'gap', text: 'Pay at the desk too?', options: ['Online only', 'Online or at the desk'] },
      ];
    });
    updateBreakdownState(bp, 'BR-1', (s) => (s.job = { step: 'read', status: 'done' }));
  });

  it('takes answers, Something else and Skip, then the draft waits for the Analyst', () => {
    expect(() => answerBreakdown(bp, 'BR-1', { q1: { choice: 'Refund in full (4.4)' } })).toThrow('Question "Pay at the desk too?" still needs an answer');
    expect(() => answerBreakdown(bp, 'BR-1', { q1: { choice: 'Maybe' }, q2: { choice: SKIP_CHOICE } })).toThrow('"Maybe" is not a choice');
    expect(() => answerBreakdown(bp, 'BR-1', { q1: { choice: 'Other' }, q2: { choice: SKIP_CHOICE } })).toThrow('Write your own answer');
    const b = answerBreakdown(bp, 'BR-1', { q1: { choice: 'Other', value: 'Refund half' }, q2: { choice: SKIP_CHOICE } });
    expect(b.status).toBe('drafting');
    expect(b.questions.map((q) => q.answer)).toEqual([{ choice: 'Other', value: 'Refund half' }, { choice: SKIP_CHOICE }]);
    const s = readBreakdownState(bp, 'BR-1');
    expect(s.job).toMatchObject({ step: 'draft', status: 'pending' });
    expect(s.activity[0]!.text).toBe('Answered 1 question and let the Analyst decide 1');
  });

  it('skips every open question at once', () => {
    const b = skipBreakdownQuestions(bp, 'BR-1');
    expect(b.questions.every((q) => q.answer?.choice === SKIP_CHOICE)).toBe(true);
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe('Let the Analyst decide 2');
  });

  it('asks about one question, one at a time', () => {
    askAboutQuestion(bp, 'BR-1', 'Q2', 'Who would take the money?');
    const b = readBreakdown(bp, 'BR-1')!;
    expect(b.questions[1]).toMatchObject({ thinking: true, thread: [{ who: 'you', text: 'Who would take the money?' }] });
    expect(readBreakdownState(bp, 'BR-1').job).toMatchObject({ step: 'reply', status: 'pending', question: 'q2' });
    expect(() => askAboutQuestion(bp, 'BR-1', 'q1', 'And this?')).toThrow('The Analyst is answering your question.');
    expect(() => answerBreakdown(bp, 'BR-1', {})).toThrow('The Analyst is answering your question.');
    expect(() => askAboutQuestion(bp, 'BR-1', 'q9', 'x')).toThrow('BR-1 has no question q9.');
  });
});

describe('stop and try again', () => {
  it('stops a waiting read at once, and Try again queues it again', () => {
    addBreakdown(bp, { text: '# BRD' });
    const b = stopBreakdown(bp, 'BR-1');
    expect(b).toMatchObject({ status: 'failed', error: 'You stopped the Analyst. Nothing is lost: Try again carries on from where it was.' });
    expect(readBreakdownState(bp, 'BR-1').job).toMatchObject({ step: 'read', status: 'failed' });
    expect(() => stopBreakdown(bp, 'BR-1')).toThrow('The Analyst is not working on BR-1 now.');
    const again = retryBreakdown(bp, 'BR-1');
    expect(again.status).toBe('reading');
    expect(again.error).toBeUndefined();
    expect(readBreakdownState(bp, 'BR-1').job).toMatchObject({ step: 'read', status: 'pending' });
  });

  it('marks a running job as stopping; the squad parks it once its run ends', () => {
    addBreakdown(bp, { text: '# BRD' });
    updateBreakdownState(bp, 'BR-1', (s) => (s.job!.status = 'running'));
    stopBreakdown(bp, 'BR-1');
    expect(readBreakdownState(bp, 'BR-1').job!.status).toBe('stopping');
    expect(readBreakdown(bp, 'BR-1')!.status).toBe('reading');
    breakdownStopped(bp, 'BR-1');
    expect(readBreakdown(bp, 'BR-1')!.status).toBe('failed');
  });
});

describe('the estimate', () => {
  function finished(id: string, costUsd: number, minutes: number) {
    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60_000);
    writeTicket(bp, {
      id,
      title: id,
      ask: '',
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'release',
      status: '',
      waiting: null,
      createdAt: from.toISOString(),
      createdBy: 'Momen',
      activity: [],
      mergedAt: to.toISOString(),
      usage: [{ role: 'builder', step: 'build', level: 'strongest', model: 'Opus', runs: 1, costUsd }],
      history: [{ who: 'builder', step: 'build', from: from.toISOString(), to: to.toISOString() }],
    });
  }

  it('is a rough guess from the sizes alone with no finished tickets', () => {
    const b = ready();
    const e = estimateBreakdown(bp, b, 'api-key');
    // S-1 M, S-2 S, S-3 L, S-4 M: 1 + 0.6 + 1.8 + 1 = 4.4 usual stories, 2 at a time.
    expect(e).toEqual({ stories: 4, costUsd: Math.round(ROUGH_STORY.costUsd * 4.4 * 100) / 100, minutes: Math.round((ROUGH_STORY.minutes * 4.4) / 2), parallel: 2, basedOn: 0, rough: true, payment: 'api-key' });
  });

  it("comes from this project's finished tickets, scaled by size; dollars only per use", () => {
    const b = ready();
    finished('RO-1', 4, 30);
    finished('RO-2', 8, 50);
    const e = estimateBreakdown(bp, b, 'api-key');
    expect(e).toMatchObject({ stories: 4, costUsd: 26.4, minutes: 88, parallel: 2, basedOn: 2, rough: false });
    const sub = estimateBreakdown(bp, b, 'subscription');
    expect(sub.costUsd).toBeUndefined();
    expect(sub.payment).toBe('subscription');
    expect(breakdownView(bp, 'BR-1', 'subscription').estimate).toEqual(sub);
  });
});

describe('starting one story', () => {
  it('only from an approved breakdown, and only once what it needs is merged', () => {
    ready();
    expect(() => startStory(bp, 'BR-1', 'S-1')).toThrow('Approve BR-1 first.');
    approveBreakdown(bp, 'BR-1');
    expect(() => startStory(bp, 'BR-1', 'S-2')).toThrow('S-2 starts after S-1 merges.');
    expect(() => startStory(bp, 'BR-1', 'F-1')).toThrow('Only a story starts. F-1 is a feature.');
  });

  it('becomes a ticket on the Builds by itself track, with its story, done-when, decisions and needs', () => {
    approved();
    const t1 = startStory(bp, 'BR-1', 's-1');
    expect(t1).toMatchObject({ id: 'RO-20', title: 'Search free slots', track: 'auto', breakdown: { id: 'BR-1', item: 'S-1' }, story: expect.stringContaining('As a lawyer'), criteria: [crit('it works')], specApproved: { by: 'Momen' }, source: { type: 'manual' } });
    expect(t1.ask).toContain('From BR-1 › Book a hearing › Find a slot › S-1.');
    expect(t1.ask).toContain('In the BRD: 3.1 Find a slot, in Pasted text.');
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-1')!.story!.ticket).toBe('RO-20');
    expect(() => startStory(bp, 'BR-1', 'S-1')).toThrow('S-1 started already, as RO-20.');
    expect(() => startStory(bp, 'BR-1', 'S-3')).toThrow('S-3 starts after S-1 merges.');

    updateTicket(bp, 'RO-20', (t) => (t.mergedAt = new Date().toISOString()));
    updateBreakdown(bp, 'BR-1', (x) => {
      findItem(x, 'S-3')!.story!.tracker = { module: 'azure', id: '139', ref: 'AB#139', url: 'https://dev.azure.com/x/_workitems/edit/139', type: 'User Story', sentHash: 'abc', sentAt: new Date().toISOString() };
    });
    const t3 = startStory(bp, 'BR-1', 'S-3');
    expect(t3).toMatchObject({ dependsOn: ['RO-20'], source: { type: 'azure', ref: 'AB#139', id: '139', url: 'https://dev.azure.com/x/_workitems/edit/139', itemType: 'User Story' } });
    expect(t3.decided).toEqual([expect.objectContaining({ id: 'd1', text: 'A held slot is freed without a warning.', item: 'S-3' })]);
    // The entry lives on the ticket now: it changes there.
    expect(readBreakdown(bp, 'BR-1')!.decided[0]!.ticket).toBe('RO-21');
    expect(() => changeDecided(bp, 'BR-1', 'd1', 'Warn a minute before')).toThrow('Change it on RO-21.');
    expect(() => editItem(bp, 'BR-1', 'S-3', { title: 'x' })).toThrow('S-3 started as RO-21. Change it on RO-21.');
    expect(() => removeItem(bp, 'BR-1', 'E-1')).toThrow('E-1 has stories that started (S-1 as RO-20, S-3 as RO-21), so it stays.');
    expect(() => deleteBreakdown(bp, 'BR-1')).toThrow('BR-1 has stories building (S-3 as RO-21).');
  });

  it('shows where each story is, from its ticket', () => {
    ready();
    expect(storyProgress(bp, readBreakdown(bp, 'BR-1')!, readBreakdownState(bp, 'BR-1')).map((p) => p.state)).toEqual(['not-started', 'not-started', 'not-started', 'not-started']);
    approveBreakdown(bp, 'BR-1');
    let b = readBreakdown(bp, 'BR-1')!;
    // Approved, Build continuously off or paused: a story whose needs are not merged says what it waits for.
    const waiting = [
      { key: 'S-1', state: 'not-started', line: 'Not started' },
      { key: 'S-2', state: 'waits', line: 'Waits for S-1 to merge', waitsOn: ['S-1'] },
      { key: 'S-3', state: 'waits', line: 'Waits for S-1 to merge', waitsOn: ['S-1'] },
      { key: 'S-4', state: 'waits', line: 'Waits for S-3 to merge', waitsOn: ['S-3'] },
    ];
    expect(storyProgress(bp, b, readBreakdownState(bp, 'BR-1'))).toEqual(waiting);
    updateBreakdownState(bp, 'BR-1', (s) => (s.build = { on: false, by: 'Momen', at: new Date().toISOString() }));
    expect(storyProgress(bp, b, readBreakdownState(bp, 'BR-1'))).toEqual(waiting);
    // Build continuously on: the next story, and the ones that wait.
    updateBreakdownState(bp, 'BR-1', (s) => (s.build = { on: true, by: 'Momen', at: new Date().toISOString() }));
    expect(storyProgress(bp, b, readBreakdownState(bp, 'BR-1'))).toEqual([
      { key: 'S-1', state: 'next', line: 'Next in line' },
      { key: 'S-2', state: 'waits', line: 'Waits for S-1 to merge', waitsOn: ['S-1'] },
      { key: 'S-3', state: 'waits', line: 'Waits for S-1 to merge', waitsOn: ['S-1'] },
      { key: 'S-4', state: 'waits', line: 'Waits for S-3 to merge', waitsOn: ['S-3'] },
    ]);
    const t = startStory(bp, 'BR-1', 'S-1');
    b = readBreakdown(bp, 'BR-1')!;
    const at = (state: () => void) => {
      state();
      return storyProgress(bp, b, readBreakdownState(bp, 'BR-1'))[0];
    };
    expect(at(() => updateTicket(bp, t.id, (x) => (x.status = 'Builder working, step 2 of 4')))).toEqual({ key: 'S-1', state: 'building', line: 'Builder working, step 2 of 4', ticket: t.id });
    expect(
      at(() =>
        updateTicket(bp, t.id, (x) => {
          x.waiting = { kind: 'ask', summary: 'The Architect asks you' };
          x.agentQuestion = { from: 'architect', text: 'Which refund rule?', options: ['A', 'B'], kind: 'clash', at: new Date().toISOString() };
        }),
      ),
    ).toEqual({ key: 'S-1', state: 'needs-you', line: 'Needs you: two parts clash', ticket: t.id, stop: 'clash' });
    expect(
      at(() =>
        updateTicket(bp, t.id, (x) => {
          delete x.agentQuestion;
          x.waiting = { kind: 'stuck', summary: 'The checks failed 3 times' };
          x.stuck = { question: 'The checks failed', options: [], gate: 'checks' };
        }),
      ),
    ).toMatchObject({ state: 'needs-you', line: 'Needs you: a check failed', stop: 'check' });
    expect(at(() => updateTicket(bp, t.id, (x) => (x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' })))).toMatchObject({ line: 'Needs you: the proof is ready for you to check', stop: 'other' });
    expect(
      at(() =>
        updateTicket(bp, t.id, (x) => {
          x.waiting = null;
          x.mergedAt = new Date().toISOString();
        }),
      ),
    ).toMatchObject({ state: 'merged', line: expect.stringMatching(/^Merged at \d\d:\d\d$/) });
    expect(storyProgress(bp, b, readBreakdownState(bp, 'BR-1'))[1]).toMatchObject({ state: 'next' });
    writeRelease(bp, { version: 'v1.2.0', status: 'released', from: 'main', date: new Date().toISOString(), tickets: [t.id], notes: '', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } });
    expect(at(() => undefined)).toMatchObject({ state: 'released', line: 'Released in v1.2.0' });
    const v = breakdownView(bp, 'BR-1', 'subscription');
    expect(v.counts).toEqual({ epics: 2, features: 2, stories: 4, merged: 1, building: 0, needsYou: 0 });
    expect(v.estimate.stories).toBe(3);
  });

  it('uses the ticket a start made before it was cut off, and never makes a second one', () => {
    approved();
    // A start that made the ticket, then stopped before saving it on the story.
    const made = createTicket(bp, { title: 'Search free slots', fromBreakdown: { id: 'BR-1', item: 'S-1', story: 'x', criteria: [crit('it works')], approvedBy: 'Momen' } });
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-1')!.story!.ticket).toBeUndefined();
    const t = startStory(bp, 'BR-1', 'S-1', { by: 'squad' });
    expect(t.id).toBe(made.id);
    expect(listTickets(bp).filter((x) => x.breakdown?.item === 'S-1')).toHaveLength(1);
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-1')!.story!.ticket).toBe(made.id);
    expect(readBreakdownState(bp, 'BR-1').activity[0]!.text).toBe(`S-1 has its ticket ${made.id} from a start that was cut off: it carries on there`);
    expect(() => startStory(bp, 'BR-1', 'S-1')).toThrow(`S-1 started already, as ${made.id}.`);
    // A deleted one is not used again: the story starts afresh.
    updateTicket(bp, made.id, (x) => (x.mergedAt = new Date().toISOString()));
    const other = createTicket(bp, { title: 'Hold a slot', fromBreakdown: { id: 'BR-1', item: 'S-3', story: 'x', criteria: [crit('it works')], approvedBy: 'Momen' } });
    updateTicket(bp, other.id, (x) => (x.deleting = { by: 'Momen', at: new Date().toISOString() } as never));
    expect(startStory(bp, 'BR-1', 'S-3').id).not.toBe(other.id);
  });

  it("lists the tickets' own Decided entries on the breakdown, each with its ticket", () => {
    approved();
    const t = startStory(bp, 'BR-1', 'S-1');
    updateTicket(bp, t.id, (x) => (x.decided = [{ id: 'd1', text: 'Search shows 20 slots a page.', by: 'builder', at: new Date().toISOString() }]));
    const v = breakdownView(bp, 'BR-1', 'subscription');
    expect(v.decided.map((d) => [d.text, d.item, d.ticket])).toEqual([
      ['A held slot is freed without a warning.', 'S-3', undefined],
      ['Receipts are in Arabic and English.', undefined, undefined],
      ['Search shows 20 slots a page.', 'S-1', t.id],
    ]);
  });
});

describe('Decided for you and delete', () => {
  it('records a change and has the Analyst redo the part it is about', () => {
    approved();
    changeDecided(bp, 'BR-1', 'D1', 'Warn the lawyer a minute before the hold ends');
    expect(readBreakdown(bp, 'BR-1')!.decided[0]!.changed).toMatchObject({ text: 'Warn the lawyer a minute before the hold ends', by: 'Momen' });
    expect(readBreakdownState(bp, 'BR-1').job).toMatchObject({ step: 'redo', status: 'pending', item: 'S-3', ask: 'Change this decision: "A held slot is freed without a warning.". Instead: "Warn the lawyer a minute before the hold ends".' });
    expect(() => changeDecided(bp, 'BR-1', 'd9', 'x')).toThrow('BR-1 has no d9.');
  });

  it('deletes the breakdown and its document', () => {
    ready();
    expect(deleteBreakdown(bp, 'BR-1')).toEqual({ ok: true, id: 'BR-1' });
    expect(fs.existsSync(breakdownDir(bp, 'BR-1'))).toBe(false);
    expect(fs.existsSync(breakdownStateFile(bp, 'BR-1'))).toBe(false);
    expect(readBreakdown(bp, 'BR-1')).toBeNull();
  });

  it('writes the project part with no live state in it', () => {
    ready();
    writeBreakdown(bp, readBreakdown(bp, 'BR-1')!);
    const text = fs.readFileSync(breakdownFile(bp, 'BR-1'), 'utf8');
    expect(text).not.toContain('activity');
    expect(text).not.toContain('job');
  });
});
