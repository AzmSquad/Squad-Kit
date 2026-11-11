import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import type { PhoneModule, PhoneSize } from '../../modules/phone/types.js';
import { ownDevice, phonesHome, savedDevices, type OwnDevice } from './devices.js';
import { aboutWords, noteStep, stepSeconds } from './times.js';

/**
 * One phone at a time, gently. squad-kit boots one of its own devices at a time, shared by every story through a queue
 * in this process and a lock file between squad-kit processes. Before booting it looks at the computer's free memory
 * and load, and when the computer is busy it waits and says so, never failing a story over it. A device shuts down
 * after 10 minutes unused, and when the board stops. Something else may keep a device up (an open Simulator window
 * boots it again after it shuts down): squad-kit then leaves it, and never fights it.
 */

/** Unused this long, squad-kit's phone shuts down. */
export const IDLE_MS = 10 * 60_000;
/** Below this much free memory (free, inactive and speculative pages), the computer is too busy to boot a phone. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** How often squad-kit looks again while the computer is busy, and how long it waits at most before it goes ahead. */
export const BUSY_LOOK_MS = 15_000;
export const BUSY_WAIT_MS = 10 * 60_000;
/** How often squad-kit looks at the lock another squad-kit holds. */
const LOCK_LOOK_MS = 2000;
/** How long after a shutdown squad-kit looks whether something booted the device again. */
const VIEWER_LOOK_MS = 5000;

/** The plain line while squad-kit waits for the computer: "The computer is busy. squad-kit waits a moment before starting the iPhone." */
export function busyWords(word: string): string {
  return `The computer is busy. squad-kit waits a moment before starting the ${word}.`;
}

/** The plain line while another squad-kit on this computer uses the phone. */
export function otherWords(word: string): string {
  return `Another squad-kit on this computer is using the ${word}. squad-kit waits for its turn.`;
}

/** `vm_stat`: the bytes free now, with the inactive and speculative pages the system gives back at once. */
export function freeMemoryOf(vmStat: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 4096);
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? NaN);
  const n = pages('free') + pages('inactive') + pages('speculative');
  return Number.isFinite(n) ? n * page : null;
}

/** What the queue reads of this computer. Tests give a made-up one. */
export interface DeskHost {
  freeBytes(): Promise<number | null>;
  load(): number;
  cores(): number;
  alive(pid: number): boolean;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realHost: DeskHost = {
  freeBytes: () =>
    new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(os.freemem());
      execFile('vm_stat', [], { timeout: 10_000, encoding: 'utf8' }, (err, out) => resolve(err ? os.freemem() : (freeMemoryOf(String(out)) ?? os.freemem())));
    }),
  load: () => os.loadavg()[0] ?? 0,
  cores: () => os.cpus().length || 4,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

let host: DeskHost = realHost;

/** Tests give a made-up computer. Null goes back to the real one. */
export function useDeskHost(h: DeskHost | null): void {
  host = h ?? realHost;
}

/** The load past which the computer is busy: a little over one for each core. */
export function busyLoad(cores: number): number {
  return Math.max(4, cores * 1.2);
}

/** Why the computer is too busy to boot a phone now, for engineers, or null. */
export async function tooBusy(): Promise<string | null> {
  const free = await host.freeBytes().catch(() => null);
  const load = host.load();
  if (free !== null && free < MIN_FREE_BYTES) return `${(free / 1024 ** 3).toFixed(1)} GB of memory free`;
  if (load > busyLoad(host.cores())) return `load ${load.toFixed(1)} on ${host.cores()} cores`;
  return null;
}

/* ── the lock between squad-kit processes ─────────────── */

const lockFile = (home: string) => path.join(phonesHome(home), 'lock.json');

/** Takes the lock when nobody else holds it: a lock left by a squad-kit that has ended does not count. */
function tryLock(home: string): boolean {
  const file = lockFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    if (held.pid && held.pid !== process.pid && host.alive(held.pid)) return false;
    fs.rmSync(file, { force: true });
  } catch {
    // No lock, or a broken one: it goes.
    fs.rmSync(file, { force: true });
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function unlock(home: string): void {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile(home), 'utf8')) as { pid?: number };
    if (held.pid === process.pid) fs.rmSync(lockFile(home), { force: true });
  } catch {
    // Already gone.
  }
}

