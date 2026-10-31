import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptFor } from './scripts.js';
import { scheduleSquad } from './schedule.js';
import { writeDecision, writeMeta, writeRelease, writeTicket, type BoardPaths } from './store.js';
import type { Activity, BoardMeta, Decision, Release, Ticket } from './types.js';

/** Minutes before now, as an ISO time, so the seeded board always looks fresh. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function gitUserName(): string {
  try {
    const name = execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
      proof: [
        {
          criterion: 'Typing a full case number opens the case',
          before: 'sk139-before.png',
          after: 'sk139-after.png',
          beforeLabel: 'Before',
          afterLabel: 'After',
          note: 'Recorded by the Tester in Chrome at 1440 by 900',
        },
      ],
      releaseNote: '**Search by case number.** Type a case number and jump straight to the case.',
      activity: log([
        [3, 'reviewer', 'Approved the changes'],
        [5, 'reviewer', 'Reading the changes (round 1 of 2, Claude)'],
        [7, 'tester', 'All 18 checks pass'],
        [25, 'you', 'Approved the plan'],
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
      gates: { checks: 'pass', checksText: '16 of 16 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      releaseNote: '**Session timeout warning.** You get a warning one minute before you are logged out.',
    }),
    base('SK-145', 'Faster login', {
      stage: 'review',
      live: true,
      status: 'Reviewer is reading the login changes',
      squad: null,
    }),
    base('SK-146', 'Filter cases by court', { stage: 'test', live: true, progress: 67, status: 'Running checks for the court filter' }),
    base('SK-147', 'Export case lists to PDF', {
      stage: 'release',
      release: 'v2.4.0',
      status: 'Ready for v2.4.0',
      gates: { checks: 'pass', checksText: '16 of 16 checks pass', review: 'pass', reviewBy: 'Claude', proof: 'pass' },
      releaseNote: '**Export to PDF.** Download any case list as a PDF, ready to print.',
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
        question: 'The checks still fail after 3 tries. autosave.spec.ts says: two clerks editing the same case notes overwrite each other.',
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
    base('SK-151', 'Print the hearing schedule', { stage: 'tickets', live: true, status: 'Analyst is reading the ticket' }),
    base('SK-153', 'Upload limit message', { stage: 'implement', live: true, progress: 66, status: 'Step 4 of 6 with Codex' }),
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
}

/** Writes a full demo board: tickets in every stage, past releases, decisions and proof images. */
export function seedDemoBoard(bp: BoardPaths, opts: SeedOptions = {}): void {
  fs.rmSync(bp.dir, { recursive: true, force: true });
  const user = gitUserName();
  const speed = opts.speed ?? 1;
  writeMeta(bp, demoMeta(user, speed, opts.project ?? 'Case portal'));
  for (const t of demoTickets(user)) {
    if (t.live && t.stage !== 'done' && !t.waiting) scheduleSquad(t, 'ambient', 3 + Math.random() * 4, speed, 0);
    writeTicket(bp, t);
  }
  for (const r of demoReleases()) writeRelease(bp, r);
  for (const d of demoDecisions(user)) writeDecision(bp, d);
  const assets = demoAssetsDir();
  fs.mkdirSync(bp.proofDir, { recursive: true });
  if (fs.existsSync(assets)) {
    for (const f of fs.readdirSync(assets)) fs.copyFileSync(path.join(assets, f), path.join(bp.proofDir, f));
  }
}
