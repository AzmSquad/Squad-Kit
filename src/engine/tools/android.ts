import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import { writeLog } from '../../core/app-log.js';
import type { PhoneTools } from '../../modules/phone/types.js';
import { endGroup, OWN_GROUP } from '../process-group.js';
import { OWN_SOURCES, type System } from './catalog.js';
import { ownTool, readFound, toolsHome } from './detect.js';
import { atLeast } from './fit.js';
import { GetTrouble, type ToolSource } from './get.js';

/**
 * Google's Android tools for squad-kit's Android phone: which files fit this computer, where they are (squad-kit's own,
 * or an SDK of the person's that has everything, used as it is and never changed), the license Google asks the person
 * to accept, the room they need, and getting them: the pinned command-line tools, then Google's own sdkmanager for the
 * rest, answering only the licenses the person accepted. sdkmanager can wait forever on a dead connection, so a
 * watchdog stops that exact process when nothing new comes for two minutes, tries once more, then says so plainly.
 */

const A = OWN_SOURCES.android;
type Chip = 'arm64' | 'x64';

/** What squad-kit gets on this computer, or null when Google's emulator can't run here. */
export interface AndroidPick {
  tools: { file: string; size: number; sha1: string; sha256?: string };
  /** Every package sdkmanager installs, the system image last. */
  packages: string[];
  image: string;
  /** Each package's download size, for the progress line. */
  sizes: Record<string, number>;
}

export function androidPick(system: System, arch: string = process.arch): AndroidPick | null {
  const chip: Chip | null = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!chip || (system !== 'mac' && chip === 'arm64')) return null;
  const key = `${system}-${chip}` as keyof typeof A.tools;
  const tools = A.tools[key];
  if (!tools) return null;
  const image = A.images[chip];
  const sizes: Record<string, number> = {};
  for (const [pkg, by] of Object.entries(A.packages) as [string, Record<string, number>][]) sizes[pkg] = by[key] ?? by[system] ?? by.all ?? 0;
  sizes[image.id] = image.size;
  return { tools, packages: [...Object.keys(A.packages), image.id], image: image.id, sizes };
}

/** All of it, in bytes to download. */
export const pickBytes = (p: AndroidPick) => p.tools.size + Object.values(p.sizes).reduce((n, x) => n + x, 0);

/* ── where things are ───────────────────────────────────── */

/** squad-kit's own folder for its Android phones and the settings Google's tools keep: never the person's ~/.android. */
export function androidHome(home = squadHome()): string {
  return path.join(home, 'phones', 'android');
}

/** One Gradle home for every project's Android builds: its downloads are kept once, not once a project. */
export function gradleHome(home = squadHome()): string {
  return path.join(home, 'caches', 'gradle');
}

/** The Java Google's tools run on: squad-kit's own, else the person's when it is 17 or newer. */
export function javaHome(home = squadHome()): string | undefined {
  const own = ownTool('java', home);
  if (own) return path.dirname(path.dirname(own.binary));
  const f = readFound(home)?.tools.java;
  if (f?.state === 'found' && f.where && f.version && atLeast(f.version, '17') && /[\\/]bin[\\/]java(\.exe)?$/.test(f.where)) return path.dirname(path.dirname(f.where));
  return undefined;
}

/** The Android SDK squad-kit uses: its own, once ready, else the person's the last check found complete. */
export function androidSdk(home = squadHome()): { sdk: string; own: boolean } | null {
  const own = ownTool('android', home);
  if (own) return { sdk: path.join(own.dir, 'sdk'), own: true };
  const f = readFound(home)?.tools.android;
  return f?.state === 'found' && f.where ? { sdk: f.where, own: Boolean(f.own) } : null;
}

/** Where the Android phone's tools are, for the phone module: squad-kit's folder always, the SDK and Java once here. */
export function androidPlace(home = squadHome()): PhoneTools {
  const sdk = androidSdk(home);
  const java = javaHome(home);
  return { home: androidHome(home), ...(sdk ? { sdk: sdk.sdk } : {}), ...(java ? { java } : {}) };
}

/**
 * The environment of an Android build (Gradle, Flutter): squad-kit's SDK and folders, its one Gradle home, Kotlin
 * compiled inside Gradle (no helper left running), and Java. A person's own SDK is never added to: the build may not
 * fetch missing parts into it.
 */
