import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import open from 'open';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { startConsoleServer, type ConsoleServer } from '../console/server.js';
import { boardPaths } from '../board/store.js';
import { ensureLiveBoard } from '../engine/setup.js';
import { readInstalledPackage } from '../core/package-info.js';
import { buildStamp, readConsoleInfo, runningConsole, stopConsole, writeConsoleInfo } from '../board/console-info.js';

export interface ConsoleOptions {
  port?: number;
  /** Commander negates `--no-open` to `open: false`. */
  open?: boolean;
  token?: string;
  /** Stop the board that is already running for this project and start a fresh one. */
  restart?: boolean;
}

const DEFAULT_PORT = 4571;

export async function runConsole(opts: ConsoleOptions): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  // loadConfig also validates the YAML — surface schema problems before binding a port.
  const config = loadConfig(paths.configFile);
  // A project without a board gets a live one; the Architect reads the project first.
  const bp = boardPaths(paths.squadDir);
  ensureLiveBoard(bp, config.project.name);

  // One board per project: a second one would run a second squad on the same tickets.
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
    // Restart from the board: a fresh process loads the newest squad-kit, in this same terminal, on the same link.
    ui.info('Restarting the board…');
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'console', '--no-open'], { stdio: 'inherit' });
    const code = await new Promise<number>((done) => child.on('exit', (c) => done(c ?? 0)));
    process.exitCode = code;
    return;
  }
  ui.info('console stopped');
}
