import fs from 'node:fs';
import path from 'node:path';
import type { RunningApp } from './checks.js';
import { KILL_AFTER_MS } from './process-group.js';

/**
 * One turn per copy. In a story's copy, a run of the project's checks and a start of its app never overlap: a test run
 * often starts the app itself (Playwright's webServer runs `next dev`), and some frameworks allow only one dev server
 * per folder, so the second one stops at once ("Another next dev server is already running"). Each waits for the other,
 * in the order they came, per folder: different copies never wait for each other. The wait has a cap, and whoever
 * waits is told what for, so nothing hangs without a word. An app squad-kit already runs in the copy stops before the
 * checks run there (stopAppsIn), for the same reason.
 */

/** What holds a copy's turn: a run of the checks (the project's own, a team's gate, an agent's run_checks) or an app start. */
export type TurnKind = 'checks' | 'app';

/** The longest one waits for its turn: a full test run fits, a hung one does not. */
export const TURN_WAIT_MS = 10 * 60_000;

const STOPPED = 'You stopped the squad.';

/** The turn did not come within the cap: what held it, and how long it waited. */
export class TurnTimeout extends Error {
  constructor(
    readonly holder: TurnKind,
    readonly ms: number,
  ) {
    super(`waited ${minutes(ms)} for ${holderWords(holder)} in this copy, and ${holder === 'checks' ? 'they still run' : 'it still goes on'}`);
    this.name = 'TurnTimeout';
  }
}

export interface Turn {
  /** Hands the turn to the next one waiting. Once is enough; more does nothing. */
  release(): void;
}

interface Place {
  kind: TurnKind;
  /** Called when this one's turn comes. */
  go(): void;
}

/** Each copy's line, by its real path: the first one holds the turn, the rest wait in order. */
const lines = new Map<string, Place[]>();

/** One spelling for a folder, so /var and /private/var on a Mac are one copy. */
function keyOf(dir: string): string {
  const plain = path.resolve(dir);
  try {
    return fs.realpathSync.native(plain);
  } catch {
    return plain;
  }
}

/** "10 minutes", "1 minute": a wait in words. */
export function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function holderWords(kind: TurnKind): string {
  return kind === 'checks' ? 'the tests running' : 'the app starting';
}

/** What holds the copy's turn now, or null when nothing does. */
export function turnHolder(dir: string): TurnKind | null {
  return lines.get(keyOf(dir))?.[0]?.kind ?? null;
}

/**
 * The copy's turn for `kind`: at once when nothing holds it, else once what is ahead has released it. `onWait` hears
 * what holds it, once, when this one has to wait. Rejects on the Stop, or with TurnTimeout after `waitMs`.
 */
export function takeTurn(dir: string, kind: TurnKind, o: { signal?: AbortSignal; waitMs?: number; onWait?(holder: TurnKind): void } = {}): Promise<Turn> {
  if (o.signal?.aborted) return Promise.reject(new Error(STOPPED));
  const key = keyOf(dir);
  const line = lines.get(key) ?? [];
  lines.set(key, line);
  const place: Place = { kind, go: () => undefined };
  line.push(place);
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    const at = line.indexOf(place);
    if (at < 0) return;
    line.splice(at, 1);
    if (!line.length) {
      if (lines.get(key) === line) lines.delete(key);
      return;
    }
    if (at === 0) line[0]!.go();
  };
  const turn: Turn = { release };
  if (line[0] === place) return Promise.resolve(turn);
  const holder = line[0]!.kind;
  return new Promise<Turn>((resolve, reject) => {
    const ms = o.waitMs ?? TURN_WAIT_MS;
    const end = (err: Error) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onStop);
      release();
      reject(err);
    };
    const onStop = () => end(new Error(STOPPED));
    const timer = setTimeout(() => end(new TurnTimeout(turnHolder(dir) ?? holder, ms)), ms);
    o.signal?.addEventListener('abort', onStop, { once: true });
    place.go = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onStop);
      resolve(turn);
    };
    // Told last, when its place in the line is ready for its turn.
    o.onWait?.(holder);
  });
}

/**
 * `work` in the turn of every copy in `dirs`, released when it ends however it ends. The turns are taken in one order
 * (by path), so two who need the same copies never each hold one and wait for the other.
 */
