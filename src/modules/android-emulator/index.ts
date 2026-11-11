import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PhoneError, type AppOnPhone, type PhoneDevice, type PhoneModel, type PhoneModule, type PhoneRuntime, type PhoneTools } from '../phone/types.js';

/**
 * Google's Android Emulator, through the Android SDK's own tools: squad-kit's own phones ("squad-kit Android phone",
 * "squad-kit Android tablet") are made with avdmanager in squad-kit's own folder, started hidden on a fixed port so
 * their serial is known, given the app with adb, and shut down by that serial. Every emulator and adb call gets
 * squad-kit's folder as its home, so nothing goes to the person's ~/.android, and their own phones are never listed,
 * started or stopped. The first start is cold and saves a snapshot; every start after loads it, in about 5 seconds.
 * A hidden emulator cannot show a window later: for a person it starts again from the snapshot, with its window.
 */

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
  /** What it printed, as bytes, when asked for (a picture). */
  bytes?: Buffer;
}

/** Runs one program and gives what it printed. Tests give a made-up one. */
export type AndroidRun = (file: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; binary?: boolean }) => Promise<Ran>;

/** Starts the emulator on its own, beside squad-kit, writing what it prints to a log file. Gives its process number. */
export type AndroidSpawn = (file: string, args: string[], o: { env: NodeJS.ProcessEnv; log: string }) => number;

/** What the module reads of this computer. Tests give a made-up one. */
export interface AndroidHost {
  alive(pid: number): boolean;
  /** True when the process with this number is an emulator: a number another program took over is never signalled. */
  isEmulator(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  portFree(port: number): Promise<boolean>;
  /** The process listening on a port of this computer, or null when none (or this computer can't say). */
  listener(port: number): Promise<number | null>;
  /** A process's command line, or null when it is gone. */
  commandOf(pid: number): string | null;
  sleep(ms: number): Promise<void>;
}

const realRun: AndroidRun = (file, args, o) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { env: o.env, timeout: o.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(o.binary ? { encoding: 'buffer' as const } : { encoding: 'utf8' as const }) },
      (err, out, errText) => {
        const bytes = Buffer.isBuffer(out) ? out : undefined;
        resolve({ ok: !err, out: bytes ? '' : String(out ?? ''), err: `${String(errText ?? '')}${err && !errText?.length ? err.message : ''}`, ...(bytes ? { bytes } : {}) });
      },
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });

