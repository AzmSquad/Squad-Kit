import fs from 'node:fs';
import path from 'node:path';
import { flutterOnPath } from '../flutter-sdk.js';
import { fvmFlutterRoot } from '../fvm-sdk.js';
import { androidBuildSdk } from './android.js';

/**
 * What a Flutter needs of the Android SDK to build an app: the Android platform it compiles against and the NDK its
 * Gradle plugin asks for, read from that Flutter's own plugin. An SDK of the person's (Android Studio's) often lacks
 * them: then the build check stops with a line that names each piece, with Android Studio's own steps to add it, before
 * the build runs, instead of the Builder finding it out. squad-kit's own Android tools come with them.
 */

export interface FlutterAndroidNeeds {
  /** The API level it compiles against: 36 for Flutter 3.47. */
  platform: number;
  /** The NDK version its Gradle plugin asks for: "28.2.13676358". */
  ndk?: string;
}

/** Android's names for its API levels, as Android Studio's SDK Manager shows them. */
const ANDROID_NAMES: Record<number, string> = { 37: '17', 36: '16', 35: '15', 34: '14', 33: '13' };

/** What this Flutter needs, from its Gradle plugin's own defaults; null when it can't tell. */
export function flutterAndroidNeeds(flutterRoot: string): FlutterAndroidNeeds | null {
  let text = '';
  try {
    text = fs.readFileSync(path.join(flutterRoot, 'packages', 'flutter_tools', 'gradle', 'src', 'main', 'kotlin', 'FlutterExtension.kt'), 'utf8');
  } catch {
    return null;
  }
  const platform = Number(/val\s+compileSdkVersion\s*:\s*Int\s*=\s*(\d+)/.exec(text)?.[1]);
  const ndk = /val\s+ndkVersion\s*:\s*String\s*=\s*"([\d.]+)"/.exec(text)?.[1];
  return platform ? { platform, ...(ndk ? { ndk } : {}) } : null;
}

export interface SdkPiece {
  /** "Android 16 (API 36)", "the NDK 28.2.13676358". */
  words: string;
  kind: 'platform' | 'ndk';
  version: string;
}

/** What an SDK lacks of what a Flutter needs. */
export function sdkLacksFor(sdk: string, needs: FlutterAndroidNeeds): SdkPiece[] {
  const list = (dir: string) => {
    try {
      return fs.readdirSync(path.join(sdk, dir));
    } catch {
      return [];
    }
  };
  const out: SdkPiece[] = [];
  // From Android 17 a platform's folder has a minor number too: android-36 or android-36.1.
  if (!list('platforms').some((p) => new RegExp(`^android-${needs.platform}(?:\\.\\d+)?$`).test(p))) {
    out.push({ kind: 'platform', version: String(needs.platform), words: `Android ${ANDROID_NAMES[needs.platform] ?? needs.platform} (API ${needs.platform})` });
  }
  if (needs.ndk && !list('ndk').includes(needs.ndk)) out.push({ kind: 'ndk', version: needs.ndk, words: `the NDK ${needs.ndk}` });
  return out;
}

/** Android Studio's own steps to add those pieces to its SDK. */
export function studioStepsFor(lacks: SdkPiece[]): string[] {
  const platform = lacks.find((l) => l.kind === 'platform');
  const ndk = lacks.find((l) => l.kind === 'ndk');
  return [
    'Open Android Studio. Open the SDK Manager: Tools, then SDK Manager (on its welcome screen: More Actions, then SDK Manager).',
    ...(platform ? [`On the SDK Platforms tab, tick ${platform.words}.`] : []),
    ...(ndk ? [`On the SDK Tools tab, tick Show Package Details, open NDK (Side by side), and tick ${ndk.version}.`] : []),
    'Press Apply, and let it download.',
  ];
}

/**
 * What the Android SDK a build in this folder uses lacks of what its Flutter needs: the Flutter FVM runs for the
 * folder's pin, else the one on the PATH. Null when nothing is missing, or it can't tell.
 */
export function sdkLacksHere(dir: string, env: NodeJS.ProcessEnv = process.env): { lacks: SdkPiece[]; own: boolean } | null {
  const sdk = androidBuildSdk();
  // An SDK that is gone is the tools check's to say, not this.
  if (!sdk || !fs.existsSync(sdk.sdk)) return null;
  const needs = [fvmFlutterRoot(dir, env), flutterOnPath(env)?.root].filter((r): r is string => Boolean(r)).map(flutterAndroidNeeds).find(Boolean);
  if (!needs) return null;
  const lacks = sdkLacksFor(sdk.sdk, needs);
  return lacks.length ? { lacks, own: sdk.own } : null;
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The pieces, in plain words: "Android 16 (API 36) and the NDK 28.2.13676358". */
export const piecesWords = (lacks: SdkPiece[]) => list(lacks.map((l) => l.words));