/** The pid of another live squad-kit holding the lock, or null. */
function heldByOther(home: string): number | null {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile(home), 'utf8')) as { pid?: number };
    return held.pid && held.pid !== process.pid && host.alive(held.pid) ? held.pid : null;
  } catch {
    return null;
  }
}

/* ── when each device was last used ───────────────────── */

const usedFile = (home: string) => path.join(phonesHome(home), 'used.json');

function readUsed(home: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(usedFile(home), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function markUsed(home: string, id: string): void {
  try {
    const all = readUsed(home);
    all[id] = new Date().toISOString();
    fs.mkdirSync(path.dirname(usedFile(home)), { recursive: true });
    fs.writeFileSync(usedFile(home), `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // Only the idle shutdown is a little earlier.
  }
}

/* ── the queue ────────────────────────────────────────── */

export interface PhoneTurn {
  device: OwnDevice;
  /** Booted in this turn: anything tied to the device before (a tapping session, an installed app) starts again. */
  fresh: boolean;
}

export interface TurnOptions {
  /** The system version to make the device on, when it is made: "18.2". Left out, the newest. */
  runtime?: string;
  say?(text: string): void;
  log?(text: string): void;
  signal?: AbortSignal;
  /** A person opens an app on the phone (Start, Try it yourself): it does not wait for a person's hold. */
  person?: boolean;
  /** Who waits, for the person's hold: "WA-3". */
  who?: string;
}

/* ── a person holding the phone ───────────────────────── */

/** How often a story waiting for the person's phone looks again. */
export const HOLD_LOOK_MS = 5000;

interface Hold {
  /** Where the person opened it, in their words: "Try it yourself", "Your apps". */
  by: string;
  since: number;
  /** A story waiting this long after the hold began ends it, so a phone left open never holds a story forever. */
  yieldAfterMs: number;
  /** Ends the hold: the person's app closes and the phone is free. */
  end(why: 'yield' | 'replaced'): void;
  /** The story that waits for the phone now. */
  wanted?: string;
  phone: PhoneModule;
}

let hold: Hold | null = null;

/** The plain line while a story's pictures wait for the phone a person holds. */
export function heldWords(word: string, by: string): string {
  return `squad-kit's ${word} is open in ${by}. The pictures wait until you close it.`;
}

/**
 * A person holds squad-kit's phone: an app open in its window, from Start or Try it yourself. Stories' pictures wait
 * meanwhile, and no idle shutdown comes. Gives the release, which starts the idle clock again.
 */
export function holdPhone(phone: PhoneModule, h: { by: string; yieldAfterMs: number; end(why: 'yield' | 'replaced'): void }): () => void {
  const mine: Hold = { ...h, since: Date.now(), phone };
  hold = mine;
  return () => {
    if (hold !== mine) return;
    hold = null;
    for (const d of savedDevices()) markUsed(squadHome(), d.id);
    if (!inTurn) armIdle(phone);
  };
}

/** Who holds the phone now, if a person does. */
export function phoneHold(): { by: string; since: string; wanted?: string } | null {
  return hold ? { by: hold.by, since: new Date(hold.since).toISOString(), ...(hold.wanted ? { wanted: hold.wanted } : {}) } : null;
}

/** Ends the person's hold, when there is one, and waits until it is let go (a few seconds at most). */
export async function endHold(why: 'yield' | 'replaced' = 'replaced'): Promise<void> {
  const h = hold;
  if (!h) return;
  h.end(why);
  const until = Date.now() + 30_000;
  while (hold === h && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (hold === h) hold = null;
}

/** Waits while a person holds the phone, saying so once; past the hold's yield time, the hold ends for the story. */
async function waitForHold(word: string, o: TurnOptions): Promise<void> {
  let said = false;
  let asked: Hold | null = null;
  while (hold && !o.person) {
    if (o.signal?.aborted) throw new Error(STOPPED);
    const h = hold;
    if (!said) {
      said = true;
      o.say?.(heldWords(word, h.by));
    }
    h.wanted = o.who ?? 'a story';
    if (asked !== h && Date.now() - h.since > h.yieldAfterMs) {
      asked = h;
      o.log?.(`squad-kit's ${word} was open in ${h.by} for over ${Math.round(h.yieldAfterMs / 60_000)} minutes while ${h.wanted} waited: it closes the app there`);
      h.end('yield');
    }
    await host.sleep(HOLD_LOOK_MS, o.signal);
  }
}

/** A turn that found the phone held by a person: it waits, then takes its turn again. */
const HELD = Symbol('held');

/** Devices squad-kit shut down, which then came up again by themselves: something else keeps them up, so they stay. */
const keptByOther = new Set<string>();
/** What else ends with a device: the tapping tool tied to it. */
const downListeners: ((id: string) => void)[] = [];

/** Runs `fn` with the id of each of squad-kit's devices it shuts down. */
export function onDown(fn: (id: string) => void): void {
  downListeners.push(fn);
}
/** The queue in this process: one turn at a time. */
let queue: Promise<unknown> = Promise.resolve();
let inTurn = 0;
let idle: NodeJS.Timeout | null = null;

const STOPPED = 'You stopped the squad.';

/** True while a turn runs in this process. */
export function phoneInUse(): boolean {
  return inTurn > 0;
}

/**
 * Shuts down one of squad-kit's own devices, by its id, then looks again a moment later: when something booted it
 * again (an open Simulator window), it is left alone from now on. True when it is down.
 */
export async function shutDownGently(phone: PhoneModule, id: string, log?: (text: string) => void): Promise<boolean> {
  if (keptByOther.has(id)) return false;
  await phone.shutdown(id);
  await host.sleep(VIEWER_LOOK_MS);
  const now = (await phone.devices().catch(() => [])).find((d) => d.id === id);
  if (now && (now.state === 'booted' || now.state === 'booting')) {
    keptByOther.add(id);
    log?.(`squad-kit shut down its phone ${id}, and something else started it again (an open Simulator window): squad-kit leaves it up`);
    return false;
  }
  for (const fn of downListeners) fn(id);
  return true;
}

/** Waits for the lock another squad-kit holds, saying so once. */
async function lockTurn(home: string, word: string, o: TurnOptions): Promise<void> {
  let said = false;
  while (!tryLock(home)) {
    if (o.signal?.aborted) throw new Error(STOPPED);
    if (!said) {
      said = true;
      o.say?.(otherWords(word));
    }
    await host.sleep(LOCK_LOOK_MS, o.signal);
  }
}

/** Waits while the computer is busy, saying so once; after BUSY_WAIT_MS it goes ahead, as a story never fails over it. */
async function waitForRoom(word: string, o: TurnOptions): Promise<void> {
  let why = await tooBusy();
  if (!why) return;
  o.say?.(busyWords(word));
  o.log?.(`The computer is busy (${why}), so squad-kit waits before booting its ${word}`);
  for (let look = 0; why && look < Math.ceil(BUSY_WAIT_MS / BUSY_LOOK_MS); look += 1) {
    if (o.signal?.aborted) throw new Error(STOPPED);
    await host.sleep(BUSY_LOOK_MS, o.signal);
    why = await tooBusy();
  }
  if (why) o.log?.(`The computer is still busy (${why}) after ${Math.round(BUSY_WAIT_MS / 60_000)} minutes: squad-kit boots its ${word} anyway`);
}

/**
 * One turn on squad-kit's own phone of a size: in this process's queue and under the lock, with only this device up
 * (squad-kit's other one shuts down first), booted hidden when it is not up yet, after the computer has room for it.
 * The job runs with the device; the idle shutdown starts again after it.
 */
export async function withPhone<T>(phone: PhoneModule, size: PhoneSize, job: (turn: PhoneTurn) => Promise<T>, o: TurnOptions = {}): Promise<T> {
  for (;;) {
    await waitForHold(phone.words[size], o);
    const run = queue.then(() => turn(phone, size, job, o));
    queue = run.catch(() => undefined);
    const r = await run;
    if (r !== HELD) return r as T;
  }
}

async function turn<T>(phone: PhoneModule, size: PhoneSize, job: (turn: PhoneTurn) => Promise<T>, o: TurnOptions): Promise<T | typeof HELD> {
  if (o.signal?.aborted) throw new Error(STOPPED);
  // A person opened an app on the phone while this turn waited in the queue: it waits for them again.
  if (hold && !o.person) return HELD;
  const home = squadHome();
  const word = phone.words[size];
  inTurn += 1;
  if (idle) clearTimeout(idle);
  idle = null;
  try {
    await lockTurn(home, word, o);
    const device = await ownDevice(phone, size, { ...(o.runtime ? { runtime: o.runtime } : {}), home });
    const states = new Map((await phone.devices()).map((d) => [d.id, d.state]));
    // Only one of squad-kit's phones is up at a time: its other one shuts down first. Nobody else's is looked at.
    for (const other of savedDevices(home)) {
      if (other.id === device.id || states.get(other.id) !== 'booted') continue;
      o.log?.(`squad-kit shuts down its ${phone.words[other.size]} ${other.id}, so only one of its phones runs`);
      await shutDownGently(phone, other.id, o.log).catch((err: unknown) => o.log?.(`Shutting down ${other.id} did not work: ${(err as Error).message}`));
    }
    let fresh = false;
    if (states.get(device.id) !== 'booted') {
      await waitForRoom(word, o);
      if (o.signal?.aborted) throw new Error(STOPPED);
      o.say?.(`Starting squad-kit's ${word}, ${aboutWords(stepSeconds('boot', home))}`);
      const t0 = Date.now();
      await phone.boot(device.id, o.signal ? { signal: o.signal } : {});
      noteStep('boot', (Date.now() - t0) / 1000, home);
      o.log?.(`squad-kit booted its ${word} ${device.id} (${device.model}, iOS ${device.runtime}) in ${Math.round((Date.now() - t0) / 1000)} s`);
      fresh = true;
    }
    markUsed(home, device.id);
    try {
      return await job({ device: { ...device }, fresh });
    } finally {
      markUsed(home, device.id);
    }
  } finally {
    unlock(home);
    inTurn -= 1;
    if (!inTurn) armIdle(phone);
  }
}

/** The idle shutdown: when nothing used squad-kit's phone for IDLE_MS, it shuts down. */
function armIdle(phone: PhoneModule): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void idleNow(phone).catch(() => undefined), IDLE_MS);
  idle.unref?.();
}

/** Shuts down squad-kit's phones nobody used for IDLE_MS, in a turn of their own. Returns the ids shut down. */
export function idleNow(phone: PhoneModule, now = Date.now()): Promise<string[]> {
  const run = queue.then(async () => {
    const home = squadHome();
    // A person's app open on the phone is no idle phone.
    if (hold || !tryLock(home)) return [];
    try {
      const used = readUsed(home);
      const states = new Map((await phone.devices()).map((d) => [d.id, d.state]));
      const down: string[] = [];
      for (const d of savedDevices(home)) {
        if (states.get(d.id) !== 'booted') {
          keptByOther.delete(d.id);
          continue;
        }
        const last = Date.parse(used[d.id] ?? '');
        if (Number.isFinite(last) && now - last < IDLE_MS) continue;
        if (await shutDownGently(phone, d.id)) down.push(d.id);
      }
      return down;
    } finally {
      unlock(home);
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Shuts down squad-kit's own phones now: when the board stops, or a person asks (`squad phone stop`). One in use by a
 * story in this process, or held by another squad-kit, is left: `busy` says so. Nobody else's device is touched.
 */
export async function stopPhones(phone: PhoneModule): Promise<{ stopped: string[]; left: string[]; busy: boolean }> {
  const home = squadHome();
  // Nothing to look at on a computer where squad-kit never made a phone.
  if (phone.notHere() || !savedDevices(home).length) return { stopped: [], left: [], busy: false };
  if (inTurn || heldByOther(home)) return { stopped: [], left: [], busy: true };
  if (idle) clearTimeout(idle);
  idle = null;
  if (!tryLock(home)) return { stopped: [], left: [], busy: true };
  try {
    const states = new Map((await phone.devices()).map((d) => [d.id, d.state]));
    const stopped: string[] = [];
    const left: string[] = [];
    for (const d of savedDevices(home)) {
      if (states.get(d.id) !== 'booted') continue;
      if (await shutDownGently(phone, d.id)) stopped.push(d.id);
      else left.push(d.id);
    }
    return { stopped, left, busy: false };
  } finally {
    unlock(home);
  }
}

/** True when something else keeps this device up, so squad-kit leaves it. */
export function keptUp(id: string): boolean {
  return keptByOther.has(id);
}

/** When each of squad-kit's devices was last used, as saved. */
export function lastUsed(home = squadHome()): Record<string, string> {
  return readUsed(home);
}

/** Tests start each case clean. */
export function resetDesk(): void {
  keptByOther.clear();
  hold = null;
  if (idle) clearTimeout(idle);
  idle = null;
  queue = Promise.resolve();
  inTurn = 0;
}
