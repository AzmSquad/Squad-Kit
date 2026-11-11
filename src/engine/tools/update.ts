import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import { writeLog } from '../../core/app-log.js';
import { OWN_GROUP, endGroup, track, whenExited } from '../process-group.js';
import { toolEntry, type ManagedBy, type System, type ToolEntry, type ToolId } from './catalog.js';
import { flutterVersionOf, systemOf, type DetectHost, type Found, type FoundBook } from './detect.js';
import { compareVersions } from './fit.js';
import { GetTrouble, measured, noteTime, setTrouble, startOne, type Getting } from './get.js';

/**
 * Updating a tool you installed yourself, when squad-kit safely can: Flutter for now, with Flutter's own
 * `flutter upgrade`, never with --force. One Flutter serves every Flutter project on the computer, so the page warns
 * and asks first. squad-kit updates only a plain copy of Flutter's own repository, on one of its channels, with no
 * changes of its own, in a folder this person may change, and not looked after by another tool. Any other copy gets
 * the steps to do it yourself.
 */

/* ── whether it is safe ─────────────────────────────────── */

const nameOf = (id: ToolId) => toolEntry(id)?.name ?? id;
const cant = (why: string) => `squad-kit can't update it here: ${why}.`;

/** Flutter's own repository, as git writes where it came from. */
const FLUTTER_REPO = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]flutter\/flutter(?:\.git)?\/?$/i;
/** Flutter's own channels: `flutter upgrade` follows these. A branch of one's own is left alone. */
const CHANNELS = ['stable', 'beta', 'main', 'master'];

const MANAGER_WORDS: Record<ManagedBy, string> = { homebrew: 'Homebrew', fvm: 'FVM', snap: 'a snap package' };

/** Another tool that looks after this folder, from where it is: Homebrew's Caskroom, an FVM folder, a snap. */
export function managedByOf(dir: string): ManagedBy | undefined {
  const parts = dir.split(/[\\/]+/);
  if (parts.includes('Caskroom')) return 'homebrew';
  if (parts.includes('fvm') || parts.includes('.fvm')) return 'fvm';
  if (parts.includes('snap')) return 'snap';
  return undefined;
}

/**
 * Whether squad-kit can update this Flutter itself, with a few short git commands that only read: never a password,
 * never a change. The first reason it can't is the one said; no reason means it can, after the person's OK.
 */
