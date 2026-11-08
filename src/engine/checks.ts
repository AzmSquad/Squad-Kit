import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ProjectCommands } from '../board/types.js';
import { writeLog } from '../core/app-log.js';
import { healEnv, healedBefore, rememberHealed } from './cache-home.js';
import { failedTests, testAlone } from './failed-tests.js';
import { KILL_AFTER_MS, endGroup, whenExited } from './process-group.js';
import { appPortVariables } from './port-vars.js';
import { guardBlockedPath, homeCachesRefused, spawnProject, type GuardSpec } from './project-guard.js';
import { scriptsOf } from './weakened.js';

/** squad-kit runs the project's own checks itself, so the AI never grades its own work. */

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
  /** It failed, then passed when run once more: what it printed the first time, for engineers. */
  failedFirst?: string;
  /** squad-kit ended it: it printed nothing for too long, ran past its time, or you pressed Stop. */
  ended?: boolean;
}

export interface CommandWatch {
  /** More environment for the command. */
  env?: Record<string, string>;
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
  /** Also ends what the command left running after it exited. */
  endAll?: boolean;
  /** squad-kit runs the command once more with a home of the project's own: the details, for engineers (runCommand). Left out, they go in the log. */
  onHealed?(detail: string): void;
}

/** A check that prints nothing for this long is waiting for something that never comes. */
export const CHECK_SILENT_MS = 5 * 60_000;
/** The longest one check may run, printing or not. */
export const CHECK_MS = 15 * 60_000;

const STOPPED = 'You stopped the squad.';

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export interface CommandResult {
  ok: boolean;
  output: string;
  seconds: number;
  ended?: boolean;
  code?: number;
  /** squad-kit ran it once more with a home of the project's own: why, for engineers. */
  healed?: string;
}

/**
 * Runs one command of the project in its own process group, with the environment every agent gets (squad-kit's own
 * keys stay out). A timeout or Stop ends the whole group, and the result comes back once the command exits, even when
 * something it started keeps its output open.
 *
 * In the guard, a tool that could not write its cache in the person's home (one squad-kit does not point at the cache
 * home by its own setting) makes the command run once more, by itself, with a home of the project's own where that place
 * is writable (engine/cache-home.ts). Only once: a command that still fails, or fails for another reason, is not run again
 * here. The same command starts with that home from then on.
 */
export async function runCommand(cwd: string, command: string, timeoutMs = CHECK_MS, watch: CommandWatch = {}): Promise<CommandResult> {
  const homes = ownHomes(command, watch.guard);
  const set = (env: Record<string, string> | null): CommandWatch => (env ? { ...watch, env: { ...watch.env, ...env } } : watch);
  const first = await runOnce(cwd, command, timeoutMs, set(homes.env(homes.before)));
  if (first.ok || first.ended || watch.signal?.aborted) return first;
  const refused = homes.refused(first.output);
  const env = homes.env([...homes.before, ...refused]);
  if (!refused.length || !env) return first;
  const detail = homes.said(refused, env);
  if (watch.onHealed) watch.onHealed(detail);
  else writeLog({ level: 'info', text: detail });
  const again: CommandResult = { ...(await runOnce(cwd, command, timeoutMs, set(env))), healed: detail };
  homes.learn(again.output, refused);
  return { ...again, seconds: first.seconds + again.seconds };
}

/**
 * What squad-kit knows of a command's tools that write in the person's home, in the guard (engine/cache-home.ts): the
 * places it needed a home of the project's own for before, the environment for such a home, and what it could not write
 * this time. Nothing without the guard's cache home: such a command runs as it is.
 */
