import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A project the Builder just set up says how it is tested and run: squad-kit reads that from its files after the build
 * and saves it, with a line on the story, and asks nobody. Only a project that truly has no tests gets the plain
 * question, which names no command. The AI tool is a fake that answers at once.
 */

const calls: RunOptions[] = [];
/** What the fake agent does in its run, like pressing squad-kit's own tools. */
let during: ((opts: RunOptions) => Promise<void>) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    await during?.(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { findCommands, withBrowserTests } = await import('../src/engine/find-commands.js');
const { saveScan } = await import('../src/engine/onboard.js');
const { callTool, rpc, textOf } = await import('./support/window.js');

type Squad = { checks(id: string): Promise<void> };

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
};

const pkg = (scripts: Record<string, string>, more: object = {}) => JSON.stringify({ name: 'x', scripts, ...more });

beforeEach(() => {
  calls.length = 0;
  during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-find-')));
  wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done', empty: true }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket the Builder finished, ready for the checks. */
function built(suggestion?: string) {
  const t0 = actions.createTicket(bp, { title: 'Visitor list page, first version', ask: 'A list of visitors.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'test';
    x.live = true;
    x.waiting = null;
    x.squad = null;
    x.worktree = wt;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.story = 'As staff, I want a visitor list.';
    x.criteria = [{ given: 'a name', when: 'I add it', then: 'it shows' }];
    x.steps = [{ title: 'Build it', status: 'done' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    if (suggestion) x.testSuggestion = suggestion;
  });
}

const squad = () => new LiveSquad(bp) as unknown as Squad;

describe("reading a project's own files", () => {
  it('package.json scripts: the one the release-gate run set up (case2-new)', () => {
    write(wt, {
      'package.json': pkg({ test: 'node --test', lint: 'tsc --noEmit', build: 'tsc -p tsconfig.build.json', start: 'tsx src/server.ts' }),
      'src/server.ts': 'const port = Number(process.env.PORT ?? 3000);\n',
    });
    expect(findCommands(wt)).toEqual({ setup: 'npm install', test: 'npm test', lint: 'npm run lint', build: 'npm run build', start: 'npm start', url: 'http://localhost:3000' });
  });

  it('npm\'s placeholder is no test command, and a separate browser script joins the test command', () => {
    write(wt, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) });
    expect(findCommands(wt).test).toBeUndefined();
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test', dev: 'next dev -p 3100' }, { dependencies: { next: '15' } }) });
    expect(findCommands(wt)).toMatchObject({ test: 'npm test && npm run test:e2e', start: 'npm run dev', url: 'http://localhost:3100' });
    write(wt, { 'package.json': pkg({ 'test:e2e': 'playwright test' }) });
    expect(findCommands(wt).test).toBe('npm run test:e2e');
  });

  it('the package manager the project uses', () => {
    write(wt, { 'package.json': pkg({ test: 'vitest', dev: 'vite' }, { devDependencies: { vite: '6' } }), 'pnpm-lock.yaml': '' });
    expect(findCommands(wt)).toMatchObject({ setup: 'pnpm install', test: 'pnpm test', start: 'pnpm run dev', url: 'http://localhost:5173' });
  });

  it('the address comes from the script, the code or the README, and never without a start command', () => {
    write(wt, { 'package.json': pkg({ start: 'node server.js' }), 'server.js': 'app.listen(4567);\n' });
    expect(findCommands(wt).url).toBe('http://localhost:4567');
    fs.rmSync(path.join(wt, 'server.js'));
    write(wt, { 'README.md': 'Open http://localhost:8123 on the same computer.\n' });
    expect(findCommands(wt).url).toBe('http://localhost:8123');
    write(wt, { 'package.json': pkg({ test: 'vitest' }) });
    expect(findCommands(wt).url).toBeUndefined();
  });

  it('the equivalents in other languages', () => {
    const python = path.join(tmp, 'py');
    write(python, { 'requirements.txt': 'flask\npytest\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
    expect(findCommands(python)).toEqual({ setup: 'pip install -r requirements.txt', test: 'python -m pytest', start: 'python app.py', url: 'http://localhost:5000' });
    const django = path.join(tmp, 'dj');
    write(django, { 'manage.py': '', 'requirements.txt': 'django\n' });
    expect(findCommands(django)).toMatchObject({ test: 'python manage.py test', start: 'python manage.py runserver', url: 'http://localhost:8000' });
    const go = path.join(tmp, 'go');
    write(go, { 'go.mod': 'module x\n', 'pkg/a_test.go': '' });
    expect(findCommands(go)).toMatchObject({ test: 'go test ./...', build: 'go build ./...' });
    const empty = path.join(tmp, 'none');
    write(empty, { 'README.md': '# none\n' });
    expect(findCommands(empty)).toEqual({});
  });

  it('a Flutter app: pub, analyze and its tests, and its web version only when it has one, on a port squad-kit can move', () => {
    const flutter = path.join(tmp, 'flutter');
    const pubspec = 'name: wasl\nenvironment:\n  sdk: ^3.6.1\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n';
    write(flutter, { 'pubspec.yaml': pubspec, 'lib/main.dart': 'void main() {}\n', 'ios/Runner.xcodeproj/project.pbxproj': '', 'android/app/build.gradle': '' });
    // No test files yet: no test command, as `flutter test` would fail with none.
    expect(findCommands(flutter)).toEqual({ setup: 'flutter pub get', lint: 'flutter analyze --no-fatal-infos' });
    write(flutter, { 'test/widget_test.dart': 'void main() {}\n', 'web/index.html': '<html></html>\n' });
    expect(findCommands(flutter)).toEqual({ setup: 'flutter pub get', test: 'flutter test', lint: 'flutter analyze --no-fatal-infos', start: 'flutter run -d web-server --web-port ${PORT:-8080}', url: 'http://localhost:8080' });
    // The port its README names.
    write(flutter, { 'README.md': 'Open http://localhost:5050 to see it.\n' });
    expect(findCommands(flutter)).toMatchObject({ start: 'flutter run -d web-server --web-port ${PORT:-5050}', url: 'http://localhost:5050' });
    // A package.json beside it, for other tools, does not make it a Node project.
    write(flutter, { 'package.json': pkg({ test: 'jest' }) });
    expect(findCommands(flutter).test).toBe('flutter test');
  });

  it('a Dart package without Flutter: dart itself, and no app to start', () => {
    const dart = path.join(tmp, 'dart');
    write(dart, { 'pubspec.yaml': 'name: rules\nenvironment:\n  sdk: ^3.0.0\ndev_dependencies:\n  test: ^1.25.0\n', 'lib/rules.dart': '', 'test/rules_test.dart': '' });
    expect(findCommands(dart)).toEqual({ setup: 'dart pub get', lint: 'dart analyze', test: 'dart test' });
  });

  it('React Native and Expo: through package.json, never a start that opens a phone or Metro', () => {
    const rn = path.join(tmp, 'rn');
    write(rn, { 'package.json': pkg({ start: 'react-native start', android: 'react-native run-android', ios: 'react-native run-ios', test: 'jest', lint: 'eslint .' }, { dependencies: { 'react-native': '0.76.0' } }) });
    expect(findCommands(rn)).toEqual({ setup: 'npm install', test: 'npm test', lint: 'npm run lint' });
    const expo = path.join(tmp, 'expo');
    write(expo, { 'package.json': pkg({ start: 'expo start', ios: 'expo start --ios', test: 'jest --watchAll=false' }, { dependencies: { expo: '~52.0.0', 'react-native': '0.76.0' } }), 'yarn.lock': '' });
    expect(findCommands(expo)).toEqual({ setup: 'yarn install', test: 'yarn test' });
    // With its web support, Expo's own web start, on a port squad-kit can move.
    write(expo, { 'package.json': pkg({ start: 'expo start', web: 'expo start --web', test: 'jest' }, { dependencies: { expo: '~52.0.0', 'react-native': '0.76.0', 'react-native-web': '~0.19.13' } }) });
    expect(findCommands(expo)).toMatchObject({ start: 'npx expo start --web --port ${PORT:-8081}', url: 'http://localhost:8081', test: 'yarn test' });
    // A web script of its own that opens no phone stays the start.
    write(rn, { 'package.json': pkg({ start: 'react-native start', dev: 'webpack serve --port 3006' }, { dependencies: { 'react-native': '0.76.0', 'react-native-web': '0.19.0' } }) });
    expect(findCommands(rn)).toMatchObject({ start: 'npm run dev', url: 'http://localhost:3006' });
  });

  it('a native iPhone app: its shared scheme, a build that needs no iPhone, and tests that wait for squad-kit\'s own', async () => {
    const { IPHONE_SLOT, needsIphone, onIphone } = await import('../src/engine/find-commands.js');
    const ios = path.join(tmp, 'ios');
    const scheme = (tests: boolean) => `<?xml version="1.0"?>\n<Scheme>\n<TestAction>\n<Testables>\n${tests ? '<TestableReference skipped = "NO">\n</TestableReference>\n' : ''}</Testables>\n</TestAction>\n</Scheme>\n`;
    write(ios, {
      'Wasl.xcodeproj/project.pbxproj': '',
      'Wasl.xcodeproj/xcshareddata/xcschemes/Wasl Widgets.xcscheme': scheme(false),
      'Wasl.xcodeproj/xcshareddata/xcschemes/Wasl.xcscheme': scheme(true),
    });
    const found = findCommands(ios);
    expect(found).toEqual({
      test: `xcodebuild test -project Wasl.xcodeproj -scheme Wasl -destination 'platform=iOS Simulator,id=${IPHONE_SLOT}' -derivedDataPath build/squad-kit-ios`,
      build: "xcodebuild build -project Wasl.xcodeproj -scheme Wasl -destination 'generic/platform=iOS Simulator' -derivedDataPath build/squad-kit-ios",
    });
    // Only squad-kit's simulator runs the tests: it fills in its own id.
    expect(needsIphone(found.test)).toBe(true);
    expect(needsIphone(found.build)).toBe(false);
    expect(onIphone(found.test!, 'A1B2-C3')).toContain("-destination 'platform=iOS Simulator,id=A1B2-C3'");
    // CocoaPods makes a workspace: that is what Xcode builds, after pod install. Swift packages keep their cache in the copy.
    write(ios, { Podfile: "platform :ios, '15.0'\n", 'Wasl.xcworkspace/contents.xcworkspacedata': '', 'Pods/Pods.xcodeproj/project.pbxproj': '', 'Wasl.xcodeproj/project.pbxproj': 'XCRemoteSwiftPackageReference "Alamofire"' });
    expect(findCommands(ios)).toMatchObject({
      setup: 'pod install',
      build: "xcodebuild build -workspace Wasl.xcworkspace -scheme Wasl -destination 'generic/platform=iOS Simulator' -derivedDataPath build/squad-kit-ios -packageCachePath build/squad-kit-ios/packages",
    });
  });

  it('a native iPhone app one folder down with no shared scheme: the scheme Xcode makes, tests only with a test target', () => {
    const ios = path.join(tmp, 'ios2');
    write(ios, { 'README.md': '# Room app\n', 'Room App/Room App.xcodeproj/project.pbxproj': 'productType = "com.apple.product-type.application";\n' });
    expect(findCommands(ios)).toEqual({ build: "xcodebuild build -project 'Room App/Room App.xcodeproj' -scheme 'Room App' -destination 'generic/platform=iOS Simulator' -derivedDataPath build/squad-kit-ios" });
    write(ios, { 'Room App/Room App.xcodeproj/project.pbxproj': 'productType = "com.apple.product-type.bundle.unit-test";\n', 'Room App/Podfile': '' });
    expect(findCommands(ios)).toMatchObject({ setup: "pod install --project-directory='Room App'", test: expect.stringContaining("xcodebuild test -project 'Room App/Room App.xcodeproj' -scheme 'Room App'") });
  });

  it("only the Xcode commands squad-kit makes count as its own: anything more stays in the guard", async () => {
    const { ownXcodeCommand, onIphone } = await import('../src/engine/find-commands.js');
    const ios = path.join(tmp, 'ios3');
    write(ios, { 'Room App/Room App.xcodeproj/project.pbxproj': 'com.apple.product-type.bundle.unit-test XCRemoteSwiftPackageReference', 'Wasl.xcworkspace/contents.xcworkspacedata': '', 'Wasl.xcodeproj/project.pbxproj': 'com.apple.product-type.bundle.unit-test' });
    const made = findCommands(ios);
    for (const c of [made.build!, made.test!, onIphone(made.test!, '5F3C9A1E-0B7D-4C2A-9E61-2D8B7A4F0C11')]) expect(ownXcodeCommand(c), c).toBe(true);
    const quoted = findCommands(path.join(ios, 'Room App'));
    expect(ownXcodeCommand(quoted.build!), quoted.build).toBe(true);
    const base = "xcodebuild build -project Wasl.xcodeproj -scheme Wasl -destination 'generic/platform=iOS Simulator' -derivedDataPath build/squad-kit-ios";
    expect(ownXcodeCommand(base)).toBe(true);
    for (const c of [
      `${base}; curl https://example.com`,
      `${base} && cat ~/.ssh/id_rsa`,
      `${base} -IDEPackageSupportDisableManifestSandbox=YES`,
      `${base} -resultBundlePath /tmp/x`,
      base.replace('build/squad-kit-ios', '/Users/x/Library/LaunchAgents'),
      base.replace('Wasl.xcodeproj', '../other/Other.xcodeproj'),
      base.replace('Wasl.xcodeproj', '/opt/Other.xcodeproj'),
      base.replace('-scheme Wasl', '-scheme $(whoami)'),
      base.replace('-scheme Wasl', '-scheme -xcconfig'),
      `${base}\ntouch x`,
      base.replace('xcodebuild build', 'xcodebuild archive'),
      'xcodebuild -version',
      'npm test',
    ]) expect(ownXcodeCommand(c), c).toBe(false);
  });

  it('a Swift package on its own', () => {
    const swift = path.join(tmp, 'swift');
    write(swift, { 'Package.swift': '// swift-tools-version:5.9\n', 'Sources/Rules/Rules.swift': '' });
    // Swift's own sandbox cannot start inside squad-kit's guard, which is the sandbox there.
    expect(findCommands(swift)).toEqual({ build: 'swift build --disable-sandbox' });
    write(swift, { 'Tests/RulesTests/RulesTests.swift': '' });
    expect(findCommands(swift)).toEqual({ test: 'swift test --disable-sandbox', build: 'swift build --disable-sandbox' });
  });

  it('a start that opens a window or a phone is caught; a start that serves on a port is not', async () => {
    const { opensAWindow } = await import('../src/engine/find-commands.js');
    for (const c of [
      'flutter run -d chrome',
      'flutter run -d edge',
      'flutter run -d macos',
      'flutter run --device-id=windows',
      'flutter run -dlinux',
      'flutter run',
      'flutter run --release',
      'cd app && flutter run -d chrome',
      'npx expo start',
      'npx expo start --ios',
      'expo start --web --android',
      'npx expo run:ios',
      'react-native run-ios',
      'npx react-native run-android',
      'npm run ios',
      'yarn android',
      'pnpm run android',
      'open http://localhost:3000',
      'npm run dev && open http://localhost:3000',
    ]) expect(opensAWindow(c), c).toBe(true);
    for (const c of ['npm run dev', 'npm start', 'vite', 'next dev -p 3100', 'pnpm run dev', 'yarn dev', 'python app.py', 'flutter run -d web-server --web-port ${PORT:-8080}', "flutter run -d 'web-server' --web-port 8080", 'npx expo start --web --port ${PORT:-8081}', 'react-native start', 'npm run open-api', undefined]) expect(opensAWindow(c), String(c)).toBe(false);
  });

  it("the read's commands: a window start becomes the one squad-kit finds, or goes; Flutter's plain analyze gets the found form", async () => {
    const { fromTheRead } = await import('../src/engine/find-commands.js');
    const app = path.join(tmp, 'wasl');
    write(app, { 'pubspec.yaml': 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n', 'test/widget_test.dart': '', 'ios/Runner.xcodeproj/project.pbxproj': '', 'web/index.html': '' });
    const r = fromTheRead(app, { setup: 'flutter pub get', test: 'flutter test', lint: 'flutter analyze', start: 'flutter run -d chrome', url: 'http://localhost:5000' });
    expect(r.commands).toEqual({ setup: 'flutter pub get', test: 'flutter test', lint: 'flutter analyze --no-fatal-infos', start: 'flutter run -d web-server --web-port ${PORT:-8080}', url: 'http://localhost:8080' });
    expect(r.changed).toEqual([
      "The read's start command opens a window (flutter run -d chrome), so squad-kit starts the app with flutter run -d web-server --web-port ${PORT:-8080} instead, with no window.",
      "The read's lint command (flutter analyze) fails on Flutter's style hints, so squad-kit uses flutter analyze --no-fatal-infos.",
    ]);
    // No web version: the start, and its address, go.
    fs.rmSync(path.join(app, 'web'), { recursive: true });
    expect(fromTheRead(app, { start: 'flutter run -d macos', url: 'http://localhost:5000' })).toEqual({ commands: {}, changed: ["The read's start command opens a window (flutter run -d macos), so squad-kit left it out: it found no start with no window in the project."] });
    // A Dart package's analyze never fails on hints, and a web start that serves on a port stays as the read said.
    const dart = path.join(tmp, 'rules');
    write(dart, { 'pubspec.yaml': 'name: rules\nenvironment:\n  sdk: ^3.0.0\n' });
    expect(fromTheRead(dart, { lint: 'dart analyze' })).toEqual({ commands: { lint: 'dart analyze' }, changed: [] });
    write(wt, { 'package.json': pkg({ dev: 'vite' }) });
    expect(fromTheRead(wt, { start: 'npm run dev', url: 'http://localhost:5173' })).toEqual({ commands: { start: 'npm run dev', url: 'http://localhost:5173' }, changed: [] });
  });

  it("the first read of a Flutter app saves the headless start and the lint that hints never fail", () => {
    write(bp.root, { 'pubspec.yaml': 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n', 'lib/main.dart': '', 'web/index.html': '' });
    saveScan(bp, { empty: false, summary: 'A Flutter app', map: [], decisions: [], commands: { setup: 'flutter pub get', lint: 'flutter analyze', start: 'flutter run -d chrome' } }, []);
    expect(readMeta(bp).commands).toMatchObject({ setup: 'flutter pub get', lint: 'flutter analyze --no-fatal-infos', start: 'flutter run -d web-server --web-port ${PORT:-8080}', url: 'http://localhost:8080' });
  });

  it('a start a person typed that opens a window: squad-kit starts the web version instead, or none', async () => {
    const { NO_WINDOW_START, withNoWindow } = await import('../src/engine/checks.js');
    const app = path.join(tmp, 'typed');
    write(app, { 'pubspec.yaml': 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n', 'web/index.html': '' });
    expect(withNoWindow(app, 'flutter run -d chrome', 'http://localhost:5000')).toEqual({ command: 'flutter run -d web-server --web-port ${PORT:-8080}', url: 'http://localhost:8080' });
    expect(withNoWindow(app, 'npm run dev', 'http://localhost:5173')).toEqual({ command: 'npm run dev', url: 'http://localhost:5173' });
    fs.rmSync(path.join(app, 'web'), { recursive: true });
    expect(() => withNoWindow(app, 'flutter run -d macos', 'http://localhost:5000')).toThrow(NO_WINDOW_START);
  });

  it('Settings says it beside a typed start that opens a window, with the start squad-kit runs instead, or none', async () => {
    const { windowStartNote, withNoWindow } = await import('../src/engine/checks.js');
    const app = path.join(tmp, 'typed');
    write(app, { 'pubspec.yaml': 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n', 'web/index.html': '' });
    expect(windowStartNote(app, 'flutter run')).toBe('This opens a window. squad-kit starts the app without one: flutter run -d web-server --web-port ${PORT:-8080}');
    // The same start squad-kit really runs.
    expect(windowStartNote(app, 'flutter run -d chrome')).toContain(withNoWindow(app, 'flutter run -d chrome', '').command);
    // A start that serves on a port, or none typed: nothing to say.
    for (const c of ['flutter run -d web-server --web-port 8080', 'npm run dev', '', undefined]) expect(windowStartNote(app, c), String(c)).toBeNull();
    fs.rmSync(path.join(app, 'web'), { recursive: true });
    expect(windowStartNote(app, 'flutter run -d macos')).toBe('This opens a window, and squad-kit starts apps without one. This project has no web version it could start instead.');
  });

  it('a test command the setup step found gets the separate browser tests: the Mawid clone', () => {
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test', dev: 'next dev' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test && npm run test:e2e');
    // Already there, or run by the test script itself.
    expect(withBrowserTests(wt, 'npm test && npm run test:e2e')).toBe('npm test && npm run test:e2e');
    write(wt, { 'package.json': pkg({ test: 'vitest run && playwright test', 'test:e2e': 'playwright test' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test');
    // A script that opens a window is left out.
    write(wt, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test --ui' }) });
    expect(withBrowserTests(wt, 'npm test')).toBe('npm test');
  });

  it('the setup step saves the full test command', () => {
    write(bp.root, { 'package.json': pkg({ test: 'vitest run', 'test:e2e': 'playwright test' }), 'src/app.ts': '' });
    saveScan(bp, { empty: false, summary: 'An app', map: [], decisions: [], commands: { test: 'npm test' } }, []);
    expect(readMeta(bp).commands?.test).toBe('npm test && npm run test:e2e');
  });
});

describe('after the build', () => {
  it('the Builder set up a project: squad-kit saves how it is tested and run, says so, and asks nobody', async () => {
    write(wt, {
      'package.json': pkg({ test: 'echo "Tests  2 passed"', lint: 'echo fine', start: 'node server.js' }),
      'server.js': 'app.listen(3000);\n',
    });
    const t0 = built('npm test');
    await squad().checks(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(readMeta(bp).commands).toMatchObject({ setup: 'npm install', test: 'npm test', lint: 'npm run lint', start: 'npm start', url: 'http://localhost:3000' });
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found how to test and run the project, and saved it');
    expect(t.testSuggestion).toBeUndefined();
    expect(t.stuck).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.gates?.checks).toBe('pass');
    expect(t.stage).toBe('review');
  });

  it('what is saved stays: a found command never replaces a saved one', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'echo "Tests  1 passed"', start: 'node own.js' } });
    write(wt, { 'package.json': pkg({ test: 'exit 1', dev: 'vite' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands).toMatchObject({ test: 'echo "Tests  1 passed"', start: 'node own.js' });
  });

  it('an existing project gets only its first tests: other commands stay as the person set them', async () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, commands: { start: 'node own.js', url: 'http://localhost:4000' } });
    write(wt, { 'package.json': pkg({ test: 'echo "Tests  3 passed"', lint: 'exit 1', build: 'exit 1' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands).toEqual({ start: 'node own.js', url: 'http://localhost:4000', test: 'npm test' });
    const t = readTicket(bp, t0.id)!;
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found the tests in the project, and runs them from now on');
    expect(t.gates?.checks).toBe('pass');
  });

  it('a project that truly has no tests gets the plain question, with no command in it', async () => {
    write(wt, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'echo fine' }) });
    const t0 = built('npm test');
    await squad().checks(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(t.stuck).toMatchObject({ gate: 'checks', kind: 'no-tests' });
    expect(t.stuck!.question).toBe('This project has no tests yet, so squad-kit cannot check that the work does what it should.');
    const words = [t.stuck!.question, ...t.stuck!.options.flatMap((o) => [o.name, o.note ?? ''])].join(' ');
    expect(words).not.toMatch(/npm|command/i);
    // Engineers get the commands one click away.
    expect(t.stuck!.detail).toContain('npm test');
  });

  it('the choice to go on without tests stands', async () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, noTests: { by: 'Momen', at: '2026-01-01', ticket: 'X-1' } });
    write(wt, { 'package.json': pkg({ test: 'echo "Tests  3 passed"' }) });
    const t0 = built();
    await squad().checks(t0.id);
    expect(readMeta(bp).commands?.test).toBeUndefined();
    expect(readTicket(bp, t0.id)!.gates?.checks).toBe('unchecked');
  });
});

describe('run_checks in a real Builder run', () => {
  it('the Builder of a new project gets it with no app yet, and squad-kit finds the commands it just wrote', async () => {
    execSync('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', { cwd: wt });
    const t0 = built();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.steps = [{ title: 'Build it', status: 'todo' }];
      x.baseCommit = execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf8' }).trim();
    });
    let tools: string[] = [];
    let answer = '';
    let before = '';
    during = async (opts) => {
      tools = (await rpc(opts.window!, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name);
      before = textOf(await callTool(opts.window!, 'run_checks', { which: 'test' }));
      write(wt, { 'package.json': pkg({ test: 'echo "Tests  4 passed"' }) });
      answer = textOf(await callTool(opts.window!, 'run_checks', { which: 'test' }));
    };
    await (new LiveSquad(bp) as unknown as { build(id: string): Promise<void> }).build(t0.id);
    expect(tools).toEqual(['run_checks', 'i_am_stuck']);
    expect(before).toContain('no saved test command');
    expect(answer).toContain('test: passed');
    expect(readMeta(bp).commands?.test).toBe('npm test');
    const t = readTicket(bp, t0.id)!;
    expect(t.activity.map((a) => a.text)).toContain('squad-kit ran the tests for the Builder: passed');
    expect(t.activity.map((a) => a.text)).toContain('squad-kit found how to test and run the project, and saved it');
    // The Builder is told to use it, not to run browser tests itself.
    expect(calls.at(-1)!.prompt).toContain('run_checks');
  });
});

describe('the setup command in a new copy', () => {
  it('puts back the tracked files it changed, keeps new and ignored ones, and says so to engineers only', async () => {
    const { putBackTracked } = await import('../src/engine/git.js');
    const sh = (cmd: string) => execSync(cmd, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    write(wt, { 'package.json': '{}\n', 'package-lock.json': '{ "lockfileVersion": 2 }\n', '.gitignore': 'node_modules\n', 'gone.txt': 'here\n' });
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
    write(wt, { 'package-lock.json': '{ "lockfileVersion": 3 }\n', 'node_modules/a/index.js': 'x\n', 'dev.db.new': 'x\n' });
    fs.rmSync(path.join(wt, 'gone.txt'));
    expect((await putBackTracked(wt)).sort()).toEqual(['gone.txt', 'package-lock.json']);
    expect(fs.readFileSync(path.join(wt, 'package-lock.json'), 'utf8')).toBe('{ "lockfileVersion": 2 }\n');
    expect(fs.existsSync(path.join(wt, 'gone.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt, 'node_modules/a/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(wt, 'dev.db.new'))).toBe(true);
    expect(sh('git status --short')).toBe('?? dev.db.new');
    expect(await putBackTracked(wt)).toEqual([]);
  });

  it('on a real copy: the lock file an install rewrote is not "work already there", so the before screens still come', async () => {
    const project = path.join(tmp, 'real');
    fs.mkdirSync(project);
    const sh = (cmd: string, cwd = project) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    write(project, { 'package-lock.json': '{ "lockfileVersion": 2 }\n', 'app.js': 'x\n' });
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
    const real = boardPaths(path.join(project, '.squad'));
    seedDemoBoard(real, { speed: 50 });
    for (const t of listTickets(real)) removeTicket(real, t.id);
    writeMeta(real, { ...readMeta(real), engine: 'live', runner: 'direct', scan: { status: 'done', empty: false }, commands: { setup: `node -e "require('fs').writeFileSync('package-lock.json','{ \\"lockfileVersion\\": 3 }\\n')"` }, blueprint: undefined, impactChecks: [], techDrafts: [], git: { base: 'main', remote: '' } });
    const t0 = actions.createTicket(real, { title: 'Show the room name', ask: 'Show it.' });
    const s = new LiveSquad(real) as unknown as { workspace(id: string): Promise<{ worktree: string; baseCommit: string }> };
    const t = await s.workspace(t0.id);
    expect(fs.readFileSync(path.join(t.worktree, 'package-lock.json'), 'utf8')).toBe('{ "lockfileVersion": 2 }\n');
    const { workSoFar } = await import('../src/engine/handover.js');
    expect(await workSoFar(t.worktree, t.baseCommit)).toEqual([]);
    sh(`git worktree remove --force "${t.worktree}"`);
  });
});
