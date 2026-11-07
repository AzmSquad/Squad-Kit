import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * Every program squad-kit starts (a check command, the app for the Tester, an agent's adapter) leads its own process
 * group, so ending it ends everything it started: a test runner's workers, the server npm started, the tool an adapter
 * drives. Stopping asks first (TERM), then makes sure (KILL) a few seconds later. Windows has no process groups:
 * there taskkill ends the program and every program under it (`/T`), at once (`/F`).
 */

/** Spawn option: the child leads a process group of its own. Windows has no process groups. */
export const OWN_GROUP = process.platform !== 'win32';

/** How long a stopped group gets to end by itself before it is killed. */
export const KILL_AFTER_MS = 5000;

/**
 * True when the process with this number started well after the one squad-kit wrote down: after a crash or a reboot the
 * number is free, and another program may have it. Never signal, or trust, a number this says is taken over. An unknown
 * answer counts as not taken over, as before. A board that restarted in place keeps its number and its older start, so
 * only a later start counts.
 */
export function takenOver(pid: number, since: string | undefined): boolean {
  if (!since || process.platform === 'win32') return false;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return false;
  try {
    const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim());
    return Number.isFinite(started) && started > at + 60_000;
  } catch {
    return false;
  }
}

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

/** How a group is ended on this computer: tests pass another platform and a fake spawn. */
export interface GroupWay {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], o: { stdio: 'ignore'; windowsHide: boolean }) => Pick<ChildProcess, 'on' | 'unref'>;
}

/**
 * Sends a signal to the child's whole group. On Windows the child is `cmd.exe` running the command, and killing it
 * alone would leave the app it started running: taskkill ends the whole tree instead, whatever the signal.
 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals, way: GroupWay = {}): void {
  if (!child.pid) return;
  if ((way.platform ?? process.platform) === 'win32') return endTree(child.pid, way);
  try {
    if (OWN_GROUP) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Windows: ends a program and every program under it, at once, with taskkill. */
export function endTree(pid: number, way: GroupWay = {}): void {
  try {
    const tk = (way.spawn ?? spawn)('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    tk.on('error', () => undefined);
    tk.unref();
  } catch {
    // taskkill is part of Windows; without it there is nothing more to try.
  }
}

/** True while any process of the group runs. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(OWN_GROUP ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  // Windows has no groups: the whole tree under the shell goes at once.
  if (process.platform === 'win32') return endTree(pid);
  try {
    process.kill(OWN_GROUP ? -pid : pid, signal);
  } catch {
    // Already gone.
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops a process group squad-kit started, from any process: TERM, then KILL when it is still there. */
export async function endPid(pid: number): Promise<void> {
  signalPid(pid, 'SIGTERM');
  const until = Date.now() + KILL_AFTER_MS;
  while (groupAlive(pid) && Date.now() < until) await pause(100);
  if (groupAlive(pid)) signalPid(pid, 'SIGKILL');
  const gone = Date.now() + 2000;
  while (groupAlive(pid) && Date.now() < gone) await pause(100);
}

/** Ends the child's group: TERM now, then KILL for anything still there after `killAfterMs`. On Windows, taskkill once. */
export function endGroup(child: ChildProcess, killAfterMs = KILL_AFTER_MS, way: GroupWay = {}): void {
  signalGroup(child, 'SIGTERM', way);
  if ((way.platform ?? process.platform) === 'win32') return;
  setTimeout(() => signalGroup(child, 'SIGKILL', way), killAfterMs).unref();
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

/** The process ids of the children squad-kit started that still run: each leads its own group. */
export function runningPids(): number[] {
  return [...running].map((c) => c.pid).filter((p): p is number => typeof p === 'number');
}

/** Clean-ups still going on as squad-kit closes (see engine/leftovers.ts): a restart waits for them too. */
const tasks = new Set<Promise<unknown>>();

export function trackTask<T>(task: Promise<T>): Promise<T> {
  tasks.add(task);
  void task.catch(() => undefined).finally(() => tasks.delete(task));
  return task;
}

/** Waits until every child squad-kit started has ended, and every clean-up with it, for at most `ms`. True when none is left. */
export async function allEnded(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while ((running.size || tasks.size) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return running.size === 0 && tasks.size === 0;
}

/** Asks whatever squad-kit started that still runs to end: a git lets go of its locks and files when it is asked. */
export function askAllToEnd(): void {
  for (const c of running) signalGroup(c, 'SIGTERM');
}

/** Kills whatever squad-kit started that still runs, at once. */
export function killAll(): void {
  for (const c of running) signalGroup(c, 'SIGKILL');
}
