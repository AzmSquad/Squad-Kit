import type { Criterion, DecisionDraft, ProofShot, Question, Ticket } from './types.js';

/**
 * What the demo squad says and does for a ticket. The real engine will produce the same
 * shapes from Claude Code or Codex; the demo plays them back on a timer.
 */
export interface TicketScript {
  analystLines: string[];
  questions: Question[];
  replies: Record<string, string>;
  planLines: { who: 'architect' | 'spec'; text: string }[];
  story(t: Ticket): string;
  criteria(t: Ticket): Criterion[];
  decision(t: Ticket): DecisionDraft | undefined;
  steps: { title: string; live: string[] }[];
  tests: number;
  reviewFix?: { ask: string; fixed: string };
  proof: ProofShot[];
  releaseNote(t: Ticket): string;
}

function answerOf(t: Ticket, id: string): { choice: string; value?: string } | undefined {
  return t.questions?.find((q) => q.id === id)?.answer;
}

const darkMode: TicketScript = {
  analystLines: ['Reading the ticket and the screenshot', 'Looking at how staff use the dashboard at night'],
  questions: [
    { id: 'q1', from: 'analyst', text: 'Who needs this most?', options: ['Night shift staff', 'Managers', 'Everyone'] },
    { id: 'q2', from: 'analyst', text: "At first, should it follow the computer's theme?", options: ['Yes', 'No, start light'] },
    {
      id: 'q3',
      from: 'architect',
      text: 'Must you use a tech the client chose?',
      options: ['No, you choose', 'Yes:'],
      inputOption: 'Yes:',
    },
    { id: 'q4', from: 'architect', text: 'Do staff share computers?', options: ['Yes, shared desks', 'No, each has their own'] },
  ],
  replies: {
    q1: 'I ask so the switch sits where these people look first. Night shift staff live on the case list, so the switch would go in its top bar.',
    q2: 'Some computers already switch to dark at night. With Yes, new users start with the same theme as their computer, and can still change it.',
    q3: 'I mean a design library for buttons, menus and colors, like Angular Material. Angular itself is already saved as a project decision. If the client requires a library, I must use its dark theme.',
    q4: 'If staff share desks, a choice saved in the browser is lost when they move. Then I would save the theme in each person\'s account instead.',
  },
  planLines: [
    { who: 'architect', text: 'Reading the code for the theme' },
    { who: 'architect', text: 'Reading the code for accounts' },
    { who: 'architect', text: 'Checking Angular Material for dark theme support' },
    { who: 'spec', text: 'Writing the plan: 6 small steps and 9 tests' },
  ],
  story(t) {
    const who = answerOf(t, 'q1')?.choice;
    const person = who === 'Managers' ? 'manager' : who === 'Everyone' ? 'staff member' : 'night shift staff member';
    return `As a ${person}, I want a dark mode, so my eyes don't get tired.`;
  },
  criteria(t) {
    const followsComputer = answerOf(t, 'q2')?.choice !== 'No, start light';
    return [
      { given: "I'm logged in", when: 'I press the theme switch', then: 'the dashboard turns dark' },
      { given: 'I chose dark', when: 'I log in on another computer', then: 'it is still dark' },
      followsComputer
        ? { given: "I'm new", when: 'I log in', then: 'the theme follows my computer' }
        : { given: "I'm new", when: 'I log in', then: 'the dashboard starts light' },
    ];
  },
  decision(t) {
    const shared = answerOf(t, 'q4')?.choice !== 'No, each has their own';
    const client = answerOf(t, 'q3');
    const lib = client?.choice === 'Yes:' ? client.value?.trim() : undefined;
    return {
      title: shared ? "Save each person's theme in their account" : 'Save the theme in the browser',
      options: [
        { name: 'In the browser', note: 'Simple, but lost when staff change desks.', chosen: !shared },
        { name: 'In the account', note: 'Follows the person to any computer.', chosen: shared },
      ],
      why: shared
        ? 'Staff share desks, from your answer to question 4.'
        : 'Each person has their own computer, from your answer to question 4, so the simple way is enough.',
      clientCheck: lib
        ? /material/i.test(lib)
          ? `${lib} supports dark themes, so there is no conflict.`
          : `${lib} will be checked for dark theme support in step 3.`
        : 'No client choice for this. The squad uses the existing styles.',
    };
  },
  steps: [
    { title: 'Add a theme setting to each account', live: ['Reading the code for accounts', 'Writing the code for saved settings', 'Adding a theme column to the database'] },
    { title: 'Theme switch in the header', live: ['Writing the code for the header', 'Placing the switch next to the user menu'] },
    { title: 'Dark colors for every page', live: ['Writing the dark colors', 'Checking 14 pages for fixed colors'] },
    { title: 'Save the choice in the account', live: ['Writing the code that saves the choice', 'Writing the code for the theme'] },
    { title: 'Follow the computer theme for new users', live: ['Reading the browser theme setting', 'Writing the code for the theme'] },
    { title: 'Tests for every "done when"', live: ['Writing the test for the saved theme', 'Writing 9 new tests'] },
  ],
  tests: 21,
  reviewFix: {
    ask: 'Asked for 1 fix: the page flashes white for a moment on login',
    fixed: 'Fixed: the theme now loads before the page shows',
  },
  proof: [
    {
      criterion: 'The switch turns the dashboard dark',
      before: 'sk148-light.png',
      after: 'sk148-dark.png',
      beforeLabel: 'Before',
      afterLabel: 'After',
      note: 'Recorded by the Tester in Chrome at 1440 by 900',
      shows: 'met',
    },
    {
      criterion: 'Still dark on another computer',
      before: 'sk148-dark.png',
      after: 'sk148-dark-b.png',
      beforeLabel: 'Computer A',
      afterLabel: 'Computer B',
      note: 'Same account, logged in on a second browser',
      shows: 'met',
    },
    {
      criterion: 'New users follow their computer theme',
      before: 'sk148-light.png',
      after: 'sk148-dark.png',
      beforeLabel: 'Computer set to light',
      afterLabel: 'Computer set to dark',
      note: 'A new account on two computers with different settings',
      shows: 'met',
    },
  ],
  releaseNote: () => '**Dark mode.** Switch the dashboard to dark. Your choice follows you to any computer.',
};

