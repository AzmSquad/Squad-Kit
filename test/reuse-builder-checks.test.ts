import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { Ticket } from '../src/board/types.js';
import { callTool, textOf } from './support/window.js';

/**
 * The Builder's last run_checks of a check passed, and it changed nothing after: the checks step uses that result
 * instead of running the same command again (a big browser suite takes minutes), check by check, and runs the checks it
 * has no such run of. Only squad-kit's own run, of the whole saved command (not one test file), passed, on the very
 * code the copy has now, from the Builder's latest round. The team's gates still run. Real commands and real git; the
 * AI tool is a fake that presses squad-kit's own tools.
 */

const h = vi.hoisted(() => ({ during: null as ((opts: RunOptions) => Promise<void>) | null }));
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    await h.during?.(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addAddition, setAdditionState } = await import('../src/board/additions.js');
const { addWorktree } = await import('./support/copy.js');
const { tailLines } = await import('../src/core/app-log.js');
const { liveNow } = await import('../src/board/now.js');
const { quickNpx } = await import('./support/fake-playwright.js');

type Squad = {
  runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void>;
  checks(id: string): Promise<void>;
  workspace(id: string): Promise<Ticket>;
};

const REUSED = 'The checks already passed on this same code when squad-kit ran them for the Builder, so they do not run again';
const TESTS_REUSED = 'The tests already passed on this same code when squad-kit ran them for the Builder, so they do not run again. squad-kit is running the other checks';
const LINT_REUSED = 'The code check already passed on this same code when squad-kit ran it for the Builder, so it does not run again. squad-kit is running the other checks';
const RUNNING = 'squad-kit is running the project checks';
/** Each check writes its name to runs.txt in the copy, which git ignores: running it is no change of the code. */
const TEST = 'echo test >> runs.txt; echo "Tests  3 passed"';
const LINT = 'echo lint >> runs.txt; echo tidy';

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const squad = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const lines = (id: string) => get(id).activity.map((a) => a.text);
const runs = (copy: string) => (fs.existsSync(path.join(copy, 'runs.txt')) ? fs.readFileSync(path.join(copy, 'runs.txt'), 'utf8').trim().split('\n').filter(Boolean) : []);
const logged = () => tailLines(400).join('\n');
const commands = (c: Record<string, string>) => writeMeta(bp, { ...readMeta(bp), commands: c });

/** What the fake Builder does in its run: an edit, then squad-kit's tools, given the copy it works in. */
function builder(fn: (copy: string, call: (args: object) => Promise<string>) => Promise<void>): void {
  h.during = async (opts) => {
    const call = async (args: object) => textOf(await callTool(opts.window!, 'run_checks', args));
    await fn(opts.cwd, call);
  };
}

const edit = (copy: string, text = 'three rooms\n') => fs.writeFileSync(path.join(copy, 'rooms.txt'), text);

beforeEach(() => {
  h.during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-reuse-builder-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'rooms.txt'), 'two rooms\n');
  fs.writeFileSync(path.join(project, 'rooms.test.js'), '// the rooms\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'runs.txt\n.ran-once\ngate.txt\nnode_modules/\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'RB',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: TEST, lint: LINT },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function story(title = 'Rooms on a phone'): { id: string; copy: string } {
  const t0 = actions.createTicket(bp, { title });
  const wt = addWorktree(project, t0.id, 'main');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'implement';
    x.live = true;
    x.squad = null;
    x.sessions = { build: 'b-1' };
    x.story = 'As a clerk, I want to see the rooms on my phone.';
    x.criteria = [{ given: 'a phone', when: 'I open the rooms', then: 'they fit' }];
    x.steps = [{ title: 'Show the rooms', status: 'todo' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
  });
  return { id: t0.id, copy: wt.dir };
}

