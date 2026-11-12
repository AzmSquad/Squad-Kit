import { describe, expect, it } from 'vitest';
import {
  appPath,
  bodyAfter,
  canAlwaysAllow,
  chipWords,
  contextWords,
  dollars,
  duration,
  exampleQuestions,
  fileLabel,
  levelName,
  openLabel,
  pageContext,
  placeOf,
  problemOf,
  problemQuestion,
  sourcePlace,
  traceSummary,
  turnMeta,
} from '../console-ui/src/lib/lead.js';
import type { LeadCard, LeadStep } from '../console-ui/src/api/types.js';
import { isPlain } from '../src/engine/shots.js';

/** The Squad lead on the board, as the board works it out from the API: its words, its links and where it was asked. */

const step = (text: string, kind: LeadStep['kind']): LeadStep => ({ at: '2026-11-11T10:00:00.000Z', text, kind });

const action = (more: Partial<Extract<LeadCard, { kind: 'board_action' }>>): LeadCard => ({
  id: 'c1.1.1',
  kind: 'board_action',
  level: 2,
  action: 'more_time',
  label: 'Give it 10 more minutes',
  command: 'squad lead run c1.1.1',
  status: 'open',
  allowAlways: true,
  ...more,
});

describe("an answer's work, in one line", () => {
  it('counts what it read, searched and looked at, in plain words', () => {
    const trace = [
      step('Read RO-12 "Owner cancels a booking"', 'story'),
      step('Read RO-5 "Sign in"', 'story'),
      step('Read decision RO-12.1', 'story'),
      step('Searched the code for "login"', 'code'),
      step('Read roomflow/store.py', 'code'),
      step('Read roomflow/static/login.html', 'code'),
      step('Read roomflow/store.py', 'code'),
      step('Ran a read command: cat roomflow/static/login.js', 'code'),
      step('Searched the code for "sign.?in"', 'code'),
      step('Started its own copy of the app, with its own database', 'app'),
      step('Looked at /app in its own copy', 'app'),
      step("Saved what it learned in squad-kit's notes", 'notes'),
    ];
    expect(traceSummary(trace)).toBe('Read 2 stories, 1 decision and 3 files, searched the code twice, then looked at the app in its own copy');
  });

  it('says the pictures it took, its notes, and a refusal', () => {
    expect(traceSummary([step('Took 2 pictures of /app, /rooms in its own copy', 'app')])).toBe('Took 2 pictures in its own copy of the app');
    expect(traceSummary([step("Found it in squad-kit's notes, saved on 2026-11-11", 'notes')])).toBe("Found it in squad-kit's notes");
    expect(traceSummary([step('squad-kit refused: commit, merge, push or release', 'refused')])).toBe('squad-kit refused the ask itself');
    expect(traceSummary([step('Searched the code for "x"', 'code')])).toBe('Searched the code once');
    expect(traceSummary([])).toBe('');
  });
});

describe('the answer', () => {
  it('says its headline once, even when the body starts with it', () => {
    expect(bodyAfter('Sign-in is a placeholder.', 'Sign-in is a placeholder. Pick a name from the list.')).toBe('Pick a name from the list.');
    expect(bodyAfter('Sign-in is a placeholder.', 'Sign-in is a placeholder.')).toBe('');
    expect(bodyAfter('No.', 'Only the owner can.')).toBe('Only the owner can.');
  });
});

describe('time and cost, small', () => {
  it('shows the seconds and the cost like the rest of the board', () => {
    expect(duration(16)).toBe('16 s');
    expect(duration(125)).toBe('2 min 5 s');
    expect(duration(120)).toBe('2 min');
    expect(dollars(0.29)).toBe('$0.29');
    expect(dollars(0.001)).toBe('under $0.01');
    expect(turnMeta({ seconds: 16, costUsd: 0.29 })).toBe('16 s · $0.29');
    expect(turnMeta({ seconds: 16 })).toBe('16 s · cost not reported');
  });

  it('says when squad-kit answered at once, with no AI and no cost', () => {
    const answer = { headline: 'x', body: '', evidence: [], sources: [], cards: [] };
    expect(turnMeta({ answer: { ...answer, by: 'note' }, seconds: 0, costUsd: 0 })).toBe("From squad-kit's notes, at once. No cost.");
    expect(turnMeta({ answer: { ...answer, by: 'refusal' }, seconds: 0, costUsd: 0 })).toBe('squad-kit answered this itself. No cost.');
    expect(turnMeta({ answer: { ...answer, by: 'record' } })).toBe("From the story's live record, at once. No cost.");
  });
});

