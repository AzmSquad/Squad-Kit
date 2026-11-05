import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A project the Builder just set up says how it is tested and run: squad-kit reads that from its files after the build
 * and saves it, with a line on the story, and asks nobody. Only a project that truly has no tests gets the plain
 * question, which names no command. The AI tool is a fake that answers at once.
 */

const calls: RunOptions[] = [];
/** What the fake agent does in its run, like pressing squad-kit's own tools. */
let during: ((opts: RunOptions) => Promise<void>) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    await during?.(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { findCommands, withBrowserTests } = await import('../src/engine/find-commands.js');
const { saveScan } = await import('../src/engine/onboard.js');
const { callTool, rpc, textOf } = await import('./support/window.js');

type Squad = { checks(id: string): Promise<void> };

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
};

const pkg = (scripts: Record<string, string>, more: object = {}) => JSON.stringify({ name: 'x', scripts, ...more });

beforeEach(() => {
  calls.length = 0;
  during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-find-')));
  wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done', empty: true }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket the Builder finished, ready for the checks. */
function built(suggestion?: string) {
  const t0 = actions.createTicket(bp, { title: 'Visitor list page, first version', ask: 'A list of visitors.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'test';
    x.live = true;
    x.waiting = null;
    x.squad = null;
    x.worktree = wt;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.story = 'As staff, I want a visitor list.';
    x.criteria = [{ given: 'a name', when: 'I add it', then: 'it shows' }];
    x.steps = [{ title: 'Build it', status: 'done' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    if (suggestion) x.testSuggestion = suggestion;
  });
}

const squad = () => new LiveSquad(bp) as unknown as Squad;

describe("reading a project's own files", () => {
  it('package.json scripts: the one the release-gate run set up (case2-new)', () => {
    write(wt, {
      'package.json': pkg({ test: 'node --test', lint: 'tsc --noEmit', build: 'tsc -p tsconfig.build.json', start: 'tsx src/server.ts' }),
      'src/server.ts': 'const port = Number(process.env.PORT ?? 3000);\n',
    });
    expect(findCommands(wt)).toEqual({ setup: 'npm install', test: 'npm test', lint: 'npm run lint', build: 'npm run build', start: 'npm start', url: 'http://localhost:3000' });
  });

  it('npm\'s placeholder is no test command, and a separate browser script joins the test command', () => {
    write(wt, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) });
    expect(findCommands(wt).test).toBeUndefined();
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test', dev: 'next dev -p 3100' }, { dependencies: { next: '15' } }) });
    expect(findCommands(wt)).toMatchObject({ test: 'npm test && npm run test:e2e', start: 'npm run dev', url: 'http://localhost:3100' });
    write(wt, { 'package.json': pkg({ 'test:e2e': 'playwright test' }) });
    expect(findCommands(wt).test).toBe('npm run test:e2e');
  });

  it('the package manager the project uses', () => {
    write(wt, { 'package.json': pkg({ test: 'vitest', dev: 'vite' }, { devDependencies: { vite: '6' } }), 'pnpm-lock.yaml': '' });
    expect(findCommands(wt)).toMatchObject({ setup: 'pnpm install', test: 'pnpm test', start: 'pnpm run dev', url: 'http://localhost:5173' });
  });

  it('the address comes from the script, the code or the README, and never without a start command', () => {
    write(wt, { 'package.json': pkg({ start: 'node server.js' }), 'server.js': 'app.listen(4567);\n' });
    expect(findCommands(wt).url).toBe('http://localhost:4567');
    fs.rmSync(path.join(wt, 'server.js'));
    write(wt, { 'README.md': 'Open http://localhost:8123 on the same computer.\n' });
    expect(findCommands(wt).url).toBe('http://localhost:8123');
    write(wt, { 'package.json': pkg({ test: 'vitest' }) });
    expect(findCommands(wt).url).toBeUndefined();
  });

  it('the equivalents in other languages', () => {
    const python = path.join(tmp, 'py');
    write(python, { 'requirements.txt': 'flask\npytest\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
    expect(findCommands(python)).toEqual({ setup: 'pip install -r requirements.txt', test: 'python -m pytest', start: 'python app.py', url: 'http://localhost:5000' });
    const django = path.join(tmp, 'dj');
    write(django, { 'manage.py': '', 'requirements.txt': 'django\n' });
    expect(findCommands(django)).toMatchObject({ test: 'python manage.py test', start: 'python manage.py runserver', url: 'http://localhost:8000' });
    const go = path.join(tmp, 'go');
    write(go, { 'go.mod': 'module x\n', 'pkg/a_test.go': '' });
    expect(findCommands(go)).toMatchObject({ test: 'go test ./...', build: 'go build ./...' });
    const empty = path.join(tmp, 'none');
    write(empty, { 'README.md': '# none\n' });
    expect(findCommands(empty)).toEqual({});
  });

  it('a test command the setup step found gets the separate browser tests: the Mawid clone', () => {
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test', dev: 'next dev' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test && npm run test:e2e');
    // Already there, or run by the test script itself.
    expect(withBrowserTests(wt, 'npm test && npm run test:e2e')).toBe('npm test && npm run test:e2e');
    write(wt, { 'package.json': pkg({ test: 'vitest run && playwright test', 'test:e2e': 'playwright test' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test');
    // A script that opens a window is left out.
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test --ui' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test');
  });

  it('the setup step saves the full test command', () => {
    write(bp.root, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test' }), 'src/app.ts': '' });
    saveScan(bp, { empty: false, summary: 'An app', map: [], decisions: [], commands: { test: 'npm test' } }, []);
    expect(readMeta(bp).commands?.test).toBe('npm test && npm run test:e2e');
  });
});

describe('after the build', () => {
  it('the Builder set up a project: squad-kit saves how it is tested and run, says so, and asks nobody', async () => {
    write(wt, {
      'package.json': pkg({ test: 'echo "Tests  2 passed"', lint: 'echo fine', start: 'node server.js' }),
      'server.js': 'app.listen(3000);\n',
    });
    const t0 = built('npm test');
    await squad().checks(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(readMeta(bp).commands).toMatchObject({ setup: 'npm install', test: 'npm test', lint: 'npm run lint', start: 'npm start', url: 'http://localhost:3000' });
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found how to test and run the project, and saved it');
    expect(t.testSuggestion).toBeUndefined();
    expect(t.stuck).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.gates?.checks).toBe('pass');
    expect(t.stage).toBe('review');
  });

  it('what is saved stays: a found command never replaces a saved one', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'echo "Tests  1 passed"', start: 'node own.js' } });
    write(wt, { 'package.json': pkg({ test: 'exit 1', dev: 'vite' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands).toMatchObject({ test: 'echo "Tests  1 passed"', start: 'node own.js' });
  });

  it('an existing project gets only its first tests: other commands stay as the person set them', async () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, commands: { start: 'node own.js', url: 'http://localhost:4000' } });
    write(wt, { 'package.json': pkg({ test: 'echo "Tests  3 passed"', lint: 'exit 1', build: 'exit 1' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands).toEqual({ start: 'node own.js', url: 'http://localhost:4000', test: 'npm test' });
    const t = readTicket(bp, t0.id)!;
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found the tests in the project, and runs them from now on');
    expect(t.gates?.checks).toBe('pass');
  });

  it('a project that truly has no tests gets the plain question, with no command in it', async () => {
    write(wt, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'echo fine' }) });
    const t0 = built('npm test');
    await squad().checks(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(t.stuck).toMatchObject({ gate: 'checks', kind: 'no-tests' });
    expect(t.stuck!.question).toBe('This project has no tests yet, so squad-kit cannot check that the work does what it should.');
    const words = [t.stuck!.question, ...t.stuck!.options.flatMap((o) => [o.name, o.note ?? ''])].join(' ');
    expect(words).not.toMatch(/npm|command/i);
    // Engineers get the commands one click away.
    expect(t.stuck!.detail).toContain('npm test');
  });

  it('the choice to go on without tests stands', async () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, noTests: { by: 'Momen', at: '2026-01-01', ticket: 'X-1' } });
    write(wt, { 'package.json': pkg({ test: 'echo "Tests  3 passed"' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands?.test).toBeUndefined();
    expect(readTicket(bp, t0.id)!.gates?.checks).toBe('unchecked');
  });
});

describe('run_checks in a real Builder run', () => {
  it('the Builder of a new project gets it with no app yet, and squad-kit finds the commands it just wrote', async () => {
    execSync('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', { cwd: wt });
    const t0 = built();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.steps = [{ title: 'Build it', status: 'todo' }];
      x.baseCommit = execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf8' }).trim();
    });
    let tools: string[] = [];
    let answer = '';
    let before = '';
    during = async (opts) => {
      tools = (await rpc(opts.window!, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name);
      before = textOf(await callTool(opts.window!, 'run_checks', { which: 'test' }));
      write(wt, { 'package.json': pkg({ test: 'echo "Tests  4 passed"' }) });
      answer = textOf(await callTool(opts.window!, 'run_checks', { which: 'test' }));
    };
    await (new LiveSquad(bp) as unknown as { build(id: string): Promise<void> }).build(t0.id);
    expect(tools).toEqual(['run_checks', 'i_am_stuck']);
    expect(before).toContain('no saved test command');
    expect(answer).toContain('test: passed');
    expect(readMeta(bp).commands?.test).toBe('npm test');
    const t = readTicket(bp, t0.id)!;
    expect(t.activity.map((a) => a.text)).toContain('squad-kit ran the tests for the Builder: passed');
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found how to test and run the project, and saved it');
    // The Builder is told to use it, not to run browser tests itself.
    expect(calls.at(-1)!.prompt).toContain('run_checks');
  });
});

describe('the setup command in a new copy', () => {
  it('puts back the tracked files it changed, keeps new and ignored ones, and says so to engineers only', async () => {
    const { putBackTracked } = await import('../src/engine/git.js');
    const sh = (cmd: string) => execSync(cmd, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    write(wt, { 'package.json': '{}\n', 'package-lock.json': '{ "lockfileVersion": 2 }\n', '.gitignore': 'node_modules\n', 'gone.txt': 'here\n' });
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
    write(wt, { 'package-lock.json': '{ "lockfileVersion": 3 }\n', 'node_modules/a/index.js': 'x\n', 'dev.db.new': 'x\n' });
    fs.rmSync(path.join(wt, 'gone.txt'));
    expect(putBackTracked(wt).sort()).toEqual(['gone.txt', 'package-lock.json']);
    expect(fs.readFileSync(path.join(wt, 'package-lock.json'), 'utf8')).toBe('{ "lockfileVersion": 2 }\n');
    expect(fs.existsSync(path.join(wt, 'gone.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt, 'node_modules/a/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(wt, 'dev.db.new'))).toBe(true);
    expect(sh('git status --short')).toBe('?? dev.db.new');
    expect(putBackTracked(wt)).toEqual([]);
  });

  it('on a real copy: the lock file an install rewrote is not "work already there", so the before screens still come', async () => {
    const project = path.join(tmp, 'real');
    fs.mkdirSync(project);
    const sh = (cmd: string, cwd = project) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    write(project, { 'package-lock.json': '{ "lockfileVersion": 2 }\n', 'app.js': 'x\n' });
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
    const real = boardPaths(path.join(project, '.squad'));
    seedDemoBoard(real, { speed: 50 });
    for (const t of listTickets(real)) removeTicket(real, t.id);
    writeMeta(real, { ...readMeta(real), engine: 'live', runner: 'direct', scan: { status: 'done', empty: false }, commands: { setup: `node -e "require('fs').writeFileSync('package-lock.json','{ \\"lockfileVersion\\": 3 }\\n')"` }, blueprint: undefined, impactChecks: [], techDrafts: [], git: { base: 'main', remote: '' } });
    const t0 = actions.createTicket(real, { title: 'Show the room name', ask: 'Show it.' });
    const s = new LiveSquad(real) as unknown as { workspace(id: string): Promise<{ worktree: string; baseCommit: string }> };
    const t = await s.workspace(t0.id);
    expect(fs.readFileSync(path.join(t.worktree, 'package-lock.json'), 'utf8')).toBe('{ "lockfileVersion": 2 }\n');
    const { workSoFar } = await import('../src/engine/handover.js');
    expect(workSoFar(t.worktree, t.baseCommit)).toEqual([]);
    sh(`git worktree remove --force "${t.worktree}"`);
  });
});
