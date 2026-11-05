import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser } from './fakes/browser.js';

/**
 * The first run on the live engine, end to end, with the AI tool faked at its boundary (Claude Code run directly):
 * Add makes the project files and the setup, the Architect's read hands in the overview, squad-kit installs, runs the
 * tests and opens the app once in its own copy, squad-kit takes the screenshot with its own browser (no agent: the
 * browser here is a fake), and the overview waits. The rules the
 * read found stay proposed until the person approves; a ticket idea becomes the first ticket. A failing test run never
 * blocks the setup, and an answer in the older shape still loads.
 */

const runs: RunOptions[] = [];
let scanAnswers: unknown[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    const ok = (structured: unknown): RunResult => ({ ok: true, sessionId: opts.sessionId ?? opts.resume ?? 's', text: '', structured });
    if (opts.prompt.includes('reading this project for the first time') || opts.prompt.includes('did not get a complete answer')) return ok(scanAnswers.shift());
    if (opts.prompt.includes('Something is wrong')) return ok({ reply: 'What did I get wrong?', ready: false });
    return ok({ summary: 'Clear', questions: [] });
  },
}));

const { boardPaths, listDecisions, listTickets, readMeta, writeMeta } = await import('../src/board/store.js');
const { prepareProject } = await import('../src/engine/setup.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { approveOverview, overviewView, setupView, ticketFromIdea } = await import('../src/board/first-run.js');
const { readOverview } = await import('../src/board/overview.js');
const { setupCopyDir } = await import('../src/engine/onboard.js');
const { reposOf } = await import('../src/engine/repos.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'ignore' });

async function until(what: string, check: () => boolean, tries = 1500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A small app with code in git: what a project manager would add. */
function roomflow(): string {
  const dir = path.join(tmp, 'roomflow');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), 'require("http").createServer((q, s) => s.end("ok")).listen(process.env.PORT || 0);\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Rooms</h1>\n');
  fs.writeFileSync(path.join(dir, 'tests', 'rooms.test.js'), 'console.log("ok");\n');
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', dir);
  return dir;
}

function answer(commands: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    empty: false,
    summary: 'A small web app for booking meeting rooms.',
    map: [{ area: 'Server', detail: 'Node, in server.js' }],
    decisions: [
      { title: 'Node.js with no framework', why: 'server.js uses the http module' },
      { title: 'Plain HTML pages', why: 'index.html has no framework' },
    ],
    commands,
    users: 'Office staff who book rooms.',
    can: ['Book a room', 'See the day per room'],
    worth: ['The login checks no password.'],
    ideas: [
      { title: 'Check a real password at login', why: 'Anyone can open the booking page.' },
      { title: 'Let people change a booking', why: 'A booking can only be cancelled.' },
      { title: 'Add browser tests', why: 'No test opens the pages.' },
    ],
    parts: [
      { id: 'staff', name: 'Staff', what: 'In a web browser', files: [], kind: 'people' },
      { id: 'pages', name: 'Pages', what: 'The booking page', files: ['index.html'], kind: 'screens' },
      { id: 'server', name: 'Server', what: 'Rooms and bookings', files: ['server.js'], kind: 'server' },
      { id: 'tests', name: 'Tests', what: 'One file', files: ['tests/'], kind: 'tests' },
    ],
    links: [
      { from: 'staff', to: 'pages', label: 'uses' },
      { from: 'pages', to: 'server', label: 'calls' },
      { from: 'tests', to: 'server', label: 'checks' },
    ],
    ...extra,
  };
}

