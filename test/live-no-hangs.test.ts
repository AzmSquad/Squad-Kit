import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser } from './fakes/browser.js';
import { tinyApp } from './support/tiny-app.js';
import { callTool, savedFiles } from './support/window.js';

/**
 * No silent hangs in the live squad (E1): a ticket waiting for a free place says so, Stop during the checks ends
 * them at once, the Builder never waits for the "before" screenshots, and a restart waits for runs to end.
 * Every agent run here is a fake that the test answers.
 */

const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

type Run = { opts: RunOptions; page?: string; end(r?: Partial<RunResult>): void };
const runs: Run[] = [];
let answer: ((opts: RunOptions) => Partial<RunResult> | null) | null = null;

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      let over = false;
      const run: Run = {
        opts,
        end: (r = {}) => {
          if (over) return;
          over = true;
          resolve({ ok: false, sessionId: opts.sessionId ?? opts.resume ?? '', text: '', error: 'Ended by the test.', ...r });
        },
      };
      const page = path.join(opts.cwd, 'page.txt');
      if (fs.existsSync(page)) run.page = fs.readFileSync(page, 'utf8');
      runs.push(run);
      opts.signal?.addEventListener('abort', () => run.end({ error: 'You stopped the squad.' }));
      const now = answer?.(opts);
      if (now) run.end(now);
    }),
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket, stopTicket } = await import('../src/board/actions.js');
const { LiveSquad, queuedText } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { addWorktree, worktreeRoot } = await import('../src/engine/git.js');
const { runCommand } = await import('../src/engine/checks.js');
const { endRuns } = await import('../src/commands/console.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A live project with one commit (page.txt says "old"), its Architect done. */
function liveProject(name: string, commands: Record<string, string> = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'page.txt'), 'old');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'start'], { cwd: dir });
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands });
  return bp;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-live-hangs-')));
  fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), { force: true });
  runs.length = 0;
  answer = null;
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a ticket waiting for a free place', () => {
  it('says so and for whom, has nothing for the watchdog, and says what it did again once it starts', async () => {
    setParallelLimit(1);
    const bp = liveProject('queue');
    const first = createTicket(bp, { title: 'one' });
    const second = createTicket(bp, { title: 'two' });
    const said = second.status;
    const squad = new LiveSquad(bp);
    stops.push(squad.start(25));

    await until('one run', () => runs.length === 1);
    const [running] = squad.ticketIds();
    const waiting = running === first.id ? second.id : first.id;
    await until('the waiting line', () => readTicket(bp, waiting)!.status === 'Next in line: starts when a slot is free (1 of 1 busy)');
    expect(readTicket(bp, waiting)!.quiet).toBeUndefined();

    runs[0]!.end();
    await until('the second run', () => runs.length === 2);
    await sleep(100);
    expect(squad.ticketIds()).toEqual([waiting]);
    expect(readTicket(bp, waiting)!.status).toBe(waiting === second.id ? said : first.status);
  });

  it('reads plainly: next in line, with how many places are busy', () => {
    expect(queuedText(['AB-3'], 1)).toBe('Next in line: starts when a slot is free (1 of 1 busy)');
    expect(queuedText(['AB-3', 'AB-5'], 2)).toBe('Next in line: starts when a slot is free (2 of 2 busy)');
    expect(queuedText(['AB-3', 'AB-5', 'CD-1'], 3)).toBe('Next in line: starts when a slot is free (3 of 3 busy)');
  });
});