export function androidBuildEnv(home = squadHome()): Record<string, string> {
  const place = androidPlace(home);
  const sdk = androidSdk(home);
  const user = path.join(place.home!, '.android');
  return {
    ...(place.sdk ? { ANDROID_HOME: place.sdk, ANDROID_SDK_ROOT: place.sdk } : {}),
    ANDROID_PREFS_ROOT: place.home!,
    ANDROID_USER_HOME: user,
    ANDROID_EMULATOR_HOME: user,
    ANDROID_AVD_HOME: path.join(user, 'avd'),
    GRADLE_USER_HOME: gradleHome(home),
    'ORG_GRADLE_PROJECT_kotlin.compiler.execution.strategy': 'in-process',
    ...(sdk && !sdk.own ? { 'ORG_GRADLE_PROJECT_android.builder.sdkDownload': 'false' } : {}),
    ...(place.java ? { JAVA_HOME: place.java } : {}),
  };
}

/* ── a person's own SDK ─────────────────────────────────── */

/** The places an Android SDK usually is: what ANDROID_HOME says, then Android Studio's own folder on each system. */
export function sdkPlaces(env: NodeJS.ProcessEnv, home: string, system: System): string[] {
  const own =
    system === 'mac'
      ? [path.join(home, 'Library', 'Android', 'sdk')]
      : system === 'windows'
        ? [path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')]
        : [path.join(home, 'Android', 'Sdk')];
  return [...new Set([env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...own].filter((x): x is string => Boolean(x)))];
}

/** The newest Android system an SDK can start on this chip, by API level, or 0. */
export function imageLevel(list: (dir: string) => string[], sdk: string, arch: string): number {
  const abi = arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  let best = 0;
  for (const level of list(path.join(sdk, 'system-images'))) {
    const api = Number(/^android-(\d+)$/.exec(level)?.[1]);
    if (api > best && list(path.join(sdk, 'system-images', level)).some((tag) => list(path.join(sdk, 'system-images', level, tag)).includes(abi))) best = api;
  }
  return best;
}

/**
 * What an SDK lacks for squad-kit's phone, in plain words; empty when it has it all: adb, the emulator, the tool that
 * makes devices, the build tools, a platform, and a system of Android 13 or newer for this chip (the first that opens
 * one app in a language of its own).
 */
export function sdkLacks(h: { exists(p: string): boolean; list(dir: string): string[] }, sdk: string, system: System, arch: string): string[] {
  const exe = (n: string) => (system === 'windows' ? `${n}.exe` : n);
  const lacks: string[] = [];
  if (!h.exists(path.join(sdk, 'platform-tools', exe('adb')))) lacks.push('adb');
  if (!h.exists(path.join(sdk, 'emulator', exe('emulator')))) lacks.push('the emulator');
  const tools = path.join(sdk, 'cmdline-tools');
  if (!h.list(tools).some((d) => h.exists(path.join(tools, d, 'bin', system === 'windows' ? 'avdmanager.bat' : 'avdmanager')))) lacks.push('the command-line tools');
  const build = path.join(sdk, 'build-tools');
  if (!h.list(build).some((v) => h.exists(path.join(build, v, exe('aapt2'))))) lacks.push('the build tools');
  if (!h.list(path.join(sdk, 'platforms')).some((p) => /^android-\d+/.test(p))) lacks.push('an Android platform');
  if (imageLevel(h.list, sdk, arch) < 33) lacks.push('an Android 13 or newer phone system');
  return lacks;
}

/* ── Google's license ───────────────────────────────────── */

export interface License {
  id: string;
  text: string;
}

/**
 * The licenses Google's manifests attach to the packages squad-kit installs, in full, from the stable channel only:
 * the same ones sdkmanager asks about.
 */
export function licensesIn(manifests: string[], packages: string[]): License[] {
  const text = manifests.join('\n');
  const stable = /<channel id="([^"]+)">stable<\/channel>/.exec(text)?.[1] ?? 'channel-0';
  const ids: string[] = [];
  for (const pkg of packages) {
    const re = new RegExp(`<remotePackage path="${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([\\s\\S]*?)</remotePackage>`, 'g');
    for (const m of text.matchAll(re)) {
      const body = m[1]!;
      if (!new RegExp(`channelRef ref="${stable}"`).test(body)) continue;
      const id = /uses-license ref="([^"]+)"/.exec(body)?.[1];
      if (id && !ids.includes(id)) ids.push(id);
      break;
    }
  }
  return ids.flatMap((id) => {
    const m = new RegExp(`<license id="${id}" type="text">([\\s\\S]*?)</license>`).exec(text);
    return m ? [{ id, text: decode(m[1]!).trim() }] : [];
  });
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

