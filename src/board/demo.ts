import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { squadHome } from '../core/home.js';
import { gitEnv } from '../engine/git.js';
import { scriptFor } from './scripts.js';
import { scheduleSquad } from './schedule.js';
import { writeDecision, writeMeta, writeRelease, writeTicket, type BoardPaths } from './store.js';
import type { Activity, AgentName, BoardMeta, Decision, Release, StepRun, Ticket, TimedStep } from './types.js';
import { countSampleHistory } from './demo-cost.js';
import { clearBoard } from './store.js';
import { seedDoneSetup, seedFreshSetup } from './demo-setup.js';
import { clearDemoRequirements, seedDemoRequirements } from './demo-requirements.js';

/** Minutes before now, as an ISO time, so the seeded board always looks fresh. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function gitUserName(): string {
  try {
    const name = execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).trim();
    return name.split(/\s+/)[0] || 'You';
  } catch {
    return 'You';
  }
}

function base(id: string, title: string, over: Partial<Ticket>): Ticket {
  return {
    id,
    title,
    ask: title,
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'tickets',
    status: '',
    waiting: null,
    createdAt: ago(600),
    createdBy: 'Momen',
    builder: 'Codex',
    reviewer: 'Claude',
    activity: [],
    ...over,
  };
}

const log = (entries: [number, Activity['who'], string][]): Activity[] =>
  entries.map(([m, who, text]) => ({ at: ago(m), who, text }));

/** Steps that ended well, from and to in minutes before now, oldest first. */
const ran = (entries: [AgentName | 'squad', TimedStep, number, number][]): StepRun[] =>
  entries.map(([who, step, from, to]) => ({ who, step, from: ago(from), to: ago(to) }));

