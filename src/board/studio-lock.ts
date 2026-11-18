import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from './store.js';
import { studioLockFile } from './studio-paths.js';

/**
 * The project's Studio lock: one Studio change at a time per project, in the console and in terminal commands alike,
 * so a change checks its stamp and writes with nothing crossing it. The lock file sits on this computer, never in
 * `.squad/`, and goes when the change ends.
 */

/** Longer than any Studio change takes: an older lock was left by a run that ended. */
const LOCK_LEFT_MS = 30_000;
/** How long a change waits for another one to finish. */
const LOCK_WAIT_MS = 5_000;
/** Locks this process holds now, so a change inside a change does not wait for itself. */
const holding = new Set<string>();

function lockLeftBehind(file: string): boolean {
  let held: { pid?: number; at?: string };
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof held;
  } catch {
    // Being written right now, or gone: not left behind unless it is old.
    try {
      return Date.now() - fs.statSync(file).mtimeMs > LOCK_LEFT_MS;
    } catch {
      return false;
    }
  }
  if (!held.pid || (held.at && Date.now() - Date.parse(held.at) > LOCK_LEFT_MS)) return true;
  if (held.pid === process.pid) return !holding.has(file);
  try {
    process.kill(held.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Runs `fn` while holding the project's Studio lock, shared by the console and terminal commands. */
export function holdStudio<T>(bp: BoardPaths, fn: () => T): T {
  const file = studioLockFile(bp);
  if (holding.has(file)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockLeftBehind(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('The Studio is saving something else right now. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  holding.add(file);
  try {
    return fn();
  } finally {
    holding.delete(file);
    fs.rmSync(file, { force: true });
  }
}
