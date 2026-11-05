import net from 'node:net';
import type { ProjectCommands } from '../board/types.js';
import { KILL_AFTER_MS, endGroup, whenExited } from './process-group.js';
import { appPortVariables } from './port-vars.js';
import { guardBlockedPath, spawnProject, type GuardSpec } from './project-guard.js';

/** squad-kit runs the project's own checks itself, so the AI never grades its own work. */

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
  /** It failed, then passed when run once more: what it printed the first time, for engineers. */
  failedFirst?: string;
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
  /** squad-kit's own guard for the project's command (engine/project-guard.ts). Left out, it runs unguarded. */
  guard?: GuardSpec;
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
export function runCommand(cwd: string, command: string, timeoutMs = 15 * 60_000, watch: CommandWatch = {}): Promise<{ ok: boolean; output: string; seconds: number; ended?: boolean }> {
  const started = Date.now();
  if (watch.signal?.aborted) return Promise.resolve({ ok: false, output: STOPPED, seconds: 0 });
  return new Promise((resolve) => {
    const child = spawnProject(command, { cwd, env: { CI: '1', FORCE_COLOR: '0' }, ...(watch.guard ? { guard: watch.guard } : {}) });
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
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
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
      resolve({ ok, output, seconds: (Date.now() - started) / 1000, ...(ended ? { ended: true } : {}) });
    };
    child.on('error', (err) => finish(false, err.message));
    // Something the command started still holds its output after it exited: end it too.
    whenExited(child, 1000, () => endGroup(child)).then((code) => finish(code === 0 && !ended, `${out.trim()}${ended ? `\n(${ended})` : ''}`.trim()));
  });
}

/**
 * A check can fail once for no reason in the code, such as a flaky test, so a failed one runs once more before anyone
 * is sent to fix it. Not after a Stop, a command squad-kit had to end (a second wait says nothing new), or a blocked
 * file: those fail the same way again.
 */
async function withOneMoreRun<R extends { ok: boolean; output: string; ended?: boolean }>(run: () => Promise<R>, watch: CommandWatch, onAgain: () => void): Promise<R & { failedFirst?: string }> {
  const first = await run();
  if (first.ok || first.ended || watch.signal?.aborted) return first;
  if (watch.guard && guardBlockedPath(first.output, watch.guard)) return first;
  onAgain();
  const again = await run();
  return again.ok ? { ...again, failedFirst: tail(first.output, 30) } : again;
}

/** The plain line for a check that failed once and passed when run again. */
export function failedOnceLine(name: string): string {
  if (name === 'start') return 'The app did not start the first time, and started when run again.';
  const what = name === 'test' ? 'A test' : name === 'lint' ? 'The code check' : name === 'build' ? 'The build' : `The ${name} check`;
  return `${what} failed once and passed when run again.`;
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
    const r = await withOneMoreRun(() => runCommand(cwd, command, undefined, { silentMs: CHECK_SILENT_MS, ...watch }), watch, () => onStart?.(name));
    results.push({ name, command, ...r });
  }
  const start = commands.start?.trim();
  const url = commands.url?.trim();
  const tested = results.some((r) => r.name === 'test' && testCount(r.output) !== 0);
  if (start && url && !tested && !watch.signal?.aborted) {
    onStart?.('start');
    const once = async () => {
      const began = Date.now();
      const seconds = () => (Date.now() - began) / 1000;
      try {
        const app = await startApp(cwd, start, url, appWaitMs, watch.signal, watch.guard);
        app.stop();
        return { ok: true, output: `The app answered at ${app.url}.`, seconds: seconds() };
      } catch (err) {
        return { ok: false, output: (err as Error).message, seconds: seconds() };
      }
    };
    results.push({ name: 'start', command: start, ...(await withOneMoreRun(once, watch, () => onStart?.('start'))) });
  }
  return results;
}

