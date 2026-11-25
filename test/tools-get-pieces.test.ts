import { describe, it, expect, afterEach } from 'vitest';
import { androidPick, wantAndroidPieces } from '../src/engine/tools/android.js';
import { packagesOf, piecesWords, type SdkPiece } from '../src/engine/tools/flutter-android.js';
import { withAndroidChecks } from '../src/engine/tools/android-builds.js';
import { percentOf, startSimulatorGet, useSimSpawn, SIMULATOR_GET_S } from '../src/engine/tools/simulator-get.js';
import { gettingNow, lastTrouble } from '../src/engine/tools/get.js';
import { toolEntry } from '../src/engine/tools/catalog.js';
import type { ToolLine } from '../src/engine/tools/index.js';

/**
 * squad-kit gets the missing phone tools itself: the pieces a project's Flutter needs come with squad-kit's own Android
 * tools (Get them), never into the person's own SDK, and the iPhone simulator comes from Apple with Xcode's own download
 * (Get it), only on the person's press. Made-up downloads; nothing reaches the internet.
 */

const lacks: SdkPiece[] = [
  { kind: 'platform', version: '36', words: 'Android 16 (API 36)' },
  { kind: 'ndk', version: '28.2.13676358', words: 'the NDK 28.2.13676358' },
];

afterEach(() => {
  wantAndroidPieces([]);
  useSimSpawn(null);
});

describe('the Android pieces Flutter needs', () => {
  it("are named as sdkmanager names them, and come with squad-kit's own tools, before its phone's system", () => {
    expect(packagesOf(lacks)).toEqual(['platforms;android-36', 'ndk;28.2.13676358']);
    expect(piecesWords(lacks)).toBe('Android 16 (API 36) and the NDK 28.2.13676358');
    wantAndroidPieces(packagesOf(lacks));
    const pick = androidPick('mac', 'arm64')!;
    // The platform is one of squad-kit's own already; the NDK comes with them, the system image stays last.
    expect(pick.packages.slice(-2)).toEqual(['ndk;28.2.13676358', 'system-images;android-36;google_apis;arm64-v8a']);
    expect(pick.packages.filter((p) => p === 'platforms;android-36')).toHaveLength(1);
    expect(pick.sizes['ndk;28.2.13676358']).toBeGreaterThan(500_000_000);
    // Only a platform or an NDK: nothing else a caller sends is ever installed.
    wantAndroidPieces(['emulator', 'platforms;android-36; rm -rf /', 'ndk;29.0.1']);
    expect(androidPick('mac', 'arm64')!.packages).toContain('ndk;29.0.1');
    expect(androidPick('mac', 'arm64')!.packages.some((p) => p.includes('rm -rf'))).toBe(false);
  });

  it('the Android line names them for Get them, with Android Studio\'s steps as the other way, on the person\'s own SDK only', () => {
    const base: ToolLine = { id: 'android', name: 'Android phone tools', gives: '', state: 'ready', priority: 'required', actions: ['pictures'], blocks: [], installer: 'squad-kit', steps: [], link: 'https://developer.android.com', command: 'squad tools get android' } as unknown as ToolLine;
    const meta = { commands: { build: 'flutter build apk --debug' } } as never;
    const theirs = withAndroidChecks([base], [], { meta, book: null, skip: null, lacks: { lacks, own: false } })[0]!;
    expect(theirs.pieces).toEqual(['Android 16 (API 36)', 'the NDK 28.2.13676358']);
    expect(theirs.studioSteps?.length).toBeGreaterThan(0);
    expect(theirs.blocks).toContain('checks');
    const own = withAndroidChecks([base], [], { meta, book: null, skip: null, lacks: { lacks, own: true } })[0]!;
    expect(own.pieces).toBeUndefined();
  });
});

describe('the iPhone simulator, from Apple', () => {
  it('is got only on the press, with what Xcode prints as its progress, and goes on its own after', async () => {
    expect(toolEntry('simulator')).toMatchObject({ installer: 'squad-kit', pressOnly: true, size: 'about 8 GB' });
    expect(percentOf('Downloading iOS 27.2 Simulator (24B8117): 45.2% (3.7 GB of 8.2 GB)')).toBe(45.2);
    expect(percentOf('Preparing...')).toBeNull();
    let finish!: (code: number) => void;
    let printed!: (text: string) => void;
    const ran: string[] = [];
    useSimSpawn((cmd, args, on) => {
      ran.push([cmd, ...args].join(' '));
      printed = on;
      return { done: new Promise((r) => (finish = r)), stop: () => undefined };
    });
    let ended = false;
    const g = startSimulatorGet(() => (ended = true));
    expect(g).toMatchObject({ tool: 'simulator', step: 'download', secondsLeft: SIMULATOR_GET_S });
    expect(ran).toEqual(['xcodebuild -downloadPlatform iOS']);
    printed('Downloading iOS 27.2 Simulator: 50.0%');
    expect(gettingNow()).toMatchObject({ tool: 'simulator', done: 50, total: 100, words: 'Getting the iPhone simulator from Apple' });
    finish(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toBe(true);
    expect(gettingNow()).toBeNull();
    expect(lastTrouble('simulator')).toBeUndefined();
  });

  it("a run that did not finish says so plainly, and why when it can tell", async () => {
    let finish!: (code: number) => void;
    let printed!: (text: string) => void;
    useSimSpawn((_cmd, _args, on) => {
      printed = on;
      return { done: new Promise((r) => (finish = r)), stop: () => undefined };
    });
    startSimulatorGet();
    printed('Error: not enough free space on the disk');
    finish(70);
    await new Promise((r) => setTimeout(r, 10));
    expect(lastTrouble('simulator')).toBe('There is not enough room on this Mac for the iPhone simulator (about 8 GB). Make room, then press Get it again.');
  });
});
