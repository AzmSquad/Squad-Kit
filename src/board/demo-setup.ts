import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDecisions, nextDecisionId, now, readMeta, writeDecision, writeMeta, type BoardPaths } from './store.js';
import type { BoardMeta, Decision } from './types.js';
import { readOverview, writeOverview, type Overview } from './overview.js';
import { begin, currentStep, finish, newSetup, type SetupState, type SetupStepId } from './setup-state.js';
import { readTalk, writeTalk } from './first-run.js';

/**
 * The first run on the sample board, played on a timer like the rest of the demo: the setup's steps with their times,
 * then the Overview with what the "Architect" understood, its rules waiting for approval, and ticket ideas. No AI runs:
 * every line is written here. `squad demo --first-run` starts the sample project at its first open; Read it again on
 * the sample Overview plays the setup again.
 */

export const DEMO_SUMMARY = 'A web portal where court clerks and judges manage cases, hearings and documents.';

export function demoOverview(readAt: string, approved?: { by: string; at: string }): Overview {
  return {
    users: 'Court clerks, judges and team leads. They sign in with their ministry account, and each role sees its own screens.',
    can: [
      'Find a case by its number or by a party name',
      'Plan hearings on a calendar, in day/month/year',
      'Upload case documents up to 20 MB',
      'Export any list page to PDF',
      'Switch between Arabic and English, right to left',
    ],
    worth: [
      'The session ends after 20 minutes with no warning, so a clerk can lose a half-filled form.',
      'Big case lists need paging, or the page freezes.',
      'No test opens the hearing calendar in a real browser yet.',
    ],
    ideas: [
      { title: 'Warn before the session ends', why: 'Clerks lose what they typed when the session ends with no warning.' },
      { title: 'Bulk assign cases to a clerk', why: 'Team leads assign cases one by one today.' },
      { title: 'Add browser tests for the hearing calendar', why: 'Nothing checks the calendar in a real browser yet.' },
    ],
    parts: [
      { id: 'people', name: 'Clerks and judges', what: 'In a web browser', files: [], kind: 'people' },
      { id: 'pages', name: 'Pages', what: 'Case list, hearings, documents', files: ['web/src/app/'], kind: 'screens' },
      { id: 'api', name: 'Web API', what: 'Cases, hearings and uploads', files: ['api/Controllers/'], kind: 'server' },
      { id: 'rules', name: 'Case rules', what: 'Filing and hearing rules in one place', files: ['api/Domain/'], kind: 'logic' },
      { id: 'db', name: 'Database', what: 'SQL Server, with migrations', files: ['api/Migrations/'], kind: 'data' },
      { id: 'signin', name: 'Ministry sign-in', what: 'Who may open which screens', files: ['api/Auth/'], kind: 'outside' },
      { id: 'tests', name: 'Tests · 18', what: 'Jest for the logic, Playwright for the screens', files: ['web/src/app/', 'e2e/'], kind: 'tests' },
    ],
    links: [
      { from: 'people', to: 'pages', label: 'uses' },
      { from: 'pages', to: 'api', label: 'calls' },
      { from: 'api', to: 'rules', label: 'follows' },
      { from: 'rules', to: 'db', label: 'stores in' },
      { from: 'api', to: 'signin', label: 'signs in with' },
      { from: 'tests', to: 'pages', label: 'checks' },
      { from: 'tests', to: 'rules', label: 'checks' },
    ],
    readAt,
    ...(approved ? { approved } : {}),
  };
}

/** The rules the sample read finds, before the person approves them. */
const FOUND: { title: string; why: string }[] = [
  { title: 'The front end is Angular 17', why: 'Every screen in web/ is an Angular component.' },
  { title: 'The back end is a .NET 8 API', why: 'api/ is one ASP.NET Core project.' },
  { title: 'SQL Server, changed only through migrations', why: 'Every table change is a migration in api/Migrations/.' },
  { title: 'Angular Material for buttons and menus', why: 'The client asks for it across all ministry portals.' },
  { title: 'Jest for logic, Playwright for screens', why: 'Both run in the checks today.' },
];

/** What the Architect opens, behind "See what the Architect is reading". The step itself says it in plain words. */
const READS = [
  'Reading README.md',
  'Reading web/package.json',
  'Looking for *.component.ts',
  'Reading web/src/app/cases/case-list.component.ts',
  'Reading web/src/app/hearings/calendar.component.ts',
  'Reading api/Controllers/CasesController.cs',
  'Reading api/Domain/HearingRules.cs',
  'Searching for "Authorize"',
  'Reading api/Migrations/',
  'Reading e2e/cases.spec.ts',
];
const DEMO_FILES = 214;