function ownHomes(command: string, guard?: GuardSpec) {
  const cache = guard?.cache;
  const hidden = { hidden: guard?.noRead ?? [] };
  const before = cache ? healedBefore(cache, command, hidden) : [];
  return {
    before,
    /** The environment for a home where these places are the project's own, or null for none (or none could be made). */
    env(places: string[]): Record<string, string> | null {
      if (!cache || !places.length) return null;
      try {
        return healEnv(cache, places, hidden);
      } catch {
        // No home of its own could be made: the command runs as it would have.
        return null;
      }
    },
    /** The places it could not write this time, other than the ones it had already. None when it failed for another reason. */
    refused(output: string): string[] {
      return cache && guard ? homeCachesRefused(output, guard).filter((p) => !before.includes(p)) : [];
    },
    /** For engineers: which places, the home it got, and the command. */
    said(refused: string[], env: Record<string, string>): string {
      return `A tool could not write in ${refused.map((p) => inHome(p)).join(', ')}, so squad-kit ran this once more with HOME=${env.HOME}, where ${refused.length === 1 ? 'that place is' : 'those places are'} the project's own: ${command}`;
    },
    /** Learned when the run once more is past those places, whatever else it says: the next run of it, by any story, starts there. */
    learn(output: string, refused: string[]): void {
      if (cache && guard && !homeCachesRefused(output, guard).some((p) => refused.includes(p))) rememberHealed(cache, command, [...before, ...refused]);
    },
  };
}

/** A path in the person's home, as people write it. */
function inHome(p: string, home = os.homedir()): string {
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function runOnce(cwd: string, command: string, timeoutMs: number, watch: CommandWatch): Promise<CommandResult> {
  const started = Date.now();
  if (watch.signal?.aborted) return Promise.resolve({ ok: false, output: STOPPED, seconds: 0 });
  return new Promise((resolve) => {
    const child = spawnProject(command, { cwd, env: { CI: '1', FORCE_COLOR: '0', ...watch.env }, ...(watch.guard ? { guard: watch.guard } : {}) });
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
    const finish = (ok: boolean, output: string, code?: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(silent);
      watch.signal?.removeEventListener('abort', onStop);
      resolve({ ok, output, seconds: (Date.now() - started) / 1000, ...(ended ? { ended: true } : {}), ...(typeof code === 'number' ? { code } : {}) });
    };
    child.on('error', (err) => finish(false, err.message));
    // Something the command started still holds its output after it exited: end it too.
    whenExited(child, 1000, () => endGroup(child)).then((code) => {
      if (watch.endAll) endGroup(child);
      finish(code === 0 && !ended, `${out.trim()}${ended ? `\n(${ended})` : ''}`.trim(), code);
    });
  });
}

/**
 * A check can fail once for no reason in the code, such as a flaky test, so a failed one runs once more before anyone
 * is sent to fix it. Not after a Stop, a command squad-kit had to end (a second wait says nothing new), or a blocked
 * file: those fail the same way again. `alone` may give a quicker look first, at just what failed: still failing there,
 * the check fails at once, with what the whole first run printed. Passing there decides nothing by itself, as a test can
 * fail only beside the others (data they share, the order they run in): the whole command runs once more, and decides.
 */
export async function withOneMoreRun<R extends { ok: boolean; output: string; ended?: boolean }>(run: () => Promise<R>, watch: CommandWatch, onAgain: () => void, alone?: (first: R) => (() => Promise<{ ok: boolean }>) | null): Promise<R & { failedFirst?: string }> {
  const first = await run();
  if (first.ok || first.ended || watch.signal?.aborted) return first;
  if (watch.guard && guardBlockedPath(first.output, watch.guard)) return first;
  onAgain();
  const quick = alone?.(first);
  if (quick && !(await quick()).ok) return first;
  if (watch.signal?.aborted) return first;
  const again = await run();
  return again.ok ? { ...again, failedFirst: tail(first.output, 30) } : again;
}

/** At most this many failed tests run again on their own first; with more, the whole test command runs again at once. */
export const MAX_ALONE = 10;

/**
 * The quick look before a failed test command runs again: only the tests that failed, each on its own with the
 * project's own test tool (engine/failed-tests.ts). A browser suite of minutes becomes a run of seconds. A test that
 * still fails on its own fails the check at once, with no second run of the whole suite. Only when squad-kit can name
 * every failed test, run each one alone, and the failure skipped nothing (in "npm test && npm run test:e2e" a failure in
 * the first part means the second never ran). A pass must say a test passed: a filter that found nothing proves nothing.
 */
export function failedAlone(cwd: string, command: string, watch: CommandWatch): (first: { output: string }) => (() => Promise<{ ok: boolean }>) | null {
  return (first) => {
    const failed = failedTests(first.output);
    if (!failed.length || failed.length > MAX_ALONE) return null;
    const each = failed.map((t) => testAlone(cwd, command, t));
    if (each.some((c) => !c)) return null;
    return async () => {
      for (const one of each as string[]) {
        const r = await runCommand(cwd, one, undefined, { silentMs: CHECK_SILENT_MS, ...watch });
        if (!r.ok || !testCount(r.output)) return { ok: false };
      }
      return { ok: true };
    };
  };
}

/** The plain line for a check that failed once and passed when run again. */
export function failedOnceLine(name: string): string {
  if (name === 'start') return 'The app did not start the first time, and started when run again.';
  const what = name === 'test' ? 'A test' : name === 'lint' ? 'The code check' : name === 'build' ? 'The build' : `The ${name} check`;
  return `${what} failed once and passed when run again.`;
}

export const OWN_CHECK = 'scripts/check';

/** A project's own scripts/check, as one more check, unless a command it has already runs it. Windows can't run it by that name. */
export function ownCheck(cwd: string, commands: ProjectCommands): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const stat = fs.statSync(path.join(cwd, OWN_CHECK));
    if (!stat.isFile() || !(stat.mode & 0o111)) return undefined;
  } catch {
    return undefined;
  }
  const said = [commands.test, commands.lint, commands.build].filter(Boolean).join(' ');
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // Not a node project.
  }
  return [said, ...scriptsOf(said).map((s) => scripts[s] ?? '')].some((c) => c.includes(OWN_CHECK)) ? undefined : `./${OWN_CHECK}`;
}