export async function flutterUpdateLook(h: DetectHost, f: Found): Promise<NonNullable<Found['update']> | undefined> {
  if (f.state !== 'found' || !f.where) return undefined;
  const sdk = f.where;
  const managedBy = managedByOf(sdk);
  const by = managedBy ? { managedBy } : {};
  if (h.system === 'windows') return { ...by, cant: cant('on Windows, you update Flutter yourself for now') };
  if (managedBy) return { ...by, cant: cant(`${MANAGER_WORDS[managedBy]} looks after this Flutter, and updates it itself`) };
  if (!h.exists(path.join(sdk, '.git'))) return { cant: cant('this Flutter was not installed the usual way, so it cannot update itself') };
  if (!h.writable(sdk) || !h.writable(path.join(sdk, '.git'))) return { cant: cant("your Flutter folder needs your computer's password to change") };
  // Read only: no lock taken, and never a question about a password.
  const git = (...args: string[]) => h.run('git', ['-C', sdk, ...args], { timeoutMs: 10_000, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  const origin = await git('remote', 'get-url', 'origin');
  if (!origin.ok || !FLUTTER_REPO.test(origin.out.trim())) return { cant: cant("this Flutter does not come from Flutter's own site") };
  const head = await git('symbolic-ref', '-q', 'HEAD');
  const branch = head.out.trim().replace(/^refs\/heads\//, '');
  if (!head.ok || !branch) return { cant: cant('your Flutter is set to stay on one version') };
  if (!CHANNELS.includes(branch)) return { cant: cant(`your Flutter follows a branch of its own, ${branch}, not one of Flutter's channels`) };
  const status = await git('status', '--porcelain');
  if (!status.ok) return { cant: cant('it could not look inside your Flutter folder') };
  if (status.out.trim()) return { cant: cant('your Flutter folder has changes of its own') };
  return {};
}

/** Adds whether squad-kit can update Flutter here, the one tool it updates for now. Never stops a check: a problem is a plain reason. */
export async function addUpdateLooks(h: DetectHost, book: FoundBook): Promise<FoundBook> {
  const f = book.tools.flutter;
  if (f?.state !== 'found') return book;
  const update = await flutterUpdateLook(h, f).catch(() => ({ cant: cant('it could not look inside your Flutter folder') }));
  return update ? { ...book, tools: { ...book.tools, flutter: { ...f, update } } } : book;
}

/* ── what the page says first ───────────────────────────── */

const about = (seconds: number) => {
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? 'about a minute' : `about ${m} minutes`;
};

/** How long an update took here last time, else the usual time. */
export function updateGuess(id: ToolId, home = squadHome()): number {
  return measured(`${id}-update`, home) ?? toolEntry(id)?.update?.seconds ?? 300;
}

/** The warning said before the OK: "This updates Flutter for every Flutter project on this Mac, not only this one. …" */
export function updateWarning(e: ToolEntry, system: System, seconds: number): string {
  const u = e.update!;
  return `This updates ${e.name} for ${u.reaches} on ${system === 'mac' ? 'this Mac' : 'this computer'}, not only this one. Older projects may need small changes to build again. It downloads ${u.size} and takes ${about(seconds)}.`;
}

/* ── the update itself ──────────────────────────────────── */

/** It runs with these: no usage numbers sent, no colors, and no questions, as on a build server. */
export const UPDATE_ENV = { FLUTTER_SUPPRESS_ANALYTICS: 'true', CI: 'true', NO_COLOR: '1' } as const;
/** An update that takes longer than this is stopped. */
export const UPDATE_LIMIT_MS = 30 * 60_000;
/**
 * Once the new Flutter is in, Flutter checks itself (flutter doctor): that check gets this long of its own. Past it,
 * squad-kit ends it, and the version Flutter has now says whether the update is done.
 */
export const DOCTOR_LIMIT_MS = 5 * 60_000;
/** When the update's own program has ended, what it started gets this long to let go of its output. Then it is ended. */
export const LET_GO_MS = 2000;
/** Asking Flutter its version, after a limit stopped the update. */
const VERSION_MS = 2 * 60_000;

/** Flutter's lines once the new Flutter is in: its new version, then its own check. */
const UPDATE_IN = /^Running flutter doctor\b|^Flutter \d+\.\d+\.\d+\S*\s+•\s+channel\b/i;

/** "30 minutes", "1 second". */
const limitWords = (ms: number) => {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

export const FIRST_STEP = 'Looking for the new Flutter';

/** Flutter's own lines and the step each starts, in plain words. Steps only go forward. */
const FLUTTER_STEPS: { test: RegExp; words: string }[] = [
  { test: /^Upgrading Flutter\b|^Downloading\b/i, words: 'Downloading the new Flutter' },
  { test: /^Building flutter tool|^Running pub (?:upgrade|get)|^Resolving dependencies|^Got dependencies|^Running flutter doctor/i, words: 'Getting Flutter ready' },
  { test: /^Doctor summary|^Flutter is already up to date/i, words: 'Checking the new Flutter' },
];

/** A line of output worth showing a person, cleaned; null for a progress bar, a stack trace line or a frame. */
export function usefulLine(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const l = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
  if (l.length < 4) return null;
  // A stack trace: its first line, Dart's "#0 main (package:…)", or an "at …" line.
  if (/^Unhandled exception:?$/i.test(l) || /^#\d+\s|^at\s|\((?:package|dart|file):|^(?:package|dart):/.test(l)) return null;
  // A download's progress, as curl prints it.
  if (/% Total|% Received|^[\d\s.,%:kKMG-]+$/.test(l)) return null;
  // Only lines and dots, as boxes and rules are drawn.
  if (/^[\s─━═│┃┌┐└┘├┤╔╗╚╝•·=*_-]+$/.test(l)) return null;
  return l.length > 240 ? `${l.slice(0, 239)}…` : l;
}

/** The update's program as it runs. Tests give a made-up one. */
export type RunUpdate = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLine(line: string): void }) => Promise<{ code: number | null; error?: string }>;

/** Ends the program and everything it started: its whole group, TERM then KILL. On Windows as before: the program, TERM then KILL. */
function endAll(child: ChildProcess): void {
  if (process.platform !== 'win32') return endGroup(child);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10_000).unref();
}

/**
 * Runs the program, line by line, with nothing to read from, in a process group of its own. A stop ends the whole
 * group. Its own end is the end: what it started gets LET_GO_MS to let go of its output, then the output is cut off,
 * and whatever is still left in its group is ended. Nothing it started outlives it.
 */
const runProgram: RunUpdate = (cmd, args, opts) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = track(spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP }));
    } catch (err) {
      resolve({ code: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (s: string) => {
        const lines = (rest + s).split(/\r\n|\r|\n/);
        rest = lines.pop() ?? '';
        for (const l of lines) opts.onLine(l);
      });
      stream?.on('end', () => {
        if (rest) opts.onLine(rest);
        rest = '';
      });
    }
    let done = false;
    const stop = () => endAll(child);
    const finish = (r: { code: number | null; error?: string }) => {
      if (done) return;
      done = true;
      opts.signal.removeEventListener('abort', stop);
      resolve(r);
    };
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => finish({ code: null, error: err.message }));
    void whenExited(child, LET_GO_MS).then((code) => {
      endAll(child);
      finish({ code });
    });
  });