export interface RunningApp {
  url: string;
  stop(): void;
  /** The last lines the app printed, for an agent that started it and for engineers. */
  lines?(n?: number): string;
  /** True once the app has stopped by itself, or was stopped. */
  ended?(): boolean;
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

/** True when a program holds the port, whether or not it answers. */
export function held(port: number | null): Promise<boolean> {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (yes: boolean) => {
      s.destroy();
      resolve(yes);
    };
    // When this process was busy (a git call that waits, on a busy computer), the timer comes up before an answer that
    // is already here. That answer goes first, or a port in use reads as free.
    s.setTimeout(800, () => setImmediate(() => done(false)));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Apps squad-kit just stopped, by the port each had, until each is gone. */
const stopping = new Map<number, Promise<void>>();

/** Ended with its whole process group and off its port, or the time for that is over: the group is killed by then. */
async function goneFrom(port: number | null, exited: () => boolean): Promise<void> {
  const until = Date.now() + KILL_AFTER_MS + 1000;
  while (Date.now() < until && (!exited() || (await held(port)))) await new Promise((r) => setTimeout(r, 50));
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

/** The port an address uses, said or not: 8000 in http://127.0.0.1:8000, 80 in http://localhost. */
function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
}

/**
 * Starts the ticket's copy of the app and waits until it answers. When something else already answers at the app's
 * address (often the person's own "npm run dev"), or holds its port and says nothing, the copy starts on a free port
 * instead: PORT, and the app's own port variables found in its code (like ROOMFLOW_PORT), so the Tester never looks at
 * the wrong app. The address the app really runs at comes back in `url`. Stop ends the wait and the app.
 */
export async function startApp(cwd: string, command: string, url: string, waitMs = 3 * 60_000, signal?: AbortSignal, guard?: GuardSpec): Promise<RunningApp> {
  if (signal?.aborted) throw new Error(STOPPED);
  // The app squad-kit stopped a moment ago (the last round of screenshots) is no other program: on a busy computer it may
  // still be on its way out, and its port is about to be free. Going around it would break an app that cannot move.
  await stopping.get(portOf(url) ?? 0);
  if (signal?.aborted) throw new Error(STOPPED);
  const taken = (await answers(url)) || (await held(portOf(url)));
  const port = taken ? await freePort() : null;
  const target = port ? url.replace(/(:\/\/[^/:]+)(:\d+)?/, `$1:${port}`) : url;
  const own = port ? appPortVariables(cwd, portOf(url)) : [];
  const moved = port ? Object.fromEntries(['PORT', ...own].map((name) => [name, String(port)])) : {};
  const env = { CI: '1', FORCE_COLOR: '0', BROWSER: 'none', ...moved };
  const child = spawnProject(command, { cwd, env, ...(guard ? { guard } : {}) });
  let out = '';
  let exited: number | null = null;
  const keep = (chunk: Buffer) => {
    out = (out + chunk.toString('utf8')).slice(-6_000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  child.on('error', (err) => {
    out += `\n${err.message}`;
    exited = -1;
  });
  child.on('exit', (code) => (exited = code ?? 0));
  // The whole process group: the shell, npm, and the server it started.
  const stop = () => {
    endGroup(child);
    const at = portOf(target);
    if (!at || stopping.has(at)) return;
    const gone = goneFrom(at, () => exited !== null).finally(() => stopping.delete(at));
    stopping.set(at, gone);
  };
  // A Stop while it starts ends it at once, not at the next look.
  signal?.addEventListener('abort', stop, { once: true });
  const busy = port ? ` ${new URL(url).host} is used by another program (maybe your own "npm run dev"), so squad-kit tried port ${port}${own.length ? ` (set as PORT and ${own.join(', ')})` : ''}.` : '';
  const until = Date.now() + waitMs;
  try {
    // Looked at often at first, as most apps answer within a second or two, then every 2 seconds.
    for (let tries = 0; Date.now() < until; tries += 1) {
      if (signal?.aborted) {
        stop();
        throw new Error(STOPPED);
      }
      if (exited !== null) throw new Error(`The app stopped while starting (${command}):${busy} ${tail(out, 8)}`);
      if (await answers(target)) {
        // It came up just as the Stop came: it does not outlive it.
        if (signal?.aborted) {
          stop();
          throw new Error(STOPPED);
        }
        return { url: target, stop, lines: (n = 20) => tail(out.trim(), n), ended: () => exited !== null };
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** tries)));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  stop();
  throw new Error(
    port
      ? `The app did not start on a free port.${busy} Stop the other program, then press Try again. (${command}): ${tail(out, 8)}`
      : `The app did not answer at ${url} within ${Math.round(waitMs / 60_000)} minutes (${command}): ${tail(out, 8)}`,
  );
}

/** Each test tool's own summary line, with how many passed. */
const SUMMARY_LINES = [
  // vitest "Tests  1 failed | 33 passed (34)", jest "Tests:  1 failed, 33 passed, 34 total". Never "Test Files" or "Test Suites".
  /^\s*Tests:?\s+(?:.*\D)?(\d+)\s+passed\b/i,
  // mocha "34 passing (12ms)", bun "34 pass".
  /^\s*(\d+)\s+pass(?:ing)?\b/i,
  // node --test: "# pass 5", or "ℹ pass 5".
  /^\s*[#ℹ]\s*pass\s+(\d+)\s*$/,
  // dotnet "Passed!  - Failed: 0, Passed: 34, Skipped: 0", or a line of its own.
  /^\s*(?:(?:Passed|Failed)!.*\b)?Passed:\s+(\d+)/,
  // pytest "===== 1 failed, 33 passed, 2 skipped in 1.20s =====".
  /^[=\s]*(?:\d+\s+\w+,\s+)*(\d+)\s+passed\b.*\bin\s+[\d.]+\s*s/i,
  // playwright "  27 passed (2.9m)".
  /^\s*(\d+)\s+passed\s+\([\d.]+\s*(?:ms|s|m|h)\)\s*$/i,
  // cargo "test result: ok. 34 passed; 0 failed; ...", one per test program.
  /^test result: \w+\.\s+(\d+)\s+passed;/,
];

/** The output without its colors. Some tools print them even with FORCE_COLOR=0 when CI is set, and they hide where a line starts. */
export function plainOutput(output: string): string {
  return output.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * How many tests passed, for the gate pill: the numbers of every summary line added up, as one command may run two test
 * tools (npm test && npm run test:e2e). Only summary lines count, so a test's own name or log line never does. Other
 * tools: the first count in the output. Null when it says none.
 */
export function testCount(output: string): number | null {
  const text = plainOutput(output);
  let total: number | null = null;
  for (const line of text.split('\n')) {
    const m = SUMMARY_LINES.map((p) => line.match(p)).find(Boolean);
    if (m) total = (total ?? 0) + Number(m[1]);
  }
  if (total !== null) return total;
  const m = text.match(/(\d+)\s+passing/i) ?? text.match(/Passed:\s+(\d+)/i) ?? text.match(/(\d+)\s+passed/i);
  return m ? Number(m[1]) : null;
}

export function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}
