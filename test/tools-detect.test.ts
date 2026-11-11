import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectAll,
  dockerVersionOf,
  flutterVersionOf,
  iosRuntimesOf,
  javaVersionOf,
  maestroVersionOf,
  podVersionOf,
  readFound,
  writeFound,
  xcodeVersionOf,
  type DetectHost,
  type Ran,
} from '../src/engine/tools/detect.js';

/**
 * Finding each tool and its version. The outputs are real ones, kept from a Mac on 2026-11-10 (Flutter 3.27.3 with Dart
 * 3.6.1, Xcode 27.2, Java 19, CocoaPods). The computer is made up: nothing runs and nothing is installed.
 */

const FLUTTER_JSON = `{
  "frameworkVersion": "3.27.3",
  "channel": "stable",
  "repositoryUrl": "https://github.com/flutter/flutter.git",
  "frameworkRevision": "c519ee916eaeb88923e67befb89c0f1dabfa83e6",
  "frameworkCommitDate": "2025-01-21 10:32:23 -0800",
  "engineRevision": "e672b006cb34c921db85b8e2f482ed3144a4574b",
  "dartSdkVersion": "3.6.1",
  "devToolsVersion": "2.40.2",
  "flutterVersion": "3.27.3"
}`;
const FLUTTER_PLAIN = `Flutter 3.27.3 • channel stable • https://github.com/flutter/flutter.git
Framework • revision c519ee916e (10 months ago) • 2025-01-21 10:32:23 -0800
Engine • revision e672b006cb
Tools • Dart 3.6.1 • DevTools 2.40.2`;
const XCODE = 'Xcode 27.2\nBuild version 27B52\n';
const JAVA = 'openjdk version "19.0.2" 2023-01-17\nOpenJDK Runtime Environment (build 19.0.2+7-44)\nOpenJDK 64-Bit Server VM (build 19.0.2+7-44, mixed mode, sharing)\n';
const RUNTIMES = JSON.stringify({
  runtimes: [
    { name: 'iOS 18.2', version: '18.2', platform: 'iOS', isAvailable: true, identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2' },
    { name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true, identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' },
    { name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true, identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0-b' },
    { name: 'watchOS 12.0', version: '12.0', platform: 'watchOS', isAvailable: true, identifier: 'x' },
    { name: 'iOS 17.0', version: '17.0', platform: 'iOS', isAvailable: false, identifier: 'y' },
  ],
});

describe('versions from real outputs', () => {
  it('Flutter: its version file, --machine, and the plain words', () => {
    expect(flutterVersionOf(FLUTTER_JSON)).toBe('3.27.3');
    expect(flutterVersionOf(FLUTTER_PLAIN)).toBe('3.27.3');
    expect(flutterVersionOf('3.27.3\n')).toBe('3.27.3');
    expect(flutterVersionOf('command not found')).toBeNull();
  });

  it('Xcode, with its build', () => {
    expect(xcodeVersionOf(XCODE)).toEqual({ version: '27.2', build: '27B52' });
    expect(xcodeVersionOf("xcode-select: error: tool 'xcodebuild' requires Xcode")).toBeNull();
  });

  it('Java, new style and old style', () => {
    expect(javaVersionOf(JAVA)).toBe('19.0.2');
    expect(javaVersionOf('java version "1.8.0_311"\nJava(TM) SE Runtime Environment')).toBe('8.0.311');
    expect(javaVersionOf('openjdk version "21" 2023-09-19')).toBe('21');
  });

  it('CocoaPods, also after Ruby warnings', () => {
    expect(podVersionOf('1.16.2\n')).toBe('1.16.2');
    expect(podVersionOf('WARNING: CocoaPods requires your terminal to be using UTF-8 encoding.\n1.15.2\n')).toBe('1.15.2');
  });

  it('the iPhone simulators that can run, newest first', () => {
    expect(iosRuntimesOf(RUNTIMES)).toEqual(['27.0', '18.2']);
    expect(iosRuntimesOf('not json')).toEqual([]);
  });

  it('Docker and Maestro', () => {
    expect(dockerVersionOf('Docker version 27.3.1, build ce12230\n')).toBe('27.3.1');
    expect(maestroVersionOf('\n2.12.1\n')).toBe('2.12.1');
  });
});

let home: string;
let ran: string[];

/** A Mac with these programs on its PATH, and what each says. */
function mac(opts: { path?: Record<string, string>; files?: Record<string, string>; answers?: Record<string, Ran>; links?: Record<string, string>; dirs?: Record<string, string[]>; system?: DetectHost['system'] } = {}): DetectHost {
  const bins = opts.path ?? {};
  const files = opts.files ?? {};
  return {
    system: opts.system ?? 'mac',
    home: '/Users/pm',
    env: { PATH: [...new Set(Object.values(bins).map((p) => path.dirname(p)))].join(':') },
    async run(cmd, args) {
      const key = `${path.basename(cmd)} ${args.join(' ')}`;
      ran.push(key);
      return opts.answers?.[key] ?? { ok: false, out: '', err: `${cmd}: not found` };
    },
    exists: (p) => Object.values(bins).includes(p) || p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    read: (p) => files[p] ?? null,
    real: (p) => opts.links?.[p] ?? p,
    list: (dir) => opts.dirs?.[dir] ?? [],
    writable: () => true,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tool-detect-'));
  ran = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('checking a computer', () => {
  it("finds this Mac's tools: Flutter from its version file, Xcode, its simulators, CocoaPods and Java", async () => {
    const h = mac({
      path: { flutter: '/usr/local/bin/flutter', pod: '/Users/pm/.rvm/bin/pod', java: '/Users/pm/.sdkman/java/bin/java' },
      links: { '/usr/local/bin/flutter': '/Users/pm/Applications/flutter/bin/flutter' },
      files: { '/Users/pm/Applications/flutter/bin/cache/flutter.version.json': FLUTTER_JSON },
      answers: {
        'xcode-select -p': { ok: true, out: '/Applications/Xcode.app/Contents/Developer\n', err: '' },
        'xcodebuild -version': { ok: true, out: XCODE, err: '' },
        'xcrun simctl list runtimes -j': { ok: true, out: RUNTIMES, err: '' },
        'pod --version': { ok: true, out: '1.16.2\n', err: '' },
        'java -version': { ok: true, out: '', err: JAVA },
      },
    });
    const book = await detectAll(h, home);
    expect(book.system).toBe('mac');
    expect(book.tools.flutter).toEqual({ state: 'found', version: '3.27.3', where: '/Users/pm/Applications/flutter' });
    expect(book.tools.xcode).toMatchObject({ state: 'found', version: '27.2', where: '/Applications/Xcode.app' });
    expect(book.tools.simulator).toEqual({ state: 'found', version: '27.0', note: 'iOS 27.0, iOS 18.2' });
    expect(book.tools.cocoapods).toMatchObject({ state: 'found', version: '1.16.2' });
    // From RubyGems, in the person's own Ruby: no other tool looks after it.
    expect(book.tools.cocoapods!.managedBy).toBeUndefined();
    expect(book.tools.java).toMatchObject({ state: 'found', version: '19.0.2' });
    expect(book.tools.maestro).toEqual({ state: 'missing' });
    expect(book.tools['android-studio']).toEqual({ state: 'missing' });
    expect(book.tools.docker).toEqual({ state: 'missing' });
    // The version file was enough: Flutter itself never ran.
    expect(ran.some((r) => r.startsWith('flutter'))).toBe(false);
  });

  it("CocoaPods from Homebrew says so, so its update steps are Homebrew's", async () => {
    const h = mac({
      path: { pod: '/opt/homebrew/bin/pod' },
      links: { '/opt/homebrew/bin/pod': '/opt/homebrew/Cellar/cocoapods/1.15.2/bin/pod' },
      answers: { 'pod --version': { ok: true, out: '1.15.2\n', err: '' } },
    });
    expect((await detectAll(h, home)).tools.cocoapods).toEqual({ state: 'found', version: '1.15.2', where: '/opt/homebrew/bin/pod', managedBy: 'homebrew' });
  });

  it('a Flutter that is here but not on the PATH is not usable yet, and says where it is', async () => {
    const h = mac({ files: { '/Users/pm/Applications/flutter/bin/flutter': '', '/Users/pm/Applications/flutter/bin/cache/flutter.version.json': FLUTTER_JSON } });
    const f = (await detectAll(h, home)).tools.flutter!;
    expect(f.state).toBe('missing');
    expect(f.version).toBe('3.27.3');
    expect(f.note).toContain('not on the PATH');
  });

  it("only Apple's command line tools: no Xcode, and xcodebuild never runs", async () => {
    const h = mac({ answers: { 'xcode-select -p': { ok: true, out: '/Library/Developer/CommandLineTools\n', err: '' } } });
    const book = await detectAll(h, home);
    expect(book.tools.xcode).toEqual({ state: 'missing', note: "Only Apple's command line tools are here, not Xcode itself." });
    expect(book.tools.simulator).toMatchObject({ state: 'missing' });
    expect(ran).not.toContain('xcodebuild -version');
  });

  it("the Mac's stand-in java with no Java installed is missing, and is never run", async () => {
    const h = mac({ path: { java: '/usr/bin/java' } });
    expect((await detectAll(h, home)).tools.java).toEqual({ state: 'missing' });
    expect(ran).not.toContain('java -version');
  });

  it('on Linux and Windows the iPhone tools are not on this computer, without asking anything', async () => {
    const book = await detectAll(mac({ system: 'linux' }), home);
    for (const id of ['xcode', 'simulator', 'cocoapods'] as const) expect(book.tools[id]).toEqual({ state: 'not-here' });
    expect(ran.some((r) => r.startsWith('xcode') || r.startsWith('xcrun'))).toBe(false);
  });

  it("squad-kit's own Java counts first, from its own folder", async () => {
    const dir = path.join(home, 'tools', 'java', '21.0.5+11');
    fs.mkdirSync(path.join(dir, 'jre', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jre', 'bin', 'java'), '');
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ version: '21.0.5+11', binary: 'jre/bin/java' }));
    expect((await detectAll(mac(), home)).tools.java).toEqual({ state: 'found', version: '21.0.5+11', where: dir, own: true });
  });

  it('keeps what it found per computer, in its own folder', async () => {
    const book = await detectAll(mac(), home);
    writeFound(book, home);
    expect(readFound(home)).toEqual(book);
    expect(fs.existsSync(path.join(home, 'tools', 'found.json'))).toBe(true);
  });
});