let runner: RunUpdate = runProgram;

/** Tests run a made-up update, never a real one. Null goes back to the real program. */
export function useUpdateRun(run: RunUpdate | null): void {
  runner = run ?? runProgram;
}

/** Flutter's version as its own files say, with nothing run. */
function versionFile(sdk: string): string | null {
  for (const file of [path.join(sdk, 'bin', 'cache', 'flutter.version.json'), path.join(sdk, 'version')]) {
    try {
      const v = flutterVersionOf(fs.readFileSync(file, 'utf8'));
      if (v) return v;
    } catch {
      // Not there.
    }
  }
  return null;
}

/** Flutter's version as it says itself (`flutter --version --machine`, which also writes its file again), with a limit. */
async function versionSaid(bin: string, sdk: string, run: RunUpdate): Promise<string | null> {
  const lines: string[] = [];
  const r = await run(bin, ['--version', '--machine'], { cwd: sdk, env: { ...process.env, ...UPDATE_ENV }, signal: AbortSignal.timeout(VERSION_MS), onLine: (l) => lines.push(l) });
  return r.error ? null : flutterVersionOf(lines.join('\n'));
}

/** Flutter's version now: before an update its files; after a limit stopped one, its files or Flutter itself. */
export type ReadVersion = (sdk: string, when: 'before' | 'after') => Promise<string | null>;

/**
 * Updates one tool in its own folder with its own updater, and says each step in plain words. Throws a reason a
 * person can read: Flutter's last useful line, never a stack trace. squad-kit adds nothing of its own to the folder.
 */
export async function updateTool(
  id: ToolId,
  sdk: string,
  opts: { system?: System; run?: RunUpdate; signal?: AbortSignal; limitMs?: number; doctorMs?: number; version?: ReadVersion; onStep?(words: string): void } = {},
): Promise<{ seconds: number }> {
  const name = nameOf(id);
  if (id !== 'flutter') throw new GetTrouble(`squad-kit can't update ${name} itself. The Tools page shows the steps.`);
  const system = opts.system ?? systemOf();
  const bin = path.join(sdk, 'bin', system === 'windows' ? 'flutter.bat' : 'flutter');
  const run = opts.run ?? runner;
  let before: string | null = null;
  const version: ReadVersion =
    opts.version ??
    (async (dir, when) => {
      const file = versionFile(dir);
      // After, its files when they already show a newer one, else Flutter itself, which writes them again.
      if (when === 'before' || (file && before && compareVersions(file, before) > 0)) return file;
      return (await versionSaid(bin, dir, run).catch(() => null)) ?? file;
    });
  // Read as the update starts, before it changes anything, and never in its way.
  const was = version(sdk, 'before').catch(() => null);
  const stop = new AbortController();
  const limitMs = opts.limitMs ?? UPDATE_LIMIT_MS;
  const doctorMs = opts.doctorMs ?? DOCTOR_LIMIT_MS;
  const timer = setTimeout(() => stop.abort('time'), limitMs);
  let doctor: NodeJS.Timeout | undefined;
  let inAt = 0;
  const fromOutside = () => stop.abort('stopped');
  if (opts.signal?.aborted) fromOutside();
  opts.signal?.addEventListener('abort', fromOutside, { once: true });
  const started = Date.now();
  let last = null as string | null;
  let at = -1;
  try {
    const r = await run(bin, ['upgrade'], {
      cwd: sdk,
      env: { ...process.env, ...UPDATE_ENV },
      signal: stop.signal,
      onLine: (raw) => {
        const line = usefulLine(raw);
        if (!line) return;
        last = line;
        const i = FLUTTER_STEPS.findIndex((s) => s.test.test(line));
        if (i > at) {
          at = i;
          opts.onStep?.(FLUTTER_STEPS[i]!.words);
        }
        // The new Flutter is in: its own check after gets a short limit of its own.
        if (!inAt && UPDATE_IN.test(line)) {
          inAt = Date.now();
          doctor = setTimeout(() => stop.abort('doctor'), doctorMs);
        }
      },
    });
    const said = last ? ` ${name} said: "${last}"` : '';
    before = await was;
    const limit = stop.signal.reason === 'time' || stop.signal.reason === 'doctor' ? (stop.signal.reason as 'time' | 'doctor') : null;
    if (limit) {
      // A limit ended it, but the new Flutter may be in all the same: the version it has now says, when there was one before.
      const after = before ? await version(sdk, 'after').catch(() => null) : null;
      if (before && after && compareVersions(after, before) > 0) {
        writeLog({ level: 'info', text: `Updating ${name}: ${limit === 'doctor' ? `its own check took more than ${limitWords(doctorMs)}` : `it took more than ${limitWords(limitMs)}`}, so squad-kit ended it. ${name} went from ${before} to ${after}, so the update is done.` });
        return { seconds: ((inAt || Date.now()) - started) / 1000 };
      }
      if (limit === 'time') throw new GetTrouble(`The update of ${name} took more than ${limitWords(limitMs)}, so squad-kit stopped it. Check the internet connection, then try again, or do it yourself with the steps.`);
      throw new GetTrouble(`The update of ${name} did not finish: its own check took more than ${limitWords(doctorMs)}, so squad-kit stopped it. Try again, or do it yourself with the steps.`);
    }
    if (stop.signal.aborted) throw new GetTrouble(`The update of ${name} was stopped before the end. Try again, or do it yourself with the steps.`);
    if (r.error) {
      writeLog({ level: 'warn', text: `Updating ${name}: could not start ${bin}: ${r.error}` });
      throw new GetTrouble(`squad-kit could not start ${name}'s update. Do it yourself with the steps.`);
    }
    if (r.code !== 0) throw new GetTrouble(`The update of ${name} did not finish.${said} Try again, or do it yourself with the steps.`);
    return { seconds: (Date.now() - started) / 1000 };
  } finally {
    clearTimeout(timer);
    clearTimeout(doctor);
    opts.signal?.removeEventListener('abort', fromOutside);
  }
}

