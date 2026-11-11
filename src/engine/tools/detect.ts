import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import { CATALOG, OWN_SOURCES, type ManagedBy, type System, type ToolId } from './catalog.js';
import { compareVersions } from './fit.js';
import { mergePath, readLoginPath } from './login-path.js';

/**
 * Finds each tool and its version with short, safe commands: `--version` style, a few seconds each, never interactive,
 * never installing anything. Where a version file says it, the file is read instead of running anything. The results
 * are kept per computer in ~/.squad-kit/tools/found.json with the time; Check again finds them again.
 */

export interface Found {
  state: 'found' | 'missing' | 'not-here';
  version?: string;
  /** Where it is: its folder or its program. */
  where?: string;
  /** One more plain line: "Only Apple's command line tools are here, not Xcode". */
  note?: string;
  /** squad-kit got it itself, into its own folder. */
  own?: boolean;
  /**
   * Whether squad-kit can update this copy itself (Flutter), looked at by update.ts: the tool that looks after it, and
   * why squad-kit can't, when it can't. Nothing in it: squad-kit can, after you OK it.
   */
  update?: { managedBy?: ManagedBy; cant?: string };
}

export interface FoundBook {
  at: string;
  system: System;
  tools: Partial<Record<ToolId, Found>>;
}

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}

/** The computer the checks look at. Tests give a made-up one. */
export interface DetectHost {
  system: System;
  home: string;
  env: NodeJS.ProcessEnv;
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<Ran>;
  exists(p: string): boolean;
  read(p: string): string | null;
  /** The real file behind a link, like a program on the PATH that links into its folder. */
  real(p: string): string;
  list(dir: string): string[];
  /** This user may change it, with no password. */
  writable(p: string): boolean;
  /** The PATH of the person's own terminal (Mac and Linux), to find a tool installed since squad-kit started. */
  loginPath?(): Promise<string | null>;
}

export function systemOf(platform: NodeJS.Platform = process.platform): System {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

/** This computer. */
export function realHost(): DetectHost {
  return {
    system: systemOf(),
    home: os.homedir(),
    env: process.env,
    run: (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: opts.timeoutMs ?? 15_000, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...opts.env } },
          (err, out, errText) => resolve({ ok: !err, out: String(out ?? ''), err: String(errText ?? '') }),
        ).stdin?.end();
      }),
    exists: (p) => fs.existsSync(p),
    read: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    real: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    },
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    writable: (p) => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    loginPath: () => readLoginPath(systemOf()),
  };
}

/** A program on the PATH squad-kit runs with, as the checks and the agents will find it. */
export function onPath(h: DetectHost, name: string): string | null {
  const dirs = (h.env.PATH ?? h.env.Path ?? '').split(h.system === 'windows' ? ';' : ':').filter(Boolean);
  const names = h.system === 'windows' ? [`${name}.exe`, `${name}.bat`, `${name}.cmd`, name] : [name];
  for (const d of dirs) for (const n of names) if (h.exists(path.join(d, n))) return path.join(d, n);
  return null;
}

/* ── reading versions from real outputs ─────────────────── */

/** `flutter --version --machine`, its version file, or the plain `flutter --version`: "Flutter 3.27.3 • channel stable". */
export function flutterVersionOf(text: string): string | null {
  try {
    const j = JSON.parse(text) as { frameworkVersion?: string; flutterVersion?: string };
    const v = j.frameworkVersion ?? j.flutterVersion;
    if (v) return v;
  } catch {
    // Not JSON: the plain words.
  }
  return /Flutter\s+(\d+\.\d+\.\d+(?:[-+.\w]*)?)/.exec(text)?.[1] ?? (/^\s*(\d+\.\d+\.\d+)\s*$/.exec(text)?.[1] ?? null);
}

/** `xcodebuild -version`: "Xcode 27.2" then "Build version 27B52". */
export function xcodeVersionOf(text: string): { version: string; build?: string } | null {
  const v = /Xcode\s+(\d+(?:\.\d+)*)/.exec(text)?.[1];
  if (!v) return null;
  const build = /Build version\s+(\S+)/.exec(text)?.[1];
  return { version: v, ...(build ? { build } : {}) };
}

