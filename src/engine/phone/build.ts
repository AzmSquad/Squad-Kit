import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import type { PhoneModule } from '../../modules/phone/types.js';
import { markPrebuilt, prebuiltIn } from '../git.js';
import { putCopyBack, treeOf } from '../lane.js';
import { endGroup } from '../process-group.js';
import { androidBuildEnv } from '../tools/android.js';
import type { PhoneSystem } from '../tools/which-phone.js';
import { aboutWords, noteStep, stepSeconds } from './times.js';

/**
 * Builds the story's app for squad-kit's phone, in the story's own copy of the code, outside the agents' sandbox. For
 * the iPhone simulator: Flutter with `flutter build ios --simulator`, React Native and native iPhone apps with
 * `xcodebuild` (after `pod install` when there is a Podfile). For Android: Flutter with `flutter build apk --debug`,
 * React Native and native Android apps with their own Gradle, in squad-kit's one Gradle home, stopped after each
 * build. An Expo app with no phone folder gets one made first (`expo prebuild`), which stays squad-kit's own: no commit
 * ever takes it. It builds again only when the copy's code changed since the last build, keeps how long it took, so
 * the next wait says "about N minutes" from this computer, and puts back whatever the build changed in the story's own
 * files (Flutter rewrites pubspec.lock and analysis_options.yaml): the story's changes stay the Builder's.
 */

export type PhoneKind = 'flutter' | 'react-native' | 'ios' | 'android';

/** squad-kit's own build folder in a copy: Xcode's build files and the record of the last build. Git never sees it. */
export const BUILD_DIR = path.join('build', 'squad-kit-ios');
/** The same for Android: the record of the last Android build. */
export const ANDROID_BUILD_DIR = path.join('build', 'squad-kit-android');
/** A build that takes longer than this is stopped. */
export const BUILD_MS = 40 * 60_000;
/** Gradle's own stop after a build, which ends its helper (over 1 GB, kept 3 hours otherwise). */
const STOP_MS = 60_000;

const ownDir = (system: PhoneSystem) => (system === 'android' ? ANDROID_BUILD_DIR : BUILD_DIR);
const WORD: Record<PhoneSystem, string> = { ios: 'iPhone', android: 'Android phone' };

export interface BuildStep {
  cmd: string;
  args: string[];
  /** Relative to the copy. */
  cwd: string;
  /** What it does, for the log. */
  what: string;
}

export interface BuildPlan {
  steps: BuildStep[];
  /** Where the built app is, as a folder to look in for one `.app`, or the folders to look in for one `.apk`. */
  products: string;
  apks?: string[];
  /** Android: the Gradle project, whose helper stops after the build. */
  gradle?: string;
}

/** What a build left: the app, and the copy's code it was built from. */
export interface Built {
  app: string;
  /** The copy's code (lane.ts treeOf) the app was built from. */
  tree?: string;
  at: string;
  seconds?: number;
}

/** Runs one build command in the copy. Tests give a made-up one. */
export type BuildRun = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<{ ok: boolean; output: string }>;

