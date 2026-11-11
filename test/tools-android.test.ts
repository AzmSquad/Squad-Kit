import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { DetectHost } from '../src/engine/tools/detect.js';
import type { ToolSource } from '../src/engine/tools/get.js';
import type { ToolsView } from '../src/engine/tools/index.js';
import type { SdkSpawn } from '../src/engine/tools/android.js';

/**
 * Google's Android phone tools on the Tools page: the right files for each system, Google's license shown in full and
 * accepted only by the person (Get it refuses before), the free room looked at first, Java got before them and Maestro
 * with them, sdkmanager answered yes only to the accepted licenses, and a watchdog that stops a download that stalls,
 * tries once more, then says so. An SDK of the person's is used only when complete, and never changed. Nothing is
 * downloaded and no real sdkmanager runs.
 */

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { buildPaths } = await import('../src/core/paths.js');
const { zip } = await import('../src/core/zip.js');
const { mountToolsApi } = await import('../src/console/api/tools.js');
const { toolsWith } = await import('../src/commands/tools.js');
const tools = await import('../src/engine/tools/index.js');
const android = await import('../src/engine/tools/android.js');
const { detectAll, writeFound } = await import('../src/engine/tools/detect.js');
const { getTool, gettingNow, setTrouble } = await import('../src/engine/tools/get.js');

let tmp: string;
let home: string;
let bp: ReturnType<typeof boardPaths>;

/** Google's two manifests, cut down to what squad-kit reads: packages on each channel, and the license texts. */
const pkg = (p: string, license: string, channel = 'channel-0') => `<remotePackage path="${p}"><uses-license ref="${license}"/><channelRef ref="${channel}"/></remotePackage>`;
const REPO = [
  '<channel id="channel-0">stable</channel><channel id="channel-2">dev</channel>',
  pkg('cmdline-tools;latest', 'android-sdk-license'),
  pkg('platform-tools', 'android-sdk-preview-license', 'channel-2'),
  pkg('platform-tools', 'android-sdk-license'),
  pkg('emulator', 'android-sdk-license'),
  pkg('platforms;android-36', 'android-sdk-license'),
  pkg('build-tools;36.0.0', 'android-sdk-license'),
  pkg('ndk;28.2.13676358', 'android-sdk-license'),
  '<license id="android-sdk-license" type="text">Terms and Conditions\n\nThis is the Android Software Development Kit License Agreement &amp; more.</license>',
  '<license id="android-sdk-preview-license" type="text">Preview terms</license>',
].join('\n');
const IMAGES = [
  '<channel id="channel-0">stable</channel>',
  pkg('system-images;android-36;google_apis;arm64-v8a', 'android-sdk-arm-dbt-license'),
  pkg('system-images;android-36;google_apis;x86_64', 'android-sdk-license'),
  '<license id="android-sdk-license" type="text">Terms and Conditions\n\nThis is the Android Software Development Kit License Agreement &amp; more.</license>',
  '<license id="android-sdk-arm-dbt-license" type="text">Terms and Conditions\n\n4.7 Arm instruction-set code.</license>',
].join('\n');

let fetched: string[];
const googleSite = (async (url: string) => {
  fetched.push(String(url));
  const text = String(url).includes('sys-img') ? IMAGES : REPO;
  return new Response(text, { status: 200 });
}) as unknown as typeof fetch;
const offline = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;

