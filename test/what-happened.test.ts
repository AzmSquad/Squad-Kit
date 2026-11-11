import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConversation } from '../src/engine/conversations.js';
import { whatHappened } from '../src/board/happened.js';
import { endStep, nextPart, startStep } from '../src/board/clock.js';
import { boardPaths, readTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import type { Activity, Ticket } from '../src/board/types.js';

/**
 * "What happened" on the Conversation tab: one card per step, built from what the engine keeps already (the steps'
 * history, the activity, the ticket now and the saved conversations), with the step's time, a line on what it did and
 * what it handed in.
 */

let tmp: string;
let base: string;
let work: string;
let bp: BoardPaths;
const BUILD = 'b5a9a6ab-2632-4011-89ff-8ec837feb166';
const INTAKE = 'a1a1a1a1-2632-4011-89ff-8ec837feb166';

const at = (min: number) => new Date(Date.parse('2026-11-03T10:00:00Z') + min * 60_000).toISOString();
const line = (min: number, who: Activity['who'], text: string): Activity => ({ at: at(min), who, text });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-happened-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  base = path.join(tmp, 'claude-projects');
  work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(base, '-work'), { recursive: true });
  fs.mkdirSync(work);
  // The Builder's real saved session: it read, wrote a new file, edited one, and tried a command it may not run.
  const build = [
    { type: 'user', cwd: work, timestamp: at(20), message: { content: 'You are the Builder.' } },
    { type: 'assistant', timestamp: at(20.5), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${work}/app.py` } }] } },
    { type: 'user', timestamp: at(20.6), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'print(1)' }] } },
    { type: 'assistant', timestamp: at(21), message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: `${work}/login.html`, content: '<form></form>' } }] } },
    { type: 'user', timestamp: at(21.1), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'File created' }] } },
    { type: 'assistant', timestamp: at(22), message: { content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: `${work}/app.py`, old_string: 'print(1)', new_string: 'print(2)' } }] } },
    { type: 'user', timestamp: at(22.1), message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Updated' }] } },
    { type: 'assistant', timestamp: at(23), message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git push' } }] } },
    { type: 'user', timestamp: at(23.1), message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: 'User refused permission to run tool', is_error: true }] } },
    // A fix later in the same session, after the review.
    { type: 'assistant', timestamp: at(41), message: { content: [{ type: 'tool_use', id: 't5', name: 'Edit', input: { file_path: `${work}/login.js`, old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', timestamp: at(41.1), message: { content: [{ type: 'tool_result', tool_use_id: 't5', content: 'Updated' }] } },
  ];
  fs.writeFileSync(path.join(base, '-work', `${BUILD}.jsonl`), build.map((l) => JSON.stringify(l)).join('\n'));
  const intake = [
    { type: 'user', cwd: work, timestamp: at(1), message: { content: 'You are the Analyst.' } },
    { type: 'assistant', timestamp: at(1.2), message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${work}/app.py` } }] } },
    { type: 'user', timestamp: at(1.3), message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'print(1)' }] } },
  ];
  fs.writeFileSync(path.join(base, '-work', `${INTAKE}.jsonl`), intake.map((l) => JSON.stringify(l)).join('\n'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket that went the whole way on the Full track, as the live squad leaves it. */
function journey(): Ticket {
  return {
    id: 'RO-3',
    title: 'Login screen',
    ask: 'A login screen',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: 'Proof ready to check',
    waiting: { kind: 'proof', summary: 'The proof is ready' },
    createdAt: at(0),
    createdBy: 'Momen',
    sessions: { intake: INTAKE, build: BUILD },
    questions: [
      { id: 'q1', from: 'analyst', text: 'What does a person enter?', options: ['Email', 'Name'], answer: { choice: 'Email' } },
      { id: 'q2', from: 'architect', text: 'Where does the login live?', options: ['Its own page', 'A dialog'], answer: { choice: 'Its own page' } },
    ],
    story: 'As a guest, I want to log in, so I see my bookings.',
    criteria: [
      { given: 'I am logged out', when: 'I open the app', then: 'I see the login page' },
      { given: 'I log in', when: 'my email is right', then: 'I see my bookings' },
    ],
    decision: { title: 'Where the login lives', options: [{ name: 'Its own page', note: '', chosen: true }, { name: 'A dialog', note: '' }], why: 'Simple.' },
    follows: ['RO-1.1'],
    steps: [
      { title: 'Login page', status: 'done' },
      { title: 'Tests', status: 'done' },
    ],
    gates: { checks: 'pass', checksText: '12 of 12 checks pass', review: 'pass', proof: 'pass' },
    proof: [{ criterion: 'I see the login page', before: 'ro3-before.png', after: 'ro3-after.png', beforeLabel: 'Before', afterLabel: 'After' }],
    history: [
      { who: 'analyst', step: 'questions', from: at(1), to: at(1.5) },
      { who: 'analyst', step: 'spec', from: at(5), to: at(5.15) },
      { who: 'architect', step: 'design', from: at(10), to: at(10.7) },
      { who: 'builder', step: 'build', from: at(20), to: at(30) },
      { who: 'squad', step: 'checks', from: at(30.1), to: at(31) },
      { who: 'reviewer', step: 'review', from: at(31.2), to: at(32) },
      { who: 'builder', step: 'fix', from: at(40), to: at(42) },
      { who: 'reviewer', step: 'review', from: at(42.2), to: at(43) },
      { who: 'tester', step: 'proof', from: at(43.5), to: at(45) },
    ],
    // Newest first, as the engine keeps it.
    activity: [
      line(45, 'tester', 'Saved 1 screenshots'),
      line(43, 'reviewer', 'Approved: meets both "done when" points'),
      line(42, 'builder', 'Fixed the review comments'),
      line(32, 'reviewer', 'Asked for 1 fix: the error message is missing'),
      line(31, 'tester', 'All checks pass: test, lint'),
      line(30, 'builder', 'Finished all steps'),
      line(12, 'you', 'Approved the design'),
      line(10.7, 'architect', 'Wrote the design'),
      line(10.6, 'architect', 'Made a mockup of how the screen will look'),
      line(6, 'you', 'Approved the spec'),
      line(5.15, 'analyst', 'Wrote the spec'),
      line(3, 'you', 'Answered 2 questions'),
      line(1.5, 'analyst', 'Asked 2 questions'),
      line(1.49, 'analyst', 'Read the login page, the booking page and saved decision RO-1.1'),
      line(1.2, 'analyst', 'Reading app.py'),
    ],
  };
}

const sources = { conversation: (id: string) => readConversation(id, 3000, base, path.join(tmp, 'none')) };

describe('What happened', () => {
  it('draws one card per step from the history, with its time, what it did and what it handed in', () => {
    const h = whatHappened(bp, journey(), sources);
    expect(h.steps.map((s) => s.name)).toEqual([
      'Analyst · Questions',
      'Analyst · Spec',
      'Architect · Design',
      'Builder · Build',
      'squad-kit · Checks',
      'Reviewer · Review',
      'Builder · Fixes',
      'Reviewer · Review',
      'Tester · Proof',
    ]);
    const [questions, spec, design, build, checks, review1, fix, review2, proof] = h.steps;
    expect(questions).toMatchObject({ seconds: 30, notes: ['you answered'], session: 'intake' });
    expect(questions!.summary).toBe('Read the login page, the booking page and saved decision RO-1.1. Then asked you 2 questions.');
    expect(questions!.handedIn).toEqual({
      kind: 'questions',
      items: [
        { from: 'analyst', text: 'What does a person enter?', answer: 'Email' },
        { from: 'architect', text: 'Where does the login live?', answer: 'Its own page' },
      ],
    });
    // It read one file in its conversation while it worked.
    expect(questions).toMatchObject({ actions: 1, skipped: 0 });
    expect(spec).toMatchObject({ seconds: 9, notes: ['you approved'], tab: 'plan', summary: 'Wrote the spec from your 2 answers, with 2 "done when" points.' });
    expect(spec!.handedIn).toEqual({ kind: 'spec', story: 'As a guest, I want to log in, so I see my bookings.', criteria: ['I see the login page', 'I see my bookings'] });
    expect(design).toMatchObject({ notes: ['you approved'], tab: 'plan', summary: 'Chose its own page and planned 2 steps to build.' });
    expect(design!.handedIn).toMatchObject({ kind: 'design', title: 'Where the login lives', chosen: 'Its own page', steps: ['Login page', 'Tests'], follows: ['RO-1.1'] });
    // The changed files come from the Builder's saved conversation when the ticket's copy is gone.
    expect(build).toMatchObject({ seconds: 600, tab: 'changes', summary: 'Did the 2 steps of the design and changed 2 files.', actions: 4, skipped: 1 });
    expect(build!.handedIn).toEqual({ kind: 'files', added: ['login.html'], changed: ['app.py'], removed: [], steps: ['Login page', 'Tests'] });
    expect(checks).toMatchObject({ summary: "squad-kit ran the project's checks: all checks pass: test, lint.", handedIn: { kind: 'checks', ok: true, text: '12 of 12 checks pass' } });
    expect(checks!.session).toBeUndefined();
    // Only the latest run of a step shows what it handed in: the first review was replaced by the second.
    expect(review1).toMatchObject({ summary: 'Asked for 1 fix.', notes: ['round 1 of 2, a fresh session'] });
    expect(review1!.handedIn).toBeUndefined();
    expect(review2).toMatchObject({ summary: 'Approved: meets both "done when" points.', notes: ['round 2 of 2, the same Reviewer as the round before'], handedIn: { kind: 'verdict', approved: true, notes: [] } });
    expect(fix).toMatchObject({ summary: 'Fixed the review comments.', handedIn: { kind: 'files', added: [], changed: ['login.js'] } });
    expect(proof).toMatchObject({ notes: [], tab: 'proof', handedIn: { kind: 'shots', shots: [{ criterion: 'I see the login page', file: 'ro3-after.png' }] } });
    expect(h.seconds).toBe(30 + 9 + 42 + 600 + 54 + 48 + 120 + 48 + 90);
  });

  it('calls a review fresh only when it started a new Reviewer', () => {
    // A rebuild started the review over: its round 1 is a new Reviewer, whatever came before.
    const t = journey();
    t.activity = [line(42.15, 'reviewer', 'Reading the changes (round 1 of 2)'), ...t.activity];
    const reviews = whatHappened(bp, t, sources).steps.filter((s) => s.name === 'Reviewer · Review');
    expect(reviews.map((s) => s.notes.at(-1))).toEqual(['round 1 of 2, a fresh session', 'round 2 of 2, a fresh session']);
  });

  it('lists the files from git when the ticket has its copy, and the step running now last', () => {
    const t = { ...journey(), waiting: null, history: journey().history!.slice(0, 4), clock: { who: 'squad' as const, step: 'checks' as const, since: at(30.1), began: at(30.1), doing: 'Running npm test' } };
    const h = whatHappened(bp, t, { ...sources, files: () => ({ added: ['login.html', 'login.js'], changed: ['app.py', 'test_api.py'], removed: [] }), now: Date.parse(at(31)) });
    expect(h.steps.at(-2)!.handedIn).toEqual({ kind: 'files', added: ['login.html', 'login.js'], changed: ['app.py', 'test_api.py'], removed: [], steps: ['Login page', 'Tests'] });
    expect(h.steps.at(-2)!.summary).toBe('Did the 2 steps of the design and changed 4 files.');
    expect(h.steps.at(-1)).toMatchObject({ name: 'squad-kit · Checks', running: true, seconds: 54, summary: 'Running npm test.' });
  });

  it('a ticket from before the history was kept gets its steps from the activity, without their time', () => {
    const t = { ...journey(), history: undefined };
    const h = whatHappened(bp, t, sources);
    expect(h.steps.map((s) => s.step)).toEqual(['questions', 'spec', 'design', 'build', 'checks', 'review', 'fix', 'review', 'proof']);
    expect(h.steps.every((s) => s.seconds === undefined)).toBe(true);
    expect(h.steps[0]!.to).toBe(at(1.5));
    expect(h.seconds).toBe(0);
  });

  it('on the sample board, the ticket waiting for its proof shows every step it took', () => {
    seedDemoBoard(bp, { speed: 50 });
    const t = readTicket(bp, 'SK-139')!;
    const h = whatHappened(bp, t);
    expect(h.steps.map((s) => s.name)).toEqual(['Analyst · Questions', 'Analyst · Spec', 'Architect · Design', 'Builder · Build', 'squad-kit · Checks', 'Tester · Proof', 'Reviewer · Review']);
    expect(h.steps[0]!.summary).toBe('Read the case list page, the case search in the API and saved decision ADR-011. Then asked you 2 questions.');
    expect(h.steps[3]!.handedIn).toMatchObject({ kind: 'files', steps: ['Search box above the case list', 'Search by number in the API', 'Show matches while typing', 'Tests for every "done when"'] });
    expect(h.steps.every((s) => s.seconds! > 0)).toBe(true);
  });
});

describe('the step history', () => {
  it('keeps each step that ended well, from its start, even when the Builder moved through plan steps', () => {
    const t = { ...journey(), history: undefined, waiting: null, steps: [{ title: 'A', status: 'doing' as const }, { title: 'B', status: 'todo' as const }] };
    const t0 = Date.parse(at(0));
    startStep(t, { who: 'builder', step: 'build' }, t0);
    nextPart(bp, t, 2, t0 + 60_000);
    expect(t.clock!.since).toBe(new Date(t0 + 60_000).toISOString());
    endStep(bp, t, t0 + 90_000);
    // With the stage it ran in, for the tracker's work times.
    expect(t.history).toEqual([{ who: 'builder', step: 'build', from: at(0), to: new Date(t0 + 90_000).toISOString(), stage: t.stage }]);
    expect(t.clock).toBeUndefined();
  });
});