const licenseFile = (home: string) => path.join(toolsHome(home), 'android-license.json');
const acceptedFile = (home: string) => path.join(toolsHome(home), 'android-accepted.json');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** The license texts for this computer's packages, read from Google's manifests (and kept, for the next look). */
export async function androidLicenses(o: { fetch?: typeof fetch; system: System; arch?: string; home?: string; signal?: AbortSignal }): Promise<License[]> {
  const home = o.home ?? squadHome();
  const pick = androidPick(o.system, o.arch ?? process.arch);
  if (!pick) throw new GetTrouble("Google's Android emulator doesn't run on this computer, so there is no license to read.");
  const f = o.fetch ?? fetch;
  try {
    const texts = await Promise.all(
      A.manifests.map(async (url) => {
        const res = await f(url, { redirect: 'follow', ...(o.signal ? { signal: o.signal } : {}) });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return res.text();
      }),
    );
    const found = licensesIn(texts, ['cmdline-tools;latest', ...pick.packages]);
    if (!found.length) throw new Error('no license in the manifests');
    fs.mkdirSync(toolsHome(home), { recursive: true });
    fs.writeFileSync(licenseFile(home), `${JSON.stringify({ at: new Date().toISOString(), licenses: found }, null, 2)}\n`);
    return found;
  } catch {
    // Google's site can't be reached now: the texts read last time are the same Google's.
    try {
      return (JSON.parse(fs.readFileSync(licenseFile(home), 'utf8')) as { licenses: License[] }).licenses;
    } catch {
      throw new GetTrouble("squad-kit could not reach Google's site to show the license. Check the internet connection, then try again.");
    }
  }
}

export interface Accepted {
  at: string;
  /** The licenses the person accepted, each with the checksum of the very text they were shown. */
  licenses: { id: string; sha256: string }[];
}

/** The person's Accept of Google's license, when they gave it. */
export function androidAccepted(home = squadHome()): Accepted | null {
  try {
    const a = JSON.parse(fs.readFileSync(acceptedFile(home), 'utf8')) as Accepted;
    return a.licenses?.length ? a : null;
  } catch {
    return null;
  }
}

/** Keeps the person's Accept of the licenses they were shown. Only a person's Accept calls this. */
export function acceptAndroid(licenses: License[], home = squadHome()): Accepted {
  if (!licenses.length) throw new GetTrouble('There is no license to accept yet. Open it first, then press Accept.');
  const a: Accepted = { at: new Date().toISOString(), licenses: licenses.map((l) => ({ id: l.id, sha256: sha(l.text) })) };
  fs.mkdirSync(toolsHome(home), { recursive: true });
  fs.writeFileSync(acceptedFile(home), `${JSON.stringify(a, null, 2)}\n`);
  return a;
}

/* ── room on the disk ───────────────────────────────────── */

/** The free bytes where squad-kit keeps its tools, or null when this computer can't say. */
export function freeBytes(dir: string): number | null {
  try {
    let at = dir;
    while (!fs.existsSync(at)) at = path.dirname(at);
    const s = fs.statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

const gb = (n: number) => `${Math.round(n / 1000 ** 3)} GB`;

/** Why there is not enough room for the Android tools, in plain words, or null. */
export function roomTrouble(free: number | null): string | null {
  if (free === null || free >= A.diskBytes) return null;
  return `The Android phone tools need about ${gb(A.diskBytes)} free on this computer, and it has ${gb(free)} free. Make room, then press Get it again.`;
}

/* ── getting them ───────────────────────────────────────── */

/** sdkmanager, started and fed. Tests give a made-up one. */
export interface SdkRunning {
  pid?: number;
  /** Writes an answer to its questions. */
  answer(text: string): void;
  stop(): void;
  /** Its exit code, once it ends. */
  done: Promise<number | null>;
}
export type SdkSpawn = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; onOutput(text: string): void }) => SdkRunning;

const realSdkSpawn: SdkSpawn = (cmd, args, o) => {
  const child = spawn(cmd, args, { env: o.env, detached: OWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
  child.stdout?.on('data', (d: Buffer) => o.onOutput(d.toString()));
  child.stderr?.on('data', (d: Buffer) => o.onOutput(d.toString()));
  return {
    ...(child.pid ? { pid: child.pid } : {}),
    answer: (text) => {
      try {
        child.stdin?.write(text);
      } catch {
        // It ended.
      }
    },
    stop: () => endGroup(child),
    done: new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    }),
  };
};