/** The checks runChecks runs before any app start, in order: the saved test, lint and build, then the project's scripts/check. */
export function checksToRun(cwd: string, commands: ProjectCommands): { name: string; command: string }[] {
  const steps = [...(['test', 'lint', 'build'] as const).map((name) => ({ name, command: commands[name]?.trim() })), { name: 'check', command: ownCheck(cwd, commands) }];
  return steps.filter((s): s is { name: string; command: string } => Boolean(s.command));
}

/** After these results, runChecks also checks that the app starts: the project says how it starts, and no tests ran. */
export function startsToo(commands: ProjectCommands, results: { name: string; output: string }[]): boolean {
  return Boolean(commands.start?.trim() && commands.url?.trim()) && !results.some((r) => r.name === 'test' && testCount(r.output) !== 0);
}

/**
 * The project's checks, one after another. When no tests ran (none set up, or none found) and the project says how it
 * starts, "start" checks that the app starts and answers at its address, then stops it: then it is the one check of
 * what the app does. With tests, the Tester starts the app for the proof anyway. After a Stop, the ones not run yet
 * never start.
 */
export async function runChecks(cwd: string, commands: ProjectCommands, onStart?: (name: string, command?: string) => void, watch: CommandWatch = {}, appWaitMs?: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, command } of checksToRun(cwd, commands)) {
    if (watch.signal?.aborted) break;
    onStart?.(name, command);
    // A failed test command runs its failed tests on their own first, when it can: still failing, nothing more runs.
    const r = await withOneMoreRun(() => runCommand(cwd, command, undefined, { silentMs: CHECK_SILENT_MS, ...watch }), watch, () => onStart?.(name), name === 'test' ? failedAlone(cwd, command, watch) : undefined);
    results.push({ name, command, ...r });
  }
  const start = commands.start?.trim();
  const url = commands.url?.trim();
  if (start && url && startsToo(commands, results) && !watch.signal?.aborted) {
    onStart?.('start');
    const once = async () => {
      const began = Date.now();
      const seconds = () => (Date.now() - began) / 1000;
      try {
        const app = await startApp(cwd, start, url, appWaitMs, watch.signal, watch.guard, watch.onHealed ? { onHealed: watch.onHealed } : {});
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

/** The address an app must keep is taken by another program. */
export class AddressTaken extends Error {}

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
 *
 * An app that stopped while starting because a tool could not write its cache in the person's home starts once more,
 * by itself, with a home of the project's own, as runCommand does: `onHealed` gets the details.
 */
export async function startApp(cwd: string, command: string, url: string, waitMs = 3 * 60_000, signal?: AbortSignal, guard?: GuardSpec, more: { fixed?: boolean; env?: Record<string, string>; onHealed?(detail: string): void } = {}): Promise<RunningApp> {
  if (signal?.aborted) throw new Error(STOPPED);
  // The app squad-kit stopped a moment ago (the last round of screenshots) is no other program: on a busy computer it may
  // still be on its way out, and its port is about to be free. Going around it would break an app that cannot move.
  await stopping.get(portOf(url) ?? 0);
  if (signal?.aborted) throw new Error(STOPPED);
  const taken = (await answers(url)) || (await held(portOf(url)));
  // A part of a product keeps its address: what calls it knows it by that.
  if (taken && more.fixed) throw new AddressTaken(`${url} is used by another program (${command}).`);
  const port = taken ? await freePort() : null;
  const target = port ? url.replace(/(:\/\/[^/:]+)(:\d+)?/, `$1:${port}`) : url;
  const own = port ? appPortVariables(cwd, portOf(url)) : [];
  const moved = port ? Object.fromEntries(['PORT', ...own].map((name) => [name, String(port)])) : {};
  const env = { CI: '1', FORCE_COLOR: '0', BROWSER: 'none', ...moved, ...more.env };
  const homes = ownHomes(command, guard);
  /** One start of the command: what it printed, and how it ended. */
  const launch = (extra: Record<string, string> | null) => {
    const run = { child: spawnProject(command, { cwd, env: { ...env, ...extra }, ...(guard ? { guard } : {}) }), out: '', exited: null as number | null };
    const keep = (chunk: Buffer) => {
      run.out = (run.out + chunk.toString('utf8')).slice(-6_000);
    };
    run.child.stdout!.on('data', keep);
    run.child.stderr!.on('data', keep);
    run.child.on('error', (err) => {
      run.out += `\n${err.message}`;
      run.exited = -1;
    });
    run.child.on('exit', (code) => (run.exited = code ?? 0));
    return run;
  };
  let app = launch(homes.env(homes.before));
  // The places it was started once more for, when it was.
  let healed: string[] | null = null;
  // The whole process group: the shell, npm, and the server it started.
  const stop = () => {
    endGroup(app.child);
    const at = portOf(target);
    if (!at || stopping.has(at)) return;
    const ended = app;
    const gone = goneFrom(at, () => ended.exited !== null).finally(() => stopping.delete(at));
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
      if (app.exited !== null) {
        // Once only: a tool that could not write its cache in the person's home starts once more with a home of the project's own.
        const refused: string[] = healed ? [] : homes.refused(app.out);
        const home = refused.length ? homes.env([...homes.before, ...refused]) : null;
        if (!home) throw new Error(`The app stopped while starting (${command}):${busy} ${tail(app.out, 8)}`);
        const detail = homes.said(refused, home);
        if (more.onHealed) more.onHealed(detail);
        else writeLog({ level: 'info', text: detail });
        endGroup(app.child);
        healed = refused;
        app = launch(home);
        continue;
      }
      if (await answers(target)) {
        // It came up just as the Stop came: it does not outlive it.
        if (signal?.aborted) {
          stop();
          throw new Error(STOPPED);
        }
        if (healed) homes.learn(app.out, healed);
        const up = app;
        return { url: target, stop, lines: (n = 20) => tail(up.out.trim(), n), ended: () => up.exited !== null };
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** tries)));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  stop();
  throw new Error(
    port
      ? `The app did not start on a free port.${busy} Stop the other program, then press Try again. (${command}): ${tail(app.out, 8)}`
      : `The app did not answer at ${url} within ${Math.round(waitMs / 60_000)} minutes (${command}): ${tail(app.out, 8)}`,
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