const realSpawn: AndroidSpawn = (file, args, o) => {
  fs.mkdirSync(path.dirname(o.log), { recursive: true });
  const out = fs.openSync(o.log, 'a');
  // On its own: the phone stays up between pictures, and squad-kit shuts it down by its serial.
  const child = spawn(file, args, { env: o.env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  if (!child.pid) throw new PhoneError('The Android phone did not start.', `${file} did not start`);
  return child.pid;
};

const realHost: AndroidHost = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  isEmulator: (pid) => {
    if (process.platform === 'win32') return true;
    try {
      return /emulator|qemu/i.test(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }));
    } catch {
      return false;
    }
  },
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  portFree: (port) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    }),
  listener: (port) =>
    new Promise((resolve) => {
      // Windows says it with netstat; the Mac and Linux with lsof. Only read, never changed.
      const win = process.platform === 'win32';
      execFile(win ? 'netstat' : 'lsof', win ? ['-ano', '-p', 'TCP'] : ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, out) => {
        if (win) {
          const line = String(out ?? '').split('\n').find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(l));
          return resolve(line ? Number(line.trim().split(/\s+/).pop()) || null : null);
        }
        const pid = Number(String(out ?? '').trim().split('\n')[0]);
        resolve(!err && pid ? pid : null);
      });
    }),
  commandOf: (pid) => {
    try {
      if (process.platform === 'win32') return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim() || null;
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The port adb's server listens on, the one Maestro reaches phones through. */
export const ADB_PORT = 5037;
/** An adb server's command line: "adb -L tcp:5037 fork-server server --reply-fd 4", or adb.exe on Windows. */
const ADB_SERVER = /\badb(\.exe)?\b/i;

/**
 * The environment without the person's own Android settings (ANDROID_SDK_HOME, ANDROID_SERIAL, …): squad-kit's calls
 * set their own, and one left from the person's could point a tool at their folders or their phone.
 */
export function withoutAndroid(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ANDROID_')));
}

/** squad-kit's devices are named "squad-kit-android-…": nothing else is ever passed to a command. */
const OWN_NAME = /^squad-kit-android-[a-z0-9-]+$/;
/** Seconds an emulator gets to end after `emu kill` before its exact process is asked to (it usually takes 1 to 3). */
const STOP_WAIT_S = 15;
/** The snapshot every start loads, saved once after the first start: a clean phone each time. */
export const SNAPSHOT = 'squad-kit-ready';
/** The console port each of squad-kit's devices asks for first; its serial is emulator-<port>. Even, in adb's range. */
export const PORTS: Record<string, number> = { 'squad-kit-android-phone': 5560, 'squad-kit-android-tablet': 5562 };
const FIRST_PORT = 5554;
const LAST_PORT = 5584;
/** The device kinds squad-kit makes, from Google's own device list. */
export const MODELS: PhoneModel[] = [
  { id: 'pixel_9', name: 'Pixel 9', size: 'phone' },
  { id: 'pixel_tablet', name: 'Pixel Tablet', size: 'tablet' },
];
/** Android's version for each API level, for people: API 36 is Android 16. */
const VERSIONS: Record<number, string> = { 37: '17', 36: '16', 35: '15', 34: '14', 33: '13', 32: '12L', 31: '12', 30: '11', 29: '10', 28: '9', 27: '8.1', 26: '8.0', 25: '7.1', 24: '7.0' };
/** The images squad-kit can start, best first: Google's services without the Play Store, then plain Android, then the Play Store's. */
const TAGS = ['google_apis', 'default', 'google_apis_playstore'];
/** Android 13 (API 33) is the first that opens one app in a language of its own. */
const APP_LANGUAGES_FROM = 33;

/** The locale tag that goes with a language: Arabic as in Saudi Arabia, English as in the United States. */
const LOCALES: Record<string, string> = { ar: 'ar-SA', en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ur: 'ur-PK', tr: 'tr-TR' };

export function localeTag(language: string): string {
  const l = language.trim().toLowerCase().split(/[-_]/)[0] || 'en';
  return LOCALES[l] ?? `${l}-${l.toUpperCase()}`;
}

/** "squad-kit Android phone" as an AVD may be named: "squad-kit-android-phone". */
export function avdName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The image a system-images folder holds, as sdkmanager names it: "system-images;android-36;google_apis;arm64-v8a". */
export function imageId(api: number, tag: string, abi: string): string {
  return `system-images;android-${api};${tag};${abi}`;
}

/** The chip an Android image must be built for to run fast on this computer. */
export function abiFor(arch: string): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

/** The images in an SDK this computer can start, newest first, with the devices squad-kit makes on them. */
export function imagesIn(sdk: string, arch: string, list: (dir: string) => string[] = safeList): PhoneRuntime[] {
  const abi = abiFor(arch);
  const out: (PhoneRuntime & { api: number; rank: number })[] = [];
  for (const level of list(path.join(sdk, 'system-images'))) {
    const api = Number(/^android-(\d+)$/.exec(level)?.[1]);
    if (!api) continue;
    for (const tag of list(path.join(sdk, 'system-images', level))) {
      const rank = TAGS.indexOf(tag);
      if (rank < 0 || !list(path.join(sdk, 'system-images', level, tag)).includes(abi)) continue;
      out.push({ id: imageId(api, tag, abi), version: VERSIONS[api] ?? String(api), models: MODELS, api, rank });
    }
  }
  return out.sort((a, b) => b.api - a.api || a.rank - b.rank).map(({ id, version, models }) => ({ id, version, models }));
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/** `aapt2 dump badging`: the app's id and the screen it opens on. */
export function badgingOf(text: string): { appId: string; activity?: string } | null {
  const appId = /^package: name='([^']+)'/m.exec(text)?.[1];
  if (!appId) return null;
  const activity = /^launchable-activity: name='([^']+)'/m.exec(text)?.[1];
  return { appId, ...(activity ? { activity } : {}) };
}

