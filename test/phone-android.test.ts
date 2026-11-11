import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { fakeAndroid, fakePhone, type FakePhone } from './fakes/phone.js';
import type { Found, FoundBook } from '../src/engine/tools/detect.js';
import type { BuildRun } from '../src/engine/phone/build.js';

/**
 * Android beside the iPhone, in the engine: which phone an app uses (the setting, and automatic), only that phone's
 * tools counting; the Android builds by kind (Flutter, React Native, native Gradle, Expo with a folder made for the
 * build and kept out of every commit), in squad-kit's one Gradle home, its helper stopped after, and the story's own
 * files put back as they were; squad-kit's Android devices saved beside the iPhone's; one phone at a time across both;
 * and Start opening Android's window first. The phones and the builds are fakes: no emulator, no Gradle.
 */

const h = vi.hoisted(() => ({ ios: null as FakePhone | null, android: null as FakePhone | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotPhone: (system?: string) => (system === 'android' ? h.android!.module : h.ios!.module),
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { buildPaths } = await import('../src/core/paths.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const tools = await import('../src/engine/tools/index.js');
const { choosePhone, parseChoice } = await import('../src/engine/tools/which-phone.js');
const { phoneApp, phoneStartPlan } = await import('../src/engine/phone/plan.js');
const build = await import('../src/engine/phone/build.js');
const { ownDevice, savedDevices } = await import('../src/engine/phone/devices.js');
const desk = await import('../src/engine/phone/turn.js');
const { PhoneOpen } = await import('../src/engine/phone/open.js');
const { stageAll } = await import('../src/engine/git.js');
const { phoneView, startPhoneNow, stopPhoneNow } = await import('../src/engine/phone/status.js');
const { phonesQuit } = await import('../src/engine/phone/quit.js');

let tmp: string;
let home: string;

const IOS_READY: Record<string, Found> = {
  flutter: { state: 'found', version: '3.47.9', where: '/fl' },
  xcode: { state: 'found', version: '27.2' },
  simulator: { state: 'found', version: '27.2' },
  cocoapods: { state: 'found', version: '1.16.2' },
  java: { state: 'found', version: '21.0.5' },
  maestro: { state: 'found', version: '2.12.1', where: '/m' },
  android: { state: 'missing' },
};
function found(over: Record<string, Found> = {}, system: FoundBook['system'] = 'mac'): void {
  writeFound({ at: new Date().toISOString(), system, tools: { ...IOS_READY, ...over } as FoundBook['tools'] }, home);
  tools.useDetectHost(null);
}

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A project with a phone app in its top folder: Flutter with the given phone folders. */
function project(folders: string[]): ReturnType<typeof boardPaths> {
  const root = path.join(tmp, `app-${folders.join('-') || 'none'}`);
  for (const f of folders) fs.mkdirSync(path.join(root, f), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live' });
  return bp;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-android-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
  h.ios = fakePhone({ notHere: null });
  h.android = fakeAndroid();
  desk.resetDesk();
  desk.useDeskHost({ freeBytes: async () => 8 * 1024 ** 3, load: () => 1, cores: () => 10, alive: () => false, sleep: async () => undefined });
});
afterEach(() => {
  build.useBuildRun(null);
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('which phone', () => {
  it('an app for one phone uses that one; for both, a computer that is not a Mac always uses Android', () => {
    const both = { kinds: ['flutter' as const], platforms: ['ios' as const, 'android' as const] };
    const never = () => {
      throw new Error('not asked');
    };
    expect(choosePhone({ kinds: ['flutter'], platforms: ['android'] }, 'iphone', 'mac', never)).toBe('android');
    expect(choosePhone({ kinds: ['ios'], platforms: ['ios'] }, 'android', 'mac', never)).toBe('ios');
    expect(choosePhone({ kinds: ['android'], platforms: ['android'] }, undefined, 'linux', never)).toBe('android');
    expect(choosePhone(both, 'iphone', 'windows', never)).toBe('android');
    expect(choosePhone(both, 'iphone', 'mac', never)).toBe('ios');
    expect(choosePhone(both, 'android', 'mac', never)).toBe('android');
    expect(choosePhone(both, undefined, 'mac', () => true)).toBe('ios');
    expect(choosePhone(both, undefined, 'mac', () => false)).toBe('android');
    expect(choosePhone({ kinds: ['web'], platforms: ['web'] }, undefined, 'mac', never)).toBeNull();
    expect(['ios', 'Android', 'automatic', 'pixel'].map(parseChoice)).toEqual(['iphone', 'android', 'auto', null]);
  });

  it("automatic on a Mac: the iPhone while its own tools are ready, else Android; Maestro missing doesn't count", () => {
    const bp = project(['ios', 'android']);
    found();
    expect(tools.phoneSystem(bp, 'pictures')).toBe('ios');
    // Android's tools are not needed meanwhile: they stop nothing.
    expect(tools.blockedBy(bp, 'pictures')).toBeNull();
    found({ maestro: { state: 'missing' } });
    expect(tools.phoneSystem(bp, 'pictures')).toBe('ios');
    expect(tools.blockedBy(bp, 'pictures')?.tools.map((t) => t.id)).toEqual(['maestro']);
    found({ xcode: { state: 'missing' }, simulator: { state: 'missing' } });
    expect(tools.phoneSystem(bp, 'pictures')).toBe('android');
    // Only Android's own tools count now: Xcode is never asked for.
    const b = tools.blockedBy(bp, 'pictures')!;
    expect(b.tools.map((t) => t.id)).toEqual(['android']);
    expect(b.text).toBe("squad-kit can't take the phone pictures yet: Android phone tools isn't on this computer.");
    expect(b.link).toBe('/tools#android');
    // A Flutter too old for Xcode 27 stops only the iPhone: Android goes on.
    found({ flutter: { state: 'found', version: '3.27.3', where: '/fl' }, android: { state: 'found', version: 'Android 16', where: '/sdk' } });
    expect(tools.phoneSystem(bp, 'pictures')).toBe('android');
    expect(tools.blockedBy(bp, 'pictures')).toBeNull();
  });

  it('the setting chooses for the whole team, through the same REST call as the other settings', async () => {
    const bp = project(['ios', 'android']);
    found({ xcode: { state: 'missing' } });
    const app = new Hono();
    mountBoardApi(app, { paths: buildPaths(bp.root) });
    const put = (phone: string) => app.request('/api/v1/settings', { method: 'PUT', body: JSON.stringify({ phone }), headers: { 'content-type': 'application/json' } });
    expect((await put('iphone')).status).toBe(200);
    expect(readMeta(bp).phone).toBe('iphone');
    expect(tools.phoneSystem(bp, 'pictures')).toBe('ios');
    expect((await put('android')).status).toBe(200);
    expect(tools.phoneSystem(bp, 'start-app')).toBe('android');
    expect((await put('auto')).status).toBe(200);
    expect(readMeta(bp).phone).toBeUndefined();
    expect((await put('pixel')).status).toBe(400);
    // The other computer is not a Mac: Android, whatever the setting.
    writeMeta(bp, { ...readMeta(bp), phone: 'iphone' });
    found({}, 'linux');
    expect(tools.phoneSystem(bp, 'pictures')).toBe('android');
  });

  it("Start and the Tools page follow the choice: the phone's own word, and the other phone's tools Optional", async () => {
    const bp = project(['ios', 'android']);
    found();
    expect(phoneStartPlan(bp, 'start-app')).toMatchObject({ system: 'ios', word: 'iPhone', ready: true });
    let lines = (await tools.projectTools(bp)).lines;
    expect(lines.find((l) => l.id === 'android')).toMatchObject({ priority: 'optional', blocks: [] });
    expect(lines.find((l) => l.id === 'xcode')).toMatchObject({ priority: 'required' });
    writeMeta(bp, { ...readMeta(bp), phone: 'android' });
    expect(phoneStartPlan(bp, 'start-app')).toMatchObject({ system: 'android', word: 'Android phone', ready: false, link: '/tools#android' });
    lines = (await tools.projectTools(bp)).lines;
    expect(lines.find((l) => l.id === 'android')).toMatchObject({ priority: 'required', blocks: ['pictures', 'start-app', 'try-it'] });
    expect(lines.find((l) => l.id === 'xcode')).toMatchObject({ priority: 'optional', blocks: [] });
    expect(phoneApp(bp)).toMatchObject({ kind: 'flutter', system: 'android' });
  });
});

describe('Android builds', () => {
  let ran: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];

  /** A copy under git like a story's: a Flutter app with its android folder. */
  function flutterCopy(): string {
    const dir = path.join(tmp, 'copy');
    fs.mkdirSync(path.join(dir, 'android'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(dir, 'pubspec.lock'), 'packages: {}\n');
    fs.writeFileSync(path.join(dir, 'analysis_options.yaml'), 'include: package:flutter_lints/flutter.yaml\n');
    fs.writeFileSync(path.join(dir, 'android', 'gradlew'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '/build/\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'app');
    return dir;
  }

  /** A made-up build: Flutter's makes the APK and, like the real one, rewrites the lock and the analysis options. */
  const fake: BuildRun = async (cmd, args, o) => {
    ran.push({ cmd: path.basename(cmd), args, cwd: o.cwd, env: o.env });
    if (cmd === 'flutter') {
      fs.mkdirSync(path.join(o.cwd, 'build', 'app', 'outputs', 'flutter-apk'), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'), 'apk');
      fs.writeFileSync(path.join(o.cwd, 'pubspec.lock'), 'packages: { http: 1.2.0 }\n');
      fs.appendFileSync(path.join(o.cwd, 'analysis_options.yaml'), 'analyzer:\n  exclude: [build/**, android/**]\n');
      fs.writeFileSync(path.join(o.cwd, '.flutter-made'), 'x');
    }
    if (cmd === 'npx') {
      // Expo makes the folder, and changes the app's own scripts on the way.
      fs.mkdirSync(path.join(o.cwd, 'android', 'app'), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, 'android', 'gradlew'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(o.cwd, 'android', 'app', 'build.gradle'), 'apply plugin: "com.android.application"\n');
      fs.writeFileSync(path.join(o.cwd, 'package.json'), JSON.stringify({ dependencies: { expo: '54', 'react-native': '0.81' }, scripts: { android: 'expo run:android' } }));
    }
    if (args[0] === 'assembleRelease' || args[0] === 'assembleDebug') {
      const out = args[0] === 'assembleRelease' ? path.join(o.cwd, 'app', 'build', 'outputs', 'apk', 'release') : path.join(o.cwd, 'app', 'build', 'outputs', 'apk', 'debug');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, args[0] === 'assembleRelease' ? 'app-release.apk' : 'app-debug.apk'), 'apk');
      fs.writeFileSync(path.join(out, 'app-debug-androidTest.apk'), 'test');
    }
    return { ok: true, output: 'built' };
  };

  beforeEach(() => {
    ran = [];
    build.useBuildRun(fake);
  });

  it('a Flutter app: flutter build apk --debug, in squad-kit\'s one Gradle home, then Gradle\'s helper stopped', async () => {
    const dir = flutterCopy();
    const built = await build.buildForPhone(dir, 'flutter', { system: 'android', home });
    expect(built.app).toBe(path.join(dir, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'));
    expect(ran.map((r) => `${r.cmd} ${r.args.join(' ')}`)).toEqual(['flutter build apk --debug', 'gradlew --stop']);
    for (const r of ran) {
      expect(r.env.GRADLE_USER_HOME).toBe(path.join(home, 'caches', 'gradle'));
      expect(r.env['ORG_GRADLE_PROJECT_kotlin.compiler.execution.strategy']).toBe('in-process');
      expect(r.env.ANDROID_PREFS_ROOT).toBe(path.join(home, 'phones', 'android'));
      expect(r.env.ANDROID_USER_HOME).toBe(path.join(home, 'phones', 'android', '.android'));
    }
    expect(ran[1]!.cwd).toBe(path.join(dir, 'android'));
    expect(build.lastBuild(dir, 'android')?.app).toBe(built.app);
    // The iPhone's record is its own.
    expect(build.lastBuild(dir, 'ios')).toBeNull();
  });

  it("the build's changes to the story's own files go back: the story's diff stays the Builder's", async () => {
    const dir = flutterCopy();
    // The Builder's own change, before the build.
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() { print(1); }\n');
    await build.buildForPhone(dir, 'flutter', { system: 'android', home });
    expect(fs.readFileSync(path.join(dir, 'pubspec.lock'), 'utf8')).toBe('packages: {}\n');
    expect(fs.readFileSync(path.join(dir, 'analysis_options.yaml'), 'utf8')).toBe('include: package:flutter_lints/flutter.yaml\n');
    expect(fs.existsSync(path.join(dir, '.flutter-made'))).toBe(false);
    expect(git(dir, 'status', '--porcelain').trim()).toBe('M lib/main.dart');
    // The same code again: no new build.
    ran = [];
    await build.buildForPhone(dir, 'flutter', { system: 'android', home });
    expect(ran).toEqual([]);
  });

  it('React Native: its release build in android/, which carries the app; a native app: assembleDebug; no Gradle: says so', async () => {
    const rn = path.join(tmp, 'rn');
    fs.mkdirSync(path.join(rn, 'android'), { recursive: true });
    fs.writeFileSync(path.join(rn, 'android', 'gradlew'), '');
    fs.writeFileSync(path.join(rn, 'android', 'gradlew.bat'), '');
    expect(build.androidPlan(rn, 'react-native', 'darwin')?.steps).toEqual([{ cmd: path.join(rn, 'android', 'gradlew'), args: ['assembleRelease'], cwd: 'android', what: 'Gradle build (assembleRelease) for the Android phone' }]);
    expect(build.androidPlan(rn, 'react-native', 'win32')?.steps[0]!.cmd).toBe(path.join(rn, 'android', 'gradlew.bat'));
    const native = path.join(tmp, 'native');
    fs.mkdirSync(path.join(native, 'app'), { recursive: true });
    fs.writeFileSync(path.join(native, 'gradlew'), '');
    await build.buildForPhone(native, 'android', { system: 'android', home });
    expect(ran.map((r) => `${r.cmd} ${r.args.join(' ')}`)).toEqual(['gradlew assembleDebug', 'gradlew --stop']);
    expect(build.lastBuild(native, 'android')?.app).toBe(path.join(native, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    const none = path.join(tmp, 'none');
    fs.mkdirSync(none, { recursive: true });
    await expect(build.buildForPhone(none, 'android', { system: 'android', home })).rejects.toThrow("squad-kit could not find the app's Android project in this story's copy.");
  });

  it('an Expo app with no android folder: Expo makes one for the build, hidden in this copy, kept out of every commit', async () => {
    const dir = path.join(tmp, 'expo');
    fs.mkdirSync(dir, { recursive: true });
    const pkg = JSON.stringify({ dependencies: { expo: '54', 'react-native': '0.81' }, scripts: { android: 'expo start --android' } });
    fs.writeFileSync(path.join(dir, 'package.json'), pkg);
    fs.writeFileSync(path.join(dir, 'App.js'), 'export default 1;\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'app');
    expect(build.needsPrebuild(dir, 'react-native', 'android')).toBe(true);
    await build.buildForPhone(dir, 'react-native', { system: 'android', home });
    expect(ran[0]).toMatchObject({ cmd: 'npx', args: ['expo', 'prebuild', '--platform', 'android', '--no-install'] });
    expect(ran[0]!.env.CI).toBe('1');
    expect(ran.slice(1).map((r) => `${r.cmd} ${r.args.join(' ')}`)).toEqual(['gradlew assembleRelease', 'gradlew --stop']);
    // Its own scripts go back; the made folder is squad-kit's, and git never sees it.
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(pkg);
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
    // Even when a story takes away the folder's own ignore file, no commit takes it.
    fs.rmSync(path.join(dir, 'android', '.gitignore'));
    stageAll(dir);
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('');
    // The next build makes nothing new by itself: Expo brings its folder up to date from the app's settings.
    fs.writeFileSync(path.join(dir, 'App.js'), 'export default 2;\n');
    ran = [];
    await build.buildForPhone(dir, 'react-native', { system: 'android', home });
    expect(ran[0]).toMatchObject({ cmd: 'npx', args: ['expo', 'prebuild', '--platform', 'android', '--no-install'] });
  });

  it('an Expo app with no ios folder gets its iPhone folder the same way, before CocoaPods and Xcode', () => {
    const dir = path.join(tmp, 'expo-ios');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '54' } }));
    expect(build.needsPrebuild(dir, 'react-native', 'ios')).toBe(true);
    expect(build.prebuildStep('ios')).toMatchObject({ cmd: 'npx', args: ['expo', 'prebuild', '--platform', 'ios', '--no-install'] });
    fs.mkdirSync(path.join(dir, 'ios'));
    expect(build.needsPrebuild(dir, 'react-native', 'ios')).toBe(false);
  });
});

describe("squad-kit's Android devices beside its iPhone", () => {
  it('making the Android phone keeps the saved iPhone, and each phone uses only its own', async () => {
    const iphone = await ownDevice(h.ios!.module, 'phone');
    const pixel = await ownDevice(h.android!.module, 'phone');
    expect(pixel).toMatchObject({ phone: 'fake-android', id: 'squad-kit-android-phone', name: 'squad-kit Android phone', model: 'Pixel 9', runtime: '16' });
    expect(savedDevices().map((d) => d.id)).toEqual([iphone.id, pixel.id]);
    expect(savedDevices(undefined, h.android!.module).map((d) => d.id)).toEqual([pixel.id]);
    expect((await ownDevice(h.android!.module, 'phone')).id).toBe(pixel.id);
    expect((await ownDevice(h.ios!.module, 'phone')).id).toBe(iphone.id);
  });

  it('one phone at a time across both: the iPhone shuts down before the Android phone starts', async () => {
    await desk.withPhone(h.ios!.module, 'phone', async () => undefined);
    const iphone = savedDevices()[0]!;
    expect(h.ios!.devices.find((d) => d.id === iphone.id)!.state).toBe('booted');
    const lines: string[] = [];
    await desk.withPhone(h.android!.module, 'phone', async (turn) => {
      expect(turn.device.model).toBe('Pixel 9');
      expect(turn.fresh).toBe(true);
    }, { say: (t) => lines.push(t) });
    expect(h.ios!.calls).toContain(`shutdown ${iphone.id}`);
    expect(h.ios!.devices.find((d) => d.id === iphone.id)!.state).toBe('shutdown');
    expect(lines).toEqual(["Starting squad-kit's Android phone, about 40 seconds"]);
  });

  it('squad phone shows both, with each system; Stop shuts them down, iPhone and Android', async () => {
    await desk.withPhone(h.android!.module, 'phone', async () => undefined);
    const v = await phoneView();
    expect(v.devices.map((d) => `${d.name} ${d.model} ${d.system} ${d.runtime} ${d.state}`)).toEqual(['squad-kit Android phone Pixel 9 Android 16 booted']);
    expect(Object.keys(v.timesBy)).toEqual(['Android phone']);
    expect(v.timesBy['Android phone']!.boot).toBeGreaterThan(0);
    const r = await stopPhoneNow();
    expect(r.message).toBe("squad-kit shut down its Android phone.");
    expect(h.android!.calls).toContain('shutdown squad-kit-android-phone');
    // With its phones down, what the phone started beside them ends too: its own adb server, when it started one.
    expect(h.android!.calls.indexOf('release')).toBeGreaterThan(h.android!.calls.indexOf('shutdown squad-kit-android-phone'));
  });

  it('the idle shutdown ends the phone and then what it started beside it', async () => {
    await desk.withPhone(h.android!.module, 'phone', async () => undefined);
    const down = await desk.idleNow(h.android!.module, Date.now() + desk.IDLE_MS + 1000);
    expect(down).toEqual(['squad-kit-android-phone']);
    expect(h.android!.calls.slice(-2)).toEqual(['shutdown squad-kit-android-phone', 'release']);
  });
});

describe('the board stops', () => {
  it("squad-kit's phones shut down even mid-picture, iPhone and Android, then what they started beside them", async () => {
    await desk.withPhone(h.ios!.module, 'phone', async () => undefined);
    const iphone = savedDevices()[0]!.id;
    let release!: () => void;
    // A story's pictures on the Android phone, cut off by the stop.
    const pictures = desk.withPhone(h.android!.module, 'phone', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    expect(desk.phoneInUse()).toBe(true);
    await phonesQuit();
    expect(h.android!.calls.slice(-2)).toEqual(['shutdown squad-kit-android-phone', 'release']);
    expect(h.android!.devices[0]!.state).toBe('shutdown');
    expect(h.ios!.devices.find((d) => d.id === iphone)!.state).toBe('shutdown');
    release();
    await pictures;
  });

  it('a phone that does not answer never keeps squad-kit from ending: the stop gives up after its time', async () => {
    await desk.withPhone(h.android!.module, 'phone', async () => undefined);
    h.android!.module.shutdown = () => new Promise(() => undefined);
    const t0 = Date.now();
    await phonesQuit(100);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("squad phone start brings the Android phone up hidden, with the word for it", async () => {
    const r = await startPhoneNow('android');
    expect(r.message).toBe("squad-kit's Android phone is up, hidden, ready for the pictures. It shuts down by itself when it has been unused for 10 minutes.");
    expect(h.android!.calls).toContain('boot squad-kit-android-phone');
    expect(h.android!.calls.some((c) => c.startsWith('window'))).toBe(false);
  });
});

describe('Start on the Android phone', () => {
  const madeApk: BuildRun = async (_cmd, _args, o) => {
    fs.mkdirSync(path.join(o.cwd, 'build', 'app', 'outputs', 'flutter-apk'), { recursive: true });
    fs.writeFileSync(path.join(o.cwd, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'), 'apk');
    return { ok: true, output: '' };
  };

  it("opens the window first (the emulator starts again for it), then puts the app on and opens it in the language", async () => {
    build.useBuildRun(madeApk);
    const dir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(dir, 'android'), { recursive: true });
    // A story's pictures had started the phone, hidden.
    await desk.withPhone(h.android!.module, 'phone', async () => undefined);
    h.android!.calls.length = 0;
    const open = new PhoneOpen({ dir, kind: 'flutter', system: 'android', by: 'Your apps', again: 'Start', language: 'ar', yieldAfterMs: 60_000, watchMs: 60_000 });
    await open.settled;
    expect(open.view()).toMatchObject({ state: 'running', device: 'Pixel 9', language: 'ar' });
    expect(h.android!.calls).toEqual([
      'window squad-kit-android-phone',
      'install squad-kit-android-phone ' + path.join(dir, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'),
      'terminate squad-kit-android-phone dev.test.app',
      'launch squad-kit-android-phone dev.test.app ar',
    ]);
    await open.stop();
    expect(h.android!.calls).toContain('shutdown squad-kit-android-phone');
  });

  it('a phone that is down starts once, with its window: never hidden first', async () => {
    build.useBuildRun(madeApk);
    const dir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(dir, 'android'), { recursive: true });
    const open = new PhoneOpen({ dir, kind: 'flutter', system: 'android', by: 'Try it yourself', again: 'Try it yourself', yieldAfterMs: 60_000, watchMs: 60_000 });
    await open.settled;
    expect(open.view().state).toBe('running');
    expect(h.android!.calls.filter((c) => c.startsWith('boot') || c.startsWith('window'))).toEqual(['window squad-kit-android-phone']);
    await open.stop();
  });
});