/** `java -version`, which writes to stderr: `openjdk version "19.0.2" 2023-01-17`, or `java version "1.8.0_311"`. */
export function javaVersionOf(text: string): string | null {
  const v = /version\s+"([^"]+)"/.exec(text)?.[1];
  if (!v) return null;
  // Java 8 and older call themselves 1.8: their real number is the second one.
  const old = /^1\.(\d+)(.*)$/.exec(v);
  return (old ? `${old[1]}${old[2]}` : v).replace(/_/g, '.');
}

/** `pod --version`: "1.15.2", maybe after Ruby's own warnings. */
export function podVersionOf(text: string): string | null {
  return /^(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1] ?? null;
}

/** `xcrun simctl list runtimes -j`: the iOS versions that can run, newest first. */
export function iosRuntimesOf(text: string): string[] {
  try {
    const j = JSON.parse(text) as { runtimes?: { name?: string; version?: string; platform?: string; isAvailable?: boolean }[] };
    // Two builds of one iOS version count once.
    const versions = (j.runtimes ?? []).filter((r) => (r.platform ? r.platform === 'iOS' : /^iOS\b/.test(r.name ?? '')) && r.isAvailable !== false && r.version).map((r) => r.version!);
    return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}

/** `docker --version`: "Docker version 27.3.1, build ce12230". */
export function dockerVersionOf(text: string): string | null {
  return /Docker version\s+(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
}

/** `maestro --version`: its last line, "2.12.1". */
export function maestroVersionOf(text: string): string | null {
  const lines = text.trim().split('\n').reverse();
  for (const l of lines) {
    const m = /^\s*(\d+\.\d+\.\d+)\s*$/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/* ── squad-kit's own tools ──────────────────────────────── */

export interface OwnTool {
  version: string;
  dir: string;
  /** The program, as a full path. */
  binary: string;
  /** How long getting it took here, in seconds. */
  seconds?: number;
}

export function toolsHome(home = squadHome()): string {
  return path.join(home, 'tools');
}

/** The newest version of a tool squad-kit got itself, marked ready. A folder without its mark is not there. */
export function ownTool(id: string, home = squadHome()): OwnTool | null {
  const base = path.join(toolsHome(home), id);
  let best: OwnTool | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const v of names) {
    try {
      const mark = JSON.parse(fs.readFileSync(path.join(base, v, 'ready.json'), 'utf8')) as { version: string; binary: string; seconds?: number };
      const binary = path.join(base, v, mark.binary);
      if (!fs.existsSync(binary)) continue;
      if (!best || compareVersions(mark.version, best.version) > 0) best = { version: mark.version, dir: path.join(base, v), binary, ...(mark.seconds ? { seconds: mark.seconds } : {}) };
    } catch {
      // Not marked ready: a download that never finished.
    }
  }
  return best;
}

/* ── each tool ──────────────────────────────────────────── */

const missing = (note?: string): Found => ({ state: 'missing', ...(note ? { note } : {}) });

/** Places people often put Flutter, for a Flutter that is here but not on the PATH. */
function flutterPlaces(h: DetectHost): string[] {
  const home = h.home;
  if (h.system === 'windows') return ['C:\\src\\flutter', 'C:\\flutter', path.join(home, 'flutter'), path.join(home, 'dev', 'flutter')];
  return [path.join(home, 'flutter'), path.join(home, 'development', 'flutter'), path.join(home, 'Applications', 'flutter'), path.join(home, 'sdk', 'flutter'), path.join(home, 'fvm', 'default'), '/opt/flutter', '/usr/local/flutter'];
}

/** The version written in a Flutter folder, without running it. */
function flutterFileVersion(h: DetectHost, sdk: string): string | null {
  const json = h.read(path.join(sdk, 'bin', 'cache', 'flutter.version.json'));
  const fromJson = json ? flutterVersionOf(json) : null;
  if (fromJson) return fromJson;
  const plain = h.read(path.join(sdk, 'version'));
  return plain ? flutterVersionOf(plain) : null;
}

async function flutter(h: DetectHost): Promise<Found> {
  const bin = onPath(h, 'flutter');
  if (bin) {
    // bin/flutter in the Flutter folder, maybe through a link.
    const sdk = path.dirname(path.dirname(h.real(bin)));
    let version = flutterFileVersion(h, sdk);
    if (!version) {
      const r = await h.run(bin, ['--version', '--machine'], { timeoutMs: 30_000, env: { FLUTTER_SUPPRESS_ANALYTICS: 'true', CI: 'true' } });
      version = flutterVersionOf(r.out) ?? flutterVersionOf(r.err);
    }
    return { state: 'found', where: sdk, ...(version ? { version } : {}) };
  }
  for (const sdk of flutterPlaces(h)) {
    if (!h.exists(path.join(sdk, 'bin', h.system === 'windows' ? 'flutter.bat' : 'flutter'))) continue;
    const version = flutterFileVersion(h, sdk);
    return { state: 'missing', where: sdk, ...(version ? { version } : {}), note: `Flutter${version ? ` ${version}` : ''} is in ${sdk}, but not on the PATH squad-kit runs with, so the squad can't use it.` };
  }
  return missing();
}

async function xcode(h: DetectHost): Promise<Found> {
  // Where the developer tools are. Asking this never opens anything, unlike running xcodebuild with none there.
  const sel = await h.run('xcode-select', ['-p'], { timeoutMs: 5_000 });
  const dev = sel.out.trim();
  if (!sel.ok || !dev) return missing();
  if (!/\.app\//.test(`${dev}/`)) return missing("Only Apple's command line tools are here, not Xcode itself.");
  const r = await h.run('xcodebuild', ['-version'], { timeoutMs: 15_000 });
  const v = xcodeVersionOf(r.out);
  if (r.ok && v) return { state: 'found', version: v.version, where: dev.replace(/\/Contents\/Developer\/?$/, '') };
  if (/licen[cs]e/i.test(r.err + r.out)) return missing('Xcode is here, but it has to be opened once to finish setting up.');
  return missing();
}

async function simulator(h: DetectHost, xcodeFound: boolean): Promise<Found> {
  if (!xcodeFound) return missing('It comes with Xcode.');
  const r = await h.run('xcrun', ['simctl', 'list', 'runtimes', '-j'], { timeoutMs: 20_000 });
  const versions = r.ok ? iosRuntimesOf(r.out) : [];
  if (!versions.length) return missing('Xcode is here, without an iPhone simulator yet.');
  return { state: 'found', version: versions[0]!, ...(versions.length > 1 ? { note: `iOS ${versions.join(', iOS ')}` } : {}) };
}

async function cocoapods(h: DetectHost): Promise<Found> {
  const bin = onPath(h, 'pod');
  if (!bin) return missing();
  const r = await h.run(bin, ['--version'], { timeoutMs: 20_000, env: { LANG: 'en_US.UTF-8' } });
  const version = podVersionOf(r.out);
  return { state: 'found', where: bin, ...(version ? { version } : {}) };
}

/** A Java of the person's own, from JAVA_HOME or the PATH. The Mac's own /usr/bin/java is only a stand-in when no Java is installed. */
async function java(h: DetectHost, home: string): Promise<Found> {
  const own = ownTool('java', home);
  if (own) return { state: 'found', version: own.version, where: own.dir, own: true };
  const fromHome = h.env.JAVA_HOME ? path.join(h.env.JAVA_HOME, 'bin', h.system === 'windows' ? 'java.exe' : 'java') : null;
  const bin = fromHome && h.exists(fromHome) ? fromHome : onPath(h, 'java');
  if (!bin) return missing();
  if (h.system === 'mac' && h.real(bin) === '/usr/bin/java') {
    const machines = [...h.list('/Library/Java/JavaVirtualMachines'), ...h.list(path.join(h.home, 'Library', 'Java', 'JavaVirtualMachines'))];
    if (!machines.some((m) => m.endsWith('.jdk'))) return missing();
  }
  const r = await h.run(bin, ['-version'], { timeoutMs: 15_000 });
  const version = javaVersionOf(r.err) ?? javaVersionOf(r.out);
  return version ? { state: 'found', version, where: bin } : missing();
}

async function maestro(h: DetectHost, home: string): Promise<Found> {
  const own = ownTool('maestro', home);
  if (own) return { state: 'found', version: own.version, where: own.dir, own: true };
  const bin = onPath(h, 'maestro');
  if (!bin) return missing();
  const r = await h.run(bin, ['--version'], { timeoutMs: 30_000, env: { ...OWN_SOURCES.maestro.env } });
  const version = maestroVersionOf(r.out);
  return { state: 'found', where: bin, ...(version ? { version } : {}) };
}

function androidStudio(h: DetectHost): Found {
  const env = h.env;
  const apps =
    h.system === 'mac'
      ? ['/Applications/Android Studio.app', path.join(h.home, 'Applications', 'Android Studio.app')].map((a) => ({ dir: a, info: path.join(a, 'Contents', 'Resources', 'product-info.json') }))
      : h.system === 'windows'
        ? [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Android', 'Android Studio')].map((a) => ({ dir: a, info: path.join(a, 'product-info.json') }))
        : ['/opt/android-studio', path.join(h.home, 'android-studio'), '/snap/android-studio/current'].map((a) => ({ dir: a, info: path.join(a, 'product-info.json') }));
  for (const a of apps) {
    if (!h.exists(a.dir)) continue;
    let version: string | undefined;
    try {
      version = (JSON.parse(h.read(a.info) ?? '{}') as { version?: string }).version;
    } catch {
      // A version is nice to show, not needed.
    }
    return { state: 'found', where: a.dir, ...(version ? { version } : {}) };
  }
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (sdk && h.exists(sdk)) return { state: 'found', where: sdk, note: "The Android tools are here, without the Android Studio app." };
  return missing();
}

async function docker(h: DetectHost): Promise<Found> {
  const bin = onPath(h, 'docker');
  if (!bin) return missing();
  const r = await h.run(bin, ['--version'], { timeoutMs: 10_000 });
  const version = dockerVersionOf(r.out);
  return { state: 'found', where: bin, ...(version ? { version } : {}) };
}

/**
 * Every tool in the catalog that this computer can have, checked side by side. Git and the AI tool are checked by
 * "Is your computer ready?" (engine/computer-ready.ts) whenever the page is read, so they are not kept here.
 */
export async function detectAll(h: DetectHost = realHost(), home = squadHome()): Promise<FoundBook> {
  // A tool installed since squad-kit started is on the person's own PATH: its folders join squad-kit's first, so the
  // checks find it, and so do the agents squad-kit starts after (this computer's env is the one squad-kit runs with).
  const more = await h.loginPath?.().catch(() => null);
  if (more) h.env.PATH = mergePath(h.env.PATH, more);
  const notHere = (id: ToolId) => {
    const e = CATALOG.find((t) => t.id === id);
    return Boolean(e?.systems && !e.systems.includes(h.system));
  };
  const safe = async (id: ToolId, find: () => Promise<Found> | Found): Promise<[ToolId, Found]> => {
    if (notHere(id)) return [id, { state: 'not-here' }];
    try {
      return [id, await find()];
    } catch {
      return [id, missing()];
    }
  };
  const x = await safe('xcode', () => xcode(h));
  const found = await Promise.all([
    safe('flutter', () => flutter(h)),
    safe('simulator', () => simulator(h, x[1].state === 'found')),
    safe('cocoapods', () => cocoapods(h)),
    safe('java', () => java(h, home)),
    safe('maestro', () => maestro(h, home)),
    safe('android-studio', () => androidStudio(h)),
    safe('docker', () => docker(h)),
  ]);
  return { at: new Date().toISOString(), system: h.system, tools: Object.fromEntries([x, ...found]) };
}

/* ── kept per computer ──────────────────────────────────── */

export function foundFile(home = squadHome()): string {
  return path.join(toolsHome(home), 'found.json');
}

export function readFound(home = squadHome()): FoundBook | null {
  try {
    return JSON.parse(fs.readFileSync(foundFile(home), 'utf8')) as FoundBook;
  } catch {
    return null;
  }
}

export function writeFound(book: FoundBook, home = squadHome()): void {
  const file = foundFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(book, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
