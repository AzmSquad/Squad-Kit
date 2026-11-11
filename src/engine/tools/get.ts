import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { squadHome } from '../../core/home.js';
import { writeLog } from '../../core/app-log.js';
import { CATALOG, OWN_SOURCES, toolEntry, type System, type ToolId } from './catalog.js';
import { systemOf, toolsHome, type OwnTool } from './detect.js';
import { androidSource } from './android.js';

/**
 * squad-kit's own installs: into ~/.squad-kit/tools/<id>/<version>/, from the official source only, checked against
 * the checksum that source publishes, unpacked, and marked ready last. No password, no system folders, no Homebrew.
 * One download at a time. A failed or cut download leaves nothing half there, and says why in plain words.
 */

export interface ToolSource {
  version: string;
  /** The file downloaded, as its source names it: "maestro.zip". */
  file: string;
  pack: 'zip' | 'tar.gz';
  /** The size its source gives, when the download itself does not say. */
  size?: number;
  /** How its checksum is made: sha256, unless its source publishes only another. */
  algorithm?: 'sha256' | 'sha1';
  /** The checksum the official source publishes, as hex (sha256, or the `algorithm` given). */
  sha256(signal: AbortSignal): Promise<string>;
  open(signal: AbortSignal): Promise<{ body: AsyncIterable<Uint8Array>; size?: number }>;
  /**
   * What runs once it is unpacked, before it is marked ready, in the unpacked folder: Google's sdkmanager installs the
   * rest of the Android tools there. Its progress counts on from the download.
   */
  finish?(dir: string, o: { signal: AbortSignal; onProgress(p: { done: number; total: number }): void }): Promise<void>;
  /** The program inside the unpacked folder, once unpacked (and finished). */
  binary(dir: string): string | null;
}

export interface Getting {
  tool: ToolId;
  name: string;
  version?: string;
  startedAt: string;
  /** squad-kit's own download and unpack, its install after (Android), or an update of your own copy (update.ts). */
  step: 'download' | 'unpack' | 'install' | 'update';
  /** A download: bytes so far and in all. An update: seconds so far and the time it usually takes. */
  done: number;
  total?: number;
  /** About how long is left, in seconds: a first guess, then from the speed of this download. */
  secondsLeft: number;
  /** An update: the step it is at, in plain words, "Downloading the new Flutter". */
  words?: string;
}

/** A reason a person can read: the board shows it as it is. */
export class GetTrouble extends Error {}

let now: Getting | null = null;
const troubles = new Map<ToolId, string>();

/** The download running now, if any. */
export function gettingNow(): Getting | null {
  return now ? { ...now } : null;
}

/** Why the last try to get a tool did not work, until it works. */
export function lastTrouble(id: ToolId): string | undefined {
  return troubles.get(id);
}

/** Keeps why the last try at a tool did not work, for its line; nothing clears it. */
export function setTrouble(id: ToolId, words?: string): void {
  if (words) troubles.set(id, words);
  else troubles.delete(id);
}

/**
 * The one slot for getting or updating a tool: one at a time, beside everything else. The job says how it goes with
 * `set`, which `gettingNow` reads; asking while one runs says so. `after` runs when it ends, well or not.
 */
export function startOne(first: Getting, job: (set: (next: Getting) => void) => Promise<void>, after?: () => void): Getting {
  if (now) {
    throw new GetTrouble(
      now.step === 'update' ? `squad-kit is updating ${now.name} now. One at a time: try again once it is done.` : `squad-kit is getting ${now.name} now. One download at a time: press Get it again once it is done.`,
    );
  }
  now = first;
  void job((next) => {
    if (now) now = next;
  })
    .catch((err: unknown) => writeLog({ level: 'warn', text: `${first.step === 'update' ? 'Updating' : 'Getting'} ${first.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` }))
    .finally(() => {
      now = null;
      after?.();
    });
  return { ...first };
}

const nameOf = (id: ToolId) => toolEntry(id)?.name ?? id;

/* ── the official sources ───────────────────────────────── */

type Fetch = typeof fetch;

function reach(name: string): GetTrouble {
  return new GetTrouble(`squad-kit could not reach ${name}'s official download. Check the internet connection, then press Get it again.`);
}