/** Plain-words content for any ticket the demo has no special script for. */
function genericScript(t: Ticket): TicketScript {
  const what = t.title.charAt(0).toLowerCase() + t.title.slice(1);
  const isBug = t.kind === 'bug';
  return {
    analystLines: isBug
      ? ['Reading the bug report', 'Following the steps to see it happen']
      : ['Reading the ticket', 'Looking at similar past tickets'],
    questions: isBug
      ? []
      : [
          { id: 'q1', from: 'analyst', text: 'Who needs this most?', options: ['Staff who use it daily', 'Managers', 'Everyone'] },
          { id: 'q2', from: 'analyst', text: 'How soon is it needed?', options: ['This week', 'This month', 'No rush'] },
          {
            id: 'q3',
            from: 'architect',
            text: 'Must you use a tech the client chose for this?',
            options: ['No, you choose', 'Yes:'],
            inputOption: 'Yes:',
          },
        ],
    replies: {
      q1: 'I ask so the plan puts this where those people already work.',
      q2: 'If it is urgent, I keep the first version small and plan the rest as a follow-up ticket.',
      q3: 'I mean a library or tool the client requires, like a design library. If there is none, I follow the project decisions already saved.',
    },
    planLines: [
      { who: 'architect', text: 'Reading the screens this touches' },
      { who: 'architect', text: 'Checking the saved project decisions' },
      { who: 'spec', text: 'Writing the plan in small steps' },
    ],
    story: () =>
      isBug ? `Fix: ${what}.` : `As a ${answerOf(t, 'q1')?.choice === 'Managers' ? 'manager' : 'staff member'}, I want ${what}, so my work is easier.`,
    criteria: () =>
      isBug
        ? [
            { given: 'the steps in the bug report', when: 'I follow them', then: 'the problem no longer happens' },
            { given: 'the fix is in', when: 'the checks run', then: 'a new test guards this bug' },
          ]
        : [
            { given: "I'm logged in", when: `I use ${what}`, then: 'it works as the ticket describes' },
            { given: 'something goes wrong', when: `I use ${what}`, then: 'I see a clear message' },
          ],
    decision: () =>
      isBug
        ? undefined
        : {
            title: 'Build it inside the existing screens',
            options: [
              { name: 'A new page', note: 'More work, and staff must learn where it is.' },
              { name: 'Inside the existing screens', note: 'Staff find it where they already work.', chosen: true },
            ],
            why: 'Staff should not have to learn a new place.',
            clientCheck: 'Follows the project decisions already saved.',
          },
    steps: isBug
      ? [
          { title: 'Reproduce the bug in a test', live: ['Writing a test that shows the bug', 'The test fails, as expected'] },
          { title: 'Fix the cause', live: ['Reading the code behind it', 'Editing the fix'] },
          { title: 'Check nothing else broke', live: ['Running the related checks'] },
        ]
      : [
          { title: 'Read the related code', live: ['Reading the screens this touches'] },
          { title: `Build ${what}`, live: ['Editing the screen', 'Editing the API'] },
          { title: 'Connect it to the existing screens', live: ['Editing the navigation'] },
          { title: 'Tests for every "done when"', live: ['Writing the tests'] },
        ],
    tests: isBug ? 12 : 16,
    proof: [],
    releaseNote: () => (isBug ? `**Fixed:** ${what}.` : `**${t.title}.**`),
  };
}

const SCRIPTS: Record<string, TicketScript> = { 'SK-148': darkMode };

export function scriptFor(t: Ticket): TicketScript {
  return SCRIPTS[t.id] ?? genericScript(t);
}

/** Status lines for tickets that work in the background of the demo board. */
export const AMBIENT: Record<string, string[]> = {
  'SK-151': ['Analyst is reading the ticket', 'Analyst is checking the hearing calendar'],
  'SK-153': ['Writing the code for the upload page', 'Writing the code for the upload limits'],
  'SK-146': ['Running checks for the court filter', 'Checking filters on 3 screen sizes'],
  'SK-145': ['Reviewer is reading the login changes', 'Reviewer is checking the session handling'],
};
