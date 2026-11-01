import { randomBytes } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path, { resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import open from 'open';
import * as ui from '../ui/index.js';
import { isInteractive } from '../ui/tty.js';
import { buildPaths, findSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { startConsoleServer, type ConsoleServer } from '../console/server.js';
import { boardExists, boardPaths } from '../board/store.js';
import { openBoard } from '../board/move.js';
import { ensureLiveBoard, setupProject } from '../engine/setup.js';
import { readInstalledPackage } from '../core/package-info.js';
import { buildStamp, readConsoleInfo, runningConsole, stopConsole, writeConsoleInfo } from '../board/console-info.js';

export interface ConsoleOptions {
  port?: number;
  /** Commander negates `--no-open` to `open: false`. */
  open?: boolean;
  token?: string;
  /** Stop the board that is already running for this project and start a fresh one. */
  restart?: boolean;
  /** Set up a folder without squad-kit without asking first. */
  yes?: boolean;
}

const DEFAULT_PORT = 4571;
/** A board run by a keeper (see restartBoard) exits with this code to ask the keeper for a fresh one. */
const RESTART_EXIT = 75;
const KEEPER_ENV = 'SQUAD_CONSOLE_KEEPER';

/**
 * The project for this terminal: the nearest folder with squad-kit, or this folder, set up now. A home folder or the
 * disk's top folder is never set up: a project needs its own folder.
 */
async function projectHere(opts: ConsoleOptions): Promise<string | null> {
  const found = findSquadRoot();
  if (found) return found;
  const here = process.cwd();
  if (here === os.homedir() || here === path.parse(here).root) {
    throw new Error('squad-kit works inside a project folder. Open the terminal in your project folder (or a new, empty one) and run: squad console');
  }
  if (isInteractive() && !opts.yes && !(await confirm({ message: `${here} has no squad-kit yet. Set it up here?`, default: true }))) return null;
  ui.step(`Setting up squad-kit in ${here}`);
  setupProject(here);
  ui.success('Project files: .squad/ with the settings and a README');
  return here;
}

/** Every project squad-kit works on is a git repo; on a Mac, git comes with the developer tools. */
function requireGit(): void {
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    throw new Error('squad-kit needs git. On a Mac, run this once, then run squad console again: xcode-select --install');
  }
}

export async function runConsole(opts: ConsoleOptions): Promise<void> {
  // Read once: the tools the squad starts don't need to see it.
  const underKeeper = process.env[KEEPER_ENV] === '1';
  delete process.env[KEEPER_ENV];
  const root = await projectHere(opts);
  if (!root) return;
  const paths = buildPaths(root);
  // loadConfig also validates the YAML — surface schema problems before binding a port.
  const config = loadConfig(paths.configFile);
  // One board per project: a second one would run a second squad on the same tickets.
  let bp = boardPaths(paths.squadDir);
  const running = runningConsole(bp);
  if (running && !opts.restart) {
    const link = running.port && running.token ? `http://127.0.0.1:${running.port}/?t=${running.token}` : null;
    ui.banner();
    ui.blank();
    ui.info(`This project's board is already open${running.startedAt ? ` (started ${new Date(running.startedAt).toLocaleTimeString()})` : ''}.`);
    if (link) ui.info(`Open it: ${link}`);
    else ui.info(`It runs in another terminal (process ${running.pid}).`);
    if (!running.build || running.build < buildStamp()) {
      ui.warning('It runs an older squad-kit. Restart it to use the new one: squad console --restart');
    } else {
      ui.info('To restart it: squad console --restart');
    }
    if (link && opts.open !== false) await open(link).catch(() => undefined);
    return;
  }
  if (running) {
    ui.info('Stopping the board that is running now…');
    if (!(await stopConsole(running.pid))) throw new Error(`The running board (process ${running.pid}) did not stop. Close it with Ctrl-C in its terminal.`);
  }

  // A board from before ADR-001 moves to the new layout once, now that nothing runs.
  const opened = openBoard(paths.squadDir);
  bp = opened.bp;
  if (opened.moved) {
    const m = opened.moved;
    ui.success(`Moved this board to the new layout: ${m.tickets} tickets, ${m.decisions} decisions and ${m.releases} releases, all checked.`);
    ui.info(`The project's files are in .squad/; this computer's are in ${m.localDir}. A copy of the old files: ${m.backup}`);
  }
  // A project without a board gets a live one; the Architect reads the project first.
  if (!boardExists(bp)) requireGit();
  const setup = ensureLiveBoard(bp, config.project.name);
  bp = setup.bp;
  for (const line of setup.did) ui.success(line);
  if (setup.did.length) ui.info('The Architect reads the project now. Follow it on the board.');

  // The same port and link as last time, so an open browser tab keeps working after a restart.
  const prior = readConsoleInfo(bp);
  const portOpt = opts.port;
  const requestedPort =
    portOpt !== undefined && !Number.isNaN(portOpt) && portOpt >= 0 ? portOpt : (prior?.port ?? DEFAULT_PORT);
  const token = opts.token ?? prior?.token ?? randomBytes(32).toString('hex');
  const build = buildStamp();

  const server: ConsoleServer = await startConsoleServer({ paths, requestedPort, token, build });
  const info = { pid: process.pid, port: server.port, token, startedAt: new Date().toISOString(), version: readInstalledPackage().version, build };
  writeConsoleInfo(bp, info);

  const url = `http://127.0.0.1:${server.port}/?t=${token}`;

  ui.banner();
  ui.divider('squad console');
  ui.summaryBox(' squad console ', [
    { key: 'project', value: resolve(paths.root) },
    { key: 'url', value: url },
    { key: 'token', value: `${token.slice(0, 8)}…` },
    { key: 'port', value: String(server.port) },
  ]);
  if (server.port !== requestedPort) {
    ui.warning(`port ${requestedPort} was busy — bound to ${server.port} instead`);
  }
  ui.blank();
  ui.step('Next:');
  ui.info('1) Work from the board, or from this terminal: try `squad inbox` in a second tab.');
  ui.info('2) Every button on the board shows its terminal command.');
  ui.info("3) Press Ctrl-C here to stop the board when you're done.");

  if (opts.open !== false) {
    try {
      await open(url);
    } catch {
      ui.warning('Could not open a browser automatically. Copy the URL above into your browser.');
    }
  } else {
    ui.info('Browser auto-open disabled (--no-open). Copy the URL above into your browser.');
  }

  // Block until SIGINT/SIGTERM. The server attaches its own listeners that resolve `done`.
  await server.done;
  writeConsoleInfo(bp, { ...info, pid: null });
  if (server.restartRequested()) {
    ui.info('Restarting the board…');
    await restartBoard(underKeeper);
    return;
  }
  ui.info('console stopped');
}

/**
 * Restart from the board: a fresh process loads the newest squad-kit, in this same terminal, on the same link
 * (console.json keeps the port and token). It never leaves the old board alive as the parent of the new one.
 */
async function restartBoard(underKeeper: boolean): Promise<void> {
  const args = [...process.execArgv, process.argv[1]!, 'console', '--no-open'];
  await new Promise<void>((done) => process.stdout.write('', () => done()));
  // Node 22.15+ swaps this process for the new board: same pid, same terminal, nothing left behind.
  if (typeof process.execve === 'function' && process.platform !== 'win32') {
    process.execve(process.execPath, [process.execPath, ...args], process.env);
  }
  // Older Node can't. A process that exits hands the terminal back to the shell, and Ctrl-C with it, so the first
  // board stays on as a small keeper that runs one board at a time; each board it runs exits to be restarted.
  if (underKeeper) process.exit(RESTART_EXIT);
  // Ctrl-C reaches the board as well (same terminal): wait for it to stop rather than leave it behind.
  process.on('SIGINT', () => undefined);
  for (;;) {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, [KEEPER_ENV]: '1' } });
    const forward = () => child.kill('SIGTERM');
    process.on('SIGTERM', forward);
    const code = await new Promise<number>((done) => child.on('exit', (c) => done(c ?? 0)));
    process.off('SIGTERM', forward);
    if (code !== RESTART_EXIT) {
      process.exitCode = code;
      return;
    }
  }
}