describe('where a question is asked from', () => {
  it('sends the open story, else the page, from any board page', () => {
    expect(pageContext('/board', { ticket: 'RO-9' })).toEqual({ from: 'story', story: 'RO-9' });
    expect(pageContext('/tickets/RO-7/proof')).toEqual({ from: 'story', story: 'RO-7' });
    expect(pageContext('/requirements/BR-1', { ticket: 'RO-3', item: 'S-14' })).toEqual({ from: 'story', story: 'RO-3' });
    expect(pageContext('/releases')).toEqual({ from: 'board', page: 'Releases' });
    expect(pageContext('/inbox')).toEqual({ from: 'board', page: 'Waiting for you' });
    expect(pageContext('/board', { ticket: 'not a story' })).toEqual({ from: 'board', page: 'Board' });
    expect(pageContext('/somewhere')).toEqual({ from: 'board' });
  });

  it('says it in plain words, before and after asking', () => {
    expect(chipWords({ from: 'app', app: 'RoomFlow web', path: '/app' })).toBe('From RoomFlow web, on /app');
    expect(contextWords({ from: 'app', app: 'RoomFlow web', path: '/app' })).toBe('Asked from RoomFlow web, on /app');
    expect(contextWords({ from: 'problem', problem: 'stuck', story: 'RO-9' })).toBe('Asked about RO-9: it looks stuck');
    expect(contextWords({ from: 'story', story: 'RO-9' })).toBe('Asked about RO-9');
    expect(contextWords({ from: 'board', page: 'Releases' })).toBe('Asked from the board, on Releases');
    expect(chipWords({ from: 'app', app: 'RoomFlow web', path: '/' })).toBe('From RoomFlow web, on its first page');
    expect(appPath('http://localhost:5000/app')).toBe('/app');
    expect(appPath('http://localhost:5000')).toBe('/');
    expect(appPath(undefined)).toBe('/');
  });

  it('fills in the problem on "Ask the lead", so nobody has to describe it', () => {
    expect(problemQuestion('error', 'RO-9')).toBe('Why did RO-9 stop, and what should I do?');
    expect(problemQuestion('slow', 'RO-9')).toBe('Why is RO-9 taking longer than usual?');
    expect(problemQuestion('stuck', 'RO-9')).toBe('Why does RO-9 look stuck, and what should I do?');
    expect(problemQuestion('waiting', 'RO-9')).toBe('What does RO-9 need from me, and what do you recommend?');
    expect(problemOf({ kind: 'slow' })).toBe('slow');
    expect(problemOf({ kind: 'looks-stuck' })).toBe('stuck');
    expect(problemOf({ kind: 'stuck' })).toBe('error');
    expect(problemOf({ kind: 'proof' })).toBe('waiting');
  });
});

describe('links and buttons', () => {
  it('opens a source where the board has a place for it', () => {
    expect(sourcePlace({ kind: 'story', ref: 'RO-12' })).toEqual({ to: '/board', ticket: 'RO-12' });
    expect(sourcePlace({ kind: 'decision', ref: 'RO-12.1' })).toEqual({ to: '/architecture', adr: 'RO-12.1' });
    expect(sourcePlace({ kind: 'release', ref: '0.2.0' })).toEqual({ to: '/releases' });
    expect(sourcePlace({ kind: 'file', ref: 'roomflow/store.py:79' })).toBeNull();
    expect(sourcePlace({ kind: 'note', ref: '2026-11-11' })).toBeNull();
    expect(fileLabel('roomflow/static/login.html:14')).toBe('login.html:14');
  });

  it('opens a check-in on its proof or its story', () => {
    expect(placeOf('/tickets/RO-7/proof')).toEqual({ to: '/tickets/$id/proof', id: 'RO-7' });
    expect(placeOf('/board?ticket=RO-9')).toEqual({ to: '/board', ticket: 'RO-9' });
    expect(placeOf('/somewhere')).toBeNull();
    expect(openLabel({ kind: 'proof' })).toBe('Open the proof');
    expect(openLabel({ kind: 'stuck' })).toBe('Open it');
  });

  it('shows each card its level, and Always allow only on the low-risk ones', () => {
    expect(levelName({ level: 1 })).toBe('On its own');
    expect(levelName({ level: 2 })).toBe('Needs your OK');
    expect(canAlwaysAllow(action({}))).toBe(true);
    expect(canAlwaysAllow(action({ action: 'start_story', allowAlways: undefined }))).toBe(false);
    // Even a card that says so is not allowed for an action outside the low-risk four.
    expect(canAlwaysAllow(action({ action: 'stop_story', allowAlways: true }))).toBe(false);
    expect(canAlwaysAllow({ ...action({}), kind: 'send_answer', story: 'RO-9', text: 'Yes' } as LeadCard)).toBe(false);
  });
});

describe('the first questions', () => {
  it('come from the project when it can, in plain words', () => {
    expect(exampleQuestions({ apps: ['RoomFlow web'], squadNow: [{ story: 'RO-9', slow: true }] })).toEqual(['How do I sign in to RoomFlow web?', 'Why is RO-9 slow?', "What's left before the release?"]);
    expect(exampleQuestions({ needsYou: [{ story: 'RO-4', kind: 'stuck' }] })[1]).toBe('Why did RO-4 stop?');
    expect(exampleQuestions({})).toEqual(['How do I sign in to the app?', 'Which story added the sign-in page?', "What's left before the release?"]);
    const all = [
      ...exampleQuestions({ apps: ['RoomFlow web'], squadNow: [{ story: 'RO-9' }] }),
      problemQuestion('error', 'RO-9'),
      problemQuestion('waiting', 'RO-9'),
      traceSummary([step('Read roomflow/store.py', 'code'), step('Looked at /app in its own copy', 'app')]),
    ];
    expect(all.filter((w) => !isPlain(w))).toEqual([]);
  });
});