async function download(f: Fetch, url: string, name: string, signal: AbortSignal): Promise<{ body: AsyncIterable<Uint8Array>; size?: number }> {
  const res = await f(url, { signal, redirect: 'follow' }).catch(() => {
    throw reach(name);
  });
  if (!res.ok || !res.body) throw reach(name);
  const size = Number(res.headers.get('content-length')) || undefined;
  return { body: res.body as unknown as AsyncIterable<Uint8Array>, ...(size ? { size } : {}) };
}

/** Finds a program a few folders down: the archive's own top folder is named after its release. */
function findIn(dir: string, tails: string[][]): string | null {
  const tops = [dir, ...safeList(dir).map((n) => path.join(dir, n))];
  for (const top of tops) for (const tail of tails) if (fs.existsSync(path.join(top, ...tail))) return path.join(top, ...tail);
  return null;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

export function maestroSource(f: Fetch = fetch, system: System = systemOf()): ToolSource {
  const m = OWN_SOURCES.maestro;
  return {
    version: m.version,
    file: m.file,
    pack: 'zip',
    size: m.size,
    async sha256(signal) {
      const res = await f(m.checksums, { signal, redirect: 'follow' }).catch(() => {
        throw reach('Maestro');
      });
      if (!res.ok) throw reach('Maestro');
      const line = (await res.text()).split('\n').find((l) => l.includes(m.file));
      const sum = /\b([0-9a-f]{64})\b/i.exec(line ?? '')?.[1]?.toLowerCase();
      // squad-kit knows this release's checksum too: a release changed after the fact is not used.
      if (!sum || sum !== m.sha256) throw new GetTrouble("Maestro's published checksum is not the one squad-kit knows for this version, so squad-kit did not download it. Nothing was installed.");
      return sum;
    },
    open: (signal) => download(f, m.url, 'Maestro', signal),
    binary: (dir) => findIn(dir, [['bin', system === 'windows' ? 'maestro.bat' : 'maestro']]),
  };
}

/** The newest Eclipse Temurin Java runtime of the line squad-kit uses, for this system and chip, from Adoptium's own API. */
export async function javaSource(f: Fetch = fetch, system: System = systemOf(), arch: string = process.arch, signal?: AbortSignal): Promise<ToolSource> {
  const j = OWN_SOURCES.java;
  const os = system === 'windows' ? 'windows' : system;
  const chip = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : arch;
  const url = `${j.api}/${j.feature}/hotspot?architecture=${chip}&image_type=jre&os=${os}&vendor=eclipse`;
  const res = await f(url, { ...(signal ? { signal } : {}), redirect: 'follow' }).catch(() => {
    throw reach('Java');
  });
  if (!res.ok) throw reach('Java');
  const list = (await res.json().catch(() => [])) as { binary?: { package?: { link?: string; checksum?: string; size?: number; name?: string } }; release_name?: string }[];
  const pick = list.find((x) => x.binary?.package?.link && x.binary.package.checksum);
  const pkg = pick?.binary?.package;
  if (!pick || !pkg?.link || !pkg.checksum) throw new GetTrouble(`squad-kit found no Java for this computer on Adoptium's official site. Nothing was installed.`);
  const name = pkg.name ?? path.basename(pkg.link);
  return {
    version: (pick.release_name ?? `${j.feature}`).replace(/^jdk-?/, ''),
    file: name,
    pack: name.endsWith('.zip') ? 'zip' : 'tar.gz',
    ...(pkg.size ? { size: pkg.size } : {}),
    sha256: async () => pkg.checksum!.toLowerCase(),
    open: (s) => download(f, pkg.link!, 'Java', s),
    binary: (dir) =>
      findIn(dir, [
        ['Contents', 'Home', 'bin', 'java'],
        ['bin', system === 'windows' ? 'java.exe' : 'java'],
      ]),
  };
}

export async function officialSource(id: ToolId, signal?: AbortSignal): Promise<ToolSource> {
  if (id === 'maestro') return maestroSource();
  if (id === 'java') return javaSource(fetch, systemOf(), process.arch, signal);
  if (id === 'android') return androidSource({ system: systemOf() });
  throw new GetTrouble(`squad-kit does not get ${nameOf(id)} itself. The Tools page says how to install it.`);
}

/* ── how long it takes here ─────────────────────────────── */

const timesFile = (home: string) => path.join(toolsHome(home), 'times.json');

/** How long it took on this computer last time, by tool ("maestro"), or by tool and job ("flutter-update"). */
export function measured(key: string, home: string): number | undefined {
  try {
    return (JSON.parse(fs.readFileSync(timesFile(home), 'utf8')) as Record<string, number>)[key];
  } catch {
    return undefined;
  }
}

export function noteTime(key: string, seconds: number, home: string): void {
  try {
    const all = fs.existsSync(timesFile(home)) ? (JSON.parse(fs.readFileSync(timesFile(home), 'utf8')) as Record<string, number>) : {};
    fs.mkdirSync(path.dirname(timesFile(home)), { recursive: true });
    fs.writeFileSync(timesFile(home), `${JSON.stringify({ ...all, [key]: Math.max(1, Math.round(seconds)) }, null, 2)}\n`);
  } catch {
    // Only the next guess is less exact.
  }
}

/** The first guess: the time measured on this computer last time, else the usual time. */
export function firstGuess(id: ToolId, home = squadHome()): number {
  return measured(id, home) ?? toolEntry(id)?.getSeconds ?? 60;
}

/* ── getting one tool ───────────────────────────────────── */

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => resolve(!err));
  });
}

