import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { DRAG_TITLE, playwrightScript, quickNpx, runsIn } from './support/fake-playwright.js';

/**
 * An old test the story did not cause does not send it back to the Builder. A failed test in a file the story did not
 * change runs on its own on main's code, in the Tester's "before" copy: failing there too, it is old, the story goes on
 * with the gate saying so, and one new story fixes the test. Passing there, the story's change broke it, and the Builder
 * fixes it, told so. A real git project here, with a stand-in for Playwright; the AI tool is a fake that answers at once.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { worktreeRoot } = await import('../src/engine/git.js');
const { prDescription } = await import('../src/engine/review-record/pr-description.js');
const { oldLine } = await import('../src/engine/old-tests.js');
const P = await import('../src/engine/prompts.js');
const { checksWords, oldFailuresWhy, proofLead } = await import('../console-ui/src/lib/gates.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths, chooseProject } = await import('../src/core/paths.js');
const { runStartTicket } = await import('../src/commands/board.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = { checks(id: string): Promise<void> };

const SETUP = 'mkdir -p node_modules/.bin && cp tools/playwright node_modules/.bin/playwright && chmod +x node_modules/.bin/playwright';
const TEST = 'npx playwright test';

let tmp: string;
let root: string;
let wt: string;
let base: string;
let log: string;
let bp: ReturnType<typeof boardPaths>;
let putBack = () => {};

beforeAll(() => (putBack = quickNpx(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-npx-')))));
afterAll(() => putBack());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

/** A project whose main has the drag on the shelves screen as `shelves` says, and the story's copy of it, set up. */
function project(shelves: 'broken' | 'fine', setup = SETUP): void {
  write(root, 'src/shelves.txt', `${shelves}\n`);
  write(root, 'src/hours.txt', 'nine to five\n');
  write(root, 'tests/e2e/shelves.spec.ts', '// the drag test\n');
  write(root, 'tests/e2e/hours.spec.ts', '// the hours test\n');
  write(root, '.gitignore', 'node_modules/\n.squad/\n');
  write(root, 'tools/playwright', playwrightScript(log));
  fs.chmodSync(path.join(root, 'tools/playwright'), 0o755);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the shop');
  base = git(root, 'rev-parse', 'HEAD');
  wt = path.join(tmp, 'copy');
  git(root, 'worktree', 'add', '-q', '-b', 'squad/story', wt, base);
  execFileSync('/bin/sh', ['-c', SETUP], { cwd: wt });
  writeMeta(bp, { ...readMeta(bp), commands: { test: TEST, setup } });
}

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-old-tests-')));
  root = path.join(tmp, 'shop');
  fs.mkdirSync(root);
  log = path.join(tmp, 'runs.log');
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const squad = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);
const bugs = () => listTickets(bp).filter((t) => t.kind === 'bug');
const lines = (id: string) => get(id).activity.map((a) => a.text);
const onMain = (id: string) => runsIn(log).filter((r) => r.startsWith(`${id.toLowerCase()}-before `));
const mainCopy = (id: string) => path.join(worktreeRoot(root), `${id.toLowerCase()}-before`);

