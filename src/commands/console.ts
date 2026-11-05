import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import open from 'open';
import * as ui from '../ui/index.js';
import { isInteractive } from '../ui/tty.js';
import { buildPaths, findSquadRoot, type SquadPaths } from '../core/paths.js';
import { startConsoleServer, startedToOutlive, type ConsoleServer } from '../console/server.js';
import { printErrors } from '../core/app-log.js';
import { installCrashNet } from '../core/crash-net.js';
import { boardPaths } from '../board/store.js';
import { isOwnFolder, prepareProject } from '../engine/setup.js';
import { setupView } from '../board/first-run.js';
import { followSetup } from './overview.js';
import { allEnded, killAll } from '../engine/process-group.js';
import { readInstalledPackage } from '../core/package-info.js';
import {
  buildStamp,
  readAppInfo,
  readConsoleInfo,
  runningApp,
  runningConsole,
  stopConsole,
  writeAppInfo,
  type ConsoleInfo,
} from '../board/console-info.js';

export interface ConsoleOptions {
  port?: number;
  /** Commander negates `--no-open` to `open: false`. */
  open?: boolean;
  token?: string;
  /** Stop squad-kit if it runs already, then start a fresh one. */
  restart?: boolean;
  /** Set up a folder without squad-kit without asking first. */
  yes?: boolean;
}

/** Plain `squad`: the one app with every project (ADR-001). */
export type AppOptions = Omit<ConsoleOptions, 'yes'>;

const DEFAULT_PORT = 4571;
/** A board run by a keeper (see restartBoard) exits with this code to ask the keeper for a fresh one. */
const RESTART_EXIT = 75;
const KEEPER_ENV = 'SQUAD_CONSOLE_KEEPER';

/**
 * The project for this terminal: the nearest folder with squad-kit (or the one --project names), or this folder, to
 * be set up. A home folder or the disk's top folder is never set up: a project needs its own folder.
 */
async function projectHere(opts: ConsoleOptions): Promise<string | null> {
  const found = findSquadRoot();
  if (found) return found;
  const here = process.cwd();
  if (!isOwnFolder(here)) {
    throw new Error('squad-kit works inside a project folder. Open the terminal in your project folder (or a new, empty one) and run: squad console. To open squad-kit with all your projects, run: squad');
  }
  if (isInteractive() && !opts.yes && !(await confirm({ message: `${here} has no squad-kit yet. Set it up here?`, default: true }))) return null;
  ui.step(`Setting up squad-kit in ${here}`);
  return here;
}

/** Read once: the tools the squad starts don't need to see it. */
function takeKeeperFlag(): boolean {
  const underKeeper = process.env[KEEPER_ENV] === '1';
  delete process.env[KEEPER_ENV];
  return underKeeper;
}

function olderBuild(info: Partial<ConsoleInfo>): boolean {
  return !info.build || info.build < buildStamp();
}

/** `squad console` in a folder: adds that project to the app and opens it, starting the app when it is not open. */
export async function runConsole(opts: ConsoleOptions): Promise<void> {
  const underKeeper = takeKeeperFlag();
  const root = await projectHere(opts);
  if (!root) return;
  const app = runningApp();

  // A board of this project alone, from before the one app, still runs: one squad per project, so point to it.
  const own = runningConsole(boardPaths(buildPaths(root).squadDir));
  if (own && own.pid !== app?.pid) {
    if (!opts.restart) {
      const link = own.port && own.token ? `http://127.0.0.1:${own.port}/?t=${own.token}` : null;
      ui.banner();
      ui.blank();
      ui.info(`This project's board is already open${own.startedAt ? ` (started ${new Date(own.startedAt).toLocaleTimeString()})` : ''}.`);
      if (link) ui.info(`Open it: ${link}`);
      else ui.info(`It runs in another terminal (process ${own.pid}).`);
      if (olderBuild(own)) ui.warning('It runs an older squad-kit. Restart it to use the new one: squad console --restart');
      else ui.info('To restart it: squad console --restart');
      if (link && opts.open !== false) await open(link).catch(() => undefined);
      return;
    }
    ui.info('Stopping the board that is running now…');
    if (!(await stopConsole(own.pid))) throw new Error(`The running board (process ${own.pid}) did not stop. Close it with Ctrl-C in its terminal.`);
  }

  if (app && !opts.restart) {
    await addToRunningApp(app, root, opts);
    return;
  }
  if (app) await stopApp(app);

  // Set up what is missing, and move a board from before ADR-001 once, now that nothing runs it.
  const ready = prepareProject(root);
  for (const line of ready.did) ui.success(line);
  // A new project, or one still getting set up: the setup page opens, and this terminal prints each step as it goes.
  const sv = setupView(ready.bp);
  const follow = sv && !sv.ready && !sv.approved ? ready.bp : undefined;
  await serveApp({ first: ready.paths, follow, opts, underKeeper, title: 'squad console', restartWith: ['console', '--no-open', '--project', root] });
}

