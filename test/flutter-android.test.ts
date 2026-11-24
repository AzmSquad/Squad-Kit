import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flutterAndroidNeeds, piecesWords, sdkLacksFor, studioStepsFor } from '../src/engine/tools/flutter-android.js';
import { toolMissing } from '../src/engine/tool-missing.js';

/**
 * What a Flutter needs of the Android SDK to build an app, read from its own Gradle plugin, and what an SDK of the
 * person's lacks of it, said with Android Studio's own steps: as on this team's Mac, where Android Studio's SDK had
 * Android 17 only, and Flutter 3.47.9 builds with Android 16 (API 36) and the NDK 28.2.13676358. Made-up folders.
 */

let base: string;
const write = (file: string, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-flutter-android-')));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('what a Flutter needs of the Android SDK', () => {
  it("is read from its Gradle plugin's own defaults", () => {
    const flutter = path.join(base, 'flutter');
    write(
      path.join(flutter, 'packages', 'flutter_tools', 'gradle', 'src', 'main', 'kotlin', 'FlutterExtension.kt'),
      'abstract class FlutterExtension {\n    /** Sets the compileSdkVersion used by default in Flutter app projects. */\n    val compileSdkVersion: Int = 36\n    val ndkVersion: String = "28.2.13676358"\n}\n',
    );
    expect(flutterAndroidNeeds(flutter)).toEqual({ platform: 36, ndk: '28.2.13676358' });
    expect(flutterAndroidNeeds(path.join(base, 'none'))).toBeNull();
  });

  it("an SDK with Android 17 only lacks Android 16 and the NDK, said with Android Studio's steps", () => {
    const sdk = path.join(base, 'sdk');
    fs.mkdirSync(path.join(sdk, 'platforms', 'android-37.0'), { recursive: true });
    const lacks = sdkLacksFor(sdk, { platform: 36, ndk: '28.2.13676358' });
    expect(piecesWords(lacks)).toBe('Android 16 (API 36) and the NDK 28.2.13676358');
    expect(studioStepsFor(lacks)).toEqual([
      'Open Android Studio. Open the SDK Manager: Tools, then SDK Manager (on its welcome screen: More Actions, then SDK Manager).',
      'On the SDK Platforms tab, tick Android 16 (API 36).',
      'On the SDK Tools tab, tick Show Package Details, open NDK (Side by side), and tick 28.2.13676358.',
      'Press Apply, and let it download.',
    ]);
    // Added: nothing lacks, whether the platform folder has a minor number or not.
    fs.mkdirSync(path.join(sdk, 'platforms', 'android-36.1'), { recursive: true });
    fs.mkdirSync(path.join(sdk, 'ndk', '28.2.13676358'), { recursive: true });
    expect(sdkLacksFor(sdk, { platform: 36, ndk: '28.2.13676358' })).toEqual([]);
  });

  it("a build that stops for a missing NDK is a missing tool, never the Builder's to fix", () => {
    expect(toolMissing('C/C++: No NDK was found. Trying to download it now.\n> NDK not configured. Download it with SDK manager. Preferred NDK version is \'28.2.13676358\'.')?.what).toBe('a part of the Android SDK');
  });
});
