import type { ChildProcess } from 'node:child_process';

/**
 * Every program squad-kit starts (a check command, the app for the Tester, an agent's adapter) leads its own process
 * group, so ending it ends everything it started: a test runner's workers, the server npm started, the tool an adapter
 * drives. Stopping asks first (TERM), then makes sure (KILL) a few seconds later.
 */

/** Spawn option: the child leads a process group of its own. Windows has no process groups. */
export const OWN_GROUP = process.platform !== 'win32';

/** How long a stopped group gets to end by itself before it is killed. */
export const KILL_AFTER_MS = 5000;

/** The children squad-kit started that still run, so a restart can wait for them to end. */
const running = new Set<ChildProcess>();
let hooked = false;

/** Counts a child until it exits. Whatever still runs when squad-kit exits is asked to stop. */
export function track<T extends ChildProcess>(child: T): T {
  running.add(child);
  const gone = () => running.delete(child);
  child.once('exit', gone);
  child.once('error', gone);
  if (!hooked) {
    hooked = true;
    process.once('exit', () => {
      for (const c of running) signalGroup(c, 'SIGTERM');
    });
  }
  return child;
}

/** Sends a signal to the child's whole group, or to the child alone where there are no groups. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (OWN_GROUP) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Ends the child's group: TERM now, then KILL for anything still there after `killAfterMs`. */
export function endGroup(child: ChildProcess, killAfterMs = KILL_AFTER_MS): void {
  signalGroup(child, 'SIGTERM');
  setTimeout(() => signalGroup(child, 'SIGKILL'), killAfterMs).unref();
}

/**
 * Resolves with the exit code once the child has exited and its output is read. Something it started can keep the
 * output open long after (a watcher, a server, a background job): then the output is cut off `graceMs` after the exit
 * instead of waited for forever, and `left` runs first, with that something still running.
 */
export function whenExited(child: ChildProcess, graceMs = 1000, left?: () => void): Promise<number | null> {
  return new Promise((resolve) => {
    let closed = false;
    child.once('close', (code: number | null) => {
      closed = true;
      resolve(code);
    });
    child.once('exit', (code: number | null) => {
      setTimeout(() => {
        if (closed) return;
        left?.();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      }, graceMs);
    });
  });
}

/** Waits until every child squad-kit started has ended, for at most `ms`. True when none is left. */
export async function allEnded(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (running.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return running.size === 0;
}

/** Kills whatever squad-kit started that still runs, at once. */
export function killAll(): void {
  for (const c of running) signalGroup(c, 'SIGKILL');
}