/** Plain `squad`, from any folder: the one app, with Home, every project and one Waiting for you list. */
export async function runApp(opts: AppOptions): Promise<void> {
  const underKeeper = takeKeeperFlag();
  const app = runningApp();
  if (app && !opts.restart) {
    const link = `http://127.0.0.1:${app.port}/?t=${app.token}`;
    ui.banner();
    ui.blank();
    ui.info(`squad-kit is open already${app.startedAt ? ` (started ${new Date(app.startedAt).toLocaleTimeString()})` : ''}.`);
    ui.info(`Open it: ${link}`);
    if (olderBuild(app)) ui.warning('It runs an older squad-kit. Restart it to use the new one: squad --restart');
    else ui.info('To restart it: squad --restart');
    if (opts.open !== false) await open(link).catch(() => undefined);
    return;
  }
  if (app) await stopApp(app);
  await serveApp({ opts, underKeeper, title: 'squad-kit', restartWith: ['--no-open'] });
}

async function stopApp(app: ConsoleInfo & { pid: number }): Promise<void> {
  ui.info('Stopping squad-kit, which is running now…');
  if (!(await stopConsole(app.pid))) throw new Error(`squad-kit (process ${app.pid}) did not stop. Close it with Ctrl-C in its terminal.`);
}

/** The app runs already: it adds the project (setting it up the same way) and this terminal prints its link. */
async function addToRunningApp(app: ConsoleInfo & { pid: number }, root: string, opts: ConsoleOptions): Promise<void> {
  const base = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${base}/api/v1/app/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ folder: root }),
  }).catch(() => null);
  if (!res) throw new Error(`squad-kit runs (process ${app.pid}) but does not answer on port ${app.port}. Restart it: squad console --restart`);
  const data = (await res.json().catch(() => ({}))) as { name?: string; url?: string; did?: string[]; added?: boolean; setup?: { status: string }; error?: string };
  if (!res.ok || !data.url) {
    throw new Error(`${data.error ?? `squad-kit could not add this project (${res.status}).`}${olderBuild(app) ? ' It runs an older squad-kit. Restart it: squad console --restart' : ''}`);
  }
  const bp = boardPaths(buildPaths(root).squadDir);
  const setup = data.did?.length ? setupView(bp) : null;
  const fresh = Boolean(setup && !setup.ready && !setup.approved);
  const link = `${base}${fresh ? data.url.replace(/\/board$/, '/setup') : data.url}?t=${app.token}`;
  ui.banner();
  ui.blank();
  for (const line of data.did ?? []) ui.success(line);
  ui.info(data.added ? `Added ${data.name} to squad-kit, which is open already.` : `${data.name} is open in squad-kit.`);
  ui.info(`Open it: ${link}`);
  if (olderBuild(app)) ui.warning('squad-kit runs an older version. Restart it to use the new one: squad console --restart');
  if (opts.open !== false) await open(link).catch(() => undefined);
  if (fresh) await followHere(bp);
}

/** The setup's steps, printed here as they go, until the overview is ready. Ctrl-C stops watching, not the setup. */
async function followHere(bp: ReturnType<typeof boardPaths>): Promise<void> {
  ui.blank();
  ui.step('Getting to know the project (Ctrl-C stops watching; the setup keeps going):');
  await new Promise<void>((done) => {
    const stop = followSetup(bp, () => {
      stop();
      done();
    });
  });
}

