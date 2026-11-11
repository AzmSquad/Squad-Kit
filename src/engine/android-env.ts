import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { androidSdk, gradleHome, javaHome } from './tools/android.js';
import { ownTool } from './tools/detect.js';

/**
 * squad-kit's Android tools for the project's own commands and the agents' shell: a check that builds an Android app
 * (`flutter build apk`, `./gradlew assembleDebug`) finds the SDK squad-kit got, Java 17 or newer, and Kotlin compiled
 * inside Gradle. In the guard the SDK and squad-kit's shared Gradle home are read only: Android's own folders and
 * Gradle's home are the project's cache home, and Gradle reads what squad-kit's own builds downloaded from the shared
 * one, so nothing downloads twice and no story can change what squad-kit's own phone builds run later.
 */

/** A command that builds or runs an Android app: Flutter's Android builds, Gradle's wrapper, or Android's own tools. */
const ANDROID_COMMAND = /(?:^|[\s;&|(/])(?:flutter\s+(?:build\s+(?:apk|appbundle)|run\b[^;&|]*\s(?:-d|--device-id)[\s=]*emulator-\d+)|gradlew(?:\.bat)?(?:\s|$)|gradle\s|adb\s|sdkmanager\b|avdmanager\b)/;

export function usesAndroid(command: string | undefined): boolean {
  return Boolean(command && ANDROID_COMMAND.test(command));
}

/**
 * The Android environment of a command. With a cache home (a guarded command, or a sandboxed agent), Android keeps its
 * settings and keys there, writable, and Gradle reads the shared downloads read only (GRADLE_RO_DEP_CACHE); Gradle's own
 * home stays the cache home's (sandbox.ts packageCacheEnv). With none, Android's settings go to a folder of squad-kit's
 * own, apart from its phones. Empty when this computer has no Android SDK squad-kit can use.
 */
export function androidCommandEnv(o: { cache?: string; home?: string } = {}): Record<string, string> {
  const home = o.home ?? squadHome();
  const sdk = androidSdk(home);
  if (!sdk) return {};
  const java = javaHome(home);
  const prefs = o.cache ? path.join(o.cache, 'android') : path.join(home, 'caches', 'android');
  const user = path.join(prefs, '.android');
  const shared = path.join(gradleHome(home), 'caches');
  return {
    ANDROID_HOME: sdk.sdk,
    ANDROID_SDK_ROOT: sdk.sdk,
    // ANDROID_PREFS_ROOT must be the folder above ANDROID_USER_HOME, or Android's build tools refuse.
    ANDROID_PREFS_ROOT: prefs,
    ANDROID_USER_HOME: user,
    ANDROID_EMULATOR_HOME: user,
    ANDROID_AVD_HOME: path.join(user, 'avd'),
    'ORG_GRADLE_PROJECT_kotlin.compiler.execution.strategy': 'in-process',
    // A person's own SDK is used as it is: a build may not download into it.
    ...(sdk.own ? {} : { 'ORG_GRADLE_PROJECT_android.builder.sdkDownload': 'false' }),
    ...(java ? { JAVA_HOME: java } : {}),
    ...(o.cache && fs.existsSync(path.join(shared, 'modules-2')) ? { GRADLE_RO_DEP_CACHE: shared } : {}),
  };
}

/**
 * What a guarded command and an agent's sandbox may read of squad-kit's own folder for Android, which is otherwise
 * hidden: the SDK squad-kit got, the Java it got, and its shared Gradle home. Never written: the guard opens these for
 * reading only. A person's own SDK is outside squad-kit's folder, and readable as it is.
 */
export function androidReads(home = squadHome()): string[] {
  const sdk = androidSdk(home);
  if (!sdk) return [];
  const java = ownTool('java', home);
  return [sdk.sdk, ...(java ? [java.dir] : []), gradleHome(home)].filter((p) => fs.existsSync(p));
}

/** A project, or a story's parts, with an Android app: the agents' shell gets the Android environment. */
export function hasAndroid(places: { kinds: string[]; platforms: string[] }[]): boolean {
  return places.some((p) => p.kinds.includes('android') || p.platforms.includes('android'));
}
