import { spawn } from 'node:child_process';
import net from 'node:net';
import type { ProjectCommands } from '../board/types.js';
import { childEnv } from './agent-env.js';
import { OWN_GROUP, endGroup, track, whenExited } from './process-group.js';

/** squad-kit runs the project's own checks itself, so the AI never grades its own work. */

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
}

export interface CommandWatch {
  /** Called with the process id once the command starts. */
  onSpawn?(pid: number): void;
  /** Called whenever the command prints something. */
  onOutput?(): void;
  /** Stops the command, and everything it started, when the person presses Stop. */
  signal?: AbortSignal;
  /** Stops a command that prints nothing for this long. */
  silentMs?: number;
}

/** A check that prints nothing for this long is waiting for something that never comes. */
export const CHECK_SILENT_MS = 5 * 60_000;

const STOPPED = 'You stopped the squad.';

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * Runs one command of the project in its own process group, with the environment every agent gets (squad-kit's own
 * keys stay out). A timeout or Stop ends the whole group, and the result comes back once the command exits, even when
 * something it started keeps its output open.
 */
export function runCommand(cwd: string, command: string, timeoutMs = 15 * 60_000, watch: CommandWatch = {}): Promise<{ ok: boolean; output: string; seconds: number }> {
  const started = Date.now();
  if (watch.signal?.aborted) return Promise.resolve({ ok: false, output: STOPPED, seconds: 0 });
  return new Promise((resolve) => {
    const child = track(spawn(command, { cwd, shell: true, detached: OWN_GROUP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv(), CI: '1', FORCE_COLOR: '0' } }));
    if (child.pid) watch.onSpawn?.(child.pid);
    let out = '';
    // Why squad-kit ended the command, when it did.
    let ended = '';
    const end = (why: string) => {
      if (ended) return;
      ended = why;
      endGroup(child);
    };
    let silent: NodeJS.Timeout | undefined;
    const heard = () => {
      if (!watch.silentMs) return;
      clearTimeout(silent);
      const ms = watch.silentMs;
      silent = setTimeout(() => end(`The command printed nothing for ${minutes(ms)}; it may be waiting in watch mode or for input.`), ms);
    };
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-12_000);
      watch.onOutput?.();
      heard();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    heard();
    const timer = setTimeout(() => end(`stopped after ${Math.round(timeoutMs / 60000)} minutes`), timeoutMs);
    const onStop = () => end(STOPPED);
    watch.signal?.addEventListener('abort', onStop, { once: true });
    let done = false;
    const finish = (ok: boolean, output: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(silent);
      watch.signal?.removeEventListener('abort', onStop);
      resolve({ ok, output, seconds: (Date.now() - started) / 1000 });
    };
    child.on('error', (err) => finish(false, err.message));
    // Something the command started still holds its output after it exited: end it too.
    whenExited(child, 1000, () => endGroup(child)).then((code) => finish(code === 0 && !ended, `${out.trim()}${ended ? `\n(${ended})` : ''}`.trim()));
  });
}

/**
 * The project's checks, one after another. When no tests ran (none set up, or none found) and the project says how it
 * starts, "start" checks that the app starts and answers at its address, then stops it: then it is the one check of
 * what the app does. With tests, the Tester starts the app for the proof anyway. After a Stop, the ones not run yet
 * never start.
 */
export async function runChecks(cwd: string, commands: ProjectCommands, onStart?: (name: string) => void, watch: CommandWatch = {}, appWaitMs?: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const name of ['test', 'lint', 'build'] as const) {
    const command = commands[name]?.trim();
    if (!command) continue;
    if (watch.signal?.aborted) break;
    onStart?.(name);
    const r = await runCommand(cwd, command, undefined, { silentMs: CHECK_SILENT_MS, ...watch });
    results.push({ name, command, ...r });
  }
  const start = commands.start?.trim();
  const url = commands.url?.trim();
  const tested = results.some((r) => r.name === 'test' && testCount(r.output) !== 0);
  if (start && url && !tested && !watch.signal?.aborted) {
    onStart?.('start');
    const began = Date.now();
    const seconds = () => (Date.now() - began) / 1000;
    try {
      const app = await startApp(cwd, start, url, appWaitMs, watch.signal);
      app.stop();
      results.push({ name: 'start', command: start, ok: true, output: `The app answered at ${app.url}.`, seconds: seconds() });
    } catch (err) {
      results.push({ name: 'start', command: start, ok: false, output: (err as Error).message, seconds: seconds() });
    }
  }
  return results;
}

export interface RunningApp {
  url: string;
  stop(): void;
}

/**
 * squad-kit starts the app for the Tester and stops it afterwards, so a dev server can never keep a step running
 * forever. Resolves once the app answers at its address.
 */
/** True when something already answers at the address. */
async function answers(url: string): Promise<boolean> {
  for (const u of [url, url.replace('://localhost', '://127.0.0.1')]) {
    if (await fetch(u, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false)) return true;
  }
  return false;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts the ticket's copy of the app and waits until it answers. When something else already answers at the app's
 * address (often the person's own "npm run dev"), the copy starts on a free port instead (PORT), so the Tester never
 * looks at the wrong app. The address the app really runs at comes back in `url`. Stop ends the wait and the app.
 */
export async function startApp(cwd: string, command: string, url: string, waitMs = 3 * 60_000, signal?: AbortSignal): Promise<RunningApp> {
  if (signal?.aborted) throw new Error(STOPPED);
  const taken = await answers(url);
  const port = taken ? await freePort() : null;
  const target = port ? url.replace(/(:\/\/[^/:]+)(:\d+)?/, `$1:${port}`) : url;
  const env = { ...childEnv(), CI: '1', FORCE_COLOR: '0', BROWSER: 'none', ...(port ? { PORT: String(port) } : {}) };
  const child = track(spawn(command, { cwd, shell: true, detached: OWN_GROUP, stdio: ['ignore', 'pipe', 'pipe'], env }));
  let out = '';
  let exited: number | null = null;
  const keep = (chunk: Buffer) => {
    out = (out + chunk.toString('utf8')).slice(-6_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', (err) => {
    out += `\n${err.message}`;
    exited = -1;
  });
  child.on('exit', (code) => (exited = code ?? 0));
  // The whole process group: the shell, npm, and the server it started.
  const stop = () => endGroup(child);
  const busy = port ? ` ${new URL(url).host} is used by another program (maybe your own "npm run dev"), so squad-kit tried port ${port}.` : '';
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (signal?.aborted) {
      stop();
      throw new Error(STOPPED);
    }
    if (exited !== null) throw new Error(`The app stopped while starting (${command}):${busy} ${tail(out, 8)}`);
    if (await answers(target)) return { url: target, stop };
    await new Promise((r) => setTimeout(r, 2000));
  }
  stop();
  throw new Error(
    port
      ? `The app did not start on a free port.${busy} Stop the other program, then press Try again. (${command}): ${tail(out, 8)}`
      : `The app did not answer at ${url} within ${Math.round(waitMs / 60_000)} minutes (${command}): ${tail(out, 8)}`,
  );
}

/** "18 passed" style counts from common test runners, for the gate pill. */
export function testCount(output: string): number | null {
  // The "Tests" summary line first (vitest, jest), so a "Test Files 1 passed" line is not mistaken for it.
  const patterns = [/^\s*Tests:?\s+(\d+)\s+passed/im, /(\d+)\s+passing/i, /^# pass (\d+)/m, /Passed:\s+(\d+)/i, /(\d+)\s+passed/i];
  for (const p of patterns) {
    const m = output.match(p);
    if (m) return Number(m[1]);
  }
  return null;
}

export function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}
