import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeLog } from '../core/app-log.js';
import { usesAndroid } from './android-env.js';
import { gradleHome } from './tools/android.js';
import { onlyAndroidBuild } from './tools/android-builds.js';

/**
 * The Gradle a project's wrapper asks for, got by squad-kit before a check that builds the Android app. The wrapper
 * downloads it on the first build, a few hundred MB that print nothing, and the check was stopped as silent long
 * before it was done. squad-kit gets it outside the check from Gradle's own site only, checks it against the SHA-256
 * Gradle publishes beside it, and keeps it in its own shared Gradle home, read only to the checks: the cache home links
 * it in (cache-home.ts gradleWrapper), so no story downloads it again. And the first Android build itself, which
 * downloads its libraries as it goes, gets more time and more quiet than other checks.
 */

/** A check that builds the Android app: this long at most, as the first one downloads its libraries. */
export const ANDROID_CHECK_MS = 40 * 60_000;
/** It may print nothing this long while Gradle downloads, before squad-kit calls it silent. */
export const ANDROID_SILENT_MS = 15 * 60_000;
/** Getting Gradle itself: this long at most. */
export const GRADLE_GET_MS = 30 * 60_000;

/** A limit for one check: the Android build's own (ANDROID_CHECK_MS, ANDROID_SILENT_MS) when it builds the app, else the usual. */
export function limitFor(command: string, usual: number, android: number): number {
  return usesAndroid(command) ? Math.max(usual, android) : usual;
}

/**
 * An Android build check that runs outside the guard (checks.ts outsideTheGuard): in squad-kit's own shared Gradle home,
 * as its phone builds, never the one the guarded commands share, whose Gradle helpers run in the guard and can't build
 * there; and with no helper left behind (8 GB each for a Flutter app).
 */
export function outsideEnv(command: string): Record<string, string> {
  if (!onlyAndroidBuild(command)) return {};
  return { GRADLE_USER_HOME: gradleHome(), GRADLE_OPTS: [process.env.GRADLE_OPTS?.trim(), '-Dorg.gradle.daemon=false'].filter(Boolean).join(' ') };
}

/** Only Gradle's own distributions, as its wrapper names them. */
const OFFICIAL = /^https:\/\/services\.gradle\.org\/distributions\/gradle-[\w.-]+-(?:bin|all)\.zip$/;

export interface WrapperDist {
  url: string;
  /** "gradle-9.3.1-all". */
  name: string;
  /** The wrapper's own folder name for it: the address's MD5 in base 36. */
  hash: string;
  /** Where the wrapper keeps it under a Gradle home: wrapper/dists/<name>/<hash>. */
  rel: string;
  /** The wrapper's mark that it is whole: <name>.zip.ok. */
  ok: string;
}

/** The Gradle a project's wrapper asks for, at the top of a Gradle project or in an app's android/ folder. */
export function wrapperDist(cwd: string): WrapperDist | null {
  let said = '';
  for (const at of [cwd, path.join(cwd, 'android')]) {
    try {
      said = fs.readFileSync(path.join(at, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
      break;
    } catch {
      // Not here.
    }
  }
  if (!said) return null;
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(said)?.[1]?.trim().replace(/\\(.)/g, '$1');
  const url = value('distributionUrl');
  // Only where the wrapper keeps them by default; a project that keeps its Gradle elsewhere has it already.
  if (!url || (value('distributionBase') ?? 'GRADLE_USER_HOME') !== 'GRADLE_USER_HOME' || (value('distributionPath') ?? 'wrapper/dists') !== 'wrapper/dists') return null;
  const name = path.basename(url).replace(/\.zip$/, '');
  const hash = BigInt(`0x${createHash('md5').update(url).digest('hex')}`).toString(36);
  return { url, name, hash, rel: path.join('wrapper', 'dists', name, hash), ok: `${name}.zip.ok` };
}

export interface GradleFetch {
  (url: string, signal: AbortSignal): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;
}

let fetcher: GradleFetch = (url, signal) => fetch(url, { signal, redirect: 'follow' });

/** Tests use a fake download. Null goes back to the real one. */
export function useGradleFetch(f: GradleFetch | null): void {
  fetcher = f ?? ((url, signal) => fetch(url, { signal, redirect: 'follow' }));
  running.clear();
}

const unzip = (file: string, dir: string) =>
  new Promise<boolean>((resolve) => {
    const [cmd, args] = process.platform === 'win32' ? ['tar', ['-xf', file, '-C', dir]] : ['unzip', ['-q', '-o', file, '-d', dir]];
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err) => resolve(!err));
  });