function demoTickets(user: string): Ticket[] {
  const darkMode = base('SK-148', 'Dark mode for the dashboard', {
    ask: 'Staff on night shifts say the white screen hurts their eyes. Add a dark mode to the dashboard.',
    source: { type: 'azure', ref: 'AB#4120' },
    priority: 'high',
    stage: 'specs',
    status: '4 questions for you',
    createdBy: user,
    createdAt: ago(9),
    activity: log([
      [6, 'analyst', 'Asked 4 questions'],
      [7, 'analyst', 'Looking at how staff use the dashboard at night'],
      [8, 'analyst', 'Reading the ticket and the screenshot'],
      [9, 'you', 'Pulled AB#4120 from Azure DevOps'],
    ]),
  });
  darkMode.questions = scriptFor(darkMode).questions.map((q) => ({ ...q, options: [...q.options] }));
  darkMode.waiting = { kind: 'questions', summary: '4 questions from the Analyst and Architect' };

  return [
    base('SK-139', 'Search by case number', {
      ask: 'Clerks scroll long lists to find a case. Let them type the case number and jump to it.',
      source: { type: 'azure', ref: 'AB#4098' },
      stage: 'review',
      status: 'Proof ready to check',
      waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
      createdAt: ago(46),
      quality: 'best',
      questions: [
        { id: 'q1', from: 'analyst', text: 'Should a part of a number find cases too, or only the full number?', options: ['Only the full number', 'Part of a number too'], answer: { choice: 'Part of a number too' } },
        { id: 'q2', from: 'architect', text: 'Where should the search box go?', options: ['Above the case list', 'In the top bar on every page'], answer: { choice: 'Above the case list' } },
      ],
      decision: {
        title: 'Where the case search lives',
        options: [
          { name: 'A search box above the case list', note: 'One place, next to the cases it finds.', chosen: true },
          { name: 'A search box in the top bar', note: 'On every page, but far from the list.' },
        ],
        why: 'Clerks search while they look at the list, and Angular Material has the search field already.',
      },
      follows: ['ADR-011'],
      history: ran([
        ['analyst', 'questions', 44.6, 44.1],
        ['analyst', 'spec', 39.8, 39.65],
        ['architect', 'design', 35.8, 35.1],
        ['builder', 'build', 29.5, 14.5],
        ['squad', 'checks', 14.4, 13.2],
        ['tester', 'proof', 13.1, 11.9],
        ['reviewer', 'review', 5.3, 3],
      ]),
      story: 'As a clerk, I want to search by case number, so I find a case in seconds.',
      criteria: [
        { given: "I'm on the case list", when: 'I type a full case number', then: 'that case opens at once' },
        { given: 'I type part of a number', when: 'I pause', then: 'I see the matching cases' },
      ],
      steps: [
        { title: 'Search box above the case list', status: 'done', minutes: 3 },
        { title: 'Search by number in the API', status: 'done', minutes: 5 },
        { title: 'Show matches while typing', status: 'done', minutes: 4 },
        { title: 'Tests for every "done when"', status: 'done', minutes: 3 },
      ],
      gates: { checks: 'pass', checksText: '18 of 18 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      specApproved: { by: 'Momen', at: ago(36) },
      stageTimes: { stage: 'review', since: ago(12), spent: { tickets: 35, specs: 250, implement: 960, test: 140 } },
      proof: [
        {
          criterion: 'Typing a full case number opens the case',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'Case 2024/118 typed in full opens straight away, at 1440 by 900.',
          page: '/cases',
          shows: 'met',
        },
        {
          criterion: 'I see the matching cases',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'Typing "2024/1" lists the three cases that start with it.',
          page: '/cases',
          more: [
            { after: 'sk148-light.png', page: '/cases?q=1446', note: 'Typing "1446" lists the cases of that year.' },
            { after: 'sk148-dark-b.png', page: '/hearings?q=1446', note: 'The same search on the hearings list shows the matching hearings.' },
          ],
          shows: 'met',
        },
      ],
      releaseNote: '**Search by case number.** Type a case number and jump straight to the case.',
      activity: log([
        [3, 'reviewer', 'Approved: meets both "done when" points and follows ADR-011'],
        [5.3, 'reviewer', 'Reading the changes (round 1 of 2, Claude)'],
        [11.9, 'tester', 'Saved 1 screenshot'],
        [13.1, 'tester', 'Taking screenshots after the change'],
        [13.2, 'tester', 'All 18 checks pass'],
        [14.4, 'tester', 'squad-kit is running the project checks'],
        [14.5, 'builder', 'Finished all steps'],
        [29.5, 'builder', 'Started building'],
        [30, 'you', 'Approved the design'],
        [35.1, 'architect', 'Wrote the design'],
        [36, 'you', 'Approved the spec'],
        [39.65, 'analyst', 'Wrote the spec'],
        [40, 'you', 'Answered 2 questions'],
        [44.1, 'analyst', 'Asked 2 questions'],
        [44.11, 'analyst', 'Read the case list page, the case search in the API and saved decision ADR-011'],
        [45, 'you', 'Pulled AB#4098 from Azure DevOps'],
      ]),
    }),
    base('SK-140', 'Date shows in the wrong format', {
      kind: 'bug',
      ask: 'On the hearing page the date shows as month/day/year.',
      stage: 'bugs',
      priority: 'high',
      severity: 'stops-work',
      foundIn: 'v2.3.1',
      status: 'Found in v2.3.1',
      activity: log([[50, 'triage', 'Sorted the bug. Priority: High. Linked to v2.3.1']]),
    }),
    base('SK-143', 'Session timeout warning', {
      stage: 'release',
      release: 'v2.4.0',
      status: 'Ready for v2.4.0',
      quality: 'best',
      mergedAt: ago(20 * 60),
      story: 'As a clerk, I want a warning before I am logged out, so I can save my work.',
      criteria: [{ given: 'I have been idle for 14 minutes', when: 'one minute is left', then: 'I see a warning with a Stay signed in button' }],
      history: ran([
        ['analyst', 'questions', 24 * 60, 24 * 60 - 0.6],
        ['analyst', 'spec', 23.5 * 60, 23.5 * 60 - 0.2],
        ['architect', 'design', 23 * 60, 23 * 60 - 0.8],
        ['builder', 'build', 22.5 * 60, 22.5 * 60 - 11],
        ['squad', 'checks', 22.3 * 60, 22.3 * 60 - 1.1],
        ['tester', 'proof', 22.2 * 60, 22.2 * 60 - 1.4],
        ['reviewer', 'review', 22 * 60, 22 * 60 - 2.2],
      ]),
      activity: log([[20 * 60, 'you', 'Checked the proof. Looks right']]),
      gates: { checks: 'pass', checksText: '16 of 16 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      releaseNote: '**Session timeout warning.** You get a warning one minute before you are logged out.',
    }),
    base('SK-145', 'Faster login', {
      stage: 'review',
      live: true,
      status: 'Reviewer is reading the login changes',
      squad: null,
      clock: { who: 'reviewer', step: 'review', since: ago(1.2), limit: 15 },
    }),
    base('SK-146', 'Filter cases by court', {
      stage: 'test',
      live: true,
      progress: 67,
      status: 'Running checks for the court filter',
      clock: { who: 'squad', step: 'checks', since: ago(0.8), limit: 15 },
    }),
    base('SK-147', 'Export case lists to PDF', {
      stage: 'release',
      release: 'v2.4.0',
      status: 'Ready for v2.4.0',
      quality: 'best',
      mergedAt: ago(26 * 60),
      history: ran([
        ['analyst', 'questions', 30 * 60, 30 * 60 - 0.7],
        ['analyst', 'spec', 29.6 * 60, 29.6 * 60 - 0.3],
        ['architect', 'design', 29.2 * 60, 29.2 * 60 - 1],
        ['builder', 'build', 28.8 * 60, 28.8 * 60 - 18],
        ['squad', 'checks', 28.4 * 60, 28.4 * 60 - 1.3],
        ['builder', 'fix', 28.3 * 60, 28.3 * 60 - 4],
        ['squad', 'checks', 28.2 * 60, 28.2 * 60 - 1.2],
        ['tester', 'proof', 28.1 * 60, 28.1 * 60 - 1.6],
        ['reviewer', 'review', 27.9 * 60, 27.9 * 60 - 2.4],
      ]),
      activity: log([[26 * 60, 'you', 'Checked the proof. Looks right']]),
      gates: { checks: 'pass', checksText: '16 of 16 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      releaseNote: '**Export to PDF.** Download any case list as a PDF, ready to print.',
    }),
    // Released in v2.3.1: off the board, but their cost and time count for the averages per Quality setting.
    base('SK-138', 'Fix: calendar week starts on Sunday', {
      kind: 'bug',
      stage: 'done',
      release: 'v2.3.1',
      status: 'Released in v2.3.1',
      quality: 'best',
      createdAt: daysAgo(19),
      mergedAt: daysAgo(18),
      gates: { checks: 'pass', checksText: '15 of 15 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      history: ran([
        ['analyst', 'questions', 19 * 1440 - 10, 19 * 1440 - 10.5],
        ['analyst', 'spec', 19 * 1440 - 30, 19 * 1440 - 30.2],
        ['architect', 'design', 19 * 1440 - 40, 19 * 1440 - 40.7],
        ['builder', 'build', 19 * 1440 - 50, 19 * 1440 - 58],
        ['squad', 'checks', 19 * 1440 - 59, 19 * 1440 - 60],
        ['tester', 'proof', 19 * 1440 - 61, 19 * 1440 - 62.2],
        ['reviewer', 'review', 19 * 1440 - 63, 19 * 1440 - 65],
      ]),
    }),
    base('SK-141', 'Fix: logout button on small screens', {
      kind: 'bug',
      stage: 'done',
      track: 'express',
      release: 'v2.3.1',
      status: 'Released in v2.3.1',
      quality: 'best',
      createdAt: daysAgo(18),
      mergedAt: daysAgo(17.9),
      gates: { checks: 'pass', checksText: '15 of 15 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      history: ran([
        ['architect', 'design', 18 * 1440 - 5, 18 * 1440 - 5.4],
        ['builder', 'build', 18 * 1440 - 6, 18 * 1440 - 9],
        ['squad', 'checks', 18 * 1440 - 9.2, 18 * 1440 - 10.1],
        ['tester', 'proof', 18 * 1440 - 10.3, 18 * 1440 - 11.2],
        ['reviewer', 'review', 18 * 1440 - 11.5, 18 * 1440 - 12.6],
      ]),
    }),
    darkMode,
    base('SK-149', 'Arabic names in PDF exports', {
      source: { type: 'azure', ref: 'AB#4126' },
      stage: 'tickets',
      status: 'From Azure, in queue',
    }),
    base('SK-150', 'Case notes autosave', {
      stage: 'implement',
      status: 'Stuck after 3 test runs',
      waiting: { kind: 'stuck', summary: 'The squad is stuck and needs one decision' },
      stuck: {
        gate: 'checks',
        question: 'The checks still fail after 3 tries: the tests show two clerks editing the same case notes overwrite each other.',
        detail: 'test (npm test):\nautosave.spec.ts: two clerks editing the same case notes overwrite each other.',
        options: [
          { do: 'retry', name: 'Let the Builder try 3 more times', note: 'It gets the full error and tries again.' },
          { do: 'yourself', name: 'Fix it yourself', note: "Open the ticket's copy in your editor and fix it. Then the checks, review and proof run again." },
          { do: 'continue', name: 'Continue anyway', note: 'Go on with the checks failing. Write why: it shows on the ticket, the pull request and the release notes.' },
          { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
        ],
      },
      steps: [
        { title: 'Read the related code', status: 'done', minutes: 2 },
        { title: 'Build case notes autosave', status: 'done', minutes: 6 },
        { title: 'Connect it to the existing screens', status: 'todo' },
        { title: 'Tests for every "done when"', status: 'todo' },
      ],
      story: 'As a clerk, I want my case notes saved as I type, so I never lose my work.',
      progress: 50,
      activity: log([
        [2, 'tester', 'Checks failed 3 times. Stopped and asked you'],
        [12, 'builder', 'Finished step 2: Build case notes autosave'],
      ]),
    }),
    // Squad-kit's stronger gates: no tests ran, so the checks say "Not checked", never a green pass.
    base('SK-142', 'Highlight the case you picked', {
      ask: 'After a search, clerks lose track of the case they opened. Highlight it in the list.',
      stage: 'review',
      status: 'Proof ready to check',
      waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
      story: 'As a clerk, I want the case I picked to stand out in the list, so I do not lose my place.',
      criteria: [{ given: 'I picked a case from the search', when: 'the case list shows', then: 'that row is highlighted' }],
      steps: [
        { title: 'Remember the picked case', status: 'done', minutes: 2 },
        { title: 'Highlight its row in the list', status: 'done', minutes: 3 },
        { title: 'Check the colors in dark mode', status: 'done', minutes: 2 },
      ],
      work: { steps: 3, tests: 0, screens: 1 },
      gates: {
        checks: 'unchecked',
        checksText: 'No tests ran · build passes, the app starts',
        review: 'pass',
        reviewBy: 'Claude',
        proof: 'pass',
      },
      specApproved: { by: 'Momen', at: ago(40) },
      stageTimes: { stage: 'review', since: ago(6), spent: { tickets: 30, specs: 200, implement: 420, test: 90 } },
      proof: [
        {
          criterion: 'That row is highlighted',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'Recorded by the Tester in Chrome at 1280 by 800',
          shows: 'met',
        },
      ],
      releaseNote: '**Highlight the picked case.** The case you opened stands out in the list.',
      activity: log([
        [3, 'reviewer', 'Approved the changes'],
        [5, 'tester', 'Not checked: No tests ran · build passes, the app starts. You chose to go on without tests in this project'],
        [6, 'tester', 'squad-kit is running the project checks'],
      ]),
    }),
    // The tests were made weaker: squad-kit stops before the checks, and only you can go on.
    base('SK-144', 'Hearing reminders by email', {
      stage: 'test',
      status: 'The tests were made weaker',
      waiting: { kind: 'stuck', summary: 'The tests were made weaker: needs one decision' },
      retryPhase: 'restore-tests',
      gates: { checks: 'fail', checksText: 'Tests were weakened', review: 'pending', proof: 'pending' },
      stuck: {
        gate: 'checks',
        kind: 'weakened',
        question: 'This change makes the tests weaker than on main, so passing checks would prove little.',
        points: [
          'web/src/app/reminders/reminder.service.spec.ts has fewer tests: 6 before, 4 now.',
          'In web/src/app/hearings/hearing-list.spec.ts: tests switched off with it.skip.',
          'The test scripts or settings in web/package.json changed: "test" was "jest", now "jest --passWithNoTests".',
        ],
        checks: ['fewer:web/src/app/reminders/reminder.service.spec.ts:4', 'skip:web/src/app/hearings/hearing-list.spec.ts:it.skip:1', 'config:web/package.json:5d1c0a2e'],
        detail: 'fewer: web/src/app/reminders/reminder.service.spec.ts\nskip: web/src/app/hearings/hearing-list.spec.ts\nconfig: web/package.json',
        options: [
          { do: 'retry', name: 'Send it back to the Builder', note: 'It puts the tests back as they were, then the checks run again.' },
          { do: 'yourself', name: 'Fix it yourself', note: "Open the ticket's copy in your editor and fix it. Then the checks, review and proof run again." },
          { do: 'continue', name: 'Continue anyway', note: 'Go on with the tests as they are now; the checks still run. Write why: it shows on the ticket, the pull request and the release notes.' },
          { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
        ],
      },
      story: 'As a clerk, I want hearing reminders sent by email too, so people without SMS still come.',
      specApproved: { by: 'Momen', at: ago(70) },
      steps: [
        { title: 'Add email to the reminder service', status: 'done', minutes: 6 },
        { title: 'Send at the same times as SMS', status: 'done', minutes: 4 },
        { title: 'Tests for every "done when"', status: 'done', minutes: 3 },
      ],
      progress: 100,
      activity: log([
        [2, 'tester', 'Stopped before the checks: the tests were made weaker.'],
        [4, 'builder', 'Finished all steps'],
      ]),
    }),
    // The screenshots still show a "done when" not working after the Builder's second round: a plain stop with ways out.
    // Each row shows its own verdict: met, not working yet, not shown yet.
    base('SK-135', 'Case search on a phone', {
      ask: 'Clerks in court use their phones. The case search must work on a phone screen.',
      stage: 'review',
      status: 'The screenshots show it is not working yet',
      waiting: { kind: 'stuck', summary: 'The screenshots show it is not working yet: needs one decision' },
      retryPhase: 'proof-fix',
      proofRound: 2,
      story: 'As a clerk in court, I want to search cases on my phone, so I find a case without a laptop.',
      criteria: [
        { given: "I'm on the case list on a phone", when: 'I open it', then: 'the search box shows above the list' },
        { given: "I'm on the case list on a phone", when: 'I scroll the results', then: 'the page fits the screen and does not scroll sideways' },
        { given: 'I searched on a phone', when: 'I open a case', then: 'the back button returns to my results' },
      ],
      specApproved: { by: 'Momen', at: ago(90) },
      steps: [
        { title: 'Search box on small screens', status: 'done', minutes: 4 },
        { title: 'Results list on small screens', status: 'done', minutes: 5 },
        { title: 'Tests for every "done when"', status: 'done', minutes: 3 },
      ],
      work: { steps: 3, tests: 6, screens: 3 },
      gates: { checks: 'pass', checksText: '14 of 14 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'fail' },
      proof: [
        {
          criterion: 'The search box shows above the list',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'The search box sits above the case list on a phone screen.',
          page: '/cases',
          shows: 'met',
        },
        {
          criterion: 'The page fits the screen and does not scroll sideways',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'The results list is wider than the phone screen.',
          page: '/cases',
          shows: 'broken',
          why: 'At phone width the results list runs off the right edge, so the page scrolls sideways.',
        },
        {
          criterion: 'The back button returns to my results',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'The case page is open.',
          page: '/cases/4417',
          more: [{ after: 'sk148-light.png', page: '/cases', note: 'The results before opening the case.' }],
          shows: 'not-shown',
          why: 'The pictures show the case page and the results before it, but not the results after pressing the back button.',
        },
      ],
      stuck: {
        gate: 'proof',
        kind: 'broken',
        question: 'The screenshots show "done when" 2 is not working yet: at phone width the results list runs off the right edge, so the page scrolls sideways.',
        points: ['"Done when" 2: The page fits the screen and does not scroll sideways', '"Done when" 3, The back button returns to my results: The pictures show the case page and the results before it, but not the results after pressing the back button.'],
        options: [
          { do: 'retry', name: 'Let the Builder try again', note: 'It gets what the screenshots show. Then the checks, the review and the screenshots run again.' },
          { do: 'continue', name: 'Continue anyway', note: 'Go on with a "done when" not working yet. Write why: it shows on the ticket, the pull request and the release notes.' },
          { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
        ],
      },
      activity: log([
        [3, 'tester', 'Still not working after 2 rounds: "done when" 2'],
        [4, 'reviewer', 'Checked the screenshots: 1 met, 1 not working yet, 1 not shown yet'],
        [12, 'builder', 'Fixed what the screenshots showed'],
        [20, 'tester', 'The screenshots show one "done when" not working yet, so the Builder fixes it: "done when" 2: At phone width the results list runs off the right edge.'],
      ]),
    }),
    // The Tester could not get a "done when" into a picture, even with squad-kit's advice: a plain stop, and the product is not touched.
    base('SK-155', 'Hearing room on the case page', {
      ask: 'Clerks want to see the hearing room on the case page, with the room number.',
      stage: 'review',
      status: 'The screenshots do not show it yet',
      waiting: { kind: 'stuck', summary: 'The screenshots do not show it yet: needs one decision' },
      retryPhase: 'proof',
      story: 'As a clerk, I want to see the hearing room on the case page, so I know where to go.',
      criteria: [
        { given: 'a case with a hearing', when: 'I open the case page', then: 'the hearing room shows with its number' },
        { given: 'a case with no hearing yet', when: 'I open the case page', then: 'it says no room yet' },
      ],
      specApproved: { by: 'Momen', at: ago(70) },
      steps: [
        { title: 'Add the hearing room to the case page', status: 'done', minutes: 3 },
        { title: 'Tests for every "done when"', status: 'done', minutes: 2 },
      ],
      work: { steps: 2, tests: 3, screens: 2 },
      gates: { checks: 'pass', checksText: '9 of 9 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'fail' },
      proof: [
        {
          criterion: 'The hearing room shows with its number',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'Room 4 shows under the hearing date.',
          page: '/cases/4417',
          shows: 'met',
        },
        {
          criterion: 'It says no room yet',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'The case page is open.',
          page: '/cases/4502',
          shows: 'not-shown',
          why: 'The picture shows a case with a hearing, so the words for a case with no hearing are not in it.',
        },
      ],
      stuck: {
        gate: 'proof',
        kind: 'not-shown',
        question: 'The squad could not show "done when" 2 on a screen. Try it yourself, or ask a question.',
        points: ['"Done when" 2, It says no room yet: The picture shows a case with a hearing, so the words for a case with no hearing are not in it.'],
        options: [
          { do: 'retry', name: 'Take the screenshots again', note: 'Only the proof runs again. Nothing is rebuilt. You can add a note for the Tester.' },
          { do: 'continue', name: 'Continue anyway', note: 'Go on with a "done when" not shown yet. Write why: it shows on the ticket, the pull request and the release notes.' },
          { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
        ],
      },
      activity: log([
        [3, 'tester', 'Could not show "done when" 2 on a screen after 2 more tries'],
        [4, 'reviewer', 'Checked the screenshots: 1 met, 1 not shown yet'],
        [8, 'tester', 'The screenshots do not show "done when" 2 clearly yet, so the Tester takes it again (try 2 of 2)'],
        [11, 'tester', 'The screenshots do not show "done when" 2 clearly yet, so the Tester takes it again (try 1 of 2)'],
      ]),
    }),
    // Its design needs SK-146, which is not merged yet: the build waits for the person to choose how to build.
    base('SK-152', 'Court filter on the hearing calendar', {
      ask: 'Clerks want the court filter from the case list on the hearing calendar too.',
      stage: 'implement',
      status: 'SK-152 needs SK-146, which is not merged yet',
      waiting: { kind: 'depends', summary: 'SK-152 needs SK-146, which is not merged yet' },
      dependsOn: ['SK-146'],
      specApproved: { by: 'Momen', at: ago(22) },
      story: "As a clerk, I want to filter the hearing calendar by court, so I see only my court's hearings.",
      criteria: [
        { given: 'I am on the hearing calendar', when: 'I pick a court', then: "I see only that court's hearings" },
        { given: 'I picked a court', when: 'I move to the next week', then: 'the calendar keeps my court' },
      ],
      work: { steps: 3, tests: 3, screens: 1 },
      steps: [
        { title: 'Use the court filter from SK-146 on the calendar', status: 'todo' },
        { title: 'Keep the chosen court when the week changes', status: 'todo' },
        { title: 'Tests for every "done when"', status: 'todo' },
      ],
      activity: log([
        [1, 'squad', 'SK-152 needs SK-146, which is not merged yet, so the build waits for you to choose how to build'],
        [2, 'you', 'Approved the design'],
        [6, 'architect', 'Wrote the design. It uses the court filter that SK-146 adds'],
      ]),
    }),
    base('SK-151', 'Print the hearing schedule', {
      stage: 'tickets',
      live: true,
      status: 'Analyst is reading the ticket',
      clock: { who: 'analyst', step: 'questions', since: ago(0.6), limit: 10 },
    }),
    // A step that is taking longer than usual, to show the card with why and its ways on: its own run of the tests
    // failed, and the Builder is fixing them.
    base('SK-153', 'Upload limit message', {
      stage: 'implement',
      live: true,
      progress: 80,
      status: 'Fixing a failed test',
      specApproved: { by: 'Momen', at: ago(40) },
      work: { steps: 6, tests: 5, screens: 2 },
      steps: [
        { title: 'Read the upload code', status: 'done', minutes: 3 },
        { title: 'Keep the limit in one setting', status: 'done', minutes: 4 },
        { title: 'Check the size before uploading', status: 'done', minutes: 3 },
        { title: 'Show the limit in plain words', status: 'done', minutes: 4 },
        { title: 'Same check in the API', status: 'done', minutes: 3 },
        { title: 'Tests for every "done when"', status: 'doing', live: 'Fixing a failed test' },
      ],
      clock: { who: 'builder', step: 'build', part: 6, since: ago(14), began: ago(31), doing: 'Fixing a failed test', doingAt: ago(0.6), limit: 60, failed: { check: 'test', times: 1, at: ago(5) } },
      stageTimes: { stage: 'implement', since: ago(31), spent: { tickets: 40, specs: 290 } },
      activity: log([
        [5, 'builder', 'squad-kit ran the tests for the Builder: did not pass'],
        [14, 'builder', 'Started step 6: Tests for every "done when"'],
        [14, 'builder', 'Finished step 5: Same check in the API'],
        [17, 'builder', 'Finished step 4: Show the limit in plain words'],
        [21, 'builder', 'Finished step 3: Check the size before uploading'],
        [24, 'builder', 'Finished step 2: Keep the limit in one setting'],
        [28, 'builder', 'Finished step 1: Read the upload code'],
        [31, 'builder', 'Started building'],
      ]),
    }),
  ];
}

function demoReleases(): Release[] {
  const addons = { changelog: true, tag: true, pipeline: true, whatsapp: true };
  return [
    {
      version: 'v2.2.0',
      status: 'released',
      from: 'v2.1.0',
      date: daysAgo(49),
      tickets: ['SK-118', 'SK-121', 'SK-124', 'SK-126'],
      titles: { 'SK-118': 'Hearing reminders by SMS', 'SK-121': 'Case list paging', 'SK-124': 'Clerk profile page', 'SK-126': 'Faster case search' },
      notes: "### What's new in 2.2.0\n\n- **Hearing reminders by SMS.**\n- **Case list paging.**",
      addons,
    },
    {
      version: 'v2.3.0',
      status: 'released',
      from: 'v2.2.0',
      date: daysAgo(31),
      tickets: ['SK-129', 'SK-131', 'SK-133', 'SK-134', 'SK-136'],
      titles: {
        'SK-129': 'Upload case documents',
        'SK-131': 'Court calendar view',
        'SK-133': 'Judge notes',
        'SK-134': 'Arabic date picker',
        'SK-136': 'Audit log for case changes',
      },
      notes: "### What's new in 2.3.0\n\n- **Upload case documents.**\n- **Court calendar view.**",
      addons,
    },
    {
      version: 'v2.3.1',
      status: 'released',
      from: 'v2.3.0',
      date: daysAgo(17),
      tickets: ['SK-137', 'SK-138', 'SK-141'],
      titles: { 'SK-137': 'Fix: upload stops at 5 MB', 'SK-138': 'Fix: calendar week starts on Sunday', 'SK-141': 'Fix: logout button on small screens' },
      bugs: ['SK-140'],
      notes: "### What's new in 2.3.1\n\n- **Fixed:** uploads stopped at 5 MB.",
      addons,
    },
    { version: 'v2.4.0', status: 'draft', from: 'v2.3.1', tickets: ['SK-147', 'SK-143'], notes: '', addons },
  ];
}

function demoDecisions(user: string): Decision[] {
  return [
    {
      id: 'ADR-011',
      title: 'Use Angular Material for buttons and menus',
      why: 'The client requires it across all ministry portals.',
      options: ['Angular Material', 'Our own components'],
      chosen: 'Angular Material',
      from: "Client's choice",
      approvedBy: user,
      date: daysAgo(20),
      checkedBy: { kind: 'lint rule', name: 'no-custom-buttons', passing: true },
      tickets: ['SK-131', 'SK-134'],
    },
    {
      id: 'ADR-010',
      title: 'Every list page can export to PDF',
      why: 'Clerks print lists for court sessions every day.',
      options: ['Export on some pages', 'Export on every list page'],
      chosen: 'Export on every list page',
      from: 'SK-147',
      approvedBy: user,
      date: daysAgo(2),
      checkedBy: { kind: 'test', name: 'list-pages-export.spec.ts', passing: true },
      tickets: ['SK-147'],
    },
    {
      id: 'ADR-007',
      title: 'Dates always show as day/month/year',
      why: 'That is how dates are read in Saudi courts. A bug proved it matters.',
      options: ['Follow the browser', 'Always day/month/year'],
      chosen: 'Always day/month/year',
      from: 'SK-112',
      approvedBy: user,
      date: daysAgo(40),
      checkedBy: { kind: 'test', name: 'date-format.spec.ts', passing: true },
      tickets: ['SK-112', 'SK-134'],
    },
    {
      id: 'ADR-003',
      title: 'The back end is a .NET 8 API',
      why: 'Found by the Architect when it first read the project.',
      options: ['.NET 8 API'],
      chosen: '.NET 8 API',
      from: 'Project scan',
      approvedBy: user,
      date: daysAgo(60),
      checkedBy: null,
      tickets: [],
    },
    {
      id: 'ADR-002',
      title: 'The front end is Angular 17',
      why: 'Found by the Architect when it first read the project.',
      options: ['Angular 17'],
      chosen: 'Angular 17',
      from: 'Project scan',
      approvedBy: user,
      date: daysAgo(60),
      checkedBy: null,
      tickets: [],
    },
  ];
}

function demoMeta(user: string, speed: number, project: string): BoardMeta {
  return {
    project,
    key: 'SK',
    nextNumber: 154,
    engine: 'demo',
    user: { name: user, role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Codex', tester: 'Codex', reviewer: 'Claude' },
    tools: [
      { name: 'Claude Code', ready: true },
      { name: 'Codex', ready: true },
    ],
    speed,
    map: [
      { area: 'Front end', detail: 'Angular 17 with Angular Material, in web/' },
      { area: 'Back end', detail: '.NET 8 API, in api/' },
      { area: 'Database', detail: 'SQL Server, migrations in api/Migrations/' },
      { area: 'Tests', detail: 'Jest for logic, Playwright for screens' },
      { area: 'Code style', detail: 'ESLint and Prettier rules in web/' },
      { area: 'How to run', detail: 'npm start in web/, dotnet run in api/' },
    ],
    lessons: [
      { id: 'L-003', text: 'Dates must show as day/month/year. A test now guards it.', from: 'SK-112', date: daysAgo(40) },
      { id: 'L-002', text: 'Big case lists need paging, or the page freezes.', from: 'SK-121', date: daysAgo(50) },
      { id: 'L-001', text: 'Always check the Arabic layout, right to left, before the proof.', from: 'SK-104', date: daysAgo(58) },
    ],
  };
}

function demoAssetsDir(): string {
  const candidates = [
    fileURLToPath(new URL('../templates/demo/proof/', import.meta.url)), // dist/cli.js
    fileURLToPath(new URL('../../templates/demo/proof/', import.meta.url)), // src/board/demo.ts
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
}

export interface SeedOptions {
  speed?: number;
  project?: string;
  /** The sample project at its first open: no tickets yet, the setup about to start, then the Overview to approve. */
  firstRun?: boolean;
}

/** How big each seeded sample ticket's work was, against a usual one. */
const SAMPLE_SIZE: Record<string, number> = { 'SK-138': 0.8, 'SK-141': 0.45, 'SK-147': 1.3 };

/** Writes a full demo board: tickets in every stage, past releases, decisions and proof images. */
/**
 * The sample board lives in its own folder on this computer, never in a project: seeding it replaces a board's tickets,
 * decisions and files.
 */
export function demoFolder(): string {
  return path.join(squadHome(), 'demo');
}

export function seedDemoBoard(bp: BoardPaths, opts: SeedOptions = {}): void {
  clearBoard(bp);
  clearDemoRequirements(bp);
  const user = gitUserName();
  const speed = opts.speed ?? 1;
  const meta = demoMeta(user, speed, opts.project ?? 'Case portal');
  if (opts.firstRun) {
    writeMeta(bp, { ...meta, nextNumber: 1, lessons: [] });
    seedFreshSetup(bp);
    return;
  }
  writeMeta(bp, meta);
  for (const t of demoTickets(user)) {
    if (t.live && t.stage !== 'done' && !t.waiting) scheduleSquad(t, 'ambient', 3 + Math.random() * 4, speed, 0);
    // The steps the sample tickets already took are counted, so the Cost tab and the averages have something to show.
    if (t.history?.length) countSampleHistory(bp, t, SAMPLE_SIZE[t.id] ?? 1);
    // The sample squad is yours: every ticket on the sample board is yours to work on and hand over.
    writeTicket(bp, { ...t, owner: user });
  }
  for (const r of demoReleases()) writeRelease(bp, r);
  for (const d of demoDecisions(user)) writeDecision(bp, d);
  // The court portal's BRD, broken down and ready to approve, for the Requirements page.
  seedDemoRequirements(bp, user);
  const assets = demoAssetsDir();
  fs.mkdirSync(bp.proofDir, { recursive: true });
  if (fs.existsSync(assets)) {
    for (const f of fs.readdirSync(assets)) fs.copyFileSync(path.join(assets, f), path.join(bp.proofDir, f));
  }
  // Its first run long ago: every setup step done, and the Overview approved, kept up to date since.
  seedDoneSetup(bp, user, daysAgo(60));
}
