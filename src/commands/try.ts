import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import { boardExists, requireTicket, type BoardPaths } from '../board/store.js';
import { TryRunner, type TryStatus } from '../engine/try-app.js';
import { boardApi, type BoardApi } from './app.js';

/**
 * `squad try <ticket>`: Try it yourself from the terminal. It runs the ticket's own copy of the app, with the change in
 * it and nothing merged. With the board open each command is the board's own REST call, so the board and the terminal
 * show the same copy. Without it, the copy runs here until Ctrl-C, and stops when the ticket moves on.
 */

export interface TryCliOptions {
  stop?: boolean;
  status?: boolean;
}

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function board(): BoardPaths {
  const { bp } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  if (!boardExists(bp)) throw new Error('This project has no board yet. Run: squad console');
  return bp;
}

/** How it stands, the way the panel says it. True while the copy runs. */
function report(s: TryStatus): boolean {
  if (s.state === 'running') {
    ui.success(`${s.ticket}'s own copy of the app runs at ${s.url}. Nothing is merged.`);
    if (s.pages?.length) {
      out('  Where to look:');
      for (const p of s.pages) out(`    ${kleur.bold(p.url)}`);
    } else out(`  Open it: ${kleur.bold(s.url ?? '')}`);
    out(`  Stop it: ${cmd(`squad try ${s.ticket} --stop`)}`);
    return true;
  }
  if (s.state === 'failed') {
    ui.failure(`${s.error ?? 'The app did not start.'} What it printed is in the ticket's activity: ${cmd(`squad show ${s.ticket}`)}`);
    out(`  Try again: ${cmd(`squad try ${s.ticket}`)}`);
    return false;
  }
  if (s.state === 'starting') {
    ui.step(`${s.ticket}'s own copy of the app is starting…`);
    return false;
  }
  if (!s.can) ui.info(s.why ?? `${s.ticket} cannot be tried now.`);
  else ui.info(`${s.ticket}'s copy of the app is not running. Try it yourself: ${cmd(`squad try ${s.ticket}`)}`);
  if (s.other) out(`  ${s.other}'s copy runs now. Starting this one stops it.`);
  return false;
}

/** The board starts the copy: follow it until it runs or fails. */
async function follow(api: BoardApi, first: TryStatus): Promise<boolean> {
  const at = `/tickets/${encodeURIComponent(first.ticket)}/try`;
  let s = first;
  if (s.state === 'starting') ui.step(`Starting ${s.ticket}'s own copy of the app, with the change in it…`);
  while (s.state === 'starting') {
    await sleep(500);
    s = await api.call<TryStatus>('GET', at);
  }
  return report(s);
}

/** squad-kit is not open: the copy runs here, in this terminal, until Ctrl-C or until the ticket moves on. */
async function runHere(runner: TryRunner, id: string, stopAsked: Promise<unknown>): Promise<boolean> {
  ui.info('squad-kit is not open, so the copy runs here until you press Ctrl-C. With squad-kit open, it runs from the board.');
  const first = runner.start(id);
  ui.step(`Starting ${first.ticket}'s own copy of the app, with the change in it…`);
  const s = await Promise.race([runner.settled(id), stopAsked.then(() => null)]);
  if (!s) {
    await runner.stop(id);
    ui.info('Stopped it.');
    return true;
  }
  if (!report(s)) return false;
  ui.info('Press Ctrl-C to stop it.');
  let asked = false;
  void stopAsked.then(() => (asked = true));
  // The runner stops it by itself when the ticket moves on: Looks right, Something's wrong, Delete.
  while (!asked && runner.status(id).state === 'running') await sleep(500);
  const after = runner.status(id);
  await runner.stop(id);
  if (asked) ui.info(`Stopped ${after.ticket}'s copy of the app.`);
  else if (after.state === 'failed') ui.failure(after.error ?? 'The app stopped by itself.');
  else ui.info(`${after.ticket} moved on, so its copy of the app stopped.`);
  return asked || after.state !== 'failed';
}

/**
 * One `squad try` call on a project: through the open board's API when there is one, here otherwise. True when it did
 * what was asked (for a start: the copy ran).
 */
export async function tryWith(bp: BoardPaths, api: BoardApi | null, ticket: string, opts: TryCliOptions = {}, here?: { runner?: TryRunner; stopAsked?: Promise<unknown> }): Promise<boolean> {
  const id = requireTicket(bp, ticket).id;
  const at = `/tickets/${encodeURIComponent(id)}/try`;
  if (opts.stop) {
    if (!api) {
      ui.info('squad-kit is not open, so no copy of the app runs from the board. A copy you started here with squad try stops with Ctrl-C.');
      return true;
    }
    await api.call<TryStatus>('POST', `${at}/stop`);
    ui.success(`Stopped ${id}'s copy of the app.`);
    return true;
  }
  if (opts.status) {
    const s = api ? await api.call<TryStatus>('GET', at) : (here?.runner ?? new TryRunner(bp)).status(id);
    report(s);
    if (!api) out(kleur.gray('  squad-kit is not open. The copy runs while it is open, or here with squad try.'));
    return true;
  }
  if (api) return follow(api, await api.call<TryStatus>('POST', at));
  let asked!: () => void;
  const stopAsked =
    here?.stopAsked ??
    new Promise<void>((r) => {
      asked = r;
      process.once('SIGINT', () => asked());
      process.once('SIGTERM', () => asked());
    });
  return runHere(here?.runner ?? new TryRunner(bp), id, stopAsked);
}

/** `squad try <ticket> [--stop] [--status]` */
export async function runTry(ticket: string, opts: TryCliOptions): Promise<void> {
  const bp = board();
  const ok = await tryWith(bp, boardApi(bp), ticket, opts);
  if (!ok && !opts.stop && !opts.status) process.exitCode = 1;
}