/**
 * Starts updating a tool beside everything else, in the same one-at-a-time slot as Get it, so its line shows the
 * progress: the step in plain words and about how long is left, from the time it took here last time. A failure is
 * kept as the line's trouble. `after` runs when it ends, well or not.
 */
export function startUpdate(
  id: ToolId,
  sdk: string,
  opts: { home?: string; system?: System; run?: RunUpdate; limitMs?: number; doctorMs?: number; version?: ReadVersion; signal?: AbortSignal; after?: () => void } = {},
): Getting {
  const home = opts.home ?? squadHome();
  const name = nameOf(id);
  const guess = updateGuess(id, home);
  const t0 = Date.now();
  const first: Getting = { tool: id, name, startedAt: new Date(t0).toISOString(), step: 'update', done: 0, total: guess, secondsLeft: guess, words: FIRST_STEP };
  return startOne(
    first,
    async (set) => {
      let g = first;
      const show = (words = g.words) => {
        const elapsed = (Date.now() - t0) / 1000;
        // Counted from the usual time; the bar never reaches the end before the update does.
        g = { ...g, ...(words ? { words } : {}), done: Math.min(Math.round(elapsed), Math.round(guess * 0.95)), secondsLeft: Math.max(10, Math.round(guess - elapsed)) };
        set(g);
      };
      const tick = setInterval(() => show(), 1000);
      tick.unref();
      setTrouble(id);
      try {
        const r = await updateTool(id, sdk, { ...(opts.system ? { system: opts.system } : {}), ...(opts.run ? { run: opts.run } : {}), ...(opts.limitMs ? { limitMs: opts.limitMs } : {}), ...(opts.doctorMs ? { doctorMs: opts.doctorMs } : {}), ...(opts.version ? { version: opts.version } : {}), ...(opts.signal ? { signal: opts.signal } : {}), onStep: (w) => show(w) });
        noteTime(`${id}-update`, r.seconds, home);
        writeLog({ level: 'info', text: `Updated ${name} in ${Math.round(r.seconds)} s, in ${sdk}` });
      } catch (err) {
        const words = err instanceof GetTrouble ? err.message : `squad-kit could not update ${name}. Try again, or do it yourself with the steps.`;
        if (!(err instanceof GetTrouble)) writeLog({ level: 'warn', text: `Updating ${name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` });
        else writeLog({ level: 'warn', text: `Updating ${name}: ${words}` });
        setTrouble(id, words);
      } finally {
        clearInterval(tick);
      }
    },
    opts.after,
  );
}