async function unpack(file: string, dir: string, pack: ToolSource['pack'], system: System): Promise<boolean> {
  fs.mkdirSync(dir, { recursive: true });
  if (pack === 'tar.gz') return run('tar', ['-xzf', file, '-C', dir]);
  // Windows' own tar and the Mac's read zip files too; most Linux has unzip.
  if (system === 'windows') return run('tar', ['-xf', file, '-C', dir]);
  return (await run('unzip', ['-q', '-o', file, '-d', dir])) || run('tar', ['-xf', file, '-C', dir]);
}

/**
 * Download folders a cut run left, and version folders never marked ready: nothing half there stays. Only the tools
 * this file gets are looked at: the same folder holds other things squad-kit keeps, like its browser.
 */
export function clearHalfGets(home = squadHome()): void {
  const base = toolsHome(home);
  for (const n of safeListAll(base)) if (n.startsWith('.part-')) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  for (const e of CATALOG.filter((t) => t.installer === 'squad-kit')) {
    const dir = path.join(base, e.id);
    for (const v of safeListAll(dir)) if (isDir(path.join(dir, v)) && !fs.existsSync(path.join(dir, v, 'ready.json'))) fs.rmSync(path.join(dir, v), { recursive: true, force: true });
  }
}

function safeListAll(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Gets one tool from its source: downloads it while checking its checksum, unpacks it beside, then moves it into
 * place and marks it ready. Whatever goes wrong, the download folder goes, and nothing is marked ready.
 */
export async function getTool(id: ToolId, source: ToolSource, opts: { home?: string; signal?: AbortSignal; system?: System; onProgress?(p: { done: number; total?: number; step: Getting['step'] }): void } = {}): Promise<OwnTool> {
  const home = opts.home ?? squadHome();
  const name = nameOf(id);
  const signal = opts.signal ?? new AbortController().signal;
  const started = Date.now();
  fs.mkdirSync(toolsHome(home), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(toolsHome(home), `.part-${id}-`));
  try {
    const algorithm = source.algorithm ?? 'sha256';
    const expected = (await source.sha256(signal)).toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${algorithm === 'sha1' ? 40 : 64}}$`).test(expected)) throw new GetTrouble(`squad-kit could not read ${name}'s published checksum, so it did not download it. Nothing was installed.`);
    const file = path.join(tmp, path.basename(source.file));
    const { body, size } = await source.open(signal);
    const total = size ?? source.size;
    // A download with an install after it shows the whole of it: the install counts on from here.
    const shown = source.finish && source.size ? source.size : total;
    const hash = createHash(algorithm);
    // Opened here and now, so a download that fails at once never leaves an open still on its way.
    const out = fs.createWriteStream(file, { fd: fs.openSync(file, 'w') });
    const closed = () => (out.closed ? Promise.resolve() : once(out, 'close').then(() => undefined, () => undefined));
    let done = 0;
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw new GetTrouble(`The download of ${name} was stopped. Nothing was installed.`);
        hash.update(chunk);
        done += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
        opts.onProgress?.({ done, ...(shown ? { total: shown } : {}), step: 'download' });
      }
      out.end();
      await once(out, 'close');
    } catch (err) {
      out.destroy();
      await closed();
      if (err instanceof GetTrouble) throw err;
      writeLog({ level: 'warn', text: `Getting ${name}: the download broke off: ${err instanceof Error ? err.message : String(err)}` });
      throw new GetTrouble(`The download of ${name} stopped before the end, so squad-kit threw it away. Nothing was installed. Press Get it again.`);
    }
    if (total && done !== total) throw new GetTrouble(`The download of ${name} stopped before the end, so squad-kit threw it away. Nothing was installed. Press Get it again.`);
    if (hash.digest('hex') !== expected) throw new GetTrouble(`The download of ${name} did not match its published checksum, so squad-kit threw it away. Nothing was installed.`);
    opts.onProgress?.({ done, ...(shown ? { total: shown } : {}), step: 'unpack' });
    const unpacked = path.join(tmp, 'unpacked');
    const system = opts.system ?? systemOf();
    if (!(await unpack(file, unpacked, source.pack, system))) throw new GetTrouble(`squad-kit could not unpack ${name}. Nothing was installed. Press Get it again.`);
    fs.rmSync(file, { force: true });
    if (source.finish) await source.finish(unpacked, { signal, onProgress: (p) => opts.onProgress?.({ done: p.done, total: p.total, step: 'install' }) });
    const bin = source.binary(unpacked);
    if (!bin) throw new GetTrouble(`${name}'s download did not have the program squad-kit expected, so squad-kit did not use it. Nothing was installed.`);
    if (system !== 'windows') fs.chmodSync(bin, 0o755);
    const binary = path.relative(unpacked, bin);
    const dir = path.join(toolsHome(home), id, source.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(unpacked, dir);
    const seconds = (Date.now() - started) / 1000;
    // Marked ready last: a folder without this mark is never used, and is cleared.
    fs.writeFileSync(path.join(dir, 'ready.json'), `${JSON.stringify({ version: source.version, binary, [algorithm]: expected, at: new Date().toISOString(), seconds: Math.round(seconds) }, null, 2)}\n`);
    noteTime(id, seconds, home);
    return { version: source.version, dir, binary: path.join(dir, binary), seconds: Math.round(seconds) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Starts getting tools one after the other, beside everything else, and says how it goes through `gettingNow`. Only
 * one download runs at a time: asking while one runs says so. `after` runs when it ends, well or not.
 */
export function startGets(ids: ToolId[], opts: { home?: string; source?: (id: ToolId) => Promise<ToolSource>; after?: () => void } = {}): Getting {
  const home = opts.home ?? squadHome();
  const first = ids[0]!;
  const job = async (set: (next: Getting) => void) => {
    clearHalfGets(home);
    for (const id of ids) {
      const guess = firstGuess(id, home);
      const t0 = Date.now();
      let g: Getting = { tool: id, name: nameOf(id), startedAt: new Date().toISOString(), step: 'download', done: 0, secondsLeft: guess };
      set(g);
      troubles.delete(id);
      try {
        const source = await (opts.source ?? officialSource)(id);
        g = { ...g, version: source.version, ...(source.size ? { total: source.size } : {}) };
        set(g);
        const got = await getTool(id, source, {
          home,
          onProgress: (p) => {
            const elapsed = (Date.now() - t0) / 1000;
            const rate = elapsed > 2 && p.done ? p.done / elapsed : 0;
            const left = p.step === 'unpack' ? Math.max(3, guess * 0.1) : rate && p.total ? (p.total - p.done) / rate + guess * 0.1 : Math.max(5, guess - elapsed);
            const words = p.step === 'install' ? `Getting the ${nameOf(id).replace(/ tools$/, '')} and its system from Google` : undefined;
            g = { ...g, step: p.step, done: p.done, ...(p.total ? { total: p.total } : {}), secondsLeft: Math.round(left), ...(words ? { words } : {}) };
            set(g);
          },
        });
        writeLog({ level: 'info', text: `Got ${nameOf(id)} ${got.version} in ${got.seconds ?? 0} s, into ${got.dir}` });
      } catch (err) {
        const words = err instanceof GetTrouble ? err.message : `squad-kit could not get ${nameOf(id)}. Nothing was installed. Press Get it again.`;
        if (!(err instanceof GetTrouble)) writeLog({ level: 'warn', text: `Getting ${nameOf(id)}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` });
        troubles.set(id, words);
        // What comes after it needs it: they wait for the next Get it.
        break;
      }
    }
  };
  return startOne({ tool: first, name: nameOf(first), startedAt: new Date().toISOString(), step: 'download', done: 0, secondsLeft: firstGuess(first, home) }, job, opts.after);
}
