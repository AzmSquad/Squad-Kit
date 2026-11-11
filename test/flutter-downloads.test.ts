import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../src/engine/checks.js';
import { flutterDownloads, flutterOnPath, precacheArgs, runsFlutter, usePrecacheRunner, type PrecacheRunner } from '../src/engine/flutter-downloads.js';
import { buildGuard, guardSupport } from '../src/engine/project-guard.js';

/**
 * Flutter's own downloads (1.3.9): in the guard, Flutter's folder is the person's program and stays read only, so
 * squad-kit runs `flutter precache` itself, outside the guard and outside the story's copy, once, for the platforms the
 * app builds for here. Never the real Flutter: a made-up one on the PATH, and a fake runner that records what it was
 * asked. The fixtures sit under the worktree, not the system temp, which the guard lets commands write in.
 */

const onMac = process.platform === 'darwin' && guardSupport().on;
const ROOT = fs.realpathSync(process.cwd());

let base: string;
let home: string;
let sdk: string;
let copy: string;
let calls: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
let answer: { ok: boolean; output: string };

const write = (file: string, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const fake: PrecacheRunner = async (program, args, o) => {
  calls.push({ program, args, cwd: o.cwd, env: o.env });
  await new Promise((r) => setTimeout(r, 20));
  return answer;
};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.fd-')));
  home = path.join(base, 'h');
  sdk = path.join(base, 'flutter');
  copy = path.join(base, 'copy');
  fs.mkdirSync(home);
  write(path.join(sdk, 'bin', 'flutter'), '#!/bin/sh\necho "Flutter 3.38.0"\n');
  fs.chmodSync(path.join(sdk, 'bin', 'flutter'), 0o755);
  write(path.join(sdk, 'bin', 'internal', 'engine.version'), 'e1\n');
  write(path.join(copy, 'pubspec.yaml'), 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(copy, 'ios', 'Runner.xcodeproj', 'project.pbxproj'));
  write(path.join(copy, 'web', 'index.html'));
  calls = [];
  answer = { ok: true, output: 'Downloading iOS tools...' };
  usePrecacheRunner(fake);
});

afterEach(() => {
  usePrecacheRunner(null);
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

const env = () => ({ PATH: ['bin', path.join(sdk, 'bin'), '/usr/bin'].join(path.delimiter) });
const get = (command = 'flutter test', more: { platform?: NodeJS.Platform } = {}) => flutterDownloads(copy, command, { env: env(), home, platform: 'darwin', ...more });

describe('which commands and which downloads', () => {
  it('a command that runs Flutter, however it is written', () => {
    for (const c of ['flutter test', 'flutter pub get', 'cd app && flutter analyze', 'flutter']) expect(runsFlutter(c)).toBe(true);
    for (const c of ['npm test', 'dart test', 'echo flutter_test', './flutterw test', 'cat /opt/flutter/bin/x']) expect(runsFlutter(c)).toBe(false);
  });

  it("the iPhone's on a Mac and the web's when the app has a web version; Android comes later", () => {
    expect(precacheArgs(['ios', 'android', 'web'], 'darwin')).toEqual(['precache', '--ios', '--web']);
    expect(precacheArgs(['ios', 'android'], 'darwin')).toEqual(['precache', '--ios']);
    expect(precacheArgs(['ios', 'web'], 'linux')).toEqual(['precache', '--web']);
    expect(precacheArgs(['ios'], 'win32')).toBeNull();
    expect(precacheArgs(['android'], 'darwin')).toBeNull();
  });

  it('the Flutter on the PATH, by its full folders only', () => {
    expect(flutterOnPath(env())).toEqual({ program: path.join(sdk, 'bin', 'flutter'), root: sdk });
    // A folder named from where a command runs could be one a story writes in.
    expect(flutterOnPath({ PATH: ['bin', 'flutter/bin'].join(path.delimiter) })).toBeNull();
    expect(flutterOnPath({ PATH: '/usr/bin' })).toBeNull();
  });
});

describe("squad-kit gets Flutter's downloads, once", () => {
  it('outside the copy, with the person\'s own Flutter and no usage report', async () => {
    expect(await get()).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ program: path.join(sdk, 'bin', 'flutter'), args: ['precache', '--ios', '--web'], cwd: home });
    expect(calls[0]!.env.FLUTTER_SUPPRESS_ANALYTICS).toBe('true');
    // Never pointed at the story's caches, nor told it is already locked: this one is Flutter's own run.
    expect(calls[0]!.env).not.toHaveProperty('PUB_CACHE');
    expect(calls[0]!.env).not.toHaveProperty('FLUTTER_ALREADY_LOCKED');
    expect(await get('flutter analyze')).toBe('had');
    expect(calls).toHaveLength(1);
  });

  it('one run for stories that start together, and again for a new Flutter', async () => {
    expect(await Promise.all([get(), get('flutter pub get'), get()])).toEqual(['done', 'done', 'done']);
    expect(calls).toHaveLength(1);
    write(path.join(sdk, 'bin', 'internal', 'engine.version'), 'e2\n');
    expect(await get()).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('a download that did not work stops nothing, and is tried again next time', async () => {
    answer = { ok: false, output: 'Failed to download https://storage.googleapis.com/...' };
    expect(await get()).toBe('failed');
    answer = { ok: true, output: '' };
    expect(await get()).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('not for another command, another kind of project, an app with neither iPhone nor web, or no Flutter here', async () => {
    expect(await get('npm test')).toBe('not-needed');
    expect(await flutterDownloads(copy, 'flutter test', { env: { PATH: '/usr/bin' }, home })).toBe('not-needed');
    fs.rmSync(path.join(copy, 'ios'), { recursive: true });
    fs.rmSync(path.join(copy, 'web'), { recursive: true });
    fs.mkdirSync(path.join(copy, 'android'));
    expect(await get()).toBe('not-needed');
    write(path.join(copy, 'pubspec.yaml'), 'name: rules\nenvironment:\n  sdk: ^3.0.0\n');
    expect(await get()).toBe('not-needed');
    expect(calls).toEqual([]);
  });

  it("only the web's off a Mac", async () => {
    expect(await get('flutter test', { platform: 'linux' })).toBe('done');
    expect(calls[0]!.args).toEqual(['precache', '--web']);
  });
});

describe.runIf(onMac)('before a guarded Flutter command, on a Mac', () => {
  it('squad-kit gets the downloads first; a command with no guard is left as it was', async () => {
    vi.stubEnv('PATH', `${path.join(sdk, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
    const guard = buildGuard({ cwd: copy, root: path.join(base, 'p'), home, platform: process.platform });
    const r = await runCommand(copy, 'flutter --version', undefined, { guard });
    expect(r.output).toContain('Flutter 3.38.0');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).not.toBe(copy);
    usePrecacheRunner(fake);
    await runCommand(copy, 'flutter --version');
    expect(calls).toHaveLength(1);
  });
});
