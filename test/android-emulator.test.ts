import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { androidEmulatorWith, avdName, badgingOf, imagesIn, launcherOf, localeTag, schemesOf, type AndroidHost, type AndroidRun, type AndroidSpawn } from '../src/modules/android-emulator/index.js';
import type { PhoneModule } from '../src/modules/phone/types.js';

/**
 * Google's Android emulator behind squad-kit's phone interface, with a made-up adb, emulator and computer: squad-kit's
 * own devices are made with avdmanager in its own folder and used again by name, started hidden on a fixed port (the
 * first start cold, saving a snapshot; the next ones from it), restarted with a window for a person, given the app,
 * opened in a language on every launch, pictured by adb, and shut down by their serial only. Nothing real runs.
 */

let tmp: string;
let sdk: string;
let home: string;
let calls: string[];
/** The emulators the made-up computer runs, by process number, with the serial each answers on. */
let procs: Map<number, { serial: string; args: string[]; env: NodeJS.ProcessEnv }>;
let envs: { file: string; env: NodeJS.ProcessEnv }[];
let taken: Set<number>;
let api: number;
let killed: string[];
let nextPid: number;
/** The adb server listening on 5037 now, if any: squad-kit's or the person's. */
let adbServer: { pid: number; command: string } | null;
/** A kill-server that the server ignores. */
let stubborn: boolean;

const avdHome = () => path.join(home, '.android', 'avd');