/** `aapt2 dump xmltree` of the manifest: the link names the app answers to ("myapp" for myapp://), never web addresses. */
export function schemesOf(text: string): string[] {
  const found = [...text.matchAll(/android:scheme\([^)]*\)="([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(found.filter((s) => /^[a-z][a-z0-9+.-]*$/i.test(s) && !/^https?$/i.test(s)))];
}

/** The screen an app opens on, from `cmd package resolve-activity --brief`: its last line, "dev.app/.MainActivity". */
export function launcherOf(text: string): string | null {
  const last = text.trim().split('\n').reverse().find((l) => /^[\w.]+\/[\w.$]+$/.test(l.trim()));
  return last ? last.trim() : null;
}

/** What squad-kit started for one of its devices: the port, the process, and whether it has a window. */
interface Running {
  port: number;
  pid: number;
  window: boolean;
  at: string;
}

const tail = (s: string, n = 2000) => s.trim().slice(-n);

export interface AndroidSetup {
  run?: AndroidRun;
  spawn?: AndroidSpawn;
  host?: AndroidHost;
  platform?: NodeJS.Platform;
  arch?: string;
  /** How long a start may take at most. */
  bootMs?: number;
}

/** The emulator, behind squad-kit's phone interface. Tests give made-up programs and a made-up computer. */
export function androidEmulatorWith(o: AndroidSetup = {}): PhoneModule {
  const run = o.run ?? realRun;
  const start = o.spawn ?? realSpawn;
  const host = o.host ?? realHost;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const win = platform === 'win32';
  let tools: PhoneTools = {};
  /** The screen each app opens on, read from its build: launch needs it. */
  const screens = new Map<string, string>();
  /** The API level of each running device, read once per start. */
  const levels = new Map<string, number>();

  const sdk = (): string => {
    if (!tools.sdk) throw new PhoneError("squad-kit's Android tools are not on this computer yet.", 'No Android SDK given (useTools)');
    return tools.sdk;
  };
  const home = (): string => {
    if (!tools.home) throw new PhoneError("squad-kit's Android tools are not on this computer yet.", 'No Android home given (useTools)');
    return tools.home;
  };
  const userHome = () => path.join(home(), '.android');
  const avdHome = () => path.join(userHome(), 'avd');
  const exe = (name: string) => (win ? `${name}.exe` : name);
  const adb = () => path.join(sdk(), 'platform-tools', exe('adb'));
  const emulator = () => path.join(sdk(), 'emulator', exe('emulator'));
  const cmdline = (name: string) => {
    const base = path.join(sdk(), 'cmdline-tools');
    const dirs = ['latest', ...safeList(base).filter((d) => d !== 'latest').sort().reverse()];
    for (const d of dirs) {
      const p = path.join(base, d, 'bin', win ? `${name}.bat` : name);
      if (fs.existsSync(p)) return p;
    }
    throw new PhoneError("squad-kit's Android tools are not complete on this computer.", `No ${name} in ${base}`);
  };
  const aapt2 = () => {
    const base = path.join(sdk(), 'build-tools');
    const newest = safeList(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).find((v) => fs.existsSync(path.join(base, v, exe('aapt2'))));
    if (!newest) throw new PhoneError("squad-kit's Android tools are not complete on this computer.", `No aapt2 in ${base}`);
    return path.join(base, newest, exe('aapt2'));
  };

  /**
   * Every Android call's environment: squad-kit's SDK, and its own folder for what the tools keep. ANDROID_PREFS_ROOT
   * must be the folder above ANDROID_USER_HOME, or the build tools refuse. The emulator and adb read only HOME for
   * their keys and caches: it is squad-kit's folder too, for them alone.
   */
  const env = (withHome: boolean): NodeJS.ProcessEnv => ({
    ...withoutAndroid(process.env),
    ANDROID_HOME: sdk(),
    ANDROID_SDK_ROOT: sdk(),
    ANDROID_PREFS_ROOT: home(),
    ANDROID_USER_HOME: userHome(),
    ANDROID_EMULATOR_HOME: userHome(),
    ANDROID_AVD_HOME: avdHome(),
    ...(tools.java ? { JAVA_HOME: tools.java } : {}),
    ...(withHome ? { HOME: home(), ...(win ? { USERPROFILE: home() } : {}) } : {}),
  });

  const exact = (id: string): string => {
    if (!OWN_NAME.test(id)) throw new PhoneError('squad-kit only uses its own Android phone, by its exact name.', `"${id}" is not one of squad-kit's devices`);
    return id;
  };

  /* ── what squad-kit started, kept in its own folder ─────── */

  const runningFile = () => path.join(home(), 'running.json');
  const readRunning = (): Record<string, Running> => {
    try {
      return JSON.parse(fs.readFileSync(runningFile(), 'utf8')) as Record<string, Running>;
    } catch {
      return {};
    }
  };
  const writeRunning = (all: Record<string, Running>) => {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(runningFile(), `${JSON.stringify(all, null, 2)}\n`);
  };
  /** The record of a device squad-kit started, while its process still runs; a gone one is forgotten. */
  const runningOf = (id: string): Running | null => {
    const all = readRunning();
    const r = all[id];
    if (!r) return null;
    if (host.alive(r.pid) && host.isEmulator(r.pid)) return r;
    delete all[id];
    writeRunning(all);
    levels.delete(id);
    return null;
  };
  const serialOf = (id: string): string | null => {
    const r = runningOf(id);
    return r ? `emulator-${r.port}` : null;
  };

  const adbRun = (serial: string, args: string[], timeoutMs = 60_000, binary = false) => run(adb(), ['-s', serial, ...args], { env: env(true), timeoutMs, ...(binary ? { binary } : {}) });

  /* ── adb's server: squad-kit's own only when it started it ── */

  const adbFile = () => path.join(home(), 'adb-server.json');
  const readAdb = (): { pid: number; port: number; at: string } | null => {
    try {
      const r = JSON.parse(fs.readFileSync(adbFile(), 'utf8')) as { pid?: number; port?: number; at?: string };
      return r.pid && r.port ? { pid: r.pid, port: r.port, at: r.at ?? '' } : null;
    } catch {
      return null;
    }
  };
  const forgetAdb = () => fs.rmSync(adbFile(), { force: true });
  /** True when the server squad-kit wrote down still runs as an adb, and is the one on the port: then it is squad-kit's. */
  const adbIsOurs = async (r: { pid: number; port: number }): Promise<boolean> => ADB_SERVER.test(host.commandOf(r.pid) ?? '') && (await host.listener(r.port)) === r.pid;

  /**
   * Before a phone starts: when no adb server runs, squad-kit starts its own, with its own keys, and writes down its
   * exact process number, so only that one is ever stopped. One that runs already is the person's (or squad-kit's from
   * before, by the number it wrote down): it is used as it is, and never stopped.
   */
  const ensureAdb = async (): Promise<void> => {
    const kept = readAdb();
    if (!(await host.portFree(ADB_PORT))) {
      if (kept && !(await adbIsOurs(kept))) forgetAdb();
      return;
    }
    if (kept) forgetAdb();
    const r = await run(adb(), ['start-server'], { env: env(true), timeoutMs: 30_000 });
    const pid = r.ok ? await host.listener(ADB_PORT) : null;
    if (pid && ADB_SERVER.test(host.commandOf(pid) ?? '')) {
      fs.mkdirSync(home(), { recursive: true });
      fs.writeFileSync(adbFile(), `${JSON.stringify({ pid, port: ADB_PORT, at: new Date().toISOString() }, null, 2)}\n`);
    }
  };
  /** One adb command on a device; a failure says `what` to people, and what adb printed to engineers. */
  const adbOk = async (id: string, args: string[], what: string, timeoutMs = 60_000): Promise<string> => {
    const serial = serialOf(exact(id));
    if (!serial) throw new PhoneError(what, `${id} is not running`);
    const r = await adbRun(serial, args, timeoutMs);
    if (!r.ok) throw new PhoneError(what, `adb -s ${serial} ${args.join(' ')}: ${tail(r.err || r.out)}`);
    return r.out;
  };

  /** True once the device answers that it has finished starting. */
  const bootedNow = async (serial: string): Promise<boolean> => (await adbRun(serial, ['shell', 'getprop', 'sys.boot_completed'], 10_000)).out.trim() === '1';

  /** A port free for a device: the one it asks for first, else the next free pair in adb's range. */
  const portFor = async (id: string): Promise<number> => {
    const taken = new Set(Object.values(readRunning()).map((r) => r.port));
    const first = PORTS[id] ?? FIRST_PORT;
    const order = [first, ...Array.from({ length: (LAST_PORT - FIRST_PORT) / 2 + 1 }, (_, i) => FIRST_PORT + i * 2).filter((p) => p !== first)];
    for (const p of order) if (!taken.has(p) && (await host.portFree(p)) && (await host.portFree(p + 1))) return p;
    throw new PhoneError('squad-kit found no free place to start its Android phone.', `Ports ${FIRST_PORT} to ${LAST_PORT + 1} are all in use`);
  };

  const snapshotSaved = (id: string) => fs.existsSync(path.join(avdHome(), `${id}.avd`, 'snapshots', SNAPSHOT));

  /** Starts a device, hidden or with its window, and waits until it is up; saves the snapshot after the very first start. */
  const startDevice = async (id: string, window: boolean, timeoutMs: number): Promise<void> => {
    await ensureAdb();
    const port = await portFor(id);
    const fromSnapshot = snapshotSaved(id);
    const args = [
      '-avd',
      id,
      '-port',
      String(port),
      ...(window ? [] : ['-no-window']),
      '-no-audio',
      '-no-boot-anim',
      '-no-metrics',
      // Nothing is saved when it shuts down: every start is the same clean phone.
      '-no-snapshot-save',
      ...(fromSnapshot ? ['-snapshot', SNAPSHOT] : ['-no-snapshot-load']),
    ];
    const log = path.join(home(), 'logs', `${id}.log`);
    const pid = start(emulator(), args, { env: env(true), log });
    writeRunning({ ...readRunning(), [id]: { port, pid, window, at: new Date().toISOString() } });
    const serial = `emulator-${port}`;
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (!host.alive(pid)) {
        const all = readRunning();
        delete all[id];
        writeRunning(all);
        let said = '';
        try {
          said = fs.readFileSync(log, 'utf8');
        } catch {
          // No log: only the plain words.
        }
        throw new PhoneError('The Android phone did not start.', `emulator ${args.join(' ')} ended: ${tail(said)}`);
      }
      if (await bootedNow(serial)) break;
      if (Date.now() > until) {
        await stopExact(id, pid, serial);
        throw new PhoneError('The Android phone did not finish starting.', `emulator ${args.join(' ')}: not up after ${Math.round(timeoutMs / 1000)} s`);
      }
      await host.sleep(1000);
    }
    if (!fromSnapshot) {
      // The very first start: the clean phone is kept, so every start after takes seconds.
      const r = await adbRun(serial, ['emu', 'avd', 'snapshot', 'save', SNAPSHOT], 180_000);
      if (!r.ok || /KO/.test(r.out)) throw new PhoneError('squad-kit could not save its Android phone for next time.', `adb emu avd snapshot save: ${tail(r.err || r.out)}`);
    }
  };

  /**
   * Shuts one device down by its serial, then waits for its exact process; only that process is ever signalled. The
   * emulator's console asks for the token it keeps in its HOME, which is squad-kit's folder: adb runs with that same
   * HOME. When the console still says no ("KO"), or the emulator does not end, its exact process is asked to end.
   */
  const stopExact = async (id: string, pid: number, serial: string): Promise<void> => {
    const r = await adbRun(serial, ['emu', 'kill'], 10_000);
    const refused = !r.ok || /^KO\b/m.test(r.out);
    for (let i = 0; i < (refused ? 0 : STOP_WAIT_S) && host.alive(pid); i += 1) await host.sleep(1000);
    if (host.alive(pid) && host.isEmulator(pid)) {
      host.kill(pid, 'SIGTERM');
      for (let i = 0; i < 10 && host.alive(pid); i += 1) await host.sleep(1000);
      if (host.alive(pid) && host.isEmulator(pid)) host.kill(pid, 'SIGKILL');
    }
    const all = readRunning();
    delete all[id];
    writeRunning(all);
    levels.delete(id);
  };

  const levelOf = async (id: string): Promise<number> => {
    const known = levels.get(id);
    if (known) return known;
    const n = Number((await adbOk(id, ['shell', 'getprop', 'ro.build.version.sdk'], 'squad-kit could not read its Android phone.', 15_000)).trim()) || 0;
    if (n) levels.set(id, n);
    return n;
  };

  /**
   * Older Android has no language per app: the whole phone changes language, which restarts its system (about 15 s).
   * Only when the language is another one than now.
   */
  const systemLanguage = async (id: string, tag: string): Promise<void> => {
    const serial = serialOf(id)!;
    const now = (await adbRun(serial, ['shell', 'getprop', 'persist.sys.locale'], 10_000)).out.trim();
    if (now === tag) return;
    await adbRun(serial, ['root'], 30_000);
    await host.sleep(2000);
    const before = (await adbRun(serial, ['shell', 'pidof', 'system_server'], 10_000)).out.trim();
    await adbOk(id, ['shell', 'setprop', 'persist.sys.locale', tag], 'squad-kit could not change the Android phone\'s language.');
    await adbOk(id, ['shell', 'setprop', 'ctl.restart', 'zygote'], 'squad-kit could not change the Android phone\'s language.');
    // "Started" stays 1 through the restart: a new system, and a package list that answers, say it is back.
    for (let i = 0; i < 90; i += 1) {
      await host.sleep(1000);
      const pid = (await adbRun(serial, ['shell', 'pidof', 'system_server'], 10_000)).out.trim();
      if (pid && pid !== before && (await bootedNow(serial)) && (await adbRun(serial, ['shell', 'pm', 'path', 'android'], 10_000)).ok) return;
    }
    throw new PhoneError("The Android phone did not come back after changing its language.", `system_server did not restart on ${serial}`);
  };

  const module: PhoneModule = {
    name: 'android-emulator',
    label: 'Android emulator',
    words: { phone: 'Android phone', tablet: 'Android tablet' },
    system: 'Android',
    // First guesses, measured on a 16 GB Mac (M1 Pro): the first build fetches Gradle and its libraries, later ones take
    // seconds; a start from the snapshot takes 5 s, the first one 40 s.
    times: {
      build: { key: 'android-build', guess: 540 },
      boot: { key: 'android-boot', guess: 40 },
      install: { key: 'android-install', guess: 5 },
      'first-run': { key: 'maestro-first-android', guess: 30 },
    },
    windowRestarts: true,
    useTools(t) {
      tools = { ...t };
    },
    tapId(id) {
      return serialOf(exact(id)) ?? id;
    },
    tapEnv(): Record<string, string> {
      // Maestro reaches the phone through adb, with the same SDK and keys, in squad-kit's folder. It also lists AVDs,
      // itself and with Google's avdmanager (Java, which never reads HOME): every Android folder is squad-kit's, so it
      // only ever sees squad-kit's own devices, and the person's ~/.android is never read or rewritten.
      if (!tools.sdk || !tools.home) return {};
      const all = env(true);
      const out: Record<string, string> = {};
      for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_PREFS_ROOT', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_AVD_HOME', 'HOME', 'USERPROFILE', 'JAVA_HOME']) if (all[k]) out[k] = all[k]!;
      return out;
    },
    notHere() {
      if ((platform === 'linux' || platform === 'win32') && arch === 'arm64') return "Google's Android emulator does not run on this kind of computer yet.";
      return null;
    },
    async runtimes() {
      if (!tools.sdk) return [];
      return imagesIn(tools.sdk, arch);
    },
    async devices() {
      if (!tools.home) return [];
      const out: PhoneDevice[] = [];
      // Only squad-kit's own folder of devices is read: the person's own phones are never listed.
      for (const f of safeList(avdHome())) {
        const id = /^(.+)\.ini$/.exec(f)?.[1];
        if (!id || !OWN_NAME.test(id)) continue;
        let runtime = '';
        try {
          const ini = fs.readFileSync(path.join(avdHome(), `${id}.avd`, 'config.ini'), 'utf8');
          const dir = /^image\.sysdir\.1\s*=\s*(.+)$/m.exec(ini)?.[1]?.trim().replace(/[\\/]+$/, '');
          const parts = dir?.split(/[\\/]/) ?? [];
          if (parts.length >= 4) runtime = `${parts[0]};${parts[1]};${parts[2]};${parts[3]}`;
        } catch {
          // Its system is not known: it still shows.
        }
        const r = runningOf(id);
        const state = !r ? 'shutdown' : (await bootedNow(`emulator-${r.port}`)) ? 'booted' : 'booting';
        out.push({ id, name: id, state, runtime });
      }
      return out;
    },
    async create(name, model, runtime) {
      const id = avdName(name);
      exact(id);
      // A device of this name in squad-kit's own folder is squad-kit's: it is used again.
      if (fs.existsSync(path.join(avdHome(), `${id}.ini`))) return id;
      fs.mkdirSync(avdHome(), { recursive: true });
      const r = await run(cmdline('avdmanager'), ['create', 'avd', '-n', id, '-k', runtime, '-d', model], { env: env(false), timeoutMs: 120_000, input: 'no\n' });
      if (!r.ok || !fs.existsSync(path.join(avdHome(), `${id}.ini`))) throw new PhoneError(`squad-kit could not make its ${name}.`, `avdmanager create avd -n ${id} -k ${runtime} -d ${model}: ${tail(r.err || r.out)}`);
      return id;
    },
    async boot(id, b = {}) {
      exact(id);
      const r = runningOf(id);
      if (r && (await bootedNow(`emulator-${r.port}`))) return;
      if (r) await stopExact(id, r.pid, `emulator-${r.port}`);
      await startDevice(id, false, b.timeoutMs ?? o.bootMs ?? 300_000);
    },
    async install(id, apk) {
      const serial = serialOf(exact(id));
      if (!serial) throw new PhoneError('squad-kit could not put the app on the Android phone.', `${id} is not running`);
      let r = await adbRun(serial, ['install', '-r', '-d', apk], 300_000);
      // Another build of the app, signed another way, is there: it goes first.
      if (!r.ok || /Failure/.test(r.out)) {
        const appId = /INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ([\w.]+)/.exec(`${r.out}${r.err}`)?.[1];
        if (appId) {
          await adbRun(serial, ['uninstall', appId], 60_000);
          r = await adbRun(serial, ['install', '-r', '-d', apk], 300_000);
        }
      }
      if (!r.ok || /Failure/.test(r.out)) throw new PhoneError('squad-kit could not put the app on the Android phone.', `adb install ${apk}: ${tail(r.err || r.out)}`);
    },
    async appInfo(apk) {
      const tool = aapt2();
      const b = await run(tool, ['dump', 'badging', apk], { env: env(false), timeoutMs: 60_000 });
      const info = b.ok ? badgingOf(b.out) : null;
      if (!info) throw new PhoneError('squad-kit could not read the app it built.', `aapt2 dump badging ${apk}: ${tail(b.err || b.out, 1000)}`);
      if (info.activity) screens.set(info.appId, info.activity);
      const x = await run(tool, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], { env: env(false), timeoutMs: 60_000 });
      const app: AppOnPhone = { appId: info.appId, schemes: x.ok ? schemesOf(x.out) : [] };
      return app;
    },
    async launch(id, appId, l = {}) {
      exact(id);
      const what = 'The app did not open on the Android phone.';
      await adbOk(id, ['shell', 'am', 'force-stop', appId], what);
      const tag = localeTag(l.language?.trim() || 'en');
      // Its language is set on every launch, English too: one left from before can come back after a restart.
      if ((await levelOf(id)) >= APP_LANGUAGES_FROM) await adbOk(id, ['shell', 'cmd', 'locale', 'set-app-locales', appId, '--locales', tag], what);
      else await systemLanguage(id, tag);
      let screen = screens.get(appId);
      if (!screen) {
        screen = launcherOf(await adbOk(id, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', appId], what)) ?? undefined;
        if (!screen) throw new PhoneError(what, `No screen to open for ${appId}`);
      }
      const component = screen.includes('/') ? screen : `${appId}/${screen}`;
      const out = await adbOk(id, ['shell', 'am', 'start', '-W', '-n', component], what, 120_000);
      if (/^Error/m.test(out)) throw new PhoneError(what, `am start -n ${component}: ${tail(out, 1000)}`);
    },
    async openLink(id, url) {
      const out = await adbOk(id, ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url], 'The app did not open its page on the Android phone.');
      if (/^Error/m.test(out)) throw new PhoneError('The app did not open its page on the Android phone.', `am start -d ${url}: ${tail(out, 1000)}`);
    },
    async screenshot(id) {
      const serial = serialOf(exact(id));
      if (!serial) throw new PhoneError('squad-kit could not take the picture on the Android phone.', `${id} is not running`);
      const r = await adbRun(serial, ['exec-out', 'screencap', '-p'], 60_000, true);
      if (!r.ok || !r.bytes?.length) throw new PhoneError('squad-kit could not take the picture on the Android phone.', `adb exec-out screencap -p: ${tail(r.err)}`);
      return r.bytes;
    },
    async terminate(id, appId) {
      await adbOk(id, ['shell', 'am', 'force-stop', appId], 'The app did not close on the Android phone.');
    },
    async shutdown(id) {
      const r = runningOf(exact(id));
      if (!r) return;
      await stopExact(id, r.pid, `emulator-${r.port}`);
    },
    async openWindow(id) {
      // A hidden emulator cannot show a window: it starts again from the snapshot, with its window, in about 5 s.
      const r = runningOf(exact(id));
      if (r?.window && (await bootedNow(`emulator-${r.port}`))) return;
      if (r) await stopExact(id, r.pid, `emulator-${r.port}`);
      await startDevice(id, true, o.bootMs ?? 300_000);
    },
    async release() {
      // While one of squad-kit's devices runs, its adb server stays; nothing stops a server squad-kit didn't start.
      if (!tools.sdk || !tools.home) return;
      const kept = readAdb();
      if (!kept) return;
      if (Object.keys(readRunning()).some((id) => runningOf(id))) return;
      if (!(await adbIsOurs(kept))) {
        forgetAdb();
        return;
      }
      // adb's own stop, with squad-kit's keys, reaches the server on the port: the one checked to be squad-kit's.
      await run(adb(), ['kill-server'], { env: env(true), timeoutMs: 20_000 });
      for (let i = 0; i < 10 && host.alive(kept.pid); i += 1) await host.sleep(500);
      if (host.alive(kept.pid) && ADB_SERVER.test(host.commandOf(kept.pid) ?? '')) host.kill(kept.pid, 'SIGTERM');
      forgetAdb();
    },
    async windowShows(id) {
      const r = runningOf(exact(id));
      return Boolean(r?.window);
    },
  };
  return module;
}

export const androidEmulator: PhoneModule = androidEmulatorWith();
