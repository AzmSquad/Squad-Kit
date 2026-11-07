import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from './store.js';

/** The console writes its pid here while its squad runs, so terminal commands don't run a second one. */
function lockFile(bp: BoardPaths): string {
  return bp.pidFile;
}

export function claimSquad(bp: BoardPaths): () => void {
  fs.mkdirSync(bp.localDir, { recursive: true });
  fs.writeFileSync(lockFile(bp), String(process.pid), 'utf8');
  return () => {
    try {
      if (fs.readFileSync(lockFile(bp), 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile(bp));
    } catch {
      // Already gone.
    }
  };
}

/**
 * One release at a time per project, and "Looks right" knows when one is going out: the release and merge on accept
 * share this lock. While it is held, an accepted ticket joins the next release and a pull request waits to merge.
 */
function releaseLockFile(bp: BoardPaths): string {
  return path.join(bp.localDir, 'release.lock');
}

/** Versions this process is releasing now; a lock file with this pid and no entry here was left by an earlier run. */
const releasing = new Map<string, string>();

/** Longer than any release takes (its pipeline stops after 20 minutes): an older lock was left behind. */
const RELEASE_LOCK_MAX_MS = 2 * 60 * 60_000;

/** The release going out right now, or null. A lock left behind by a process that has ended does not count. */
export function releaseGoingOut(bp: BoardPaths): string | null {
  const file = releaseLockFile(bp);
  let held: { pid?: number; version?: string; at?: string };
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof held;
  } catch {
    return null;
  }
  if (!held.pid || !held.version) return null;
  if (held.pid === process.pid) return releasing.get(file) === held.version ? held.version : null;
  if (held.at && Date.now() - Date.parse(held.at) > RELEASE_LOCK_MAX_MS) return null;
  try {
    process.kill(held.pid, 0);
    return held.version;
  } catch {
    return null;
  }
}

/** Takes the release lock for `version`. Throws when another release is going out; the returned function frees it. */
export function holdRelease(bp: BoardPaths, version: string): () => void {
  const file = releaseLockFile(bp);
  const going = releaseGoingOut(bp);
  if (going) throw new Error(`${going} is going out right now. Wait for it to finish.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A lock left behind goes; `wx` makes sure two releases starting at once do not both get it.
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, version, at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error(`${releaseGoingOut(bp) ?? 'Another release'} is going out right now. Wait for it to finish.`);
  }
  releasing.set(file, version);
  return () => {
    releasing.delete(file);
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (held.pid === process.pid) fs.rmSync(file);
    } catch {
      // Already gone.
    }
  };
}

/** Tickets being taken out of a release, one at a time per board: each checks the code first, which takes a while. */
const takingOut = new Map<string, Promise<unknown>>();

export function takingOutTurn<T>(bp: BoardPaths, job: () => Promise<T>): Promise<T> {
  const run = (takingOut.get(bp.squadDir) ?? Promise.resolve()).catch(() => undefined).then(job);
  takingOut.set(bp.squadDir, run);
  void run.catch(() => undefined).finally(() => {
    if (takingOut.get(bp.squadDir) === run) takingOut.delete(bp.squadDir);
  });
  return run;
}

/** Once no ticket is being taken out of a release. With none, it returns at once and the caller goes on without a wait. */
export function takingOutDone(bp: BoardPaths): Promise<unknown> | undefined {
  return takingOut.get(bp.squadDir)?.catch(() => undefined);
}

export function squadRunsElsewhere(bp: BoardPaths): boolean {
  try {
    const pid = Number(fs.readFileSync(lockFile(bp), 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
