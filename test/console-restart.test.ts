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
});
