import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildRun } from '../src/engine/phone/build.js';

/**
 * Building the story's app for the iPhone simulator, in its own copy, by kind: Flutter, React Native (after CocoaPods)
 * and a native iPhone app. It builds again only when the copy's code changed, keeps how long it took for the next
 * "about N minutes", and its own build folder never shows as a change of the story. No real build runs here.
 */

const { BUILD_DIR, appIn, buildForPhone, buildPlan, lastBuild, useBuildRun, BuildFailed } = await import('../src/engine/phone/build.js');
const { stepSeconds } = await import('../src/engine/phone/times.js');

let tmp: string;
let ran: string[];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** A copy with a Flutter app in it, under git like a story's copy. */
function flutterCopy(): string {
  const dir = path.join(tmp, 'copy');
  fs.mkdirSync(path.join(dir, 'ios', 'Runner.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '/build/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'app');
  return dir;
}

/** A made-up build that makes the app where the real one would. */
const fakeBuild: BuildRun = async (cmd, args, o) => {
  ran.push(`${cmd} ${args.join(' ')} @ ${path.basename(o.cwd)}`);
  if (cmd === 'flutter') fs.mkdirSync(path.join(o.cwd, 'build', 'ios', 'iphonesimulator', 'Runner.app'), { recursive: true });
  const derived = args[args.indexOf('-derivedDataPath') + 1];
  if (cmd === 'xcodebuild' && derived) {
    const config = args[args.indexOf('-configuration') + 1];
    fs.mkdirSync(path.join(derived, 'Build', 'Products', `${config}-iphonesimulator`, 'App.app'), { recursive: true });
    fs.mkdirSync(path.join(derived, 'Build', 'Products', `${config}-iphonesimulator`, 'AppTests.app'), { recursive: true });
  }
  return { ok: true, output: 'built' };
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-build-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  ran = [];
  useBuildRun(fakeBuild);
});
afterEach(() => {
  useBuildRun(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the build command for each kind of app', () => {
  it('Flutter builds for the simulator with its own command', () => {
    const plan = buildPlan('/c', 'flutter')!;
    expect(plan.steps.map((s) => `${s.cmd} ${s.args.join(' ')}`)).toEqual(['flutter build ios --simulator --debug']);
    expect(plan.products).toBe('/c/build/ios/iphonesimulator');
  });

  it('React Native: CocoaPods first, then Xcode on its workspace, Release so the app carries its own code', () => {
    const dir = path.join(tmp, 'rn');
    fs.mkdirSync(path.join(dir, 'ios', 'Wasl.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ios', 'Wasl.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ios', 'Podfile'), "platform :ios, '15.0'\n");
    const plan = buildPlan(dir, 'react-native')!;
    expect(plan.steps.map((s) => `${s.cmd} ${s.args.join(' ')} @ ${s.cwd}`)).toEqual([
      'pod install @ ios',
      `xcodebuild -workspace ${dir}/ios/Wasl.xcworkspace -scheme Wasl -configuration Release -sdk iphonesimulator -destination generic/platform=iOS Simulator -derivedDataPath ${dir}/${BUILD_DIR}/xcode build @ ios`,
    ]);
    expect(plan.products).toBe(`${dir}/${BUILD_DIR}/xcode/Build/Products/Release-iphonesimulator`);
  });

  it('a native iPhone app builds its Xcode project, with no CocoaPods when it has no Podfile', () => {
    const dir = path.join(tmp, 'native');
    fs.mkdirSync(path.join(dir, 'Notes.xcodeproj'), { recursive: true });
    const plan = buildPlan(dir, 'ios')!;
    expect(plan.steps.map((s) => s.cmd)).toEqual(['xcodebuild']);
    expect(plan.steps[0]!.args.slice(0, 6)).toEqual(['-project', `${dir}/Notes.xcodeproj`, '-scheme', 'Notes', '-configuration', 'Debug']);
    expect(buildPlan(path.join(tmp, 'nothing'), 'ios')).toBeNull();
  });

  it('the built app is the one that is not a test runner', () => {
    const products = path.join(tmp, 'p');
    fs.mkdirSync(path.join(products, 'AppTests.app'), { recursive: true });
    fs.mkdirSync(path.join(products, 'App.app'), { recursive: true });
    expect(appIn(products)).toBe(path.join(products, 'App.app'));
  });
});

describe('building in the story\'s copy', () => {
  it('builds once, then again only when the code changed; keeps the time; its folder never shows as a change', async () => {
    const dir = flutterCopy();
    const lines: string[] = [];
    const first = await buildForPhone(dir, 'flutter', { say: (t) => lines.push(t) });
    expect(first.app).toBe(path.join(dir, 'build', 'ios', 'iphonesimulator', 'Runner.app'));
    expect(lines).toEqual(['Building the app for the iPhone, about 5 minutes']);
    expect(ran).toEqual(['flutter build ios --simulator --debug @ copy']);
    expect(lastBuild(dir)?.tree).toBe(first.tree);
    // The time it took is kept with the tools' times, for the next "about N minutes".
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'home', 'tools', 'times.json'), 'utf8'))).toHaveProperty('iphone-build');
    expect(stepSeconds('build')).toBe(1);
    // The same code: the same app, no build.
    const again = await buildForPhone(dir, 'flutter');
    expect(again.app).toBe(first.app);
    expect(ran).toHaveLength(1);
    // Nothing of squad-kit's build folder shows as a change of the story.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // A change in the code: it builds again.
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() { print(1); }\n');
    await buildForPhone(dir, 'flutter');
    expect(ran).toHaveLength(2);
  });

  it('a build that does not work says so plainly, with the command and its last lines for engineers', async () => {
    const dir = flutterCopy();
    useBuildRun(async () => ({ ok: false, output: 'Error (Xcode): Target debug_unpack_ios failed\nEncountered error while building for simulator.' }));
    const err = (await buildForPhone(dir, 'flutter').catch((e: unknown) => e)) as InstanceType<typeof BuildFailed>;
    expect(err).toBeInstanceOf(BuildFailed);
    expect(err.message).toBe('The app did not build for the iPhone.');
    expect(err.detail).toContain('flutter build ios --simulator --debug');
    expect(err.detail).toContain('Target debug_unpack_ios failed');
    expect(lastBuild(dir)).toBeNull();
  });
});