describe.skipIf(process.platform === 'win32')('Stop during the checks', () => {
  it('ends the running check at once and parks the ticket, without counting a failed try', async () => {
    const pidFile = path.join(tmp, 'check.pid');
    const bp = liveProject('checks', { test: `echo $$ > ${pidFile}; exec sleep 30`, lint: 'echo lint' });
    const t = createTicket(bp, { title: 'checked' });
    const wt = addWorktree(bp.root, t.id, 'main');
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.stage = 'test';
      x.squad = { phase: 'test', nextAt: new Date().toISOString() };
    });
    stops.push(new LiveSquad(bp).start(25));
    await until('the test command', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    const pressed = Date.now();
    stopTicket(bp, t.id);
    await until('the stopped card', () => Boolean(readTicket(bp, t.id)!.stuck));
    expect(Date.now() - pressed).toBeLessThan(5000);
    const after = readTicket(bp, t.id)!;
    expect(after.stuck!.question).toContain('You stopped the squad.');
    expect(after.tries ?? 0).toBe(0);
    expect(after.gates?.checks).toBe('pending');
    expect(after.activity.some((a) => a.text.startsWith('Checks failed'))).toBe(false);
    expect(alive(pid)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the "before" screenshots', () => {
  /** A ticket ready to build, with one screen to show, a tiny app, and squad-kit's browser faked. */
  async function readyToBuild() {
    const app = await tinyApp();
    h.browser = fakeBrowser({ '/': { has: ['text:ok'] } }).module;
    const bp = liveProject('shots', { start: app.start, url: app.url });
    const t = createTicket(bp, { title: 'Say new' });
    const wt = addWorktree(bp.root, t.id, 'main');
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.squad = null;
      x.criteria = [{ given: 'the page', when: 'it opens', then: 'it says new' }];
      x.steps = [{ title: 'Change the page', status: 'todo' }] as typeof x.steps;
      x.work = { steps: 1, tests: 0, screens: 1 };
    });
    return { bp, t: readTicket(bp, t.id)!, wt };
  }
  const snapshotOf = (bp: { root: string }, id: string) => path.join(worktreeRoot(bp.root), `${id.toLowerCase()}-before`);
  type Squad = { build(id: string): Promise<void>; beforeShotsOf: Map<string, Promise<void>> };

  it('run beside the build, from a copy of the code as it was, and the copy goes after', async () => {
    const { bp, t, wt } = await readyToBuild();
    // The Builder changes the ticket's copy and finishes at once; the Tester waits for the test.
    answer = (opts) => {
      if (opts.cwd !== wt.dir) return null;
      fs.writeFileSync(path.join(wt.dir, 'page.txt'), 'new');
      return { ok: true, structured: { summary: 'Done' } };
    };
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.build(t.id);
    // The Builder is done, and the before-shots still run.
    const built = readTicket(bp, t.id)!;
    expect(built.stage).toBe('test');
    expect(built.activity.some((a) => a.text === 'Started building')).toBe(true);
    expect(squad.beforeShotsOf.has(t.id)).toBe(true);

    await until('the Tester', () => runs.some((r) => r.opts.cwd !== wt.dir));
    const tester = runs.find((r) => r.opts.cwd !== wt.dir)!;
    expect(tester.opts.cwd).toBe(snapshotOf(bp, t.id));
    expect(tester.page).toBe('old');
    expect(fs.readFileSync(path.join(wt.dir, 'page.txt'), 'utf8')).toBe('new');

    // The Tester takes the picture with squad-kit's own tools, over the run's window.
    const [file] = savedFiles(await callTool(tester.opts.window!, 'take_screenshots', { shots: [{ page: '/' }] }));
    expect(file).toBe(`${t.id.toLowerCase()}-before-1.png`);
    tester.end({ ok: true, structured: { shots: [{ criterion: 1, file, shows: 'not-shown', note: 'The page as it was.' }], offScreen: [] } });
    await squad.beforeShotsOf.get(t.id);
    expect(readTicket(bp, t.id)!.proof).toEqual([expect.objectContaining({ criterion: 'It says new', before: file })]);
    expect(fs.existsSync(snapshotOf(bp, t.id))).toBe(false);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: bp.root, encoding: 'utf8' })).not.toContain('-before');
  }, 20_000);

  it('say so when they could not be taken', async () => {
    const { bp, t, wt } = await readyToBuild();
    answer = (opts) => (opts.cwd === wt.dir ? { ok: true, structured: { summary: 'Done' } } : { ok: false, error: 'No browser here.' });
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.build(t.id);
    await squad.beforeShotsOf.get(t.id);
    const lines = readTicket(bp, t.id)!.activity.map((a) => a.text);
    expect(lines).toContain('Could not take the before screenshots, so the proof shows the screens after the change only');
    // The tool's own words are for engineers, never the activity.
    expect(lines.join('\n')).not.toContain('No browser here.');
    expect(fs.existsSync(snapshotOf(bp, t.id))).toBe(false);
  }, 20_000);

  it('end on Stop, quietly, and the copy goes', async () => {
    const { bp, t, wt } = await readyToBuild();
    answer = (opts) => (opts.cwd === wt.dir ? { ok: true, structured: { summary: 'Done' } } : null);
    const squad = new LiveSquad(bp) as unknown as Squad & { stops: Map<string, AbortController> };
    await squad.build(t.id);
    await until('the Tester', () => runs.some((r) => r.opts.cwd !== wt.dir));
    // What the board does when you press Stop, whichever step of the ticket runs then.
    const pressed = Date.now();
    squad.stops.get(`__before:${t.id}`)!.abort();
    await squad.beforeShotsOf.get(t.id);
    expect(Date.now() - pressed).toBeLessThan(3000);
    expect(readTicket(bp, t.id)!.activity.some((a) => a.text.startsWith('Could not take the before screenshots'))).toBe(false);
    expect(fs.existsSync(snapshotOf(bp, t.id))).toBe(false);
  }, 20_000);
});

describe.skipIf(process.platform === 'win32')('a restart', () => {
  it('waits for what runs to end, and ends what is left after its limit', async () => {
    void runCommand(tmp, 'sleep 0.6', 20_000);
    let started = Date.now();
    expect(await endRuns(5000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);

    const stuck = runCommand(tmp, "trap '' TERM; sleep 30", 60_000);
    started = Date.now();
    expect(await endRuns(300)).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await stuck).ok).toBe(false);
  });
});