/** An SDK with what squad-kit's phone needs, as files only. */
function makeSdk(): void {
  for (const f of ['platform-tools/adb', 'emulator/emulator', 'cmdline-tools/latest/bin/avdmanager', 'build-tools/36.0.0/aapt2']) {
    fs.mkdirSync(path.dirname(path.join(sdk, f)), { recursive: true });
    fs.writeFileSync(path.join(sdk, f), '');
  }
  fs.mkdirSync(path.join(sdk, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
}

const serialOf = (args: string[]) => (args[0] === '-s' ? args[1]! : '');
const running = (serial: string) => [...procs.values()].some((p) => p.serial === serial);

const run: AndroidRun = async (file, args, o) => {
  const tool = path.basename(file);
  calls.push(`${tool} ${args.join(' ')}`);
  envs.push({ file: tool, env: o.env });
  if (tool === 'avdmanager') {
    const name = args[args.indexOf('-n') + 1]!;
    fs.mkdirSync(path.join(avdHome(), `${name}.avd`), { recursive: true });
    fs.writeFileSync(path.join(avdHome(), `${name}.ini`), `path=${path.join(avdHome(), `${name}.avd`)}\n`);
    fs.writeFileSync(path.join(avdHome(), `${name}.avd`, 'config.ini'), `image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n`);
    return { ok: o.input === 'no\n', out: '', err: '' };
  }
  if (tool === 'aapt2') {
    if (args[1] === 'badging') return { ok: true, out: "package: name='dev.test.app' versionCode='1'\nlaunchable-activity: name='dev.test.app.MainActivity'  label='App'\n", err: '' };
    return { ok: true, out: '      E: data (line=30)\n        A: android:scheme(0x01010027)="testapp" (Raw: "testapp")\n        A: android:scheme(0x01010027)="https" (Raw: "https")\n', err: '' };
  }
  if (tool === 'adb' && args[0] === 'start-server') {
    adbServer ??= { pid: 6000, command: 'adb -L tcp:5037 fork-server server --reply-fd 4' };
    return { ok: true, out: '* daemon started successfully\n', err: '' };
  }
  if (tool === 'adb' && args[0] === 'kill-server') {
    if (!stubborn) adbServer = null;
    return { ok: true, out: '', err: '' };
  }
  const serial = serialOf(args);
  const rest = args.slice(2).join(' ');
  if (!running(serial)) return { ok: false, out: '', err: `device '${serial}' not found` };
  if (rest === 'shell getprop sys.boot_completed') return { ok: true, out: '1\n', err: '' };
  if (rest === 'shell getprop ro.build.version.sdk') return { ok: true, out: `${api}\n`, err: '' };
  if (rest === 'emu kill') {
    for (const [pid, p] of procs) if (p.serial === serial) procs.delete(pid);
    return { ok: true, out: 'OK: killing emulator, bye bye\n', err: '' };
  }
  if (rest.startsWith('emu avd snapshot save')) {
    const name = [...procs.values()].find((p) => p.serial === serial)!.args[1]!;
    fs.mkdirSync(path.join(avdHome(), `${name}.avd`, 'snapshots', 'squad-kit-ready'), { recursive: true });
    return { ok: true, out: 'OK\n', err: '' };
  }
  if (rest.startsWith('shell cmd package resolve-activity')) return { ok: true, out: 'priority=0 preferredOrder=0 match=0x108000\ndev.test.app/.MainActivity\n', err: '' };
  if (rest === 'exec-out screencap -p') return { ok: true, out: '', err: '', bytes: Buffer.from('PNG-bytes') };
  if (rest === 'shell getprop persist.sys.locale') return { ok: true, out: 'en-US\n', err: '' };
  if (rest === 'shell pidof system_server') return { ok: true, out: `${calls.filter((c) => c.includes('ctl.restart')).length + 100}\n`, err: '' };
  return { ok: true, out: rest.startsWith('shell am start') ? 'Status: ok\nLaunchState: COLD\n' : '', err: '' };
};

const spawn: AndroidSpawn = (file, args, o) => {
  const pid = nextPid++;
  calls.push(`emulator ${args.join(' ')}`);
  procs.set(pid, { serial: `emulator-${args[args.indexOf('-port') + 1]}`, args, env: o.env });
  return pid;
};

const host: AndroidHost = {
  alive: (pid) => procs.has(pid) || pid === adbServer?.pid,
  isEmulator: (pid) => procs.has(pid),
  kill: (pid, signal) => {
    killed.push(`${pid} ${signal}`);
    procs.delete(pid);
    if (pid === adbServer?.pid) adbServer = null;
  },
  portFree: async (port) => (port === 5037 ? !adbServer : !taken.has(port)),
  listener: async (port) => (port === 5037 ? (adbServer?.pid ?? null) : null),
  commandOf: (pid) => (pid === adbServer?.pid ? adbServer.command : procs.has(pid) ? 'qemu-system-aarch64-headless' : null),
  sleep: async () => undefined,
};

function phone(): PhoneModule {
  const p = androidEmulatorWith({ run, spawn, host, platform: 'darwin', arch: 'arm64' });
  p.useTools!({ sdk, home, java: '/java/21' });
  return p;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-android-')));
  sdk = path.join(tmp, 'sdk');
  home = path.join(tmp, 'home', 'phones', 'android');
  calls = [];
  envs = [];
  procs = new Map();
  taken = new Set();
  killed = [];
  adbServer = null;
  stubborn = false;
  api = 36;
  nextPid = 7000;
  makeSdk();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("squad-kit's own Android devices", () => {
  it('are made with avdmanager in its own folder, named for squad-kit, and used again by name', async () => {
    const p = phone();
    expect(avdName('squad-kit Android phone')).toBe('squad-kit-android-phone');
    const [image] = await p.runtimes();
    expect(image).toMatchObject({ id: 'system-images;android-36;google_apis;arm64-v8a', version: '16' });
    const id = await p.create('squad-kit Android phone', 'pixel_9', image!.id);
    expect(id).toBe('squad-kit-android-phone');
    expect(calls).toEqual(['avdmanager create avd -n squad-kit-android-phone -k system-images;android-36;google_apis;arm64-v8a -d pixel_9']);
    // Again: the one in squad-kit's own folder is used, with no second avdmanager.
    expect(await p.create('squad-kit Android phone', 'pixel_9', image!.id)).toBe(id);
    expect(calls).toHaveLength(1);
    expect(await p.devices()).toEqual([{ id, name: id, state: 'shutdown', runtime: 'system-images;android-36;google_apis;arm64-v8a' }]);
    // avdmanager runs with squad-kit's folders, never the person's ~/.android, and with Java.
    const env = envs[0]!.env;
    expect(env).toMatchObject({ ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_PREFS_ROOT: home, ANDROID_USER_HOME: path.join(home, '.android'), ANDROID_AVD_HOME: avdHome(), JAVA_HOME: '/java/21' });
  });

  it("lists only its own devices, from its own folder: the person's own emulators never show", async () => {
    const p = phone();
    fs.mkdirSync(avdHome(), { recursive: true });
    fs.writeFileSync(path.join(avdHome(), 'Pixel_7_API_34.ini'), 'path=x\n');
    expect(await p.devices()).toEqual([]);
    await expect(p.boot('Pixel_7_API_34')).rejects.toThrow("squad-kit only uses its own Android phone, by its exact name.");
    await expect(p.shutdown('emulator-5554')).rejects.toThrow('by its exact name');
    expect(calls).toEqual([]);
  });

  it('the image fits the chip: Arm on Apple, x86_64 on Intel and AMD, Google services first', () => {
    const list = (dir: string) => {
      const tree: Record<string, string[]> = {
        [path.join('/s', 'system-images')]: ['android-34', 'android-36', 'android-36-ext'],
        [path.join('/s', 'system-images', 'android-36')]: ['default', 'google_apis'],
        [path.join('/s', 'system-images', 'android-36', 'default')]: ['arm64-v8a', 'x86_64'],
        [path.join('/s', 'system-images', 'android-36', 'google_apis')]: ['arm64-v8a'],
        [path.join('/s', 'system-images', 'android-34')]: ['google_apis_playstore'],
        [path.join('/s', 'system-images', 'android-34', 'google_apis_playstore')]: ['x86_64'],
      };
      return tree[dir] ?? [];
    };
    expect(imagesIn('/s', 'arm64', list).map((r) => r.id)).toEqual(['system-images;android-36;google_apis;arm64-v8a', 'system-images;android-36;default;arm64-v8a']);
    expect(imagesIn('/s', 'x64', list).map((r) => r.id)).toEqual(['system-images;android-36;default;x86_64', 'system-images;android-34;google_apis_playstore;x86_64']);
  });
});

describe('starting and stopping', () => {
  it('the first start is cold and hidden on its fixed port, and saves the snapshot; the next start loads it', async () => {
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    const first = calls.find((c) => c.startsWith('emulator'))!;
    expect(first).toBe('emulator -avd squad-kit-android-phone -port 5560 -no-window -no-audio -no-boot-anim -no-metrics -no-snapshot-save -no-snapshot-load');
    expect(calls).toContain('adb -s emulator-5560 emu avd snapshot save squad-kit-ready');
    expect(p.tapId!(id)).toBe('emulator-5560');
    expect((await p.devices())[0]!.state).toBe('booted');
    // The emulator and adb get squad-kit's folder as their home: their keys and caches stay out of ~/.android.
    expect(procs.get(7000)!.env.HOME).toBe(home);
    expect(envs.find((e) => e.file === 'adb')!.env.HOME).toBe(home);
    await p.shutdown(id);
    expect(calls).toContain('adb -s emulator-5560 emu kill');
    expect(procs.size).toBe(0);
    calls = [];
    await p.boot(id);
    expect(calls[0]).toBe('emulator -avd squad-kit-android-phone -port 5560 -no-window -no-audio -no-boot-anim -no-metrics -no-snapshot-save -snapshot squad-kit-ready');
    expect(calls).not.toContain('adb -s emulator-5560 emu avd snapshot save squad-kit-ready');
  });

  it('a port in use takes the next free pair, so its serial is known all the same', async () => {
    taken.add(5560);
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    expect(p.tapId!(id)).toBe('emulator-5554');
    const tablet = await p.create('squad-kit Android tablet', 'pixel_tablet', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(tablet);
    expect(p.tapId!(tablet)).toBe('emulator-5562');
  });

  it('Start and Try it yourself: a hidden phone starts again from the snapshot with its window, and closing it is seen', async () => {
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    expect(await p.windowShows(id)).toBe(false);
    calls = [];
    await p.openWindow(id);
    expect(calls[0]).toBe('adb -s emulator-5560 emu kill');
    expect(calls[1]).toBe('emulator -avd squad-kit-android-phone -port 5560 -no-audio -no-boot-anim -no-metrics -no-snapshot-save -snapshot squad-kit-ready');
    expect(await p.windowShows(id)).toBe(true);
    // Already open with its window: nothing starts again.
    calls = [];
    await p.openWindow(id);
    expect(calls.filter((c) => c.startsWith('emulator'))).toEqual([]);
    // The person closes the window: the emulator ends, and squad-kit sees it.
    procs.clear();
    expect(await p.windowShows(id)).toBe(false);
    expect((await p.devices())[0]!.state).toBe('shutdown');
  });

  it("shutting down touches only its own serial and its own process, and never another emulator's", async () => {
    const p = phone();
    // Somebody else's emulator runs on this computer.
    procs.set(42, { serial: 'emulator-5554', args: ['-avd', 'Pixel_7'], env: {} });
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    taken.add(5554);
    await p.boot(id);
    await p.shutdown(id);
    expect(calls.filter((c) => c.includes('emu kill'))).toEqual(['adb -s emulator-5560 emu kill']);
    expect(procs.has(42)).toBe(true);
    expect(killed).toEqual([]);
  });

  it("an emulator that does not end after emu kill: only its own process is stopped, by its number", async () => {
    const p = androidEmulatorWith({
      run: async (file, args, o) => (args.join(' ').endsWith('emu kill') ? { ok: true, out: '', err: '' } : run(file, args, o)),
      spawn,
      host,
      platform: 'darwin',
      arch: 'arm64',
    });
    p.useTools!({ sdk, home });
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    procs.set(42, { serial: 'emulator-5554', args: [], env: {} });
    taken.add(5554);
    await p.boot(id);
    await p.shutdown(id);
    expect(killed).toEqual(['7000 SIGTERM']);
    expect(procs.has(42)).toBe(true);
  });
});

describe('shutting down when the console says no', () => {
  it("a refused console (KO) goes straight to the emulator's own exact process, never another's", async () => {
    let slept = 0;
    const p = androidEmulatorWith({
      run: async (file, args, o) => (args.join(' ').endsWith('emu kill') ? { ok: true, out: 'KO: authentication token does not match ~/.emulator_console_auth_token\n', err: '' } : run(file, args, o)),
      spawn,
      host: { ...host, sleep: async () => void (slept += 1) },
      platform: 'darwin',
      arch: 'arm64',
    });
    p.useTools!({ sdk, home });
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    procs.set(42, { serial: 'emulator-5554', args: [], env: {} });
    taken.add(5554);
    await p.boot(id);
    slept = 0;
    await p.shutdown(id);
    expect(killed).toEqual(['7000 SIGTERM']);
    expect(slept).toBe(0);
    expect(procs.has(42)).toBe(true);
    // The emulator's token lives in squad-kit's folder: adb asked with that same HOME.
    expect(envs.filter((e) => e.file === 'adb').every((e) => e.env.HOME === home)).toBe(true);
  });
});

describe("adb's server", () => {
  const record = () => path.join(home, 'adb-server.json');
  async function upAndDown(p: PhoneModule): Promise<string> {
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    return id;
  }

  it('none runs: squad-kit starts its own with its own keys, writes down its number, and stops it once its phones are down', async () => {
    const p = phone();
    const id = await upAndDown(p);
    expect(calls).toContain('adb start-server');
    expect(envs.find((e) => e.file === 'adb')!.env.HOME).toBe(home);
    expect(JSON.parse(fs.readFileSync(record(), 'utf8'))).toMatchObject({ pid: 6000, port: 5037 });
    // While its phone runs, the server stays.
    await p.release!();
    expect(calls).not.toContain('adb kill-server');
    await p.shutdown(id);
    await p.release!();
    expect(calls.filter((c) => c === 'adb kill-server')).toHaveLength(1);
    expect(envs.filter((e) => e.file === 'adb').at(-1)!.env.HOME).toBe(home);
    expect(adbServer).toBeNull();
    expect(fs.existsSync(record())).toBe(false);
    expect(killed).toEqual([]);
  });

  it("the person's own adb server, running before, is used as it is and never stopped", async () => {
    adbServer = { pid: 555, command: '/Users/pm/Library/Android/sdk/platform-tools/adb -L tcp:5037 fork-server server --reply-fd 4' };
    const p = phone();
    const id = await upAndDown(p);
    expect(calls).not.toContain('adb start-server');
    expect(fs.existsSync(record())).toBe(false);
    await p.shutdown(id);
    await p.release!();
    expect(calls).not.toContain('adb kill-server');
    expect(killed).toEqual([]);
    expect(adbServer).toEqual({ pid: 555, command: expect.stringContaining('adb') });
  });

  it('a number written down that is no longer its adb server is never signalled: another server on the port is left', async () => {
    const p = phone();
    const id = await upAndDown(p);
    await p.shutdown(id);
    // squad-kit's server ended by itself, and the person started their own since.
    adbServer = { pid: 8123, command: 'adb -L tcp:5037 fork-server server --reply-fd 4' };
    await p.release!();
    expect(calls).not.toContain('adb kill-server');
    expect(killed).toEqual([]);
    expect(fs.existsSync(record())).toBe(false);
    // And on the next start, the person's server is used as it is.
    calls = [];
    await p.boot(id);
    expect(calls).not.toContain('adb start-server');
  });

  it("a server of its own that ignores adb's own stop: only its exact process, checked to be adb, is stopped", async () => {
    stubborn = true;
    const p = phone();
    const id = await upAndDown(p);
    await p.shutdown(id);
    await p.release!();
    expect(calls).toContain('adb kill-server');
    expect(killed).toEqual(['6000 SIGTERM']);
  });
});

describe('the app on the phone', () => {
  it('reads the app it built: its id, the screen it opens on, its own link names', async () => {
    const p = phone();
    expect(await p.appInfo('/b/app-debug.apk')).toEqual({ appId: 'dev.test.app', schemes: ['testapp'] });
    expect(badgingOf("package: name='a.b'\n")).toEqual({ appId: 'a.b' });
    expect(schemesOf('A: android:scheme(0x01010027)="http" (Raw: "http")')).toEqual([]);
    expect(launcherOf('priority=0 preferredOrder=0\na.b/.MainActivity\n')).toBe('a.b/.MainActivity');
  });

  it('opens it fresh in a language on every launch, English too, with the per-app language of Android 13 and newer', async () => {
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    await p.appInfo('/b/app-debug.apk');
    calls = [];
    await p.launch(id, 'dev.test.app', { language: 'ar' });
    await p.launch(id, 'dev.test.app');
    expect(calls).toEqual([
      'adb -s emulator-5560 shell am force-stop dev.test.app',
      'adb -s emulator-5560 shell getprop ro.build.version.sdk',
      'adb -s emulator-5560 shell cmd locale set-app-locales dev.test.app --locales ar-SA',
      'adb -s emulator-5560 shell am start -W -n dev.test.app/dev.test.app.MainActivity',
      'adb -s emulator-5560 shell am force-stop dev.test.app',
      'adb -s emulator-5560 shell cmd locale set-app-locales dev.test.app --locales en-US',
      'adb -s emulator-5560 shell am start -W -n dev.test.app/dev.test.app.MainActivity',
    ]);
    expect(localeTag('fr')).toBe('fr-FR');
  });

  it('on Android 12 and older, the whole phone changes language: only when it is another one', async () => {
    api = 31;
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-31;google_apis;arm64-v8a');
    await p.boot(id);
    calls = [];
    await p.launch(id, 'dev.test.app', { language: 'ar' });
    expect(calls).toContain('adb -s emulator-5560 shell setprop persist.sys.locale ar-SA');
    expect(calls).toContain('adb -s emulator-5560 shell setprop ctl.restart zygote');
    expect(calls).not.toContain('adb -s emulator-5560 shell cmd locale set-app-locales dev.test.app --locales ar-SA');
    // With no build read before, the screen it opens on comes from the phone itself.
    expect(calls).toContain('adb -s emulator-5560 shell am start -W -n dev.test.app/.MainActivity');
    calls = [];
    await p.launch(id, 'dev.test.app', { language: 'en' });
    expect(calls.some((c) => c.includes('ctl.restart'))).toBe(false);
  });

  it('installs with adb install -r, takes the picture with screencap, and closes the app', async () => {
    const p = phone();
    const id = await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    await p.boot(id);
    calls = [];
    await p.install(id, '/b/app-debug.apk');
    expect((await p.screenshot(id)).toString()).toBe('PNG-bytes');
    await p.terminate(id, 'dev.test.app');
    expect(calls).toEqual(['adb -s emulator-5560 install -r -d /b/app-debug.apk', 'adb -s emulator-5560 exec-out screencap -p', 'adb -s emulator-5560 shell am force-stop dev.test.app']);
  });

  it('Maestro reaches it by its serial, with the same SDK and the same keys', async () => {
    const p = phone();
    // Every Android folder is squad-kit's: Maestro, and the avdmanager it runs (Java never reads HOME), see only its devices.
    // The person's own Android settings never pass through.
    process.env.ANDROID_SDK_HOME = '/Users/pm/.android-old';
    process.env.ANDROID_SERIAL = 'emulator-5554';
    expect(Object.keys(p.tapEnv!()).sort()).toEqual(['ANDROID_AVD_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_HOME', 'ANDROID_PREFS_ROOT', 'ANDROID_SDK_ROOT', 'ANDROID_USER_HOME', 'HOME', 'JAVA_HOME']);
    await p.create('squad-kit Android phone', 'pixel_9', 'system-images;android-36;google_apis;arm64-v8a');
    expect(envs[0]!.env.ANDROID_SDK_HOME).toBeUndefined();
    expect(envs[0]!.env.ANDROID_SERIAL).toBeUndefined();
    delete process.env.ANDROID_SDK_HOME;
    delete process.env.ANDROID_SERIAL;
    expect(p.tapEnv!()).toMatchObject({ ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, HOME: home, ANDROID_AVD_HOME: avdHome(), ANDROID_USER_HOME: path.join(home, '.android'), ANDROID_PREFS_ROOT: home, ANDROID_EMULATOR_HOME: path.join(home, '.android'), JAVA_HOME: '/java/21' });
    expect(p.notHere()).toBeNull();
    expect(androidEmulatorWith({ platform: 'linux', arch: 'arm64' }).notHere()).toBe("Google's Android emulator does not run on this kind of computer yet.");
    expect(androidEmulatorWith({ platform: 'win32', arch: 'x64' }).notHere()).toBeNull();
  });
});
