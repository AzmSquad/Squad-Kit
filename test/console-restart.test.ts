import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { boardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { readConsoleInfo, type ConsoleInfo } from '../src/board/console-info.js';
import { demoFolder } from '../src/commands/board.js';
import { rememberProject } from '../src/core/projects.js';

/**
 * Restart from the board, end to end: a real `squad console` in its own process group, the way a terminal runs it.
 * Each restart must load a fresh board on the same port and link without leaving the old board alive as the parent
 * of the new one, and Ctrl-C to the group must still stop it all.
 */

const repo = path.resolve(__dirname, '..');
const tsx = pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href;
const cli = path.join(repo, 'src/cli.ts');

let tmp: string | undefined;
let top: ChildProcess | undefined;

afterEach(() => {
  if (top?.pid && top.exitCode === null && top.signalCode === null) {
    try {
      process.kill(-top.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = top = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** While it runs, this test's own squad-kit home stands in for the one the test setup made. */
function withHome<T>(home: string, fn: () => T): T {
  const was = process.env.SQUAD_KIT_HOME;
  process.env.SQUAD_KIT_HOME = home;
  try {
    return fn();
  } finally {
    process.env.SQUAD_KIT_HOME = was;
  }
}

function parentOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

async function until<T>(what: string, check: () => Promise<T | undefined>, log: () => string, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}. Console output:\n${log()}`);
}

describe.skipIf(process.platform === 'win32')('squad console restart from the board', () => {
  it('keeps one board on the same port and link, and Ctrl-C still stops it', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-restart-')));
    const squadDir = path.join(tmp, '.squad');
    fs.mkdirSync(squadDir, { recursive: true });
    fs.writeFileSync(
      path.join(squadDir, 'config.yaml'),
      yaml.dump({
        version: 1,
        project: { name: 'restart-test', primaryLanguage: 'typescript' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
      }),
      'utf8',
    );
    // A demo board: its squad plays a script, so nothing starts a real agent.
    const bp = boardPaths(squadDir);
    seedDemoBoard(bp);

    let output = '';
    const log = () => output;
    top = spawn(process.execPath, ['--import', tsx, cli, 'console', '--no-open', '--port', '0'], {
      cwd: tmp,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    top.stdout!.on('data', (d) => (output += d));
    top.stderr!.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((done) => top!.on('exit', (code) => done(code)));
    const topPid = top.pid!;

    const boardUp = (what: string, after?: ConsoleInfo) =>
      until(
        what,
        async () => {
          const info = readConsoleInfo(bp);
          if (!info?.pid || info.startedAt === after?.startedAt || !alive(info.pid)) return undefined;
          const res = await fetch(`http://127.0.0.1:${info.port}/healthz`);
          return res.ok ? (info as ConsoleInfo & { pid: number }) : undefined;
        },
        log,
      );
    const restart = async (from: ConsoleInfo & { pid: number }) => {
      const res = await fetch(`http://127.0.0.1:${from.port}/api/v1/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${from.token}` },
      });
      expect(res.ok).toBe(true);
      return boardUp('the restarted board', from);
    };

    const first = await boardUp('the first board');
    expect(first.pid).toBe(topPid);
    const second = await restart(first);
    const third = await restart(second);

    for (const board of [second, third]) {
      expect(board.port).toBe(first.port);
      expect(board.token).toBe(first.token);
    }
    if (typeof process.execve === 'function') {
      // Newer Node swaps the process in place.
      expect(third.pid).toBe(topPid);
    } else {
      // Older Node: the first process keeps the terminal and runs one board at a time.
      expect(second.pid).not.toBe(topPid);
      expect(alive(second.pid)).toBe(false);
      expect(parentOf(third.pid)).toBe(topPid);
    }

    // Ctrl-C in the terminal reaches every process in its group.
    process.kill(-topPid, 'SIGINT');
    expect(await exited).toBe(0);
    expect(alive(third.pid)).toBe(false);
    expect(readConsoleInfo(bp)?.pid).toBeNull();
    expect(output).toContain('console stopped');
    expect(output).not.toContain('server close');
  }, 90_000);

  /** A project with a sample board: its squad plays a script, so nothing starts a real agent, whatever goes wrong here. */
  function aProject(root: string, name: string) {
    const squadDir = path.join(root, '.squad');
    fs.mkdirSync(squadDir, { recursive: true });
    fs.writeFileSync(path.join(squadDir, 'config.yaml'), yaml.dump({ version: 1, project: { name, primaryLanguage: 'typescript' }, tracker: { type: 'none' }, naming: { includeTrackerId: false, globalSequence: true }, agents: [] }), 'utf8');
    const bp = boardPaths(squadDir);
    seedDemoBoard(bp, { project: name });
    return boardPaths(squadDir);
  }

  /** Runs in its own process group, on its own squad-kit home, like a person's own terminal. */
  function start(cwd: string, home: string, args: string[]) {
    let output = '';
    top = spawn(process.execPath, ['--import', tsx, cli, ...args], { cwd, env: { ...process.env, SQUAD_KIT_HOME: home }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    top.stdout!.on('data', (d) => (output += d));
    top.stderr!.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((done) => top!.on('exit', (code) => done(code)));
    return { log: () => output, exited };
  }

  it('a project taken out of the app stays out after a restart, and after the next one', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-removed-')));
    const home = path.join(tmp, 'home');
    const root = path.join(tmp, 'app');
    const other = path.join(tmp, 'other');
    for (const dir of [home, root, other]) fs.mkdirSync(dir);
    const bp = withHome(home, () => aProject(root, 'removed-test'));
    const stays = withHome(home, () => aProject(other, 'stays'));
    const app = start(root, home, ['console', '--no-open', '--port', '0']);
    const appInfo = () => JSON.parse(fs.readFileSync(path.join(home, 'app.json'), 'utf8')) as ConsoleInfo;
    const list = () => (JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')) as { projects: { root: string }[] }).projects.map((p) => p.root);
    const up = (what: string, after?: string) =>
      until(
        what,
        async () => {
          const info = appInfo();
          if (!info.pid || info.startedAt === after || !alive(info.pid)) return undefined;
          return (await fetch(`http://127.0.0.1:${info.port}/healthz`)).ok ? info : undefined;
        },
        app.log,
      );
    const call = (info: ConsoleInfo, method: string, where: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${info.port}${where}`, { method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const restart = async (info: ConsoleInfo) => {
      expect((await call(info, 'POST', `/p/${encodeURIComponent(stays.projectId)}/api/v1/restart`)).ok).toBe(true);
      return up('the restarted app', info.startedAt);
    };

    const first = await up('the first app');
    expect((await call(first, 'POST', '/api/v1/app/projects', { folder: other })).ok).toBe(true);
    expect(list()).toEqual([root, other]);
    // A restart with it still there keeps it, also from a board a keeper runs.
    const second = await restart(first);
    expect(list()).toEqual([root, other]);
    expect((await call(second, 'DELETE', `/api/v1/app/projects/${encodeURIComponent(bp.projectId)}`)).ok).toBe(true);
    expect(list()).toEqual([other]);

    const third = await restart(second);
    expect(list()).toEqual([other]);
    const open = async (info: ConsoleInfo) => ((await (await call(info, 'GET', '/api/v1/app/projects')).json()) as { projects: { root: string }[] }).projects.map((p) => p.root);
    expect(await open(third)).toEqual([other]);
    // Its board is not open again either: its squad does not run.
    expect(withHome(home, () => readConsoleInfo(bp))?.pid).toBeNull();

    const fourth = await restart(third);
    expect(fourth.port).toBe(first.port);
    expect(fourth.token).toBe(first.token);
    expect(list()).toEqual([other]);
    expect(await open(fourth)).toEqual([other]);
    expect(withHome(home, () => readConsoleInfo(bp))?.pid).toBeNull();

    process.kill(-top!.pid!, 'SIGINT');
    expect(await app.exited).toBe(0);
  }, 120_000);

  it('squad demo opens the sample board alone: no real project starts, the list stays, and a restart keeps it so', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-demo-alone-')));
    const home = path.join(tmp, 'home');
    const real = path.join(tmp, 'real');
    fs.mkdirSync(home);
    fs.mkdirSync(real);
    const bp = withHome(home, () => {
      const made = aProject(real, 'a-real-project');
      rememberProject(made.projectId, real);
      return made;
    });
    const before = fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
    const demo = start(tmp, home, ['demo', '--no-open', '--port', '0']);
    const sample = withHome(home, () => boardPaths(path.join(demoFolder(), '.squad')));
    const up = (what: string, after?: string) =>
      until(
        what,
        async () => {
          const info = withHome(home, () => readConsoleInfo(boardPaths(path.join(demoFolder(), '.squad'))));
          if (!info?.pid || info.startedAt === after || !alive(info.pid)) return undefined;
          return (await fetch(`http://127.0.0.1:${info.port}/healthz`)).ok ? info : undefined;
        },
        demo.log,
      );
    const rows = async (info: ConsoleInfo) => (await (await fetch(`http://127.0.0.1:${info.port}/api/v1/app/projects`, { headers: { authorization: `Bearer ${info.token}` } })).json() as { projects: { root: string }[] }).projects.map((p) => p.root);
    const check = async (info: ConsoleInfo) => {
      expect(await rows(info)).toEqual([sample.root]);
      // The real project: its squad never started, and nothing says this app runs it.
      expect(withHome(home, () => readConsoleInfo(bp))).toBeNull();
      expect(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).toBe(before);
      // The sample board is not the app: plain `squad` and `squad console` never take it for one.
      expect(fs.existsSync(path.join(home, 'app.json'))).toBe(false);
    };
    const first = await up('the sample board');
    await check(first);
    const res = await fetch(`http://127.0.0.1:${first.port}/api/v1/restart`, { method: 'POST', headers: { authorization: `Bearer ${first.token}` } });
    expect(res.ok).toBe(true);
    const second = await up('the restarted sample board', first.startedAt);
    expect(second.port).toBe(first.port);
    expect(second.token).toBe(first.token);
    await check(second);

    process.kill(-top!.pid!, 'SIGINT');
    expect(await demo.exited).toBe(0);
  }, 120_000);
});
