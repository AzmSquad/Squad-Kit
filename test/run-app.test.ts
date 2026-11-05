import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { AppRunner, portTaken, stopApps, appRunner } from '../src/engine/run-app.js';
import { GUARD_BLOCKED_DOCKER, guardSupport } from '../src/engine/project-guard.js';
import { freePort } from './support/tiny-app.js';

/**
 * Your apps: squad-kit runs the app from its own copy of main, never the person's checkout, waits for the address,
 * and stops the whole process group. Real git repos and real little servers.
 */

let tmp: string;
let project: string;
let bp: BoardPaths;
let port: number;
let setups: string;
const runners: AppRunner[] = [];

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasLsof = (() => {
  try {
    execSync('command -v lsof', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The app serves version.txt, after a short start, and starts a helper process of its own. */
const SERVER = `
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const at = process.argv.indexOf('--port');
const port = Number(at > 0 ? process.argv[at + 1] : process.env.PORT || require('./port.json'));
spawn(process.execPath, ['-e', "setInterval(() => require('fs').appendFileSync('helper.beat', 'x'), 100)"], { stdio: 'ignore' });
console.log('starting the app');
setTimeout(() => http.createServer((q, r) => r.end(fs.readFileSync('version.txt', 'utf8').trim())).listen(port, '127.0.0.1'), 500);
`;

/**
 * Is a program still working? It adds to its file every 100 ms. A process number would not do: inside the guard on
 * Linux a program has a number of its own, which means nothing outside.
 */
async function beating(file: string): Promise<boolean> {
  const size = () => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  const before = size();
  await sleep(600);
  return size() > before;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function text(url: string): Promise<string> {
  return fetch(url, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
}

async function answers(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
}

function commit(file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(project, file), content);
  sh(`git add -A && git commit -qm "${message}"`, project);
}

function runner(waitMs = 20_000): AppRunner {
  const r = new AppRunner(bp, { waitMs });
  runners.push(r);
  return r;
}

function setCommands(commands: Record<string, string>): void {
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, commands: { ...meta.commands, ...commands } });
}

/** The project's app reads no port setting, so squad-kit cannot move it. */
function noPortSetting(): void {
  commit('server.js', SERVER.replace("process.env.PORT || require('./port.json')", "require('./port.json')"), 'read the port from one file');
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-apps-'));
  project = path.join(tmp, 'roomflow');
  fs.mkdirSync(project);
  port = await freePort();
  setups = path.join(tmp, 'setups.log');
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'server.js'), SERVER);
  fs.writeFileSync(path.join(project, 'version.txt'), 'v1\n');
  fs.writeFileSync(path.join(project, 'port.json'), String(port));
  fs.writeFileSync(path.join(project, 'package.json'), '{ "name": "roomflow" }\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'helper.beat\nnode_modules\n.squad\n');
  sh('git add -A && git commit -qm start', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'roomflow',
    key: 'RO',
    nextNumber: 1,
    engine: 'live',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { setup: `echo set-up >> "${setups}"`, start: 'node server.js', url: `http://localhost:${port}` },
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(async () => {
  for (const r of runners.splice(0)) r.stopAll();
  stopApps(bp);
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('your apps run from squad-kit’s own copy of main', () => {
  it('starts main, says Starting until the address answers, then Running; Stop ends the whole process group', async () => {
    // The person's own checkout has a change of theirs: the app runs main as committed, from a copy.
    fs.writeFileSync(path.join(project, 'version.txt'), 'my own edit\n');
    const apps = runner();
    const first = apps.start();
    expect(first.state).toBe('starting');
    expect(first.dir).toBe(path.join(bp.localDir, 'apps', 'roomflow'));
    expect(() => apps.start()).toThrow('roomflow is starting already.');

    const s = await apps.settled();
    expect(s.state).toBe('running');
    expect(s.address).toBe(`http://localhost:${port}`);
    expect(s.up).toBe(true);
    expect(await text(`http://127.0.0.1:${port}`)).toBe('v1');
    expect(fs.readFileSync(path.join(project, 'version.txt'), 'utf8')).toBe('my own edit\n');
    expect(sh('git status --porcelain', project)).toBe('M version.txt');
    // A new copy is set up first.
    expect(fs.readFileSync(setups, 'utf8')).toBe('set-up\n');
    expect(apps.lines().join('\n')).toContain('starting the app');
    // Only one copy per app.
    expect(() => apps.start()).toThrow(`roomflow is already running at http://localhost:${port}.`);

    const helper = path.join(s.dir, 'helper.beat');
    expect(await beating(helper)).toBe(true);
    const stopped = await apps.stop();
    expect(stopped.state).toBe('stopped');
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(false);
    expect(await beating(helper)).toBe(false);
    await expect(apps.stop()).rejects.toThrow('roomflow is not running.');
  }, 40_000);

  it('brings the copy up to date before every Start, and sets it up again only when the dependency files change', async () => {
    const apps = runner();
    apps.start();
    expect((await apps.settled()).state).toBe('running');
    await apps.stop();

    // A ticket merged into main: the next Start runs it, without setting up again.
    commit('version.txt', 'v2\n', 'merge RO-5');
    apps.start();
    const s = await apps.settled();
    expect(s.commit).toBe(sh('git rev-parse main', project));
    expect(await text(`http://127.0.0.1:${port}`)).toBe('v2');
    expect(fs.readFileSync(setups, 'utf8')).toBe('set-up\n');

    // Restart: stops it, and starts it on the newest main; new packages bring the setup again.
    commit('package.json', '{ "name": "roomflow", "dependencies": { "left-pad": "1.3.0" } }\n', 'add a package');
    commit('version.txt', 'v3\n', 'merge RO-6');
    await apps.restart();
    expect((await apps.settled()).state).toBe('running');
    expect(await text(`http://127.0.0.1:${port}`)).toBe('v3');
    expect(fs.readFileSync(setups, 'utf8')).toBe('set-up\nset-up\n');
  }, 60_000);

  it('a moment when this process was busy does not make a port in use read as free', async () => {
    const yours = http.createServer((q, r) => r.end('yours')).listen(port, '127.0.0.1');
    try {
      await new Promise((r) => yours.once('listening', r));
      const asked = portTaken(port);
      // What a git call that waits does to the process, on a busy computer.
      const until = Date.now() + 1200;
      while (Date.now() < until);
      expect(await asked).toBe(true);
    } finally {
      yours.close();
    }
  });

  it('a busy port: the app goes around it by itself when it can move, and the other program is left alone', async () => {
    const yours = http.createServer((q, r) => r.end('yours')).listen(port, '127.0.0.1');
    try {
      // The app reads PORT, so nobody is asked.
      const apps = runner();
      apps.start();
      const moved = await apps.settled();
      expect(moved.state).toBe('running');
      expect(moved.error).toBeUndefined();
      const to = Number(new URL(moved.address!).port);
      expect(to).toBeGreaterThan(port);
      expect(moved.address).toBe(`http://localhost:${to}`);
      expect(await text(`http://127.0.0.1:${to}`)).toBe('v1');
      expect(await text(`http://127.0.0.1:${port}`)).toBe('yours');
      expect(apps.lines().join('\n')).toContain(`Port ${port} is used by another program, so roomflow runs on port ${to}`);
      await apps.stop();

      // A start command with a port setting moves too.
      setCommands({ start: `node server.js --port ${port}` });
      apps.start();
      const flag = await apps.settled();
      expect(flag.state).toBe('running');
      expect(Number(new URL(flag.address!).port)).toBeGreaterThan(port);
      expect(await text(`http://127.0.0.1:${port}`)).toBe('yours');
    } finally {
      yours.close();
    }
  }, 40_000);

  it('a busy port it cannot go around: one plain sentence, and the port and the program are for engineers', async () => {
    const yours = http.createServer((q, r) => r.end('yours')).listen(port, '127.0.0.1');
    try {
      noPortSetting();
      const apps = runner();
      apps.start();
      const s = await apps.settled();
      expect(s.state).toBe('failed');
      expect(s.error).toBe('Another program on this computer is using what roomflow needs.');
      expect(s.busy).toMatchObject({ port, ours: false });
      expect(s.detail).toContain(`listens on port ${port}`);
      if (hasLsof) {
        expect(s.busy).toMatchObject({ pid: process.pid, program: expect.stringMatching(/node/i) });
        expect(s.detail).toContain(`(process ${process.pid})`);
      }
      expect(await text(`http://127.0.0.1:${port}`)).toBe('yours');
    } finally {
      yours.close();
    }
  }, 40_000);

  it.runIf(hasLsof)('a program squad-kit started on the port can be stopped for it', async () => {
    const other = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => r.end('old')).listen(${port}, '127.0.0.1')`], { detached: true, stdio: 'ignore' });
    try {
      while (!(await answers(`http://127.0.0.1:${port}`))) await sleep(100);
      noPortSetting();
      const apps = runner();
      apps.start();
      const s = await apps.settled();
      expect(s.error).toBe('Something squad-kit started earlier is using what roomflow needs.');
      expect(s.busy).toMatchObject({ port, ours: true, pid: other.pid });
      apps.start(undefined, { stopOther: true });
      expect((await apps.settled()).state).toBe('running');
      expect(await text(`http://127.0.0.1:${port}`)).toBe('v1');
      expect(alive(other.pid!)).toBe(false);
    } finally {
      if (alive(other.pid!)) process.kill(other.pid!);
    }
  }, 40_000);

  it('a setup or a start that tries Docker says so, where the guard runs', async () => {
    if (!guardSupport().on) return;
    const words = "console.error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'); process.exit(1)";
    setCommands({ setup: `node -e "${words}"` });
    let s = await (() => {
      const apps = runner();
      apps.start();
      return apps.settled();
    })();
    expect(s.state).toBe('failed');
    expect(s.error).toBe(GUARD_BLOCKED_DOCKER);
    setCommands({ setup: 'node -e 0', start: `node -e "${words}"` });
    s = await (() => {
      const apps = runner();
      apps.start();
      return apps.settled();
    })();
    expect(s.state).toBe('failed');
    expect(s.error).toBe(GUARD_BLOCKED_DOCKER);
  }, 30_000);

  it('a setup that fails says one plain sentence: the command and what it printed are for engineers', async () => {
    setCommands({ setup: `node -e "console.error('npm ERR! network'); process.exit(3)"` });
    const apps = runner();
    apps.start();
    const s = await apps.settled();
    expect(s.state).toBe('failed');
    expect(s.error).toBe('squad-kit could not set up roomflow.');
    expect(s.detail).toContain('process.exit(3)');
    expect(s.detail).toContain('npm ERR! network');
  }, 30_000);

  it('a crash while starting fails with one plain sentence, what it printed is for engineers, and a taken port is said the same way', async () => {
    setCommands({ start: `node -e "console.log('booting'); console.error('Error: Cannot find module express'); process.exit(1)"` });
    const apps = runner();
    apps.start();
    const s = await apps.settled();
    expect(s.state).toBe('failed');
    expect(s.error).toBe('It stopped while starting.');
    expect(s.detail).toContain('Error: Cannot find module express');

    // The app's real port differs from its address: the crash names the port that is taken.
    const taken = await freePort();
    const yours = http.createServer().listen(taken, '127.0.0.1');
    try {
      setCommands({ start: `node -e "require('http').createServer().listen(${taken}, '127.0.0.1')"` });
      apps.start();
      const busy = await apps.settled();
      expect(busy.error).toBe('Another program on this computer is using what roomflow needs.');
      expect(busy.busy?.port).toBe(taken);
      expect(busy.detail).toContain(`listens on port ${taken}`);
    } finally {
      yours.close();
    }
  }, 40_000);

  it('waits only so long for the address, then stops it and says so', async () => {
    setCommands({ start: 'node -e "setInterval(() => {}, 1000)"' });
    const apps = runner(1500);
    apps.start();
    const s = await apps.settled();
    expect(s.state).toBe('failed');
    expect(s.error).toBe('It did not answer within 2 seconds.');
    expect(s.detail).toContain(`It did not answer at http://localhost:${port}.`);
  }, 30_000);

  it('an app with no address set runs at the address it prints', async () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, commands: { start: `node -e "require('http').createServer((q, r) => r.end('hi')).listen(${port}, '127.0.0.1', () => console.log('Local: http://localhost:${port}/'))"` } });
    const apps = runner();
    apps.start();
    const s = await apps.settled();
    expect(s.state).toBe('running');
    expect(s.address).toBe(`http://localhost:${port}`);
  }, 30_000);

  it('without a start command it says how to go on', () => {
    writeMeta(bp, { ...readMeta(bp), commands: {} });
    expect(() => runner().start()).toThrow('squad-kit does not know how to start roomflow yet. Ask the Architect to find it, or type the start command.');
  });

  it('an app started outside the board (squad app start in a terminal) shows as running there, and the board can stop it', async () => {
    const terminal = runner();
    terminal.start();
    expect((await terminal.settled()).state).toBe('running');
    const board = runner();
    const seen = await board.statusOf();
    expect(seen).toMatchObject({ state: 'running', elsewhere: true, address: `http://localhost:${port}` });
    expect(() => board.start()).toThrow('started outside the board');
    await board.stop();
    await terminal.exited();
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(false);
  }, 40_000);

  it('the board closing stops every app it started, the whole process group', async () => {
    const apps = appRunner(bp);
    apps.start();
    const s = await apps.settled();
    const helper = path.join(s.dir, 'helper.beat');
    expect(await beating(helper)).toBe(true);
    stopApps(bp);
    await apps.exited();
    const until = Date.now() + 3000;
    while ((await beating(helper)) && Date.now() < until) await sleep(100);
    expect(await beating(helper)).toBe(false);
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(bp.localDir, 'apps.json'), 'utf8'))['.'].pid).toBeUndefined();
  }, 30_000);
});