let sdkSpawn: SdkSpawn = realSdkSpawn;

/** Tests run a made-up sdkmanager. Null goes back to the real one. */
export function useSdkSpawn(s: SdkSpawn | null): void {
  sdkSpawn = s ?? realSdkSpawn;
}

/** No new bytes and no new words from sdkmanager for this long: it is stuck, and its exact process is stopped. */
export const NO_PROGRESS_MS = 2 * 60_000;
/** How often the watchdog looks. */
const LOOK_MS = 5000;

/** Bytes in a folder and everything in it, counted only as deep as a download folder goes. */
function bytesIn(dir: string, depth = 4): number {
  let n = 0;
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += depth > 0 ? bytesIn(p, depth - 1) : 0;
    else {
      try {
        n += fs.statSync(p).size;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return n;
}

/** The folder sdkmanager installs a package into: "ndk;28.2.13676358" is ndk/28.2.13676358. */
export const packageDir = (sdk: string, pkg: string) => path.join(sdk, ...pkg.split(';'));

/** How much of the packages is in: the finished ones by their size, plus what sdkmanager is downloading now. */
export function installedBytes(sdk: string, pick: AndroidPick): number {
  let n = 0;
  for (const pkg of pick.packages) if (fs.existsSync(path.join(packageDir(sdk, pkg), 'package.xml'))) n += pick.sizes[pkg] ?? 0;
  return n + bytesIn(path.join(sdk, '.temp'));
}

export interface InstallOptions {
  sdk: string;
  sdkmanager: string;
  pick: AndroidPick;
  /** The licenses the person accepted: sdkmanager is answered yes to these, and no to any other. */
  accepted: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onProgress(p: { done: number; total: number }): void;
  /** Tests make the watchdog quicker. */
  quietMs?: number;
  lookMs?: number;
  sleep?(ms: number): Promise<void>;
}

/**
 * Runs sdkmanager once over the packages, answering its license questions: yes only to the ids the person accepted.
 * Resolves with how it ended: 'done', 'stuck' (the watchdog stopped it), 'refused' (a license nobody accepted), or
 * 'failed' with what it said.
 */
async function installOnce(o: InstallOptions): Promise<{ end: 'done' | 'stuck' | 'refused' | 'failed'; said: string }> {
  const total = o.pick.packages.reduce((n, p) => n + (o.pick.sizes[p] ?? 0), 0);
  let said = '';
  let license = '';
  let refused = false;
  let lastOut = Date.now();
  const p = sdkSpawn(o.sdkmanager, [`--sdk_root=${o.sdk}`, '--install', ...o.pick.packages], {
    env: o.env,
    onOutput: (text) => {
      said = (said + text).slice(-20_000);
      lastOut = Date.now();
      const id = [...text.matchAll(/License ([\w.-]+):/g)].pop()?.[1];
      if (id) license = id;
      if (/Accept\? \(y\/N\):\s*$/.test(said)) {
        const yes = o.accepted.includes(license);
        if (!yes) refused = true;
        p.answer(yes ? 'y\n' : 'N\n');
        said += yes ? 'y\n' : 'N\n';
      }
    },
  });
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const quiet = o.quietMs ?? NO_PROGRESS_MS;
  let ended: number | null | undefined;
  void p.done.then((c) => (ended = c));
  let bytes = installedBytes(o.sdk, o.pick);
  let lastBytes = Date.now();
  const stopOnAbort = () => p.stop();
  o.signal.addEventListener('abort', stopOnAbort, { once: true });
  try {
    while (ended === undefined) {
      await sleep(o.lookMs ?? LOOK_MS);
      if (ended !== undefined) break;
      const now = installedBytes(o.sdk, o.pick);
      if (now !== bytes) {
        bytes = now;
        lastBytes = Date.now();
      }
      o.onProgress({ done: Math.min(now, total), total });
      if (o.signal.aborted) return { end: 'failed', said: `${said}\nYou stopped it.` };
      if (Date.now() - Math.max(lastBytes, lastOut) > quiet) {
        p.stop();
        await p.done;
        return { end: 'stuck', said };
      }
    }
  } finally {
    o.signal.removeEventListener('abort', stopOnAbort);
  }
  if (refused) return { end: 'refused', said };
  const missing = o.pick.packages.filter((pkg) => !fs.existsSync(path.join(packageDir(o.sdk, pkg), 'package.xml')));
  return { end: ended === 0 && !missing.length ? 'done' : 'failed', said: missing.length ? `${said}\nNot installed: ${missing.join(', ')}` : said };
}

/**
 * Installs the packages with sdkmanager, with the watchdog: a run that stalls is stopped and tried once more (what came
 * already stays in the folder), then it says so plainly. Throws GetTrouble.
 */
export async function installPackages(o: InstallOptions): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const r = await installOnce(o);
    if (r.end === 'done') return;
    if (o.signal.aborted) throw new GetTrouble('The download of the Android phone tools was stopped. Nothing was installed.');
    if (r.end === 'refused') throw new GetTrouble("Google's tools asked about a license you have not accepted, so squad-kit said no and installed nothing. Read the license again and press Accept, then Get it.");
    if (r.end === 'stuck' && attempt < 2) continue;
    if (r.end === 'stuck') throw new GetTrouble("Google's download of the Android phone tools stopped twice and did not go on. Check the internet connection, then press Get it again. Nothing was installed.");
    writeLog({ level: 'warn', text: `Getting the Android phone tools: sdkmanager did not finish:\n${r.said.slice(-4000)}` });
    throw new GetTrouble('squad-kit could not install the Android phone tools. Nothing was installed. Press Get it again.');
  }
}

