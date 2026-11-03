import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import { boardExists, readMeta, writeMeta, type BoardPaths } from '../board/store.js';
import { runningConsole } from '../board/console-info.js';
import { findApp, withAppCommands, type AppTicket, type NewVersion } from '../board/apps.js';
import { AppRunner, type AppStatus, type StartOptions } from '../engine/run-app.js';
import { shellArg } from '../utils/text.js';

/**
 * `squad app`: Your apps from the terminal. With the board open, each command is the board's own REST call, so the
 * board and the terminal show the same app. Without it, `squad app start` runs the app here, until Ctrl-C.
 */

type AppView = AppStatus & { includes?: AppTicket[]; fresh?: NewVersion };

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function board(): BoardPaths {
  const { bp } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  if (!boardExists(bp)) throw new Error('This project has no board yet. Run: squad console');
  return bp;
}

interface BoardApi {
  call<T>(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown): Promise<T>;
}

/** The open board's API for this project, or null when squad-kit is not open. */
function boardApi(bp: BoardPaths): BoardApi | null {
  const c = runningConsole(bp);
  if (!c?.port || !c.token) return null;
  const base = `http://127.0.0.1:${c.port}/p/${encodeURIComponent(bp.projectId)}/api/v1`;
  return {
    async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown): Promise<T> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      }).catch(() => null);
      if (!res) throw new Error(`squad-kit runs (process ${c.pid}) but does not answer on port ${c.port}. Restart it: squad console --restart`);
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `squad-kit answered ${res.status}. It may run an older version: squad console --restart`);
      return data;
    },
  };
}

/** The name to put in a command: none when the project has one app. */
function refOf(bp: BoardPaths, name: string): string {
  return readMeta(bp).repos?.length ? ` ${shellArg(name)}` : '';
}