/** One at a time for the same Gradle: a story starting beside another waits for the same download. */
const running = new Map<string, Promise<boolean>>();

/** The Gradle homes where a whole copy of this Gradle may be already: squad-kit's shared one, and the person's. */
function haveIt(d: WrapperDist, homes: string[]): boolean {
  return homes.some((h) => fs.existsSync(path.join(h, d.rel, d.ok)));
}

/**
 * Before a guarded command that builds the Android app: the Gradle its wrapper asks for, in squad-kit's shared Gradle
 * home, once. 'had' when it was there (or in the person's own), 'not-needed' when the command or the project needs
 * none, 'failed' when it could not be got: the command then runs as it would have, and says why itself.
 */
export async function gradleDownloads(cwd: string, command: string, o: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?(): void; home?: string } = {}): Promise<'done' | 'had' | 'not-needed' | 'failed'> {
  if (!usesAndroid(command)) return 'not-needed';
  const d = wrapperDist(cwd);
  if (!d || !OFFICIAL.test(d.url)) return 'not-needed';
  const shared = gradleHome(o.home);
  const env = o.env ?? process.env;
  if (haveIt(d, [shared, env.GRADLE_USER_HOME ?? path.join(env.HOME ?? '', '.gradle')])) return 'had';
  let run = running.get(d.url);
  if (!run) {
    run = getGradle(d, path.join(shared, d.rel), o)
      .catch((err: Error) => {
        writeLog({ level: 'warn', text: `squad-kit could not get ${d.name} from Gradle's site, so the build downloads it itself: ${err.message}` });
        return false;
      })
      .finally(() => running.delete(d.url));
    running.set(d.url, run);
  }
  return (await run) ? 'done' : 'failed';
}

/** Downloads, checks and unpacks one Gradle into its folder, and marks it whole last, as the wrapper does. */
async function getGradle(d: WrapperDist, dir: string, o: { signal?: AbortSignal; onOutput?(): void }): Promise<boolean> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), GRADLE_GET_MS);
  const outside = () => stop.abort();
  o.signal?.addEventListener('abort', outside, { once: true });
  const part = `${dir}.part-${process.pid}`;
  try {
    const sum = await fetcher(`${d.url}.sha256`, stop.signal);
    const expected = sum.ok ? /\b([0-9a-f]{64})\b/i.exec(await sum.text())?.[1]?.toLowerCase() : undefined;
    if (!expected) throw new Error(`no SHA-256 published for ${d.url}`);
    const res = await fetcher(d.url, stop.signal);
    if (!res.ok || !res.body) throw new Error(`the download of ${d.url} did not start`);
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    const zip = path.join(part, `${d.name}.zip`);
    const hash = createHash('sha256');
    let last = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      // Heard, so the step is seen working while it downloads.
      if (Date.now() - last > 5_000) {
        last = Date.now();
        o.onOutput?.();
      }
    });
    await pipeline(body, fs.createWriteStream(zip));
    if (hash.digest('hex') !== expected) throw new Error(`${d.name}.zip did not match the SHA-256 Gradle publishes`);
    if (!(await unzip(zip, part))) throw new Error(`could not unpack ${d.name}.zip`);
    fs.rmSync(zip, { force: true });
    fs.writeFileSync(path.join(part, d.ok), '');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(part, dir);
    writeLog({ level: 'info', text: `squad-kit got ${d.name} from Gradle's site for the Android builds, in ${dir}` });
    return true;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', outside);
    fs.rmSync(part, { recursive: true, force: true });
  }
}
