import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { Ticket } from '../src/board/types.js';
import { callTool, textOf } from './support/window.js';

/**
 * The story the owner watched: the Builder on its step "Write tests: …", its own run of the tests did not pass, it
 * fixed them, then the tests, the code check and the build passed. The card said "building the app" and "Taking longer
 * than usual" in amber. Now its words follow the real work, and the slow card says why, calmly. Real commands and real
 * git; the AI tool is a fake that presses squad-kit's own tools.
 */

const h = vi.hoisted(() => ({ during: null as ((opts: RunOptions) => Promise<void>) | null }));
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    await h.during?.(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const { liveNow } = await import('../src/board/now.js');
const { slowStep } = await import('../src/board/clock.js');
const { answerAsk } = await import('../src/board/ask.js');

type Squad = {
  runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void>;
  setQuiet(id: string, q: Ticket['quiet'] | null): void;
};

/** The tests fail the first time and pass after; the build takes a moment, so its line can be seen. */
const TEST = 'if [ -f .ran-once ]; then echo "Tests  3 passed"; else touch .ran-once; echo "  1 failed"; exit 1; fi';
const LINT = 'echo tidy';
const BUILD = 'sleep 1; echo built';

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (id: string) => readTicket(bp, id)!;

beforeEach(() => {
  h.during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-slow-why-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'rooms.txt'), 'two rooms\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ran-once\nnode_modules/\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'SW',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: TEST, lint: LINT, build: BUILD },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a slow step that was fine all along', () => {
  it('says "writing tests", then "fixing a failed test", never "building the app", and the slow card says why', async () => {
    const t0 = actions.createTicket(bp, { title: 'Rooms on a phone' });
    const wt = addWorktree(project, t0.id, 'main');
    const id = t0.id;
    updateTicket(bp, id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.stage = 'implement';
      x.live = true;
      x.squad = null;
      x.sessions = { build: 'b-1' };
      x.steps = [{ title: 'Write tests: the rooms list on a phone', status: 'todo' }];
    });
    const s = new LiveSquad(bp) as unknown as Squad;
    const seen: Record<string, unknown> = {};
    const doings = new Set<string>();
    h.during = async (opts) => {
      const edit = async () => {
        // The watcher takes one line each 700 ms.
        await sleep(750);
        opts.onTool?.({ name: 'Edit', input: { file_path: path.join(opts.cwd, 'rooms.test.js') } });
      };
      const call = async (args: object) => textOf(await callTool(opts.window!, 'run_checks', args));
      await edit();
      seen.writing = liveNow(get(id), {}).line;
      // Its own run of the tests did not pass.
      expect(await call({ which: 'test' })).toContain('test: failed');
      seen.failed = { doing: get(id).clock?.doing, status: get(id).status, failed: get(id).clock?.failed };
      await edit();
      seen.fixing = liveNow(get(id), {}).line;
      // Ten minutes on the step: the watchdog's look finds it taking longer than usual.
      updateTicket(bp, id, (x) => (x.clock!.since = new Date(Date.now() - 10 * 60_000).toISOString()));
      s.setQuiet(id, slowStep(get(id), {}));
      const slow = liveNow(get(id), {});
      seen.slow = { line: slow.line, card: slow.slow?.line, calm: slow.slow?.calm, text: slow.slow?.text, note: slow.slow?.note };
      seen.activity = get(id).activity[0]?.text;
      seen.ask = answerAsk(get(id), slow, {}, 'is it stuck?').lines[0];
      // Then it runs them all: the tests, the code check and the build pass.
      let ran = false;
      const all = call({}).finally(() => (ran = true));
      while (!ran) {
        doings.add(get(id).clock?.doing ?? '');
        await sleep(25);
      }
      expect(await all).toContain('build: passed');
      seen.passed = { doing: get(id).clock?.doing, failed: get(id).clock?.failed };
      const after = liveNow(get(id), {});
      seen.after = { line: after.line, text: after.slow?.text, note: after.slow?.note };
    };
    await s.runBuilder(id, 'Build it', true, 'build');

    expect(seen.writing).toBe('Builder · step 1 of 1 · writing tests');
    expect(seen.failed).toMatchObject({ doing: 'Fixing a failed test', status: 'Fixing a failed test', failed: { check: 'test', times: 1 } });
    expect(seen.fixing).toBe('Builder · step 1 of 1 · fixing a failed test');
    expect(seen.slow).toEqual({
      line: 'Builder · step 1 of 1 · fixing a failed test',
      card: 'Longer than usual · 10 min · still working',
      calm: true,
      text: 'The tests failed once, so the Builder is fixing them.',
      note: undefined,
    });
    expect(seen.activity).toBe('Taking longer than usual: the tests failed once, so the Builder is fixing them. Still working.');
    expect(seen.ask).toBe('It is taking longer than usual, but it is still working. The tests failed once, so the Builder is fixing them.');
    // While squad-kit built the app for the Builder, the line said it checks that the app builds.
    expect(doings).toContain('Checking that the app builds');
    expect(doings).not.toContain('Building the app');
    expect(seen.passed).toMatchObject({ doing: 'The build passed', failed: { check: 'test', times: 1, fixed: expect.any(String) } });
    expect(seen.after).toEqual({ line: 'Builder · step 1 of 1 · the build passed', text: 'The tests failed once on the way. The Builder fixed them, and they pass now.', note: 'Fixed a failed test' });
    const lines = get(id).activity.map((a) => a.text);
    expect(lines).toContain('squad-kit ran the tests for the Builder: did not pass');
    expect(lines).toContain('squad-kit ran the build for the Builder: passed');
  }, 30_000);
});