/** Seconds each step takes at normal speed. */
const PACE: Record<SetupStepId, number> = { files: 1, tool: 2, read: 26, commands: 7, tests: 6, app: 6, overview: 1 };

/** The sample app's first page: the demo's own screenshot of the case list. */
function demoShotSource(): string | null {
  for (const rel of ['../templates/demo/proof/sk139-before.png', '../../templates/demo/proof/sk139-before.png']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function copyShot(bp: BoardPaths): string | undefined {
  const src = demoShotSource();
  if (!src) return undefined;
  fs.mkdirSync(bp.proofDir, { recursive: true });
  fs.copyFileSync(src, path.join(bp.proofDir, 'setup-app.png'));
  return 'setup-app.png';
}

/** The sample board as it is long after its first run: every step done, the overview approved and kept up to date. */
export function seedDoneSetup(bp: BoardPaths, user: string, readAt: string): void {
  const start = Date.parse(readAt) - 60_000;
  const s = newSetup('repo', start, start + 1000);
  let t = start + 1000;
  for (const id of ['tool', 'read', 'commands', 'tests', 'app', 'overview'] as const) {
    begin(s, id, undefined, t);
    t += PACE[id] * 1000 * (id === 'read' ? 6 : 3);
    finish(s, id, 'done', { note: doneNote(id) }, t);
  }
  s.proof = proofOf(copyShot(bp));
  s.readyAt = new Date(t).toISOString();
  s.approvedAt = new Date(t + 120_000).toISOString();
  s.qualityAt = s.approvedAt;
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, scan: { status: 'done', at: readAt, summary: DEMO_SUMMARY }, setup: s });
  // The first idea became SK-143, which waits for the next release.
  const o = demoOverview(readAt, { by: user, at: s.approvedAt });
  writeOverview(bp, { ...o, ideas: o.ideas.map((i, n) => (n === 0 ? { ...i, ticket: 'SK-143' } : i)) });
}

/** The sample project at its first open: nothing read yet, the setup about to start. */
export function seedFreshSetup(bp: BoardPaths): void {
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, map: [], scan: { status: 'pending' }, setup: newSetup('repo', Date.now() - 1200) });
  fs.rmSync(path.join(bp.knowledgeDir, 'overview.md'), { force: true });
}

function doneNote(id: SetupStepId): string {
  switch (id) {
    case 'tool':
      return 'The squad works with it';
    case 'read':
      return `Read the project: ${DEMO_FILES} files`;
    case 'commands':
      return 'Found how to run the tests and start the app';
    case 'tests':
      return 'Ran your tests: 18 pass';
    case 'app':
      return 'Opened the app';
    case 'overview':
      return 'What squad-kit understood, for you to check';
    default:
      return 'A .squad folder in your project. Your code is not changed.';
  }
}

function proofOf(shot: string | undefined): SetupState['proof'] {
  return {
    files: DEMO_FILES,
    read: DEMO_FILES,
    branch: 'main',
    unsaved: 0,
    tests: [{ ok: true, command: 'npm test', passed: 18, seconds: 41 }],
    app: { ok: true, url: 'http://localhost:4200', command: 'npm start', ...(shot ? { shot } : {}) },
  };
}

/** The read is in: the overview, the map and the proposed rules, as the live squad writes them. */
function readDone(bp: BoardPaths, meta: BoardMeta): void {
  const at = now();
  meta.scan = { status: 'done', at, summary: DEMO_SUMMARY };
  meta.map = [
    { area: 'Front end', detail: 'Angular 17 with Angular Material, in web/' },
    { area: 'Back end', detail: '.NET 8 API, in api/' },
    { area: 'Database', detail: 'SQL Server, migrations in api/Migrations/' },
    { area: 'Tests', detail: 'Jest for logic, Playwright for screens' },
  ];
  meta.commands = { setup: 'npm install', test: 'npm test', start: 'npm start', url: 'http://localhost:4200', ...meta.commands };
  const before = readOverview(bp);
  writeOverview(bp, { ...demoOverview(at), ...(before.ideas.some((i) => i.ticket) ? { ideas: before.ideas } : {}) });
  const known = listDecisions(bp);
  for (const f of FOUND) {
    if (known.some((d) => d.title === f.title)) continue;
    const d: Decision = { id: nextDecisionId(bp), title: f.title, why: f.why, options: [f.title], chosen: f.title, from: 'Project scan', approvedBy: '', proposed: true, date: at, checkedBy: null, tickets: [] };
    writeDecision(bp, d);
  }
}