/**
 * Google's Android tools as one of squad-kit's own downloads (get.ts): the pinned command-line tools by their checksum,
 * then, once unpacked, sdkmanager installs the rest beside them into the same folder.
 */
export function androidSource(o: { system: System; arch?: string; home?: string; fetch?: typeof fetch } = { system: 'mac' }): ToolSource {
  const pick = androidPick(o.system, o.arch ?? process.arch);
  if (!pick) throw new GetTrouble("Google's Android emulator doesn't run on this computer, so squad-kit did not get its tools.");
  const home = o.home ?? squadHome();
  const f = o.fetch ?? fetch;
  const win = o.system === 'windows';
  const sdkmanagerIn = (dir: string) => path.join(dir, 'sdk', 'cmdline-tools', 'latest', 'bin', win ? 'sdkmanager.bat' : 'sdkmanager');
  return {
    version: A.version,
    file: pick.tools.file,
    pack: 'zip',
    size: pickBytes(pick),
    algorithm: pick.tools.sha256 ? 'sha256' : 'sha1',
    sha256: async () => pick.tools.sha256 ?? pick.tools.sha1,
    async open(signal) {
      const res = await f(`${A.base}${pick.tools.file}`, { signal, redirect: 'follow' }).catch(() => {
        throw new GetTrouble("squad-kit could not reach Google's official download. Check the internet connection, then press Get it again.");
      });
      if (!res.ok || !res.body) throw new GetTrouble("squad-kit could not reach Google's official download. Check the internet connection, then press Get it again.");
      return { body: res.body as unknown as AsyncIterable<Uint8Array>, size: pick.tools.size };
    },
    async finish(dir, s) {
      // The command-line tools go where sdkmanager expects itself: sdk/cmdline-tools/latest.
      const sdk = path.join(dir, 'sdk');
      const latest = path.join(sdk, 'cmdline-tools', 'latest');
      fs.mkdirSync(path.dirname(latest), { recursive: true });
      fs.renameSync(path.join(dir, 'cmdline-tools'), latest);
      if (!win) fs.chmodSync(sdkmanagerIn(dir), 0o755);
      const accepted = androidAccepted(home);
      if (!accepted) throw new GetTrouble("Google's license for the Android phone tools needs your Accept first. Nothing was installed.");
      const java = javaHome(home);
      if (!java) throw new GetTrouble('The Android phone tools need Java 17 or newer, and squad-kit found none. Get Java on the Tools page first.');
      const user = path.join(androidHome(home), '.android');
      fs.mkdirSync(user, { recursive: true });
      await installPackages({
        sdk,
        sdkmanager: sdkmanagerIn(dir),
        pick,
        accepted: accepted.licenses.map((l) => l.id),
        env: { ...process.env, JAVA_HOME: java, ANDROID_USER_HOME: user, ANDROID_PREFS_ROOT: androidHome(home), ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
        signal: s.signal,
        onProgress: (p) => s.onProgress({ done: pick.tools.size + p.done, total: pickBytes(pick) }),
      });
    },
    binary: (dir) => (fs.existsSync(sdkmanagerIn(dir)) ? sdkmanagerIn(dir) : null),
  };
}
