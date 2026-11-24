import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLog } from '../core/app-log.js';
import { OWN_GROUP, endGroup, track, whenExited } from './process-group.js';

/**
 * FVM, which runs the Flutter version a project pins: inside squad-kit's guard it can't download that Flutter (its
 * cache is outside the copy, and the guard keeps it read only), so `fvm flutter` failed before the first check. As with
 * Flutter's own downloads (flutter-downloads.ts), squad-kit gets it outside the guard first: `fvm install <version>`,
 * with the version it read from the copy's pin and fixed words, run from the home folder, never from the copy. Then
 * FVM finds it installed, and only that Flutter's own version stamps open in the guard, each exactly (flutter-sdk.ts).
 * A download that does not work stops nothing: the command runs as it would have, and says what is wrong.
 */

/** A command that runs FVM: `fvm flutter test`, `cd app && fvm install`. */
export function runsFvm(command: string): boolean {
  return /(?:^|[\s;&|(])fvm(?:\s|$)/.test(command);
}

/** A version as FVM names one: "3.47.9", "stable", "3.38.0-0.1.pre". Anything else is never passed on. */
const VERSION = /^[\w][\w.+-]{0,39}$/;

/** The Flutter version a folder pins with FVM: FVM 3's .fvmrc, or FVM 2's .fvm/fvm_config.json. Null when none. */
export function fvmPin(dir: string): string | null {
  const read = (file: string, key: string): string | null => {
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>)[key];
      return typeof v === 'string' && VERSION.test(v.trim()) ? v.trim() : null;
    } catch {
      return null;
    }
  };
  return read('.fvmrc', 'flutter') ?? read(path.join('.fvm', 'fvm_config.json'), 'flutterSdkVersion');
}

/** FVM's own folder of Flutter versions: FVM_CACHE_PATH when set, else ~/fvm/versions, as FVM 3 and 4 keep it. */
export function fvmCache(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const set = env.FVM_CACHE_PATH?.trim();
  return set && path.isAbsolute(set) ? set : path.join(home, 'fvm', 'versions');
}

/** The Flutter folder FVM runs for a folder's pin, whether it is there yet or not. Null when the folder pins none. */
export function fvmFlutterRoot(dir: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const v = fvmPin(dir);
  return v ? path.join(fvmCache(env, home), v) : null;
}

/** FVM's program on the PATH, by the PATH's full folders only. */
function fvmOnPath(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const program = path.join(dir, process.platform === 'win32' ? 'fvm.bat' : 'fvm');
    try {
      if (fs.statSync(program).isFile()) return program;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/** Getting a Flutter version is a git clone of about 1 GB: this long at most. */
export const FVM_INSTALL_MS = 30 * 60_000;

export interface FvmRunner {
  (program: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?(): void }): Promise<{ ok: boolean; output: string }>;
}

/** Runs FVM in its own process group, ended on Stop or after FVM_INSTALL_MS. */
const realRunner: FvmRunner = (program, args, o) =>
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
    const timer = setTimeout(end, FVM_INSTALL_MS);
    o.signal?.addEventListener('abort', end, { once: true });
    child.on('error', (err) => (output += `\n${err.message}`));
    void whenExited(child).then((code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', end);
      resolve({ ok: code === 0, output });
    });
  });

let runner: FvmRunner = realRunner;

/** Tests use a fake runner. Null goes back to the real one. */
export function useFvmRunner(r: FvmRunner | null): void {
  runner = r ?? realRunner;
  running.clear();
}

/** One install at a time for the same version: a story starting beside another waits for the same one. */
const running = new Map<string, Promise<boolean>>();

/**
 * Before a guarded command runs FVM in a folder that pins a Flutter version: FVM installs that version outside the
 * guard, once. Answers the Flutter folder FVM runs (installed now or before), or null when the command or the folder
 * needs none, FVM is not here, or the install did not work.
 */
export async function fvmInstall(dir: string, command: string, o: { env: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?(): void; home?: string }): Promise<string | null> {
  if (!runsFvm(command)) return null;
  const version = fvmPin(dir);
  const home = o.home ?? os.homedir();
  const root = version ? path.join(fvmCache(o.env, home), version) : null;
  if (!version || !root) return null;
  if (fs.existsSync(path.join(root, 'bin', 'flutter'))) return root;
  const fvm = fvmOnPath(o.env);
  if (!fvm) return null;
  let run = running.get(root);
  if (!run) {
    // From the home folder, never the copy, so nothing a story wrote is read; the version is the one squad-kit read.
    run = runner(fvm, ['install', version], { cwd: home, env: { ...o.env, CI: 'true', FLUTTER_SUPPRESS_ANALYTICS: 'true' }, ...(o.signal ? { signal: o.signal } : {}), ...(o.onOutput ? { onOutput: o.onOutput } : {}) })
      .then((r) => {
        if (!r.ok) writeLog({ level: 'warn', text: `squad-kit could not get Flutter ${version} with FVM (fvm install ${version}), so the command runs without it:\n${r.output.trim()}` });
        return r.ok && fs.existsSync(path.join(root, 'bin', 'flutter'));
      })
      .catch(() => false)
      .finally(() => running.delete(root));
    running.set(root, run);
  }
  return (await run) ? root : null;
}