/** A story the Builder finished in its copy: it changed the hours screen. */
function built(title = 'Show opening hours'): Ticket {
  write(wt, 'src/hours.txt', 'eight to six\n');
  const t0 = actions.createTicket(bp, { title, ask: 'Show when the shop is open.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'test';
    x.live = true;
    x.waiting = null;
    x.squad = null;
    x.worktree = wt;
    x.baseCommit = base;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.story = 'As a shopper, I want to see the opening hours.';
    x.criteria = [{ given: 'the home page', when: 'I open it', then: 'I see the hours' }];
    x.steps = [{ title: 'Show the hours', status: 'done' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
  });
}

describe('an old test that fails on main too', () => {
  it('the story goes on to review: no try, no Builder, the gate says so, and one new story fixes the test', async () => {
    project('broken');
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    // All 70 in the story's copy, the failed one on its own there, then once on main's code, where it failed too.
    expect(runsIn(log)).toEqual(['copy test', 'copy test tests/e2e/shelves\\.spec\\.ts:387', `${t0.id.toLowerCase()}-before test tests/e2e/shelves\\.spec\\.ts:387`]);
    expect(builds()).toHaveLength(0);
    expect(t.tries ?? 0).toBe(0);
    expect(t.fails ?? 0).toBe(0);
    expect(t.stage).toBe('review');
    expect(t.squad?.phase).toBe('review');
    const [bug] = bugs();
    expect(bugs()).toHaveLength(1);
    expect(t.gates).toMatchObject({
      checks: 'pass',
      checksText: '69 tests pass, test OK; 1 old test also fails on main',
      oldFailures: [{ title: DRAG_TITLE, file: 'tests/e2e/shelves.spec.ts', story: bug!.id }],
    });
    expect(lines(t0.id)).toContain(`An old test fails on main too, without this story's change: ${DRAG_TITLE}. It is not this story's, so the work goes on. squad-kit made ${bug!.id} for it; it waits on the board until you start it.`);
    // The new story: a bug, in plain words, with what the Analyst needs.
    expect(bug).toMatchObject({ kind: 'bug', title: `Fix an old test that fails: ${DRAG_TITLE}`, oldTests: ['tests/e2e/shelves.spec.ts::Putting shelves in order › laptop: a mouse drag changes the order'] });
    expect(bug!.ask).toContain(`squad-kit found it while checking ${t0.id} (Show opening hours)`);
    expect(bug!.ask).toContain('on main, without any story');
    expect(bug!.ask).toContain('File: tests/e2e/shelves.spec.ts, line 387');
    expect(bug!.ask).toContain('Received: "Bread"');
    expect(bug!.activity[0]).toMatchObject({ who: 'squad', text: `squad-kit made this story while checking ${t0.id}: a test fails on main without its change. It waits here until you start it` });
    // Kept with the project, so a teammate's board knows it too.
    expect(fs.readFileSync(path.join(bp.ticketsDir, bug!.id, 'ticket.md'), 'utf8')).toContain('oldTests:');
    // The copy of main is gone.
    expect(fs.existsSync(mainCopy(t0.id))).toBe(false);
  });

  it('the proof, the release, the pull request and the Reviewer say it plainly', async () => {
    project('broken');
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    const id = bugs()[0]!.id;
    expect(checksWords(t.gates)).toBe('69 tests pass, test OK; 1 old test also fails on main');
    expect(proofLead(t.gates)).toBe('Every gate is green for this story\'s change. 1 old test also fails on main, without it. Compare the screens before and after each "done when".');
    expect(oldFailuresWhy(t.gates)).toBe(`This test fails on main too, without this story's change, so it is not this story's: ${DRAG_TITLE}. ${id} fixes it.`);
    expect(prDescription(t, null, [])).toContain(`  - Fails on main too, without this change: ${DRAG_TITLE} (tests/e2e/shelves.spec.ts); ${id} fixes it`);
    expect(P.reviewPrompt(readMeta(bp), [], t, 1)).toContain('Some tests failed here that fail on main\'s code too, without this change');
  });

  it('never a second story for the same test while one is open; and the same main is not asked twice', async () => {
    project('broken');
    const t0 = built();
    await squad().checks(t0.id);
    const id = bugs()[0]!.id;
    // A second story with the same old test: it goes on too, and names the story already open.
    const t1 = built('Show the address');
    await squad().checks(t1.id);
    expect(bugs()).toHaveLength(1);
    expect(get(t1.id).gates?.oldFailures).toEqual([{ title: DRAG_TITLE, file: 'tests/e2e/shelves.spec.ts', story: id }]);
    expect(lines(t1.id)).toContain(oldLine([{ title: DRAG_TITLE, file: 'tests/e2e/shelves.spec.ts', story: id }], true, [id]));
    // The first story's checks run again (after a review, say): main's code is not run again, and nothing is said twice.
    const before = onMain(t0.id).length;
    await squad().checks(t0.id);
    expect(onMain(t0.id)).toHaveLength(before);
    expect(get(t0.id).stage).toBe('review');
    expect(lines(t0.id).filter((l) => l.startsWith('An old test fails on main too'))).toHaveLength(1);
    // Once that story is done, the test may get a new one.
    updateTicket(bp, id, (x) => (x.stage = 'done'));
    const t2 = built('Show the phone number');
    await squad().checks(t2.id);
    expect(bugs()).toHaveLength(2);
  });
});

describe('the new story waits on the board', () => {
  it('no Analyst runs for it, nothing is spent, until the person presses Start', async () => {
    project('broken');
    const t0 = built();
    const s = new LiveSquad(bp) as unknown as Squad & { tick(): void; running: { has(key: string): boolean } };
    await s.checks(t0.id);
    const bug = bugs()[0]!;
    expect(bug).toMatchObject({ waitsToStart: true, live: false, status: 'Waits for you to start it', waiting: null });
    expect(bug.squad ?? null).toBeNull();
    // The squad looks at the board: the story it made is not picked up, and no run of any role starts for it.
    updateTicket(bp, t0.id, (x) => (x.squad = null));
    const before = calls.length;
    s.tick();
    await new Promise((r) => setTimeout(r, 300));
    s.tick();
    expect(s.running.has(bug.id)).toBe(false);
    expect(calls.length).toBe(before);
    expect(get(bug.id).squad ?? null).toBeNull();
    // Start: the Analyst reads it, as on any new story. A story that does not wait cannot be started this way.
    const started = actions.startTicket(bp, bug.id);
    expect(started).toMatchObject({ live: true, squad: { phase: 'analyst-read' } });
    expect(started.waitsToStart).toBeUndefined();
    expect(started.activity[0]).toMatchObject({ who: 'you', text: 'Started it' });
    expect(() => actions.startTicket(bp, bug.id)).toThrow('does not wait to be started');
    // Once it is started, the next story's line no longer says it waits.
    expect(oldLine([{ title: DRAG_TITLE, file: 'tests/e2e/shelves.spec.ts', story: bug.id }], true, [])).toBe(`An old test fails on main too, without this story's change: ${DRAG_TITLE}. It is not this story's, so the work goes on. squad-kit made ${bug.id} for it.`);
  });
});

describe('Start', () => {
  it('is one REST call and one terminal command', async () => {
    const waits = () => actions.createTicket(bp, { title: 'Fix an old test that fails: a drag', kind: 'bug', waitsToStart: true, bySquad: 'squad-kit made this story' });
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(root) });
    const one = waits();
    expect((await a.request(`/api/v1/tickets/${one.id}/start`, { method: 'POST' })).status).toBe(200);
    expect(get(one.id)).toMatchObject({ live: true, squad: { phase: 'analyst-read' } });
    // A story that does not wait has nothing to start: a plain refusal.
    expect((await a.request(`/api/v1/tickets/${one.id}/start`, { method: 'POST' })).status).toBe(400);
    chooseProject(root);
    const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    try {
      const two = waits();
      await runStartTicket(two.id);
      expect(get(two.id).waitsToStart).toBeUndefined();
      expect(get(two.id).squad?.phase).toBe('analyst-read');
    } finally {
      for (const q of quiet) q.mockRestore();
    }
  });
});