function app(o: { free?: number | null; source?: (id: string) => Promise<ToolSource>; fetch?: typeof fetch } = {}) {
  const a = new Hono();
  mountToolsApi(a, { paths: buildPaths(bp.root), fetch: o.fetch ?? googleSite, ...(o.free !== undefined ? { free: o.free } : {}), ...(o.source ? { source: o.source as never } : {}) });
  return a;
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const post = (a: Hono, p: string, body?: unknown) => a.request(`/api/v1${p}`, { method: 'POST', ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

async function untilDone(): Promise<void> {
  for (let i = 0; i < 400 && gettingNow(); i += 1) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-android-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
  fetched = [];
  const root = path.join(tmp, 'app');
  fs.mkdirSync(path.join(root, 'android'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live' });
  writeFound({ at: new Date().toISOString(), system: 'mac', tools: { flutter: { state: 'found', version: '3.47.9' }, java: { state: 'missing' }, maestro: { state: 'missing' }, android: { state: 'missing' } } }, home);
  tools.useDetectHost(null);
});
afterEach(async () => {
  await untilDone();
  for (const id of ['android', 'java', 'maestro'] as const) setTrouble(id);
  android.useSdkSpawn(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the right files for each computer', () => {
  it('a Mac with Apple chip, an Intel Mac, Windows and Linux each get their own zip and system image', () => {
    expect(android.androidPick('mac', 'arm64')).toMatchObject({ tools: { file: 'commandlinetools-mac_arm64-15859902_latest.zip', sha256: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e' }, image: 'system-images;android-36;google_apis;arm64-v8a' });
    expect(android.androidPick('mac', 'x64')).toMatchObject({ tools: { file: 'commandlinetools-mac_x86_64-15859902_latest.zip', sha1: '1a79e61677b99cb0ce622792713cbea7ff2dc5de' }, image: 'system-images;android-36;google_apis;x86_64' });
    expect(android.androidPick('windows', 'x64')).toMatchObject({ tools: { file: 'commandlinetools-win-15859902_latest.zip' }, image: 'system-images;android-36;google_apis;x86_64' });
    expect(android.androidPick('linux', 'x64')).toMatchObject({ tools: { file: 'commandlinetools-linux-15859902_latest.zip' }, image: 'system-images;android-36;google_apis;x86_64' });
    // Google's emulator doesn't run on Windows or Linux computers with an Arm chip.
    expect(android.androidPick('linux', 'arm64')).toBeNull();
    expect(android.androidPick('windows', 'arm64')).toBeNull();
    const mac = android.androidPick('mac', 'arm64')!;
    expect(mac.packages).toEqual(['platform-tools', 'emulator', 'platforms;android-36', 'build-tools;36.0.0', 'ndk;28.2.13676358', 'system-images;android-36;google_apis;arm64-v8a']);
    // About 3.6 GB to download on this Mac, as the spike measured.
    expect(Math.round(android.pickBytes(mac) / 1e8) / 10).toBe(3.6);
  });
});

describe("Google's license", () => {
  it('is read in full from the stable packages of the manifests: two licenses on an Arm Mac, one on Intel', () => {
    const arm = android.licensesIn([REPO, IMAGES], ['cmdline-tools;latest', ...android.androidPick('mac', 'arm64')!.packages]);
    expect(arm.map((l) => l.id)).toEqual(['android-sdk-license', 'android-sdk-arm-dbt-license']);
    expect(arm[0]!.text).toBe('Terms and Conditions\n\nThis is the Android Software Development Kit License Agreement & more.');
    const intel = android.licensesIn([REPO, IMAGES], ['cmdline-tools;latest', ...android.androidPick('mac', 'x64')!.packages]);
    expect(intel.map((l) => l.id)).toEqual(['android-sdk-license']);
  });

  it('Get it is refused until the person accepts it; Accept needs every license shown; squad-kit never accepts by itself', async () => {
    const a = app();
    const line = (v: ToolsView) => v.lines.find((l) => l.id === 'android')!;
    const page = await json<ToolsView>(await a.request('/api/v1/tools'));
    expect(line(page)).toMatchObject({ name: 'Android phone tools', state: 'missing', installer: 'squad-kit', priority: 'required', license: { accepted: false, command: 'squad tools accept android' }, size: 'about 20 GB', seconds: 720, command: 'squad tools get android' });
    const refused = await post(a, '/tools/android/get');
    expect(refused.status).toBe(400);
    expect((await json<{ error: string }>(refused)).error).toBe("Google's license for the Android phone tools needs your Accept first. Read it on the Tools page and press Accept, or run: squad tools accept android");
    expect(fs.existsSync(path.join(home, 'tools', 'android-accepted.json'))).toBe(false);
    // The license, in full, from Google's own site.
    const lic = await json<{ licenses: { id: string; text: string }[]; accepted: boolean }>(await a.request('/api/v1/tools/android/license'));
    expect(lic.licenses.map((l) => l.id)).toEqual(process.arch === 'arm64' ? ['android-sdk-license', 'android-sdk-arm-dbt-license'] : ['android-sdk-license']);
    expect(lic.accepted).toBe(false);
    expect(fetched).toEqual(['https://dl.google.com/android/repository/repository2-3.xml', 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml']);
    // Half an Accept is no Accept.
    const half = await post(a, '/tools/android/accept', { licenses: process.arch === 'arm64' ? ['android-sdk-license'] : [] });
    expect(half.status).toBe(400);
    const ok = await post(a, '/tools/android/accept', { licenses: lic.licenses.map((l) => l.id) });
    expect(ok.status).toBe(200);
    expect(line(await json<ToolsView>(ok)).license).toEqual({ accepted: true, command: 'squad tools accept android' });
    const kept = JSON.parse(fs.readFileSync(path.join(home, 'tools', 'android-accepted.json'), 'utf8')) as { licenses: { id: string; sha256: string }[] };
    expect(kept.licenses[0]).toEqual({ id: 'android-sdk-license', sha256: createHash('sha256').update(lic.licenses[0]!.text).digest('hex') });
  });

  it("offline, the texts read last time from Google's site are shown; never read, it says so plainly", async () => {
    await expect(tools.toolLicense('android', { fetch: offline })).rejects.toThrow("squad-kit could not reach Google's site to show the license. Check the internet connection, then try again.");
    await tools.toolLicense('android', { fetch: googleSite });
    expect((await tools.toolLicense('android', { fetch: offline })).licenses[0]!.id).toBe('android-sdk-license');
  });

  it('in the terminal: the license printed in full, then a yes or no of the person', async () => {
    const said: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (said.push(String(s)), true)) as typeof process.stdout.write;
    try {
      // The terminal reads Google's site itself: this test gives it the made-up one through the kept texts.
      await tools.toolLicense('android', { fetch: googleSite });
      const realFetch = globalThis.fetch;
      globalThis.fetch = offline;
      try {
        expect(await toolsWith(bp, null, 'accept', 'android', { ask: async () => false })).toBe(true);
        expect(android.androidAccepted(home)).toBeNull();
        expect(await toolsWith(bp, null, 'accept', 'android', { ask: async () => true })).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      process.stdout.write = write;
    }
    expect(said.join('')).toContain('License android-sdk-license:');
    expect(said.join('')).toContain('This is the Android Software Development Kit License Agreement & more.');
    expect(android.androidAccepted(home)?.licenses.length).toBeGreaterThan(0);
  });
});

describe('Get it', () => {
  async function accepted(): Promise<void> {
    const v = await tools.toolLicense('android', { fetch: googleSite });
    await tools.acceptToolNow('android', v.licenses.map((l) => l.id), { fetch: googleSite });
  }

  it('looks at the free room first and says it plainly, getting nothing', async () => {
    await accepted();
    const r = await post(app({ free: 12 * 1000 ** 3 }), '/tools/android/get');
    expect(r.status).toBe(400);
    expect((await json<{ error: string }>(r)).error).toBe('The Android phone tools need about 20 GB free on this computer, and it has 12 GB free. Make room, then press Get it again.');
    expect(gettingNow()).toBeNull();
  });

  it('gets Java first (its tools run on it), then the Android tools, then Maestro, one at a time', async () => {
    await accepted();
    const asked: string[] = [];
    const data = zip([{ name: 'x/bin/tool', data: '#!/bin/sh\n' }]);
    async function* body(): AsyncIterable<Uint8Array> {
      yield data;
    }
    const source = async (id: string): Promise<ToolSource> => {
      asked.push(id);
      return {
        version: id === 'android' ? '36' : '1.0',
        file: `${id}.zip`,
        pack: 'zip',
        algorithm: 'sha1',
        sha256: async () => createHash('sha1').update(data).digest('hex'),
        open: async () => ({ body: body(), size: data.length }),
        binary: (dir) => path.join(dir, 'x', 'bin', 'tool'),
      };
    };
    const r = await post(app({ free: 50 * 1000 ** 3, source }), '/tools/android/get');
    expect(r.status).toBe(200);
    await untilDone();
    expect(asked).toEqual(['java', 'android', 'maestro']);
    // Checked by the checksum its source gives, here a SHA-1 as in Google's manifest, and marked ready last.
    expect(JSON.parse(fs.readFileSync(path.join(home, 'tools', 'android', '36', 'ready.json'), 'utf8'))).toMatchObject({ version: '36', sha1: createHash('sha1').update(data).digest('hex') });
  });

  it("a download with an install after it: the install runs in the unpacked folder before it is marked ready, and its progress counts on", async () => {
    const data = zip([{ name: 'cmdline-tools/bin/sdkmanager', data: '#!/bin/sh\n' }]);
    async function* body(): AsyncIterable<Uint8Array> {
      yield data;
    }
    const steps: string[] = [];
    const got = await getTool(
      'android',
      {
        version: '36',
        file: 'tools.zip',
        pack: 'zip',
        size: data.length + 1000,
        algorithm: 'sha1',
        sha256: async () => createHash('sha1').update(data).digest('hex'),
        open: async () => ({ body: body(), size: data.length }),
        async finish(dir, o) {
          expect(fs.existsSync(path.join(dir, 'cmdline-tools', 'bin', 'sdkmanager'))).toBe(true);
          fs.mkdirSync(path.join(dir, 'sdk', 'emulator'), { recursive: true });
          o.onProgress({ done: data.length + 1000, total: data.length + 1000 });
        },
        binary: (dir) => path.join(dir, 'cmdline-tools', 'bin', 'sdkmanager'),
      },
      { home, onProgress: (p) => steps.push(`${p.step} ${p.total}`) },
    );
    expect(fs.existsSync(path.join(got.dir, 'sdk', 'emulator'))).toBe(true);
    expect(steps).toContain(`download ${data.length + 1000}`);
    expect(steps).toContain(`install ${data.length + 1000}`);
  });
});

describe("Google's sdkmanager", () => {
  const pick = android.androidPick('mac', 'arm64')!;
  let sdk: string;
  let stops: number;
  let starts: number;

  /** A made-up sdkmanager: asks the given licenses, then installs (or stalls). */
  function sdkmanager(o: { asks: string[]; stall?: number }): SdkSpawn {
    return (_cmd, args, s) => {
      starts += 1;
      const me = starts;
      let answered: (v: number | null) => void = () => undefined;
      const done = new Promise<number | null>((r) => (answered = r));
      const queue = [...o.asks];
      let stopped = false;
      const next = () => {
        const id = queue.shift();
        if (id) return s.onOutput(`License ${id}:\n---\nterms\n---\nAccept? (y/N): `);
        if (o.stall && me <= o.stall) return;
        for (const p of args.slice(2)) {
          fs.mkdirSync(android.packageDir(sdk, p), { recursive: true });
          fs.writeFileSync(path.join(android.packageDir(sdk, p), 'package.xml'), '<x/>');
        }
        answered(0);
      };
      setTimeout(next, 1);
      return {
        pid: 9000 + me,
        answer: (text) => {
          s.onOutput(text);
          if (text === 'y\n') setTimeout(next, 1);
          else answered(1);
        },
        stop: () => {
          stops += 1;
          if (!stopped) answered(null);
          stopped = true;
        },
        done,
      };
    };
  }

  const opts = () => ({ sdk, sdkmanager: '/sdk/cmdline-tools/latest/bin/sdkmanager', pick, env: {}, signal: new AbortController().signal, onProgress: () => undefined, quietMs: 30, lookMs: 5, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) });

  beforeEach(() => {
    sdk = path.join(tmp, 'sdk');
    stops = 0;
    starts = 0;
  });

  it('is answered yes only to the licenses the person accepted, and installs every package', async () => {
    android.useSdkSpawn(sdkmanager({ asks: ['android-sdk-license', 'android-sdk-arm-dbt-license'] }));
    await android.installPackages({ ...opts(), accepted: ['android-sdk-license', 'android-sdk-arm-dbt-license'] });
    for (const p of pick.packages) expect(fs.existsSync(path.join(android.packageDir(sdk, p), 'package.xml'))).toBe(true);
  });

  it('a license nobody accepted is answered no, and nothing is installed', async () => {
    android.useSdkSpawn(sdkmanager({ asks: ['android-sdk-license', 'android-sdk-arm-dbt-license'] }));
    await expect(android.installPackages({ ...opts(), accepted: ['android-sdk-license'] })).rejects.toThrow("Google's tools asked about a license you have not accepted, so squad-kit said no and installed nothing.");
  });

  it('a download that gets no new bytes is stopped, by its own process, and tried once more', async () => {
    android.useSdkSpawn(sdkmanager({ asks: [], stall: 1 }));
    await android.installPackages({ ...opts(), accepted: ['android-sdk-license'] });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  });

  it('stalled twice, it says so plainly', async () => {
    android.useSdkSpawn(sdkmanager({ asks: [], stall: 2 }));
    await expect(android.installPackages({ ...opts(), accepted: ['android-sdk-license'] })).rejects.toThrow("Google's download of the Android phone tools stopped twice and did not go on. Check the internet connection, then press Get it again. Nothing was installed.");
    expect(starts).toBe(2);
    expect(stops).toBe(2);
  });
});

describe('finding the Android tools', () => {
  function host(o: { files?: string[]; dirs?: Record<string, string[]>; env?: NodeJS.ProcessEnv; system?: DetectHost['system']; arch?: string }): DetectHost {
    const files = new Set(o.files ?? []);
    return {
      system: o.system ?? 'mac',
      arch: o.arch ?? 'arm64',
      home: '/Users/pm',
      env: o.env ?? { PATH: '/nowhere' },
      run: async () => ({ ok: false, out: '', err: '' }),
      exists: (p) => files.has(p) || p in (o.dirs ?? {}),
      read: () => null,
      real: (p) => p,
      list: (dir) => o.dirs?.[dir] ?? [],
      writable: () => true,
    };
  }
  const complete = (sdk: string) => ({
    files: [`${sdk}/platform-tools/adb`, `${sdk}/emulator/emulator`, `${sdk}/cmdline-tools/latest/bin/avdmanager`, `${sdk}/build-tools/35.0.0/aapt2`],
    dirs: {
      [sdk]: ['platform-tools'],
      [`${sdk}/cmdline-tools`]: ['latest'],
      [`${sdk}/build-tools`]: ['35.0.0'],
      [`${sdk}/platforms`]: ['android-35'],
      [`${sdk}/system-images`]: ['android-35'],
      [`${sdk}/system-images/android-35`]: ['google_apis'],
      [`${sdk}/system-images/android-35/google_apis`]: ['arm64-v8a'],
    },
  });

  it("squad-kit's own, once ready", async () => {
    const dir = path.join(home, 'tools', 'android', '36');
    fs.mkdirSync(path.join(dir, 'sdk', 'cmdline-tools', 'latest', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), '');
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ version: '36', binary: 'sdk/cmdline-tools/latest/bin/sdkmanager' }));
    const book = await detectAll(host({}), home);
    expect(book.tools.android).toEqual({ state: 'found', version: 'Android 16', where: path.join(dir, 'sdk'), own: true });
  });

  it("an SDK of the person's with everything is used as it is; one that lacks something is left, and squad-kit gets its own", async () => {
    const sdk = '/Users/pm/Library/Android/sdk';
    const c = complete(sdk);
    expect((await detectAll(host(c), home)).tools.android).toEqual({ state: 'found', version: 'Android 15', where: sdk, note: `Your own Android SDK in ${sdk}: squad-kit uses it as it is, and never changes it.` });
    const lacking = host({ files: c.files.filter((f) => !f.endsWith('/emulator')), dirs: { ...c.dirs, [`${sdk}/system-images`]: [] } });
    expect((await detectAll(lacking, home)).tools.android).toEqual({ state: 'missing', note: `Your Android SDK in ${sdk} lacks the emulator and an Android 13 or newer phone system. squad-kit gets its own instead, and leaves yours as it is.` });
    // ANDROID_HOME first, on any system.
    const linux = complete('/opt/android');
    expect((await detectAll(host({ ...linux, system: 'linux', arch: 'x64', env: { PATH: '/x', ANDROID_HOME: '/opt/android' }, dirs: { ...linux.dirs, '/opt/android/system-images/android-35/google_apis': ['x86_64'] } }), home)).tools.android).toMatchObject({ state: 'found', where: '/opt/android' });
  });

  it("a build with the person's own SDK may not fetch anything into it; with squad-kit's own it may", () => {
    writeFound({ at: new Date().toISOString(), system: 'mac', tools: { android: { state: 'found', where: '/Users/pm/Library/Android/sdk' }, java: { state: 'found', version: '19.0.2', where: '/jdk/bin/java' } } }, home);
    expect(android.androidBuildEnv(home)).toMatchObject({ ANDROID_HOME: '/Users/pm/Library/Android/sdk', 'ORG_GRADLE_PROJECT_android.builder.sdkDownload': 'false', JAVA_HOME: '/jdk', GRADLE_USER_HOME: path.join(home, 'caches', 'gradle') });
    writeFound({ at: new Date().toISOString(), system: 'mac', tools: { android: { state: 'found', where: '/sk/sdk', own: true }, java: { state: 'found', version: '11.0.2', where: '/old/bin/java' } } }, home);
    const env = android.androidBuildEnv(home);
    expect(env['ORG_GRADLE_PROJECT_android.builder.sdkDownload']).toBeUndefined();
    // Java 11 is too old for Google's tools: none is given, rather than one that fails.
    expect(env.JAVA_HOME).toBeUndefined();
  });

  it("can't run on a Linux or Windows computer with an Arm chip: Not on this computer", async () => {
    expect((await detectAll(host({ system: 'linux', arch: 'arm64' }), home)).tools.android).toEqual({ state: 'not-here' });
  });
});
