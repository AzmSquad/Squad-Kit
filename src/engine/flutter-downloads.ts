import { usesAndroid } from './android-env.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLog } from '../core/app-log.js';
import { OWN_GROUP, endGroup, track, whenExited } from './process-group.js';
import { projectEnv } from './project-guard.js';
import { flutterOnPath } from './flutter-sdk.js';
import { kindsOf, type Platform } from './tools/kinds.js';

/**
 * Flutter's own downloads, done by squad-kit outside the guard. Flutter keeps what it downloads for each phone (the
 * iPhone's and the web's engine) in its own folder, and that folder is the person's program: in the guard it stays read
 * only, so a story's code can never change what they run later. So before a guarded Flutter command, squad-kit runs
 * `flutter precache` itself, once, for the platforms the project builds for here: the person's own Flutter, with fixed
 * words, outside the story's copy. Android comes in a later update. A Flutter that is not there, or a download that
 * does not work, stops nothing: the command runs as it would have, and says what is wrong in its own words.
 */

export interface PrecacheRunner {
  (program: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?(): void }): Promise<{ ok: boolean; output: string }>;
}

/** The first time, Flutter downloads hundreds of MB: this long at most. */
export const PRECACHE_MS = 20 * 60_000;

/** True when a command runs Flutter: `flutter test`, `cd app && flutter pub get`. */
export function runsFlutter(command: string): boolean {
  return /(?:^|[\s;&|(])flutter(?:\s|$)/.test(command);
}

/**
 * What `flutter precache` gets: the iPhone's on a Mac, the web's when the app has a web version, and Android's only for
 * a command that builds for Android (`flutter build apk`). Null when none.
 */
export function precacheArgs(platforms: Platform[], platform: NodeJS.Platform = process.platform, command?: string): string[] | null {
  const android = platforms.includes('android') && usesAndroid(command);
  const want = [...(platforms.includes('ios') && platform === 'darwin' ? ['--ios'] : []), ...(platforms.includes('web') ? ['--web'] : []), ...(android ? ['--android'] : [])];
  return want.length ? ['precache', ...want] : null;
}

export { flutterOnPath };

/** The engine a Flutter uses, from its own file: a new Flutter has a new engine, and downloads again. */
function engineOf(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'bin', 'internal', 'engine.version'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Runs the person's Flutter in its own process group, ended on Stop or after PRECACHE_MS. */
const realRunner: PrecacheRunner = (program, args, o) =>
  new Promise((resolve) => {
    let output = '';
    const child = track(spawn(program, args, { cwd: o.cwd, env: o.env, detached: OWN_GROUP, stdio: ['ignore', 'pipe', 'pipe'] }));
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000);
      o.onOutput?.();
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const end = () => endGroup(child);
    const timer = setTimeout(end, PRECACHE_MS);
    o.signal?.addEventListener('abort', end, { once: true });
    child.on('error', (err) => (output += `\n${err.message}`));
    void whenExited(child).then((code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', end);
      resolve({ ok: code === 0, output });
    });
  });

let runner: PrecacheRunner = realRunner;

/** Tests use a fake runner. Null goes back to the real one. */
export function usePrecacheRunner(r: PrecacheRunner | null): void {
  runner = r ?? realRunner;
  done.clear();
  running.clear();
}

/** What is done already, by Flutter, its engine and the platforms: once each while squad-kit runs. */
const done = new Set<string>();
/** One run at a time for the same: a story starting beside another waits for the same run. */
const running = new Map<string, Promise<boolean>>();

export type FlutterDownloads = 'done' | 'had' | 'not-needed' | 'failed';

/**
 * Before a guarded command runs Flutter in a Flutter app's folder: Flutter's own downloads for the platforms it builds
 * for, by squad-kit, once. 'had' when they were done before, 'not-needed' when the command or the folder needs none.
 */
export async function flutterDownloads(dir: string, command: string, o: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?(): void; platform?: NodeJS.Platform; home?: string } = {}): Promise<FlutterDownloads> {
  if (!runsFlutter(command)) return 'not-needed';
  const { kinds, platforms } = kindsOf(dir);
  const args = kinds.includes('flutter') ? precacheArgs(platforms, o.platform, command) : null;
  const env = o.env ?? projectEnv();
  const flutter = args ? flutterOnPath(env) : null;
  if (!args || !flutter) return 'not-needed';
  const key = [flutter.root, engineOf(flutter.root), ...args].join('\n');
  if (done.has(key)) return 'had';
  let run = running.get(key);
  if (!run) {
    // Outside every copy, so nothing a story wrote is read; with no usage report, as squad-kit's own run.
    run = runner(flutter.program, args, { cwd: o.home ?? os.homedir(), env: { ...env, FLUTTER_SUPPRESS_ANALYTICS: 'true' }, ...(o.signal ? { signal: o.signal } : {}), ...(o.onOutput ? { onOutput: o.onOutput } : {}) })
      .then((r) => {
        if (r.ok) done.add(key);
        else writeLog({ level: 'warn', text: `squad-kit could not get Flutter's downloads (flutter ${args.join(' ')}), so the command runs without them:\n${r.output.trim()}` });
        return r.ok;
      })
      .catch(() => false)
      .finally(() => running.delete(key));
    running.set(key, run);
  }
  return (await run) ? 'done' : 'failed';
}