/** Add project, the way the app and `squad console` do it, with the AI tool run directly (the fake one). */
function add(dir: string) {
  const ready = prepareProject(dir);
  writeMeta(ready.bp, { ...readMeta(ready.bp), runner: 'direct' });
  return ready;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-first-run-')));
  runs.length = 0;
  scanAnswers = [];
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the first run on the live engine', () => {
  it('goes Add, setup, Overview, approve, first ticket: every step with its time, the rules proposed until approved', async () => {
    const dir = roomflow();
    const port = await freePort();
    const commands = {
      setup: 'node -e "require(\'fs\').writeFileSync(\'installed.txt\', \'yes\')"',
      test: 'node -e "console.log(\'Tests: 3 passed\')"',
      start: `node -e "require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"`,
      url: `http://127.0.0.1:${port}`,
    };
    scanAnswers = [answer(commands)];
    const { bp, did } = add(dir);
    expect(did.length).toBeGreaterThan(0);

    // Add made the project files and started the setup: the first step done, the rest to do.
    const first = setupView(bp)!;
    expect(first.kind).toBe('repo');
    expect(first.steps.map((s) => [s.id, s.state])).toEqual([
      ['files', 'done'],
      ['tool', 'todo'],
      ['read', 'todo'],
      ['commands', 'todo'],
      ['tests', 'todo'],
      ['app', 'todo'],
      ['overview', 'todo'],
    ]);
    expect(first.steps[0]!.seconds).toBeGreaterThanOrEqual(1);
    expect(first.steps.every((s) => s.usual.startsWith('usually '))).toBe(true);

    const browser = fakeBrowser({ '/': { has: ['text:RoomFlow'] } });
    h.browser = browser.module;
    stops.push(new LiveSquad(bp).start(25));
    await until('the overview to be ready', () => Boolean(setupView(bp)?.ready), 3000);
    const v = setupView(bp)!;
    expect(v.steps.find((s) => s.id === 'tool')!.state).not.toBe('todo');
    for (const id of ['read', 'commands', 'tests', 'app', 'overview']) expect(v.steps.find((s) => s.id === id)!.state).toBe('done');
    expect(v.steps.find((s) => s.id === 'read')!.label).toBe('The Architect read your code');
    expect(v.steps.find((s) => s.id === 'commands')!.note).toBe('Found how to run the tests and start the app');
    expect(v.steps.find((s) => s.id === 'tests')!.note).toBe('Ran your tests: 3 pass');
    expect(v.steps.find((s) => s.id === 'app')!.note).toBe('Opened the app');
    expect(v.steps.every((s) => typeof s.seconds === 'number')).toBe(true);

    // squad-kit's own copy got the install; the person's folder did not.
    expect(fs.existsSync(path.join(dir, 'installed.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(setupCopyDir(bp, reposOf(readMeta(bp))[0]!), 'installed.txt'), 'utf8')).toBe('yes');
    // squad-kit's own screenshot is in the proof folder, where the board shows proof.
    expect(fs.existsSync(path.join(bp.proofDir, 'setup-app.png'))).toBe(true);
    expect(browser.log).toEqual(['goto /']);
    // One read by the Architect, and no agent for the screenshot: nothing else ran.
    expect(runs.map((r) => (r.prompt.includes('screenshot') ? 'shot' : r.prompt.includes('reading this project') ? 'scan' : 'other'))).toEqual(['scan']);

    // What the read found: the overview in .squad/knowledge, the rules as proposals, not approved by anyone.
    const o = readOverview(bp);
    expect(o).toMatchObject({ users: 'Office staff who book rooms.', can: ['Book a room', 'See the day per room'], worth: ['The login checks no password.'] });
    expect(o.ideas.map((i) => i.title)).toEqual(['Check a real password at login', 'Let people change a booking', 'Add browser tests']);
    expect(o.links).toHaveLength(3);
    const found = listDecisions(bp);
    expect(found.map((d) => [d.id, d.proposed, d.approvedBy])).toEqual(
      expect.arrayContaining([
        ['STACK.1', true, ''],
        ['STACK.2', true, ''],
      ]),
    );
    // Agents see them as how the code is today, not as approved rules.
    const ctx = P.buildPrompt(readMeta(bp), found, { id: 'RF-1', title: 'x', ask: 'x', kind: 'feature', activity: [] } as never);
    expect(ctx).toContain('Saved decisions every ticket must follow:\n- (none yet)');
    expect(ctx).toContain('not approved by the person yet');

    const ov = overviewView(bp);
    expect(ov).toMatchObject({ handover: 'ready', proposed: 2, summary: 'A small web app for booking meeting rooms.', old: false });
    expect(ov.proof?.tests?.[0]).toMatchObject({ ok: true, passed: 3 });
    expect(ov.proof?.app).toMatchObject({ ok: true, shot: 'setup-app.png' });
    expect(ov.proof?.branch).toBe('main');

    // Looks right, start working: the rules are approved by the person, the copy goes.
    const done = approveOverview(bp);
    expect(done.handover).toBe('approved');
    expect(done.approved?.by).toBe(readMeta(bp).user.name);
    expect(listDecisions(bp).every((d) => !d.proposed && d.approvedBy === readMeta(bp).user.name)).toBe(true);
    expect(setupView(bp)!.approved).toBe(true);
    expect(fs.existsSync(setupCopyDir(bp, reposOf(readMeta(bp))[0]!))).toBe(false);

    // A ticket idea becomes the first ticket with one click, and the same click again gives the same ticket.
    const t = ticketFromIdea(bp, 1);
    expect(t.title).toBe('Check a real password at login');
    expect(ticketFromIdea(bp, 1).id).toBe(t.id);
    expect(listTickets(bp)).toHaveLength(1);
    expect(readOverview(bp).ideas[0]!.ticket).toBe(t.id);
  }, 60_000);

  it('never blocks on failing tests or an app that does not open: each says so, with a way out, and the overview still comes', async () => {
    const dir = roomflow();
    scanAnswers = [answer({ test: 'node -e "console.error(\'2 failing\'); process.exit(1)"', start: 'node -e "process.exit(3)"', url: 'http://127.0.0.1:9' })];
    const { bp } = add(dir);
    const browser = fakeBrowser({ '/': { has: ['text:RoomFlow'] } });
    h.browser = browser.module;
    stops.push(new LiveSquad(bp).start(25));
    await until('the overview to be ready', () => Boolean(setupView(bp)?.ready), 3000);
    const v = setupView(bp)!;
    const tests = v.steps.find((s) => s.id === 'tests')!;
    expect(tests.state).toBe('failed');
    expect(tests.output).toContain('2 failing');
    expect(tests.ways.map((w) => w.label)).toEqual(['Try again', 'See what failed']);
    expect(tests.ways[0]).toMatchObject({ do: 'again', step: 'tests', command: 'squad setup --again tests' });
    const app = v.steps.find((s) => s.id === 'app')!;
    expect(app.state).toBe('failed');
    // One plain sentence for the person; what the app printed is behind See what failed.
    expect(app.error).toBe('squad-kit could not start the app in its own copy. The setup goes on: this does not stop you.');
    expect(app.output).toContain('The app stopped while starting');
    expect(app.ways.map((w) => w.label)).toEqual(['Try again', 'See what failed', 'Set how it starts']);
    expect(v.steps.find((s) => s.id === 'overview')!.state).toBe('done');
    expect(overviewView(bp).handover).toBe('ready');
  }, 60_000);

  it('asks once more for an answer in the older shape, then keeps what fits', async () => {
    const dir = roomflow();
    const old = { empty: false, summary: 'An app.', map: [{ area: 'Server', detail: 'server.js' }], decisions: [{ title: 'Node.js', why: 'server.js' }], commands: {} };
    scanAnswers = [old, old];
    const { bp } = add(dir);
    const browser = fakeBrowser({ '/': { has: ['text:RoomFlow'] } });
    h.browser = browser.module;
    stops.push(new LiveSquad(bp).start(25));
    await until('the overview to be ready', () => Boolean(setupView(bp)?.ready), 3000);
    expect(runs.filter((r) => r.prompt.includes('did not get a complete answer from you (users is missing)'))).toHaveLength(1);
    expect(readMeta(bp).scan).toMatchObject({ status: 'done', summary: 'An app.' });
    expect(readOverview(bp)).toMatchObject({ can: [], ideas: [], parts: [] });
    // Nothing to run: the steps say so instead of failing.
    expect(setupView(bp)!.steps.find((s) => s.id === 'tests')).toMatchObject({ state: 'skipped', note: 'No tests found. Your first ticket can add some.' });
    expect(setupView(bp)!.steps.find((s) => s.id === 'app')).toMatchObject({ state: 'skipped', ways: [{ do: 'settings', label: 'Set how it starts' }] });
  }, 60_000);

  it('skips the tries for an empty folder, and offers no ideas before the person said what they want', async () => {
    const dir = path.join(tmp, 'new-idea');
    fs.mkdirSync(dir);
    scanAnswers = [{ empty: true, summary: 'An empty folder for a new project.', map: [], decisions: [], commands: {}, ideas: [{ title: 'Start with the booking page', why: 'It is the heart of it.' }] }];
    const { bp } = add(dir);
    expect(setupView(bp)!.kind).toBe('empty');
    const browser = fakeBrowser({ '/': { has: ['text:RoomFlow'] } });
    h.browser = browser.module;
    stops.push(new LiveSquad(bp).start(25));
    await until('the overview to be ready', () => Boolean(setupView(bp)?.ready), 3000);
    const v = setupView(bp)!;
    for (const id of ['commands', 'tests', 'app']) expect(v.steps.find((s) => s.id === id)).toMatchObject({ state: 'skipped', note: 'Nothing to run yet: the project has no code' });
    expect(overviewView(bp)).toMatchObject({ empty: true, ideas: [] });
  }, 60_000);
});