/** What a step says while it runs on the sample board. */
const START_NOTE: Partial<Record<SetupStepId, string>> = {
  read: 'Starting…',
  commands: 'Installing what it needs',
  tests: 'Running the tests',
  app: 'Starting the app',
};

/** One turn of the sample setup: the step on now moves on with its time; the next one starts when it ends. */
export function playDemoSetup(bp: BoardPaths, meta: BoardMeta, at = Date.now()): void {
  playDemoTalk(bp, meta, at);
  const s = meta.setup;
  if (!s || s.approvedAt) return;
  const cur = currentStep(s);
  if (!cur || cur.state === 'stopped' || cur.state === 'failed') return;
  if (s.stopping) {
    if (cur.state === 'now') finish(s, cur.id, 'stopped', { note: 'You stopped it.' }, at);
    else Object.assign(cur, { state: 'stopped', note: 'You stopped it.' });
    delete s.stopping;
    if (cur.id === 'read') meta.scan = { status: 'failed', at: now(), error: 'You stopped it. Press Start again when you are ready.' };
    writeMeta(bp, meta);
    return;
  }
  if (cur.state === 'todo') {
    if (cur.id === 'read') {
      meta.scan = { status: 'running', at: now() };
      s.proof = { files: DEMO_FILES, read: 0, branch: 'main', unsaved: 0 };
      s.reads = [];
    }
    begin(s, cur.id, START_NOTE[cur.id], at);
    writeMeta(bp, meta);
    return;
  }
  const took = (at - Date.parse(cur.since ?? new Date(at).toISOString())) / 1000;
  const need = PACE[cur.id] / (meta.speed || 1);
  if (took < need) {
    if (cur.id === 'read') {
      const i = Math.min(READS.length - 1, Math.floor((took / need) * READS.length));
      const opened = Math.round((took / need) * DEMO_FILES * 0.6);
      cur.note = `Reading the code · ${opened} files`;
      if (s.reads?.at(-1) !== READS[i]) s.reads = [...(s.reads ?? []), READS[i]!].slice(-8);
      s.proof = { ...s.proof, read: opened };
      meta.scan = { ...meta.scan!, status: 'running', now: 'Reading the code' };
      writeMeta(bp, meta);
    } else if (cur.id === 'app' && took >= need / 2 && cur.note?.startsWith('Starting')) {
      cur.note = 'Taking a screenshot';
      writeMeta(bp, meta);
    }
    return;
  }
  if (cur.id === 'read') {
    readDone(bp, meta);
    s.proof = { ...s.proof, read: DEMO_FILES };
  }
  if (cur.id === 'tests') s.proof = { ...s.proof, tests: proofOf(undefined)!.tests };
  if (cur.id === 'app') s.proof = { ...s.proof, app: proofOf(copyShot(bp))!.app };
  finish(s, cur.id, 'done', { note: doneNote(cur.id) }, at);
  if (cur.id === 'overview') s.readyAt = new Date(at).toISOString();
  writeMeta(bp, meta);
}

/** The sample Architect answers "Something is wrong" with short scripted lines. */
function playDemoTalk(bp: BoardPaths, meta: BoardMeta, at: number): void {
  const t = readTalk(bp);
  if (!t?.open) return;
  if (t.stopping) {
    writeTalk(bp, { ...t, thinking: false, stopping: undefined, messages: t.thinking ? [...t.messages, { who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' }] : t.messages });
    return;
  }
  if (!t.thinking) return;
  const last = t.messages.at(-1);
  if (last && at - Date.parse(last.at) < 2200 / (meta.speed || 1)) return;
  if (!last && at - Date.parse(meta.setup?.readyAt ?? new Date(0).toISOString()) < 0) return;
  const said = t.messages.filter((m) => m.who === 'you').length;
  const text =
    said === 0
      ? 'Thanks for checking. What did I get wrong: who uses it, what it does, the picture of its parts, or one of the rules?'
      : said === 1
        ? 'I see. I will read the project again with that in mind and change the overview and the rules to match. Anything else before I do?'
        : 'Got it. Press **Read it again with this** and I will read the project again with what you said.';
  writeTalk(bp, { ...t, thinking: false, messages: [...t.messages, { who: 'architect', text, at: now(), ...(said === 0 ? { options: ['Who uses it', 'What it can do', 'One of the rules'] } : {}) }] });
}