const at = (url?: string) => (url ?? '').replace(/^https?:\/\//, '');

function minutes(iso?: string): string {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just started' : `for ${m} min`;
}

/** One line for the app's state, the way the board says it. */
function stateLine(s: AppView): string {
  switch (s.state) {
    case 'running':
      return kleur.green(`Running at ${at(s.address)}`) + kleur.gray(`, ${minutes(s.since)}${s.elsewhere ? ', started outside the board' : ''}`);
    case 'starting':
      return kleur.yellow('Starting…');
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return kleur.red(`Failed: ${s.error ?? 'it did not start'}`);
    default:
      return s.up ? `Not running ${kleur.gray(`(something else answers at ${at(s.url)})`)}` : 'Not running';
  }
}

/** What the app does now, while it starts. */
function stepLine(s: AppView): string {
  if (s.step === 'setup') return `Setting it up first: ${s.setup}`;
  if (s.step === 'start') return `Starting: ${s.start}`;
  return `Getting the newest ${s.base}`;
}

/** The busy port, in plain words, with the way out. */
function busyLines(s: AppView, ref: string): void {
  const b = s.busy!;
  const who = b.program ? ` It is ${b.program} (process ${b.pid}).` : '';
  ui.failure(`${s.error}.${who}`);
  if (b.ours) out(`  squad-kit started it. Stop it and start ${s.name}: ${cmd(`squad app start${ref} --stop-other`)}`);
  if (b.nextPort) out(`  Or run ${s.name} on port ${b.nextPort} instead: ${cmd(`squad app start${ref} --next-port`)}`);
  if (!b.ours && !b.nextPort) {
    out(`  Close that program, then start again: ${cmd(`squad app start${ref}`)}`);
    out(`  Or give ${s.name} another address: ${cmd(`squad app set${ref} --url http://localhost:${b.port + 1}`)}`);
  }
}

/** How the start went. False when it did not start. */
function report(bp: BoardPaths, s: AppView, lines: string[] = []): boolean {
  const ref = refOf(bp, s.name);
  if (s.state === 'running') {
    ui.success(`${s.name} runs at ${s.address}, from squad-kit's copy of ${s.base}.`);
    if (s.includes?.length) out(`  Includes ${s.includes.map((t) => `${t.id} ${t.title}`).join(', ')}`);
    out(`  Open it: ${kleur.bold(s.address ?? '')}`);
    out(`  Stop it: ${cmd(`squad app stop${ref}`)}`);
    return true;
  }
  if (s.busy) {
    busyLines(s, ref);
    return false;
  }
  if (s.state === 'stopped') {
    ui.info(`${s.name} was stopped before it started.`);
    return false;
  }
  ui.failure(`${s.name} did not start: ${s.error ?? 'it stopped'}`);
  const last = lines.filter((l) => l.trim()).slice(-12);
  if (last.length) {
    out(kleur.gray('  The last lines it printed:'));
    for (const l of last) out(kleur.gray(`    ${l}`));
  }
  out(`  Try again: ${cmd(`squad app start${ref}`)}`);
  return false;
}

/** The board starts the app: follow its steps until it runs or fails. */
async function follow(bp: BoardPaths, api: BoardApi, name: string, first: AppView): Promise<void> {
  let said = '';
  let s = first;
  const enc = encodeURIComponent(name);
  while (s.state === 'starting') {
    const line = stepLine(s);
    if (line !== said) ui.step(line);
    said = line;
    await sleep(500);
    s = (await api.call<{ apps: AppView[] }>('GET', '/apps')).apps.find((a) => a.name === name) ?? s;
  }
  const lines = s.state === 'running' ? [] : (await api.call<{ lines: string[] }>('GET', `/apps/${enc}/output`)).lines;
  if (!report(bp, s, lines)) process.exitCode = 1;
}

/** squad-kit is not open: the app runs here, in this terminal, until Ctrl-C, and stops with it. */
async function runHere(bp: BoardPaths, name: string, opts: StartOptions, again: boolean): Promise<void> {
  const runner = new AppRunner(bp, { echo: (text) => process.stdout.write(kleur.gray(text)) });
  ui.info('squad-kit is not open, so the app runs here until you press Ctrl-C. With squad-kit open, it runs from the board.');
  let asked!: () => void;
  const stopAsked = new Promise<void>((r) => (asked = r));
  process.once('SIGINT', () => asked());
  process.once('SIGTERM', () => asked());
  const first = again ? await runner.restart(name, opts) : runner.start(name, opts);
  ui.step(stepLine(first));
  const s = await Promise.race([runner.settled(name), stopAsked.then(() => null)]);
  if (!s) {
    await runner.stop(name).catch(() => undefined);
    ui.info(`Stopped ${name}.`);
    return;
  }
  if (!report(bp, s, runner.lines(name))) {
    process.exitCode = 1;
    return;
  }
  ui.info('Press Ctrl-C to stop it.');
  const why = await Promise.race([stopAsked.then(() => 'stop' as const), runner.exited(name).then(() => 'ended' as const)]);
  if (why === 'stop') {
    await runner.stop(name).catch(() => undefined);
    ui.info(`Stopped ${name}.`);
    return;
  }
  const after = await runner.statusOf(name);
  ui.failure(after.error ?? `${name} stopped by itself.`);
  process.exitCode = 1;
}

async function startOrRestart(name: string | undefined, opts: StartOptions, again: boolean): Promise<void> {
  const bp = board();
  const app = findApp(readMeta(bp), name);
  const api = boardApi(bp);
  const body = { nextPort: Boolean(opts.nextPort), stopOther: Boolean(opts.stopOther) };
  if (!api) return runHere(bp, app.name, body, again);
  const first = await api.call<AppView>('POST', `/apps/${encodeURIComponent(app.name)}/${again ? 'restart' : 'start'}`, body);
  await follow(bp, api, app.name, first);
}

/** `squad app start [name]`: runs the app from squad-kit's copy of main. */
export async function runAppStart(name: string | undefined, opts: StartOptions): Promise<void> {
  await startOrRestart(name, opts, false);
}

/** `squad app restart [name]`: stops it, then starts it on the newest main. Also "Run the new version". */
export async function runAppRestart(name: string | undefined, opts: StartOptions): Promise<void> {
  await startOrRestart(name, opts, true);
}

/** `squad app stop [name]` */
export async function runAppStop(name: string | undefined): Promise<void> {
  const bp = board();
  const app = findApp(readMeta(bp), name);
  const api = boardApi(bp);
  if (api) await api.call('POST', `/apps/${encodeURIComponent(app.name)}/stop`);
  else await new AppRunner(bp).stop(app.name);
  ui.success(`Stopped ${app.name}.`);
}

/** `squad app status`: every app of the project, the way the board's sidebar shows it. */
export async function runAppStatus(): Promise<void> {
  const bp = board();
  const api = boardApi(bp);
  const apps = api ? (await api.call<{ apps: AppView[] }>('GET', '/apps')).apps : await new AppRunner(bp).status();
  out();
  out(`  ${kleur.bold('Your apps')}`);
  out();
  if (!apps.length) {
    out(kleur.gray('  This project has no app to run yet.'));
    out();
    return;
  }
  const w = Math.max(...apps.map((a) => a.name.length));
  const pad = ' '.repeat(w + 7);
  for (const a of apps as AppView[]) {
    const ref = refOf(bp, a.name);
    const dot = a.state === 'running' ? kleur.green('●') : a.state === 'failed' ? kleur.red('●') : a.state === 'starting' ? kleur.yellow('●') : kleur.gray('○');
    out(`  ${dot} ${kleur.bold(a.name.padEnd(w))}   ${stateLine(a)}`);
    if (!a.start) out(`${pad}Start command unknown. Set it: ${cmd(`squad app set${ref} --start "npm run dev" --url http://localhost:3000`)}  or ask the Architect: ${cmd('squad app find')}`);
    else if (a.state === 'running') {
      if (a.includes?.length) out(`${pad}${kleur.gray(`Includes ${a.includes.map((t) => `${t.id} ${t.title}`).join(', ')}`)}`);
      out(`${pad}Stop: ${cmd(`squad app stop${ref}`)}   Restart: ${cmd(`squad app restart${ref}`)}`);
    } else if (a.state !== 'starting') out(`${pad}Start: ${cmd(`squad app start${ref}`)}`);
    if (a.fresh) out(`${pad}${kleur.green(`${a.fresh.id} is in ${a.fresh.base}`)} · Run the new version: ${cmd(`squad app restart${ref}`)}`);
  }
  out();
  if (!api) out(kleur.gray('  squad-kit is not open. Apps run while it is open (squad console), or here with squad app start.'));
  if (!api) out();
}

/** `squad app set [name] --start <command> --url <address>`: "Type it" on the board. */
export async function runAppSet(name: string | undefined, opts: { start?: string; url?: string }): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  const app = findApp(meta, name);
  const api = boardApi(bp);
  if (api) await api.call('PUT', `/apps/${encodeURIComponent(app.name)}/commands`, { start: opts.start, url: opts.url });
  else writeMeta(bp, withAppCommands(meta, app.repo, opts));
  ui.success(`Saved how ${app.name} starts, in the project's settings.`);
  out(`  Start it: ${cmd(`squad app start${refOf(bp, app.name)}`)}`);
}

/** `squad app find`: "Ask the Architect to find it". The Architect reads the project again, with its run commands. */
export async function runAppFind(): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new Error('Only a live board reads the project. Set the start command yourself: squad app set --start "npm run dev"');
  const api = boardApi(bp);
  if (api) await api.call('POST', '/scan');
  else writeMeta(bp, { ...meta, scan: { status: 'pending' } });
  ui.success(api ? 'The Architect is reading the project to find how to start it.' : 'The Architect reads the project as soon as squad-kit is open: squad console');
  out(`  Then see what it found: ${cmd('squad app status')}`);
}