const realRun: BuildRun = (cmd, args, o) =>
  new Promise((resolve) => {
    let output = '';
    let done = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d: Buffer) => (output = (output + d.toString()).slice(-60_000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const end = () => {
      if (!done) endGroup(child);
    };
    const timer = setTimeout(() => {
      output += `\nIt ran longer than ${Math.round(o.timeoutMs / 60_000)} minutes, so squad-kit stopped it.`;
      end();
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', end, { once: true });
    const finish = (ok: boolean, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', end);
      resolve({ ok, output: `${output}${extra}` });
    };
    child.on('error', (err) => finish(false, `\n${err.message}`));
    child.on('close', (code) => finish(code === 0 && !o.signal?.aborted));
  });

let runner: BuildRun = realRun;

/** Tests run made-up builds. Null goes back to the real one. */
export function useBuildRun(r: BuildRun | null): void {
  runner = r ?? realRun;
}

const exists = (p: string) => fs.existsSync(p);

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** The Xcode workspace or project to build: a workspace first (CocoaPods makes one), in the folder or one level down. */
function xcodeOf(dir: string): { flag: '-workspace' | '-project'; file: string } | null {
  const here = (d: string) => {
    const names = list(d);
    const ws = names.find((n) => n.endsWith('.xcworkspace'));
    if (ws) return { flag: '-workspace' as const, file: path.join(d, ws) };
    const pj = names.find((n) => n.endsWith('.xcodeproj'));
    return pj ? { flag: '-project' as const, file: path.join(d, pj) } : null;
  };
  return here(dir) ?? list(dir).map((n) => path.join(dir, n)).filter((d) => !path.basename(d).startsWith('.') && path.basename(d) !== 'node_modules' && isDir(d)).map(here).find(Boolean) ?? null;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The commands that build a copy for the iPhone simulator, by kind. React Native builds its Release setup, which
 * carries the app's own code inside it: a Debug build waits for a dev server on this computer the pictures don't have.
 * Null when squad-kit cannot tell how (no Xcode project).
 */
export function buildPlan(dir: string, kind: PhoneKind): BuildPlan | null {
  const derived = path.join(dir, BUILD_DIR, 'xcode');
  if (kind === 'flutter') {
    return { steps: [{ cmd: 'flutter', args: ['build', 'ios', '--simulator', '--debug'], cwd: '.', what: 'Flutter build for the iPhone simulator' }], products: path.join(dir, 'build', 'ios', 'iphonesimulator') };
  }
  const iosDir = kind === 'react-native' ? path.join(dir, 'ios') : dir;
  const x = xcodeOf(iosDir);
  if (!x) return null;
  const xdir = path.dirname(x.file);
  const steps: BuildStep[] = [];
  if (fs.existsSync(path.join(xdir, 'Podfile'))) steps.push({ cmd: 'pod', args: ['install'], cwd: path.relative(dir, xdir) || '.', what: "CocoaPods install of the app's iPhone libraries" });
  const scheme = path.basename(x.file).replace(/\.(xcworkspace|xcodeproj)$/, '');
  const config = kind === 'react-native' ? 'Release' : 'Debug';
  steps.push({
    cmd: 'xcodebuild',
    args: [x.flag, x.file, '-scheme', scheme, '-configuration', config, '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, 'build'],
    cwd: path.relative(dir, xdir) || '.',
    what: 'Xcode build for the iPhone simulator',
  });
  return { steps, products: path.join(derived, 'Build', 'Products', `${config}-iphonesimulator`) };
}

/** Gradle's own start script in a folder: gradlew, or gradlew.bat on Windows. */
export function gradlewIn(dir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(dir, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

/** The folders of a native Android app's modules where Gradle puts their debug app: app/build/outputs/apk/debug. */
function moduleApks(root: string): string[] {
  return list(root)
    .filter((n) => !n.startsWith('.') && n !== 'build' && isDir(path.join(root, n)))
    .map((n) => path.join(root, n, 'build', 'outputs', 'apk', 'debug'));
}

/**
 * The commands that build a copy for squad-kit's Android phone, by kind. React Native builds its release setup, which
 * carries the app's own code inside it (and signs with the debug key, as its template does): a debug build waits for a
 * dev server on this computer the pictures don't have. Null when squad-kit cannot tell how (no Gradle project).
 */
export function androidPlan(dir: string, kind: PhoneKind, platform: NodeJS.Platform = process.platform): BuildPlan | null {
  if (kind === 'flutter') {
    return {
      steps: [{ cmd: 'flutter', args: ['build', 'apk', '--debug'], cwd: '.', what: 'Flutter build for the Android phone' }],
      products: path.join(dir, 'build', 'app', 'outputs', 'flutter-apk'),
      apks: [path.join(dir, 'build', 'app', 'outputs', 'flutter-apk')],
      gradle: path.join(dir, 'android'),
    };
  }
  // React Native keeps its Gradle project in android/; a native app has it at its top, or in an android/ folder.
  const root = kind === 'react-native' || !exists(gradlewIn(dir, platform)) ? path.join(dir, 'android') : dir;
  if (!exists(gradlewIn(root, platform))) return null;
  const task = kind === 'react-native' ? 'assembleRelease' : 'assembleDebug';
  const out = kind === 'react-native' ? [path.join(root, 'app', 'build', 'outputs', 'apk', 'release')] : moduleApks(root);
  return {
    steps: [{ cmd: gradlewIn(root, platform), args: [task], cwd: path.relative(dir, root) || '.', what: `Gradle build (${task}) for the Android phone` }],
    products: out[0] ?? root,
    apks: out,
    gradle: root,
  };
}

/** The app an Android build made: the newest `.apk` in its folders that is not a test app. */
export function apkIn(folders: string[]): string | null {
  let best: { file: string; at: number } | null = null;
  for (const f of folders) {
    for (const n of list(f)) {
      if (!n.endsWith('.apk') || /androidTest|-unaligned|-unsigned/.test(n)) continue;
      const file = path.join(f, n);
      const at = fs.statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    }
  }
  return best?.file ?? null;
}

/** An Expo app (React Native with the expo package) that has no folder of its own for this phone yet. */
export function needsPrebuild(dir: string, kind: PhoneKind, system: PhoneSystem): boolean {
  if (kind !== 'react-native' || exists(path.join(dir, system))) return false;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    return Boolean(j.dependencies?.expo ?? j.devDependencies?.expo);
  } catch {
    return false;
  }
}

/** Expo makes the phone's folder from the app's own settings: no packages installed, no questions asked. */
export function prebuildStep(system: PhoneSystem): BuildStep {
  return { cmd: 'npx', args: ['expo', 'prebuild', '--platform', system, '--no-install'], cwd: '.', what: `Expo's own ${system} folder, made for this build` };
}

/** The app a build made: the one `.app` in its folder that is not a test runner. */
export function appIn(products: string): string | null {
  const apps = list(products).filter((n) => n.endsWith('.app') && !/Tests?(-Runner)?\.app$/.test(n));
  return apps.length ? path.join(products, apps[0]!) : null;
}

const recordFile = (dir: string, system: PhoneSystem = 'ios') => path.join(dir, ownDir(system), 'built.json');

/** The last build in a copy, as saved: for the iPhone, or for Android. */
export function lastBuild(dir: string, system: PhoneSystem = 'ios'): Built | null {
  try {
    return JSON.parse(fs.readFileSync(recordFile(dir, system), 'utf8')) as Built;
  } catch {
    return null;
  }
}

/** squad-kit's build folder in a copy, which ignores itself: nothing in it ever shows as a change of the story. */
function ownFolder(dir: string, system: PhoneSystem): void {
  const own = path.join(dir, ownDir(system));
  fs.mkdirSync(own, { recursive: true });
  const ignore = path.join(own, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

/** A build that did not work. `message` is for people, `detail` for engineers: the command and the end of what it printed. */
export class BuildFailed extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

const tail = (s: string, n = 40) => s.trim().split('\n').slice(-n).join('\n');

/** The words for a build's phone: "iPhone", "Android phone". */
const wordOf = (system: PhoneSystem, phone?: PhoneModule) => phone?.words.phone ?? WORD[system];

/**
 * The story's app, built for squad-kit's phone in its copy `dir` (the iPhone simulator, or Android), or the last build
 * when the copy's code is the same. Says what it does and about how long it takes. Throws BuildFailed.
 */
export async function buildForPhone(dir: string, kind: PhoneKind, o: { system?: PhoneSystem; phone?: PhoneModule; say?(text: string): void; log?(text: string): void; signal?: AbortSignal; home?: string } = {}): Promise<Built> {
  const home = o.home ?? squadHome();
  const system = o.system ?? (kind === 'android' ? 'android' : 'ios');
  const word = wordOf(system, o.phone);
  const tree = await treeOf(dir);
  const last = lastBuild(dir, system);
  if (last && tree && last.tree === tree && fs.existsSync(last.app)) {
    o.log?.(`The app for the ${word} is built already from this code (${tree.slice(0, 12)}), so squad-kit uses it`);
    return last;
  }
  // An Android build gets squad-kit's own Android settings only: one of the person's (ANDROID_SDK_HOME) could point it at theirs.
  const base = system === 'android' ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANDROID_'))) : process.env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    LANG: process.env.LANG || 'en_US.UTF-8',
    COCOAPODS_DISABLE_STATS: 'true',
    ...(system === 'android' ? androidBuildEnv(home) : {}),
  };
  ownFolder(dir, system);
  o.say?.(`Building the app for the ${word}, ${aboutWords(stepSeconds('build', home, o.phone))}`);
  const t0 = Date.now();
  let plan: BuildPlan | null = null;
  try {
    // An Expo app gets its phone folder first, made by Expo itself, kept out of git in this copy and out of every commit.
    if (needsPrebuild(dir, kind, system) || prebuiltIn(dir).some((f) => path.resolve(topOf(dir), f) === path.join(dir, system))) {
      await runStep(prebuildStep(system), dir, { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, o);
      if (exists(path.join(dir, system))) markPrebuilt(dir, [system]);
    }
    plan = system === 'android' ? androidPlan(dir, kind) : buildPlan(dir, kind);
    if (!plan) throw new BuildFailed(`squad-kit could not find the app's ${system === 'android' ? 'Android' : 'iPhone'} project in this story's copy.`, system === 'android' ? `No Gradle project (gradlew) in ${dir} or ${path.join(dir, 'android')}` : `No .xcworkspace or .xcodeproj in ${kind === 'react-native' ? path.join(dir, 'ios') : dir}`);
    for (const s of plan.steps) await runStep(s, dir, env, o);
  } finally {
    // Gradle's helper ends with the build, and what the build changed in the story's own files goes back.
    if (plan?.gradle) await stopGradle(plan.gradle, env, o);
    if (tree) {
      const back = await putCopyBack(dir, tree).catch(() => []);
      if (back.length) o.log?.(`The build changed ${back.length} of the story's files, so squad-kit put them back: ${back.slice(0, 8).join(', ')}${back.length > 8 ? ', …' : ''}`);
    }
  }
  const app = plan.apks ? apkIn(plan.apks) : appIn(plan.products);
  if (!app) throw new BuildFailed(`The app did not build for the ${word}.`, `The build ended well, but no ${plan.apks ? '.apk' : '.app'} is in ${(plan.apks ?? [plan.products]).join(', ')}`);
  const seconds = (Date.now() - t0) / 1000;
  noteStep('build', seconds, home, o.phone);
  const built: Built = { app, ...(tree ? { tree } : {}), at: new Date().toISOString(), seconds: Math.round(seconds) };
  fs.writeFileSync(recordFile(dir, system), `${JSON.stringify(built, null, 2)}\n`);
  o.log?.(`squad-kit built the app for the ${word} in ${Math.round(seconds)} s: ${app}`);
  return built;
}

/** One build command in the copy; a failed one throws BuildFailed with its end. */
async function runStep(s: BuildStep, dir: string, env: NodeJS.ProcessEnv, o: { log?(text: string): void; signal?: AbortSignal; phone?: PhoneModule; system?: PhoneSystem }): Promise<void> {
  if (o.signal?.aborted) throw new Error('You stopped the squad.');
  o.log?.(`squad-kit runs ${s.what} in ${path.join(dir, s.cwd)}: ${s.cmd} ${s.args.join(' ')}`);
  const r = await runner(s.cmd, s.args, { cwd: path.join(dir, s.cwd), env, ...(o.signal ? { signal: o.signal } : {}), timeoutMs: BUILD_MS });
  if (o.signal?.aborted) throw new Error('You stopped the squad.');
  const word = wordOf(o.system ?? (s.what.includes('Android') ? 'android' : 'ios'), o.phone);
  if (!r.ok) throw new BuildFailed(`The app did not build for the ${word}.`, `${s.cmd} ${s.args.join(' ')} in ${path.join(dir, s.cwd)}:\n${tail(r.output)}`);
}

/** Stops the Gradle helper of squad-kit's Gradle home: `gradlew --stop`, which stops only that home's helpers. */
async function stopGradle(root: string, env: NodeJS.ProcessEnv, o: { log?(text: string): void }): Promise<void> {
  const gradlew = gradlewIn(root);
  if (!exists(gradlew)) return;
  const r = await runner(gradlew, ['--stop'], { cwd: root, env, timeoutMs: STOP_MS }).catch(() => ({ ok: false, output: '' }));
  o.log?.(r.ok ? "squad-kit stopped Gradle's helper after the build" : `Gradle's helper did not stop: ${tail(r.output, 5)}`);
}

function topOf(dir: string): string {
  let at = path.resolve(dir);
  while (!exists(path.join(at, '.git')) && path.dirname(at) !== at) at = path.dirname(at);
  return exists(path.join(at, '.git')) ? at : dir;
}