describe('the usual way', () => {
  it('a failed test that passes on main every time: the story broke it, so the Builder fixes it, told so', async () => {
    project('fine');
    // The story's change broke the drag, in the screen's code, not in its test.
    write(wt, 'src/shelves.txt', 'broken\n');
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(onMain(t0.id)).toHaveLength(3);
    expect(bugs()).toHaveLength(0);
    expect(t.tries).toBe(1);
    expect(t.gates?.checks).toBe('fail');
    expect(t.gates?.oldFailures).toBeUndefined();
    expect(builds()).toHaveLength(1);
    const prompt = builds()[0]!.prompt!;
    expect(prompt).toContain("These pass there every time, so this story's change probably broke them: fix the code, not the tests.");
    expect(prompt).toContain(`<data>\n${DRAG_TITLE}\n</data>`);
    expect(prompt).toContain('While you fix a failing test, run only that test: run_checks with "only" and its file. squad-kit runs all the checks again when you finish.');
    expect(fs.existsSync(mainCopy(t0.id))).toBe(false);
  });

  it('the story made to fix an old test never goes past that test: its Builder fixes it', async () => {
    project('broken');
    const t0 = built();
    await squad().checks(t0.id);
    const bug = bugs()[0]!;
    // The squad builds the new story in the same copy of the code, and the test still fails.
    updateTicket(bp, bug.id, (x) => {
      x.stage = 'test';
      x.worktree = wt;
      x.baseCommit = base;
      x.sessions = { intake: 'i-2', build: 'b-2' };
      x.steps = [{ title: 'Fix the drag', status: 'done' }];
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    const asked = onMain(bug.id).length;
    await squad().checks(bug.id);
    expect(onMain(bug.id)).toHaveLength(asked);
    expect(get(bug.id).tries).toBe(1);
    expect(get(bug.id).gates?.checks).toBe('fail');
    expect(bugs()).toHaveLength(1);
  });

  it('a failed test in a file the story changed: the Builder, and main is never asked', async () => {
    project('broken');
    write(wt, 'tests/e2e/shelves.spec.ts', '// the drag test\n// and a new case\n');
    const t0 = built();
    await squad().checks(t0.id);
    expect(onMain(t0.id)).toHaveLength(0);
    expect(bugs()).toHaveLength(0);
    expect(get(t0.id).tries).toBe(1);
    expect(builds()).toHaveLength(1);
    expect(builds()[0]!.prompt).not.toContain('pass there every time');
  });

  it('a test tool squad-kit does not know, or a copy of main that cannot be set up: as before', async () => {
    project('broken', 'exit 3');
    const t0 = built();
    await squad().checks(t0.id);
    expect(onMain(t0.id)).toHaveLength(0);
    expect(get(t0.id).tries).toBe(1);
    expect(bugs()).toHaveLength(0);
    expect(fs.existsSync(mainCopy(t0.id))).toBe(false);
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'echo "the booking test failed"; exit 1', setup: SETUP } });
    const t1 = built('Another');
    await squad().checks(t1.id);
    expect(get(t1.id).tries).toBe(1);
    expect(bugs()).toHaveLength(0);
    expect(builds()).toHaveLength(2);
  });
});
