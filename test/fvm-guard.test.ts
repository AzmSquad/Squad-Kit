import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flutterDownloads, usePrecacheRunner, type PrecacheRunner } from '../src/engine/flutter-downloads.js';
import { fvmCache, fvmFlutterRoot, fvmInstall, fvmPin, runsFvm, useFvmRunner, type FvmRunner } from '../src/engine/fvm-sdk.js';
import { guardStamps, stampRoots } from '../src/engine/flutter-sdk.js';
import { buildGuard } from '../src/engine/project-guard.js';
import { toolMissing } from '../src/engine/tool-missing.js';

/**
 * FVM in squad-kit's guard: inside it FVM can't download the Flutter a project pins (its cache is outside the copy), so
 * squad-kit runs `fvm install <version>` itself first, outside the guard, from the home folder, with the version it read
 * from the copy's pin; then FVM finds it installed, and that Flutter's version stamps open in the guard, each exactly.
 * A made-up FVM and Flutter, and fake runners: nothing real downloads.
 */

const ROOT = fs.realpathSync(process.cwd());
let base: string;
let home: string;
let copy: string;
let cache: string;
let bin: string;
let fvmCalls: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
let precache: { program: string; args: string[] }[];
let installs: boolean;

const write = (file: string, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** FVM installs the version into its cache, as the real one does, when `installs` is on. */
const fakeFvm: FvmRunner = async (program, args, o) => {
  fvmCalls.push({ program, args, cwd: o.cwd, env: o.env });
  await new Promise((r) => setTimeout(r, 20));
  if (!installs) return { ok: false, output: 'Failed to install 3.47.9' };
  write(path.join(cache, args[1]!, 'bin', 'flutter'), '#!/bin/sh\n');
  write(path.join(cache, args[1]!, 'bin', 'internal', 'engine.version'), 'e9\n');
  return { ok: true, output: 'Flutter SDK 3.47.9 installed' };
};
const fakePrecache: PrecacheRunner = async (program, args) => {
  precache.push({ program, args });
  return { ok: true, output: '' };
};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.fvm-')));
  home = path.join(base, 'h');
  copy = path.join(base, 'copy');
  cache = path.join(home, 'fvm', 'versions');
  bin = path.join(base, 'bin');
  fs.mkdirSync(home, { recursive: true });
  write(path.join(bin, 'fvm'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'fvm'), 0o755);
  write(path.join(copy, 'pubspec.yaml'), 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(copy, 'ios', 'Runner.xcodeproj', 'project.pbxproj'));
  write(path.join(copy, '.fvmrc'), JSON.stringify({ flutter: '3.47.9' }));
  fvmCalls = [];
  precache = [];
  installs = true;
  useFvmRunner(fakeFvm);
  usePrecacheRunner(fakePrecache);
});

afterEach(() => {
  useFvmRunner(null);
  usePrecacheRunner(null);
  fs.rmSync(base, { recursive: true, force: true });
});

const env = () => ({ PATH: [bin, '/usr/bin'].join(path.delimiter) });

describe("a project's FVM pin", () => {
  it('reads the version from .fvmrc, or from FVM 2\'s own file, and never a value that is not a version', () => {
    expect(fvmPin(copy)).toBe('3.47.9');
    fs.rmSync(path.join(copy, '.fvmrc'));
    write(path.join(copy, '.fvm', 'fvm_config.json'), JSON.stringify({ flutterSdkVersion: 'stable' }));
    expect(fvmPin(copy)).toBe('stable');
    write(path.join(copy, '.fvmrc'), JSON.stringify({ flutter: '3.47.9; rm -rf ~' }));
    expect(fvmPin(copy)).toBe('stable');
    expect(runsFvm('fvm flutter test')).toBe(true);
    expect(runsFvm('cd app && fvm install')).toBe(true);
    expect(runsFvm('flutter test')).toBe(false);
  });

  it("finds FVM's cache where FVM keeps it: FVM_CACHE_PATH, else ~/fvm/versions", () => {
    expect(fvmCache({}, home)).toBe(cache);
    expect(fvmCache({ FVM_CACHE_PATH: '/data/fvm' }, home)).toBe('/data/fvm');
    expect(fvmFlutterRoot(copy, {}, home)).toBe(path.join(cache, '3.47.9'));
  });
});

describe('before a guarded command that runs fvm', () => {
  it("squad-kit installs the pinned Flutter with FVM, outside the guard and the copy, once; then precaches with it", async () => {
    const r = await flutterDownloads(copy, 'fvm install && fvm flutter pub get', { env: env(), home, platform: 'darwin' });
    expect(fvmCalls).toEqual([{ program: path.join(bin, 'fvm'), args: ['install', '3.47.9'], cwd: home, env: expect.objectContaining({ CI: 'true' }) }]);
    // The Flutter FVM runs gets the downloads, never the one on the PATH.
    expect(precache).toEqual([{ program: path.join(cache, '3.47.9', 'bin', 'flutter'), args: ['precache', '--ios'] }]);
    expect(r).toBe('done');
    // Installed now: never again.
    await flutterDownloads(copy, 'fvm flutter analyze', { env: env(), home, platform: 'darwin' });
    expect(fvmCalls).toHaveLength(1);
  });

  it('two stories at once wait for the same install', async () => {
    await Promise.all([fvmInstall(copy, 'fvm flutter test', { env: env(), home }), fvmInstall(copy, 'fvm flutter analyze', { env: env(), home })]);
    expect(fvmCalls).toHaveLength(1);
  });

  it('an install that does not work stops nothing: the command runs and says why itself', async () => {
    installs = false;
    expect(await fvmInstall(copy, 'fvm flutter test', { env: env(), home })).toBeNull();
    // With no FVM here, or no pin, nothing is run.
    expect(await fvmInstall(copy, 'fvm flutter test', { env: { PATH: '/usr/bin' }, home })).toBeNull();
    fs.rmSync(path.join(copy, '.fvmrc'));
    expect(await fvmInstall(copy, 'fvm flutter test', { env: env(), home })).toBeNull();
    expect(fvmCalls).toHaveLength(1);
  });
});

describe('in the guard', () => {
  it("only the stamps of the pinned Flutter open, beside the PATH's, each exactly", () => {
    const flutter = path.join(base, 'flutter');
    const roots = stampRoots(flutter, copy, {});
    expect(roots).toEqual([flutter, path.join(os.homedir(), 'fvm', 'versions', '3.47.9')]);
    const g = guardStamps([path.join(cache, '3.47.9')]);
    expect(g.writeExactly).toEqual([
      `^${path.join(cache, '3.47.9').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/cache/engine\\.stamp$`,
      `^${path.join(cache, '3.47.9').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/cache/engine\\.stamp\\.tmp\\.[0-9]+$`,
      `^${path.join(cache, '3.47.9').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/cache/engine\\.realm$`,
    ]);
    expect(g.writeExactlyIn).toEqual([path.join(cache, '3.47.9', 'bin', 'cache')]);
    // A copy with no pin opens only the PATH's.
    fs.rmSync(path.join(copy, '.fvmrc'));
    expect(buildGuard({ cwd: copy, root: copy, home, platform: 'darwin', flutter: null }).writeExactly).toBeUndefined();
  });

  it("a pinned Flutter FVM could not get is a missing tool, never the Builder's to fix", () => {
    expect(toolMissing('Flutter SDK: SDK Version : 3.47.9 is not installed.\nInstalling Flutter SDK automatically...\n✗ Failed to install 3.47.9 (0.6s)')?.what).toBe('the Flutter version this project pins');
  });
});
