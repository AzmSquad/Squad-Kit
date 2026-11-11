import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * The project's own checks and the agents' shell for an Android app: a command that builds for Android gets squad-kit's
 * Android tools (the SDK and the shared Gradle home read only in the guard, Android's folders and Gradle's home in the
 * project's cache home); a check that fails only for a missing tool counts no try and never reaches the Builder; and a
 * Flutter build for a phone handed in by the first read becomes the web build, or none. No real build runs.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');
const { androidCommandEnv, androidReads, hasAndroid, usesAndroid } = await import('../src/engine/android-env.js');
const { buildGuard, profileText, spawnProject } = await import('../src/engine/project-guard.js');
const { sandboxAsk } = await import('../src/engine/sandbox.js');
const { cacheHomeEnv } = await import('../src/engine/cache-home.js');
const { precacheArgs } = await import('../src/engine/flutter-downloads.js');
const { afterToolMissing, toolMissing } = await import('../src/engine/tool-missing.js');
const { fromTheRead, findCommands } = await import('../src/engine/find-commands.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const { useDetectHost } = await import('../src/engine/tools/index.js');

let tmp: string;
let home: string;
let sdk: string;

/** squad-kit's own Android SDK, as Get it leaves it, and its shared Gradle home with what its own builds downloaded. */
function ownAndroid(): void {
  const dir = path.join(home, 'tools', 'android', '36');
  sdk = path.join(dir, 'sdk');
  fs.mkdirSync(path.join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), '');
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ version: '36', binary: 'sdk/cmdline-tools/latest/bin/sdkmanager' }));
  fs.mkdirSync(path.join(home, 'caches', 'gradle', 'caches', 'modules-2'), { recursive: true });
  writeFound({ at: new Date().toISOString(), system: 'mac', tools: { java: { state: 'found', version: '21.0.5', where: '/jdk21/bin/java' }, android: { state: 'found', version: 'Android 16', where: sdk, own: true } } }, home);
  useDetectHost(null);
}

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-android-checks-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("squad-kit's Android tools for the project's own commands", () => {
  it('knows a command that builds for Android, and leaves the others as they are', () => {
    for (const c of ['flutter build apk', 'flutter build appbundle --release', './gradlew assembleDebug', 'cd android && ./gradlew test', 'gradlew.bat test', 'flutter run -d emulator-5560']) expect(usesAndroid(c), c).toBe(true);
    for (const c of ['flutter test', 'flutter build web', 'flutter analyze --no-fatal-infos', 'npm test', 'pnpm build', undefined]) expect(usesAndroid(c), String(c)).toBe(false);
    expect(hasAndroid([{ kinds: ['flutter'], platforms: ['ios', 'android'] }])).toBe(true);
    expect(hasAndroid([{ kinds: ['web'], platforms: ['web'] }])).toBe(false);
  });

  it("in the guard: the SDK, Java and Kotlin inside Gradle, Android's folders in the cache home, Gradle's shared downloads read only", () => {
    ownAndroid();
    const cache = path.join(tmp, 'cache');
    expect(androidCommandEnv({ cache })).toEqual({
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_PREFS_ROOT: path.join(cache, 'android'),
      ANDROID_USER_HOME: path.join(cache, 'android', '.android'),
      ANDROID_EMULATOR_HOME: path.join(cache, 'android', '.android'),
      ANDROID_AVD_HOME: path.join(cache, 'android', '.android', 'avd'),
      'ORG_GRADLE_PROJECT_kotlin.compiler.execution.strategy': 'in-process',
      JAVA_HOME: '/jdk21',
      GRADLE_RO_DEP_CACHE: path.join(home, 'caches', 'gradle', 'caches'),
    });
    // Gradle's own home stays the cache home's: never the shared one squad-kit's own phone builds run from.
    expect(cacheHomeEnv(cache, { wall: 'project' }).GRADLE_USER_HOME).toBe(path.join(cache, 'gradle'));
    // No SDK squad-kit can use: nothing is added.
    fs.rmSync(path.join(home, 'tools'), { recursive: true, force: true });
    expect(androidCommandEnv({ cache })).toEqual({});
  });

  it("an SDK of the person's own is given as it is, and a build may not download into it", () => {
    writeFound({ at: new Date().toISOString(), system: 'mac', tools: { android: { state: 'found', version: 'Android 15', where: '/Users/pm/Library/Android/sdk' } } }, home);
    expect(androidCommandEnv({})).toMatchObject({ ANDROID_HOME: '/Users/pm/Library/Android/sdk', 'ORG_GRADLE_PROJECT_android.builder.sdkDownload': 'false', ANDROID_PREFS_ROOT: path.join(home, 'caches', 'android') });
  });

  it('the guard opens the SDK and the shared Gradle home for reading only, and so does the agents\' sandbox', () => {
    ownAndroid();
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(copy);
    const g = buildGuard({ cwd: copy, root: copy, cache: path.join(tmp, 'cache'), home: tmp, platform: 'darwin', flutter: null });
    const real = (p: string) => fs.realpathSync(p);
    expect(g.read).toEqual(expect.arrayContaining([real(sdk), real(path.join(home, 'caches', 'gradle'))]));
    expect(g.write.some((w) => w.startsWith(real(home)))).toBe(false);
    const profile = profileText(g);
    expect(profile).toContain(`(allow file-read* (subpath "${real(sdk)}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${real(sdk)}"))`);
    expect(androidReads(home)).toEqual([sdk, path.join(home, 'caches', 'gradle')]);
    const ask = sandboxAsk({ cwd: copy, root: copy, read: [], proof: path.join(tmp, 'proof'), secrets: [], network: 'standard', flutter: null, home: tmp });
    expect(ask.read).toEqual(expect.arrayContaining([sdk]));
    expect(ask.write.some((w) => w.startsWith(home))).toBe(false);
  });

  it('a command that builds for Android gets it where it runs; another command does not', () => {
    ownAndroid();
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(copy);
    const printed = (command: string) =>
      new Promise<string>((resolve) => {
        const child = spawnProject(command, { cwd: copy });
        let out = '';
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => resolve(out.trim()));
      });
    return Promise.all([printed('echo ./gradlew >/dev/null; printf "%s|%s" "$ANDROID_HOME" "$JAVA_HOME"'), printed('printf "%s" "${ANDROID_HOME:-none}"')]).then(([android, other]) => {
      expect(android).toBe(`${sdk}|/jdk21`);
      expect(other).toBe(process.env.ANDROID_HOME ?? 'none');
    });
  });

  it("Gradle's own copy is linked from squad-kit's shared Gradle home, and Flutter's Android downloads come only for an Android build", () => {
    ownAndroid();
    const app = path.join(tmp, 'app');
    const url = 'https\\://services.gradle.org/distributions/gradle-9.3.1-all.zip';
    fs.mkdirSync(path.join(app, 'android', 'gradle', 'wrapper'), { recursive: true });
    fs.writeFileSync(path.join(app, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionUrl=${url}\n`);
    const hash = BigInt(`0x${createHash('md5').update(url.replace(/\\(.)/g, '$1')).digest('hex')}`).toString(36);
    const shared = path.join(home, 'caches', 'gradle', 'wrapper', 'dists', 'gradle-9.3.1-all', hash);
    fs.mkdirSync(path.join(shared, 'gradle-9.3.1'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'gradle-9.3.1-all.zip.ok'), '');
    const cache = path.join(tmp, 'cache');
    cacheHomeEnv(cache, { wall: 'project', cwd: app, home: path.join(tmp, 'nobody') });
    expect(fs.readlinkSync(path.join(cache, 'gradle', 'wrapper', 'dists', 'gradle-9.3.1-all', hash, 'gradle-9.3.1'))).toBe(path.join(shared, 'gradle-9.3.1'));
    expect(precacheArgs(['ios', 'android', 'web'], 'darwin', 'flutter build apk')).toEqual(['precache', '--ios', '--web', '--android']);
    expect(precacheArgs(['ios', 'android', 'web'], 'darwin', 'flutter test')).toEqual(['precache', '--ios', '--web']);
  });
});

describe('a missing tool is not the Builder\'s', () => {
  it('reads the few things a missing tool prints, by name, and nothing a test prints', () => {
    expect(toolMissing('Running Gradle task...\n[!] No Android SDK found. Try setting the ANDROID_HOME environment variable.\n')).toEqual({ what: 'the Android SDK', line: '[!] No Android SDK found. Try setting the ANDROID_HOME environment variable.' });
    expect(toolMissing("SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable")?.what).toBe('the Android SDK');
    expect(toolMissing('ERROR: JAVA_HOME is not set and no java command could be found in your PATH.')?.what).toBe('Java');
    expect(toolMissing('The operation couldn’t be completed. Unable to locate a Java Runtime.')?.what).toBe('Java');
    expect(toolMissing('xcrun: error: unable to find utility "simctl"')?.what).toBe('Xcode');
    expect(toolMissing('zsh: command not found: flutter')?.what).toBe('a program the command runs');
    expect(toolMissing('sh: 1: flutter: not found')?.what).toBe('a program the command runs');
    for (const test of ['Element not found: Text matching "Save"', 'Expected: 3 bookings\n  Actual: 2 bookings', 'image.png: not found in assets', 'FAILED: the booking test']) expect(toolMissing(test), test).toBeNull();
    expect([afterToolMissing(0, null), afterToolMissing(1, { text: 'x' }), afterToolMissing(1, null)]).toEqual(['again', 'wait', 'stop']);
  });

  describe('in the checks step', () => {
    let wt: string;
    let bp: ReturnType<typeof boardPaths>;
    beforeEach(() => {
      wt = path.join(tmp, 'copy');
      fs.mkdirSync(wt, { recursive: true });
      bp = boardPaths(path.join(tmp, '.squad'));
      seedDemoBoard(bp, { speed: 50 });
      for (const t of listTickets(bp)) removeTicket(bp, t.id);
      writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
      writeFound({ at: new Date().toISOString(), system: 'mac', tools: {} }, home);
      useDetectHost({ system: 'mac', home: '/Users/nobody', env: { PATH: '/nowhere' }, run: async () => ({ ok: false, out: '', err: '' }), exists: () => false, read: () => null, real: (p) => p, list: () => [], writable: () => true });
    });
    afterEach(() => useDetectHost(null));

    const built = () => {
      const t0 = actions.createTicket(bp, { title: 'Count bookings', ask: 'Show how many bookings there are.' });
      return updateTicket(bp, t0.id, (x) => {
        x.stage = 'test';
        x.live = true;
        x.waiting = null;
        x.squad = null;
        x.worktree = wt;
        x.sessions = { intake: 'i-1', build: 'b-1' };
        x.steps = [{ title: 'Count them', status: 'done' }];
        x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      });
    };
    const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);

    it('no try is counted and no Builder is asked: the checks run once more, then a card says what to install', async () => {
      writeMeta(bp, { ...readMeta(bp), commands: { test: 'true', build: 'echo "[!] No Android SDK found. Try setting the ANDROID_HOME environment variable."; exit 1' } });
      const squad = new LiveSquad(bp) as unknown as { checks(id: string): Promise<void> };
      const t0 = built();
      await squad.checks(t0.id);
      let t = readTicket(bp, t0.id)!;
      expect(builds()).toHaveLength(0);
      expect(t.tries ?? 0).toBe(0);
      expect(t.fails ?? 0).toBe(0);
      expect(t.squad?.phase).toBe('test');
      expect(t.activity.map((a) => a.text)).toContain('The build could not run: the Android SDK is not there for it, so squad-kit set its tools up again and runs the checks once more. Not a failed try');
      await squad.checks(t0.id);
      t = readTicket(bp, t0.id)!;
      expect(builds()).toHaveLength(0);
      expect(t.tries ?? 0).toBe(0);
      expect(t.stuck).toMatchObject({ gate: 'checks', question: "squad-kit can't run the build on this computer: the Android SDK is missing. Install it, then press Try again. The code was not the problem." });
      expect(t.waiting?.kind).toBe('stuck');
    });

    it("an Android build the Tools page knows: the story waits for squad-kit's Android tools, with its line", async () => {
      fs.writeFileSync(path.join(wt, 'gradlew'), '#!/bin/sh\necho "SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable"\nexit 1\n', { mode: 0o755 });
      fs.mkdirSync(path.join(bp.root, 'android', 'app'), { recursive: true });
      fs.writeFileSync(path.join(bp.root, 'android', 'app', 'build.gradle'), 'apply plugin: "com.android.application"\n');
      writeMeta(bp, { ...readMeta(bp), commands: { test: 'true', build: './gradlew assembleDebug' } });
      const squad = new LiveSquad(bp) as unknown as { checks(id: string): Promise<void> };
      const t0 = built();
      await squad.checks(t0.id);
      expect(readTicket(bp, t0.id)!.squad?.phase).toBe('test');
      expect(builds()).toHaveLength(0);
      // The Tools page's line: Get it is one press away.
      const { toolsHold } = await import('../src/engine/tools/index.js');
      const hold = toolsHold(bp, readTicket(bp, t0.id)!, 'test');
      expect(hold?.tools.map((x) => x.id)).toEqual(['android', 'java']);
      expect(hold?.status).toBe("Waits for Android phone tools and Java on this computer. Goes on by itself once they're there");
    });
  });
});

describe("Flutter's build check", () => {
  function flutterApp(web: boolean): string {
    const dir = path.join(tmp, web ? 'with-web' : 'phone-only');
    fs.mkdirSync(path.join(dir, 'android'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ios'), { recursive: true });
    if (web) fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    return dir;
  }

  it("a phone build handed in by the first read becomes the web build, or goes, with one line saying why", () => {
    const web = flutterApp(true);
    expect(findCommands(web).build).toBe('flutter build web');
    expect(fromTheRead(web, { test: 'flutter test', build: 'flutter build apk' })).toEqual({
      commands: { test: 'flutter test', build: 'flutter build web' },
      changed: ["The read's build check (flutter build apk) builds for a phone, which squad-kit's own phone build already shows, so squad-kit checks flutter build web instead."],
    });
    const phoneOnly = flutterApp(false);
    expect(findCommands(phoneOnly).build).toBeUndefined();
    for (const build of ['flutter build appbundle', 'flutter build ios --no-codesign', 'flutter build ipa']) {
      const r = fromTheRead(phoneOnly, { build });
      expect(r.commands.build, build).toBeUndefined();
      expect(r.changed).toEqual([`The read's build check (${build}) builds for a phone, which squad-kit's own phone build already shows, so squad-kit left it out.`]);
    }
    // A web build, or another kind of project's build, stays as it is.
    expect(fromTheRead(web, { build: 'flutter build web' }).changed).toEqual([]);
    expect(fromTheRead(path.join(tmp, 'none'), { build: 'npm run build' }).changed).toEqual([]);
  });
});