/** Starts the app, prints its link, and runs until Ctrl-C (or a restart from the board). */
async function serveApp(a: { first?: SquadPaths; follow?: ReturnType<typeof boardPaths>; opts: AppOptions; underKeeper: boolean; title: string; restartWith: string[] }): Promise<void> {
  const { opts } = a;
  // The same port and link as last time, so an open browser tab keeps working after a restart. The first time, a
  // project's own board from before the one app gives its port and link.
  const prior = readAppInfo() ?? (a.first ? readConsoleInfo(boardPaths(a.first.squadDir)) : null);
  const portOpt = opts.port;
  const requestedPort =
    portOpt !== undefined && !Number.isNaN(portOpt) && portOpt >= 0 ? portOpt : (prior?.port ?? DEFAULT_PORT);
  const token = opts.token ?? prior?.token ?? randomBytes(32).toString('hex');
  const build = buildStamp();

  // Errors also print here, in the terminal that runs the app, as they reach the app log.
  printErrors(true);
  const server: ConsoleServer = await startConsoleServer({ paths: a.first, app: true, requestedPort, token, build, keepOnHangup: startedToOutlive() });
  // From here on, one error nobody caught no longer ends every project's squad.
  installCrashNet();
  const info = { pid: process.pid, port: server.port, token, startedAt: new Date().toISOString(), version: readInstalledPackage().version, build };
  writeAppInfo(info);
  // The Update button: look for a new squad-kit now and once a day (Settings › About turns it off).
  server.updates.watch();

  const firstId = a.first ? server.projects.first : null;
  const url = `http://127.0.0.1:${server.port}${firstId ? `/p/${firstId}/${a.follow ? 'setup' : 'board'}` : '/'}?t=${token}`;
  const rows = server.projects.summaries();

  ui.banner();
  ui.divider(a.title);
  ui.summaryBox(` ${a.title} `, [
    ...(a.first ? [{ key: 'project', value: resolve(a.first.root) }] : []),
    { key: 'projects', value: String(rows.filter((r) => r.open).length) },
    { key: 'url', value: url },
    { key: 'token', value: `${token.slice(0, 8)}…` },
    { key: 'port', value: String(server.port) },
  ]);
  if (server.port !== requestedPort) {
    ui.warning(`port ${requestedPort} was busy — bound to ${server.port} instead`);
  }
  for (const r of rows.filter((x) => !x.open)) ui.warning(`${r.name} did not open: ${r.why}`);
  ui.blank();
  ui.step('Next:');
  ui.info('1) Work from the board, or from this terminal: try `squad inbox` in a second tab.');
  ui.info('2) Every button on the board shows its terminal command.');
  ui.info('3) Add more projects from Home, or run `squad console` in their folder.');
  ui.info("4) Press Ctrl-C here to stop squad-kit when you're done.");

  if (opts.open !== false) {
    try {
      await open(url);
    } catch {
      ui.warning('Could not open a browser automatically. Copy the URL above into your browser.');
    }
  } else {
    ui.info('Browser auto-open disabled (--no-open). Copy the URL above into your browser.');
  }
  // A new project: each step of its setup prints here as it goes.
  let stopFollow = () => {};
  if (a.follow) {
    ui.blank();
    ui.step('Getting to know the project:');
    stopFollow = followSetup(a.follow, () => stopFollow());
  }

  // Block until SIGINT/SIGTERM. The server attaches its own listeners that resolve `done`.
  await server.done;
  stopFollow();
  writeAppInfo({ ...info, pid: null });
  if (server.restartRequested()) {
    ui.info('Restarting the board…');
    await restartBoard(a.underKeeper, a.restartWith);
    return;
  }
  // Quitting leaves nothing behind either: the runs end, and what they left in squad-kit's copies is stopped.
  await endRuns();
  ui.info('console stopped');
}

/** How long a restart waits for the running agents, checks and apps to end after their Stop. */
const RESTART_WAIT_MS = 10_000;

/**
 * The board stopped every run as it closed. A restart or a quit waits for them to end first (10 seconds at most), and
 * for squad-kit to stop what they left running in its copies (engine/leftovers.ts), so the new board never finds a
 * half-ended step or a server still holding its port; whatever is left then is killed.
 */
export async function endRuns(waitMs = RESTART_WAIT_MS): Promise<boolean> {
  if (await allEnded(waitMs)) return true;
  killAll();
  return allEnded(1000);
}

/**
 * Restart from the board: a fresh process loads the newest squad-kit, in this same terminal, on the same link
 * (app.json keeps the port and token). It never leaves the old board alive as the parent of the new one.
 */
async function restartBoard(underKeeper: boolean, command: string[]): Promise<void> {
  const args = [...process.execArgv, process.argv[1]!, ...command];
  await endRuns();
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