export async function inTurn<T>(dirs: string | string[], kind: TurnKind, work: () => Promise<T>, o: { signal?: AbortSignal; waitMs?: number; onWait?(holder: TurnKind): void } = {}): Promise<T> {
  const keys = [...new Set((Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean).map(keyOf))].sort();
  const held: Turn[] = [];
  try {
    for (const k of keys) held.push(await takeTurn(k, kind, o));
    return await work();
  } finally {
    for (const t of held) t.release();
  }
}

/* ── the apps squad-kit runs in a copy ───────────────── */

/** How one app stops for a run of the checks: true when it was still running and stopped. */
type StopForChecks = () => Promise<boolean>;

/** The apps squad-kit runs in each copy now, by its real path: the one an agent asked for, one kept for the proof. */
const apps = new Map<string, Set<StopForChecks>>();

/**
 * squad-kit runs an app in `dir`: a run of the checks there stops it first (stopAppsIn), as the tests often start their
 * own and some frameworks allow one per folder. The return takes it off the list. A product's parts are never on it.
 */
export function appIn(dir: string, stop: StopForChecks): () => void {
  const key = keyOf(dir);
  const set = apps.get(key) ?? new Set<StopForChecks>();
  apps.set(key, set);
  set.add(stop);
  return () => {
    set.delete(stop);
    if (!set.size && apps.get(key) === set) apps.delete(key);
  };
}

/** Before a run of the checks in `dirs`: every app squad-kit runs there stops, and is waited for. How many stopped. */
export async function stopAppsIn(dirs: string | string[]): Promise<number> {
  const keys = [...new Set((Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean).map(keyOf))];
  const all = keys.flatMap((k) => [...(apps.get(k) ?? [])]);
  const stopped = await Promise.all(all.map((stop) => stop().catch(() => false)));
  return stopped.filter(Boolean).length;
}

/** Waits until a stopped app has gone, for at most the time its group gets before it is killed. */
export async function untilEnded(app: RunningApp): Promise<void> {
  const until = Date.now() + KILL_AFTER_MS + 1000;
  while (app.ended && !app.ended() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

/** The plain words for one that waits: "The tests are running in this copy. The app starts when they finish." */
export function waitWords(holder: TurnKind, wants: TurnKind): string {
  if (holder === 'checks') return wants === 'app' ? 'The tests are running in this copy. The app starts when they finish.' : 'Other checks are running in this copy. These run when they finish.';
  return wants === 'app' ? 'The app is already starting in this copy. This start waits until that one ends.' : 'The app is starting in this copy. The checks run once it is up.';
}

/**
 * The process another dev server of the same folder runs as, when the app's own words say one already runs there and
 * name it; else null. Next.js: "Another next dev server is already running. … - PID: 94520 … or run kill 94520 to stop
 * it and start a new one." Only the words of an app that stopped while starting are read, so a port in use is not this.
 */
export function otherDevServer(said: string): number | null {
  const text = said.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/\balready running\b|\bstart a new one\b/i.test(text)) return null;
  const m = /\bkill\s+(\d{2,7})\b|\btaskkill\s+\/PID\s+(\d{2,7})\b|\bPID:?\s+(\d{2,7})\b/i.exec(text);
  const pid = m ? Number(m[1] ?? m[2] ?? m[3]) : 0;
  return pid > 1 ? pid : null;
}

/**
 * Starts an app, and once more when its framework said another dev server already runs in its folder: after `stop` has
 * stopped that very process, when squad-kit may (a program it left in that copy). Otherwise the error says so, for
 * engineers and the agent.
 */
export async function startPastOther(start: () => Promise<RunningApp>, stop: (pid: number) => Promise<boolean>, log?: (text: string) => void): Promise<RunningApp> {
  try {
    return await start();
  } catch (err) {
    const said = (err as Error)?.message ?? String(err);
    const pid = otherDevServer(said);
    if (!pid) throw err;
    if (!(await stop(pid).catch(() => false))) {
      throw new Error(`Another dev server already runs in this copy (process ${pid}), and squad-kit may not stop it: it is not a program squad-kit left there. If you started it yourself, stop it first.\n${said}`);
    }
    log?.(`Stopped process ${pid}, another dev server left in the copy, and started the app again`);
    return await start();
  }
}