describe.skipIf(process.platform === 'win32')("the Builder's last run of the checks", () => {
  it('passed on this same code: the checks step uses it, with the gate a fresh run gives, and one plain line', async () => {
    const a = story();
    const s = squad();
    let said = '';
    builder(async (copy, call) => {
      edit(copy);
      said = await call({});
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    expect(said).toContain('test: passed');
    expect(said).toContain('lint: passed');
    expect(runs(a.copy)).toEqual(['test', 'lint']);
    await s.checks(a.id);
    // The commands did not run a second time.
    expect(runs(a.copy)).toEqual(['test', 'lint']);
    const t = get(a.id);
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '3 tests pass, test, lint OK' });
    expect(t.gates?.ran).toEqual([
      { name: 'test', command: TEST, ok: true, tests: 3 },
      { name: 'lint', command: LINT, ok: true },
    ]);
    expect(lines(a.id)).toContain(REUSED);
    expect(lines(a.id)).not.toContain(RUNNING);
    expect(lines(a.id)).toContain('All checks pass: test, lint');
    expect(t.squad?.phase).toBe('review');
    expect(t.tries).toBe(0);
    // Engineers read which run it was, and its commands.
    expect(logged()).toContain("squad-kit uses the Builder's run_checks from");

    // The same work with an edit after the run: the checks run, and the gate is the same.
    const b = story('Rooms on a tablet');
    builder(async (copy, call) => {
      edit(copy);
      await call({});
      edit(copy, 'four rooms\n');
    });
    await s.runBuilder(b.id, 'Build it', true, 'build');
    await s.checks(b.id);
    expect(runs(b.copy)).toEqual(['test', 'lint', 'test', 'lint']);
    expect(lines(b.id)).toContain(RUNNING);
    expect(lines(b.id)).not.toContain(REUSED);
    expect(get(b.id).gates).toEqual(t.gates);
    expect(logged()).toContain('changed since that run started');
  });

  it('not when the code changed while it ran: the run may have seen part of it', async () => {
    commands({ test: 'echo test >> runs.txt; sleep 1; echo "Tests  3 passed"', lint: LINT });
    const a = story();
    const s = squad();
    builder(async (copy, call) => {
      const run = call({});
      // The tests have started: the edit lands while they run.
      while (!runs(copy).includes('test')) await sleep(20);
      edit(copy);
      expect(await run).toContain('test: passed');
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint', 'test', 'lint']);
    expect(lines(a.id)).not.toContain(REUSED);
    expect(get(a.id).gates?.checks).toBe('pass');
  });

  it('not for a check that failed in it: that one runs again, and the one that passed stands', async () => {
    commands({ test: 'echo test >> runs.txt; if [ -f .ran-once ]; then echo "Tests  3 passed"; else touch .ran-once; echo "  1 failed"; exit 1; fi', lint: LINT });
    const a = story();
    const s = squad();
    builder(async (copy, call) => {
      edit(copy);
      expect(await call({})).toContain('test: failed');
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint', 'test']);
    expect(lines(a.id)).not.toContain(REUSED);
    expect(lines(a.id)).toContain(LINT_REUSED);
    expect(get(a.id).gates?.checks).toBe('pass');
  });

  it('counts each check from its own latest run: one check after all of them, all the tests when one file was asked', async () => {
    const s = squad();
    const one = story();
    builder(async (copy, call) => {
      edit(copy);
      await call({});
      await call({ which: 'lint' });
    });
    await s.runBuilder(one.id, 'Build it', true, 'build');
    await s.checks(one.id);
    expect(runs(one.copy)).toEqual(['test', 'lint', 'lint']);
    expect(lines(one.id)).toContain(REUSED);

    // squad-kit cannot run one file with these tests, so it ran all of them: that is a run of the whole test command.
    const file = story('Rooms on a tablet');
    builder(async (copy, call) => {
      edit(copy);
      await call({});
      expect(await call({ only: 'rooms.test.js' })).toContain('so it ran all of them');
    });
    await s.runBuilder(file.id, 'Build it', true, 'build');
    await s.checks(file.id);
    expect(runs(file.copy)).toEqual(['test', 'lint', 'test']);
    expect(lines(file.id)).toContain(REUSED);

    // One check first, then all of them: the last run is the one that counts.
    const last = story('Rooms on a desk');
    builder(async (copy, call) => {
      edit(copy);
      await call({ which: 'test' });
      await call({});
    });
    await s.runBuilder(last.id, 'Build it', true, 'build');
    await s.checks(last.id);
    expect(runs(last.copy)).toEqual(['test', 'test', 'lint']);
    expect(lines(last.id)).toContain(REUSED);
  });

  it('a run of the tests alone counts for the tests: the code check runs as usual, and the Test stage says so', async () => {
    const a = story();
    const s = squad();
    builder(async (copy, call) => {
      edit(copy);
      // The tests through squad-kit; the code check in its own shell, which squad-kit cannot vouch for.
      expect(await call({ which: 'test' })).toContain('test: passed');
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint']);
    const t = get(a.id);
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '3 tests pass, test, lint OK' });
    expect(t.gates?.ran).toEqual([
      { name: 'test', command: TEST, ok: true, tests: 3 },
      { name: 'lint', command: LINT, ok: true },
    ]);
    expect(lines(a.id)).toContain(TESTS_REUSED);
    expect(lines(a.id)).not.toContain(REUSED);
    expect(t.history?.filter((h) => h.step === 'checks').pop()?.builderRun).toEqual({ checks: ['test'] });
    expect(liveNow(t, {}).stages.find((x) => x.stage === 'test')?.note).toMatch(/^\d+ s · tests from the Builder's run$/);
    expect(logged()).toContain("squad-kit uses the Builder's run_checks from");

    // Every check from the Builder's run: the Test stage says it was checked with it.
    const b = story('Rooms on a tablet');
    builder(async (copy, call) => {
      edit(copy);
      await call({});
    });
    await s.runBuilder(b.id, 'Build it', true, 'build');
    await s.checks(b.id);
    expect(get(b.id).history?.filter((h) => h.step === 'checks').pop()?.builderRun).toEqual({ checks: ['test', 'lint'], all: true });
    expect(liveNow(get(b.id), {}).stages.find((x) => x.stage === 'test')?.note).toMatch(/^\d+ s · checked with the Builder's run$/);
  });

  it('a run of the tests alone does not count after an edit, nor from an earlier round', async () => {
    const s = squad();
    const a = story();
    builder(async (copy, call) => {
      edit(copy);
      await call({ which: 'test' });
      edit(copy, 'four rooms\n');
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'test', 'lint']);
    expect(lines(a.id)).toContain(RUNNING);
    expect(lines(a.id)).not.toContain(TESTS_REUSED);
    expect(get(a.id).history?.filter((h) => h.step === 'checks').pop()?.builderRun).toBeUndefined();
    expect(logged()).toContain('changed since that run started');

    const b = story('Rooms on a tablet');
    builder(async (copy, call) => {
      edit(copy);
      await call({ which: 'test' });
    });
    await s.runBuilder(b.id, 'Build it', true, 'build');
    h.during = null;
    await s.runBuilder(b.id, 'Fix it', true);
    await s.checks(b.id);
    expect(runs(b.copy)).toEqual(['test', 'test', 'lint']);
    expect(lines(b.id)).not.toContain(TESTS_REUSED);
  });

  it('not for a check whose saved command is not the one it ran', async () => {
    const a = story();
    const s = squad();
    builder(async (copy, call) => {
      edit(copy);
      await call({});
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    commands({ test: TEST, lint: 'echo lint-strict >> runs.txt; echo tidy' });
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint', 'lint-strict']);
    expect(lines(a.id)).not.toContain(REUSED);
    expect(lines(a.id)).toContain(TESTS_REUSED);
    expect(logged()).toContain('the checks now are not the ones it ran (lint: echo lint-strict');
  });

  it('not from an earlier round of the Builder, and only once: a later checks step runs them', async () => {
    const s = squad();
    const a = story();
    builder(async (copy, call) => {
      edit(copy);
      await call({});
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    // A second round (a fix) that runs no checks of its own.
    h.during = null;
    await s.runBuilder(a.id, 'Fix it', true);
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint', 'test', 'lint']);
    expect(lines(a.id)).not.toContain(REUSED);

    const b = story('Rooms on a tablet');
    builder(async (copy, call) => {
      edit(copy);
      await call({});
    });
    await s.runBuilder(b.id, 'Build it', true, 'build');
    await s.checks(b.id);
    expect(runs(b.copy)).toEqual(['test', 'lint']);
    // Try again, with no new round of the Builder: squad-kit runs them itself.
    updateTicket(bp, b.id, (x) => (x.stage = 'test'));
    await s.checks(b.id);
    expect(runs(b.copy)).toEqual(['test', 'lint', 'test', 'lint']);
  });

  it("the team's gates still run with the checks", async () => {
    const g = addAddition(bp, 'Momen', { kind: 'gate', name: 'Room names', command: 'echo gate >> gate.txt', when: 'checks', on_fail: 'stop', tried: { at: new Date().toISOString(), by: 'Momen', result: 'passed', seconds: 1 } });
    setAdditionState(bp, 'Momen', g.id, 'on');
    const a = story();
    const s = squad();
    builder(async (copy, call) => {
      edit(copy);
      await call({});
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    expect(runs(a.copy)).toEqual(['test', 'lint']);
    expect(lines(a.id)).toContain(REUSED);
    expect(fs.readFileSync(path.join(a.copy, 'gate.txt'), 'utf8').trim()).toBe('gate');
    expect(get(a.id).added?.find((x) => x.name === 'Room names')).toMatchObject({ result: 'passed' });
    expect(get(a.id).gates?.checks).toBe('pass');
  });
});

describe.skipIf(process.platform === 'win32')('a story with several parts', () => {
  const PART_TEST = 'echo test >> runs.txt; echo "Tests  1 passed"';
  const parts = [
    { id: 'api', name: 'API', repo: 'api-server', needs: [] },
    { id: 'web', name: 'Web app', repo: 'web-ui', needs: ['api'] },
  ];
  let root: string;

  beforeEach(() => {
    root = path.join(tmp, 'workspace');
    for (const name of ['api-server', 'web-ui']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'runs.txt\n');
      execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: dir });
    }
    bp = boardPaths(path.join(root, '.squad'));
    writeMeta(bp, {
      project: 'App',
      key: 'AP',
      nextNumber: 2,
      engine: 'live',
      runner: 'direct',
      user: { name: 'Momen', role: 'Project manager' },
      roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
      tools: [],
      speed: 1,
      map: [],
      lessons: [],
      repos: ['api-server', 'web-ui'].map((r) => ({ path: r, base: 'main', remote: '', commands: { test: PART_TEST } })),
      parts,
      scan: { status: 'done', empty: false },
    } as never);
    writeTicket(bp, {
      id: 'AP-1',
      title: 'Show the evaluation',
      ask: 'Show the first evaluation',
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'implement',
      status: '',
      waiting: null,
      createdAt: new Date().toISOString(),
      createdBy: 'Momen',
      activity: [],
      repo: 'api-server',
      parts: ['api', 'web'],
      sessions: { build: 'b-1' },
      story: 'As a judge, I see the first evaluation.',
      criteria: [{ given: 'a case', when: 'I open it', then: 'I see the tab' }],
    } as Ticket);
  });

  const copyOf = (t: Ticket, repo: string) => path.join(t.storyDir!, repo);

  it('uses them only when every part it checks has its own passing run of every check', async () => {
    const s = squad();
    const t = await s.workspace('AP-1');
    builder(async (_folder, call) => {
      for (const repo of ['api-server', 'web-ui']) fs.writeFileSync(path.join(copyOf(t, repo), 'tab.txt'), 'the tab\n');
      await call({ part: 'api' });
      await call({ part: 'web' });
    });
    await s.runBuilder('AP-1', 'Build it', false, 'build');
    await s.checks('AP-1');
    expect(runs(copyOf(t, 'api-server'))).toEqual(['test']);
    expect(runs(copyOf(t, 'web-ui'))).toEqual(['test']);
    expect(lines('AP-1')).toContain(REUSED);
    const reused = get('AP-1').gates;
    expect(reused).toMatchObject({ checks: 'pass', checksText: 'API ✓, Web app ✓' });

    // Only one part ran them: its run stands, and the other part runs its own.
    updateTicket(bp, 'AP-1', (x) => {
      x.stage = 'implement';
      x.activity = [];
    });
    builder(async (_folder, call) => {
      for (const repo of ['api-server', 'web-ui']) fs.writeFileSync(path.join(copyOf(t, repo), 'tab.txt'), 'the new tab\n');
      await call({ part: 'api' });
    });
    await s.runBuilder('AP-1', 'Fix it', true);
    await s.checks('AP-1');
    expect(runs(copyOf(t, 'api-server'))).toEqual(['test', 'test']);
    expect(runs(copyOf(t, 'web-ui'))).toEqual(['test', 'test']);
    expect(lines('AP-1')).not.toContain(REUSED);
    expect(lines('AP-1')).toContain(TESTS_REUSED);
    expect(get('AP-1').gates).toEqual(reused);
  });
});

describe.skipIf(process.platform === 'win32')('one test file on its own', () => {
  /** A stand-in for Playwright: all the tests with no file, one test with one. Each run notes itself in runs.txt. */
  const PLAYWRIGHT = '#!/bin/sh\nif [ "$#" -le 1 ]; then echo test >> runs.txt; echo "  3 passed (1.0s)"; else echo one-file >> runs.txt; echo "  1 passed (0.3s)"; fi\n';
  let putBack = () => {};
  beforeEach(() => {
    putBack = quickNpx(path.join(tmp, 'npx'));
    commands({ test: 'npx playwright test', lint: LINT });
  });
  afterEach(() => putBack());

  /** The tool and a test file in the story's copy, as an install and the project's own tests would put them. */
  const install = (copy: string) => {
    fs.mkdirSync(path.join(copy, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'node_modules', '.bin', 'playwright'), PLAYWRIGHT, { mode: 0o755 });
    fs.mkdirSync(path.join(copy, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'tests', 'e2e', 'rooms.spec.ts'), '// the rooms\n');
  };

  it('never counts for the tests, and as the latest run of them, an earlier run of all of them no longer counts', async () => {
    const a = story();
    install(a.copy);
    const s = squad();
    builder(async (copy, call) => {
      edit(copy);
      await call({});
      expect(await call({ only: 'tests/e2e/rooms.spec.ts' })).toContain('1 passed');
    });
    await s.runBuilder(a.id, 'Build it', true, 'build');
    await s.checks(a.id);
    // All the tests run again; the code check, from the first run, does not.
    expect(runs(a.copy)).toEqual(['test', 'lint', 'one-file', 'test']);
    expect(lines(a.id)).toContain(LINT_REUSED);
    expect(get(a.id).gates).toMatchObject({ checks: 'pass' });
    expect(get(a.id).history?.filter((x) => x.step === 'checks').pop()?.builderRun).toEqual({ checks: ['lint'] });
  });
});
