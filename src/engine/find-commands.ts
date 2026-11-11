import fs from 'node:fs';
import path from 'node:path';
import type { ProjectCommands } from '../board/types.js';
import { findPortVariables } from './port-vars.js';
import { kindsOf, type Platform, type ProjectKind } from './tools/kinds.js';

/**
 * How to test and run a project, read from its own files with no AI: its package.json scripts and the equivalents in
 * other languages. A project that started empty has nothing saved until the Builder set it up, so squad-kit reads this
 * after the build and nobody is asked. Only what the files really say: a project with no test script has no test
 * command here.
 */

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

/** "http://localhost:3000" for a port, when one is known. */
const at = (port: number | null | undefined) => (port ? `http://localhost:${port}` : undefined);

/** The usual port of a web tool, by the package that brings it. */
const USUAL_PORT: [RegExp, number][] = [
  [/^next$/, 3000],
  [/^react-scripts$/, 3000],
  [/^nuxt$/, 3000],
  [/^@remix-run\//, 3000],
  [/^@angular\/cli$/, 4200],
  [/^astro$/, 4321],
  [/^gatsby$/, 8000],
  [/^@sveltejs\/kit$/, 5173],
  [/^vite$/, 5173],
  [/^express$|^fastify$|^koa$|^hono$/, 3000],
];

/** The port a script says: "--port 8080", "-p 8080", "PORT=8080". */
function portInScript(script: string): number | null {
  const m = /(?:--port[= ]|\s-p[= ]?|\bPORT=)(\d{2,5})\b/.exec(` ${script}`);
  return m ? Number(m[1]) : null;
}

/** The port the project's own code or README names for itself. */
function portInFiles(dir: string): number | null {
  const own = findPortVariables(dir).flatMap((v) => v.defaults)[0];
  if (own) return own;
  const words = /(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?|\.listen\(\s*)(\d{2,5})\b/;
  for (const f of ['server.js', 'server.ts', 'server.mjs', 'app.js', 'app.ts', 'index.js', 'index.ts', 'main.js', 'main.ts', 'src/server.js', 'src/server.ts', 'src/app.js', 'src/app.ts', 'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts']) {
    const m = words.exec(read(path.join(dir, f)));
    if (m) return Number(m[1]);
  }
  const said = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/.exec(read(path.join(dir, 'README.md')));
  return said ? Number(said[1]) : null;
}

/** A script that runs tests in a real browser, on its own: run after the others, and never one that opens a window. */
const BROWSER_SCRIPT = /^(?:test[:-])?(?:e2e|browser|playwright|cypress)(?:[:-]test)?$/i;
const SHOWS_A_WINDOW = /--ui\b|--headed\b|--debug\b|cypress open|\bcodegen\b/;
/** npm's own placeholder, and a project's way of saying it has none. */
const NO_TESTS = /no test specified|no tests? yet|echo\s+['"]?no tests?\b/i;
/** A command or script that runs browser tests by itself. */
const RUNS_BROWSER = /playwright\s+test|cypress\s+run/;

function browserScript(scripts: Record<string, string>): string | undefined {
  return Object.keys(scripts).find((k) => BROWSER_SCRIPT.test(k) && !SHOWS_A_WINDOW.test(scripts[k]!) && !NO_TESTS.test(scripts[k]!));
}

/** A package.json's scripts. */
function scriptsOf(dir: string): Record<string, string> | null {
  if (!has(dir, 'package.json')) return null;
  try {
    const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return null;
  }
}

function runnerOf(dir: string): { install: string; run: (s: string) => string; test: string; start: string } {
  if (has(dir, 'pnpm-lock.yaml')) return { install: 'pnpm install', run: (s) => `pnpm run ${s}`, test: 'pnpm test', start: 'pnpm start' };
  if (has(dir, 'yarn.lock')) return { install: 'yarn install', run: (s) => `yarn ${s}`, test: 'yarn test', start: 'yarn start' };
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return { install: 'bun install', run: (s) => `bun run ${s}`, test: 'bun run test', start: 'bun run start' };
  return { install: 'npm install', run: (s) => `npm run ${s}`, test: 'npm test', start: 'npm start' };
}

/** A project's full test command: the test script, with its separate browser tests after it. */
function nodeTests(dir: string, scripts: Record<string, string>): string | undefined {
  const r = runnerOf(dir);
  const main = scripts.test && !NO_TESTS.test(scripts.test) ? r.test : scripts['test:unit'] ? r.run('test:unit') : undefined;
  const browser = browserScript(scripts);
  if (!main) return browser ? r.run(browser) : undefined;
  return withBrowserTests(dir, main);
}

/**
 * A script that opens a phone, or starts Metro, the phone's own server: never the app's start for the web. React Native's
 * start, run-ios and run-android, and Expo's start without --web and its run:ios and run:android.
 */
const OPENS_A_PHONE = /\breact-native\s+(?:start|run-ios|run-android)\b|\bexpo\s+(?:start\b(?![^&|;]*--web)|run:(?:ios|android)\b)|\bmetro\b/;

/** Expo's web version, on a port squad-kit can move: PORT when squad-kit sets it, else Expo's own 8081. */
export const EXPO_WEB_PORT = 8081;
export const EXPO_WEB_START = `npx expo start --web --port \${PORT:-${EXPO_WEB_PORT}}`;

function nodeCommands(dir: string, scripts: Record<string, string>): ProjectCommands {
  const r = runnerOf(dir);
  const lint = ['lint', 'typecheck', 'type-check', 'check-types', 'types'].find((s) => scripts[s]);
  const test = nodeTests(dir, scripts);
  const deps = (() => {
    try {
      const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { dependencies?: object; devDependencies?: object };
      return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    } catch {
      return [];
    }
  })();
  // A phone app (React Native, with or without Expo) starts for the web only by a script that does not open a phone.
  const phone = deps.includes('react-native') || deps.includes('expo');
  const startScript = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s] && !(phone && OPENS_A_PHONE.test(scripts[s]!)));
  // Expo with its web support: Expo's own web start, whatever the scripts say.
  const expoWeb = deps.includes('expo') && deps.includes('react-native-web');
  const usual = USUAL_PORT.find(([re]) => deps.some((d) => re.test(d)))?.[1];
  const script = startScript ? scripts[startScript]! : '';
  const port = expoWeb ? EXPO_WEB_PORT : startScript ? (portInScript(script) ?? portInFiles(dir) ?? usual ?? null) : null;
  const url = at(port);
  const start = expoWeb ? EXPO_WEB_START : startScript ? (startScript === 'start' ? r.start : r.run(startScript)) : undefined;
  return {
    ...(Object.keys(scripts).length || deps.length ? { setup: r.install } : {}),
    ...(test ? { test } : {}),
    ...(lint ? { lint: r.run(lint) } : {}),
    ...(scripts.build ? { build: r.run('build') } : {}),
    ...(start ? { start } : {}),
    ...(url ? { url } : {}),
  };
}

/* ── Flutter and Dart ───────────────────────────────────── */

/**
 * The commands of a Flutter app. Its web version starts only when it has one. Flutter's style hints (infos) never fail
 * the check, as `flutter analyze` would by default; its warnings and errors still do.
 */
export const FLUTTER_COMMANDS = { setup: 'flutter pub get', lint: 'flutter analyze --no-fatal-infos', test: 'flutter test' } as const;

/** Flutter has no usual port for its web version: this one, when the project's own files say none. */
export const FLUTTER_WEB_PORT = 8080;

/** A Flutter app's web version, on a port squad-kit can move: PORT when squad-kit sets it, else the one given. */
export function flutterWebStart(port: number = FLUTTER_WEB_PORT): string {
  return `flutter run -d web-server --web-port \${PORT:-${port}}`;
}

/** A Flutter app, or a Dart package without Flutter: its pubspec.yaml says which. Tests only when it has test files. */
function dartCommands(dir: string): ProjectCommands | null {
  if (!has(dir, 'pubspec.yaml')) return null;
  const tests = anyFile(path.join(dir, 'test'), (f) => f.endsWith('_test.dart'));
  const { kinds, platforms } = kindsOf(dir);
  if (!kinds.includes('flutter')) return { setup: 'dart pub get', lint: 'dart analyze', ...(tests ? { test: 'dart test' } : {}) };
  const port = platforms.includes('web') ? (portInFiles(dir) ?? FLUTTER_WEB_PORT) : null;
  return {
    setup: FLUTTER_COMMANDS.setup,
    ...(tests ? { test: FLUTTER_COMMANDS.test } : {}),
    lint: FLUTTER_COMMANDS.lint,
    ...(port ? { start: flutterWebStart(port), url: at(port)! } : {}),
  };
}

/* ── native iPhone apps and Swift packages ──────────────── */

/**
 * Where the iPhone goes in a native iPhone app's test command. Those tests run on a simulator, which is squad-kit's own
 * and shared through its queue, so the command is saved with this in place of the simulator's id, and squad-kit fills
 * it in when its simulator runs them (onIphone). Building needs no iPhone, so the build command has none.
 */
export const IPHONE_SLOT = '{iphone}';

/** True when a command runs on the iPhone: only squad-kit's simulator can run it. */
export const needsIphone = (command: string | undefined): boolean => Boolean(command?.includes(IPHONE_SLOT));

/** The command for one simulator, by its id. */
export const onIphone = (command: string, id: string): string => command.split(IPHONE_SLOT).join(id);

/** Xcode's build folder, inside each copy, so no two stories share one (and the person's own DerivedData stays theirs). */
export const XCODE_BUILD_DIR = 'build/squad-kit-ios';

/** A word in a command, in single quotes when it needs them. */
const word = (s: string) => (/^[\w./@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A name in squad-kit's own Xcode command, as `word` writes it: plain, or in single quotes, never an option. */
const XCODE_NAME = String.raw`(?:[\w@+][\w./@+-]*|'(?!-)[^'\n]*')`;

/**
 * Exactly the Xcode commands squad-kit makes for a native iPhone app (xcodeCommands), and nothing more: one xcodebuild
 * that builds or tests the app's own project for the simulator, into its build folder in the copy. Only these run
 * outside squad-kit's guard (outsideTheGuard in engine/checks.ts), so a command with anything else in it (another
 * program, another flag, a place outside the copy) is not one of them, and stays in the guard.
 */
const OWN_XCODE = new RegExp(
  `^xcodebuild (?:build|test) -(?:workspace|project) (${XCODE_NAME}) -scheme ${XCODE_NAME} -destination '(?:generic/platform=iOS Simulator|platform=iOS Simulator,id=(?:\\{iphone\\}|[\\w-]+))' -derivedDataPath ${XCODE_BUILD_DIR}(?: -packageCachePath ${XCODE_BUILD_DIR}/packages)?$`,
);

export function ownXcodeCommand(command: string): boolean {
  const m = OWN_XCODE.exec(command.trim());
  const where = m?.[1]?.replace(/^'|'$/g, '');
  return Boolean(where && !where.startsWith('/') && !where.split('/').includes('..'));
}

/** Folders that hold no Xcode project of the app's own. */
const NOT_THE_APP = new Set(['Pods', 'Carthage', 'build', 'DerivedData', 'node_modules', 'vendor']);

/** The app's Xcode workspace, else its project, right in the folder or one down (App/), as a path from the folder. */
function xcodeContainer(dir: string): { kind: 'workspace' | 'project'; rel: string } | null {
  const list = (d: string) => {
    try {
      return fs.readdirSync(path.join(dir, d)).filter((f) => !f.startsWith('.') && f !== 'Pods.xcodeproj');
    } catch {
      return [];
    }
  };
  const folders = [
    '',
    ...(() => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NOT_THE_APP.has(e.name) && !/\.(xcodeproj|xcworkspace)$/.test(e.name))
          .map((e) => e.name);
      } catch {
        return [];
      }
    })(),
  ];
  for (const ending of ['.xcworkspace', '.xcodeproj'] as const) {
    for (const d of folders) {
      const found = list(d).find((f) => f.endsWith(ending));
      if (found) return { kind: ending === '.xcworkspace' ? 'workspace' : 'project', rel: path.join(d, found) };
    }
  }
  return null;
}

/** The shared schemes beside a container: its own and its folder's projects'. Each with whether it runs tests. */
function sharedSchemes(dir: string, rel: string): { name: string; tests: boolean }[] {
  const folder = path.join(dir, path.dirname(rel));
  const holders = [path.join(dir, rel), ...(() => {
    try {
      return fs.readdirSync(folder).filter((f) => f.endsWith('.xcodeproj') && f !== 'Pods.xcodeproj').map((f) => path.join(folder, f));
    } catch {
      return [];
    }
  })()];
  const out: { name: string; tests: boolean }[] = [];
  for (const h of [...new Set(holders)]) {
    const at = path.join(h, 'xcshareddata', 'xcschemes');
    for (const f of fs.existsSync(at) ? fs.readdirSync(at).filter((x) => x.endsWith('.xcscheme')).sort() : []) {
      out.push({ name: f.replace(/\.xcscheme$/, ''), tests: /<TestableReference\b/.test(read(path.join(at, f))) });
    }
  }
  return out;
}

/** The text of every Xcode project file beside a container, to look for test targets and Swift packages. */
function projectFiles(dir: string, rel: string): string {
  const folder = path.join(dir, path.dirname(rel));
  try {
    return fs
      .readdirSync(folder)
      .filter((f) => f.endsWith('.xcodeproj') && f !== 'Pods.xcodeproj')
      .map((f) => read(path.join(folder, f, 'project.pbxproj')))
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * A native iPhone app, with no package manager on top: its shared scheme (the one that runs tests first, else the one
 * named as the app), read from its files with no Xcode run. With none shared, Xcode makes one per app named as the app.
 * Building is for the simulator with no device; the tests need the iPhone (IPHONE_SLOT). CocoaPods' install first when
 * it has a Podfile. Swift packages get a cache folder in the copy too: the person's own stays theirs.
 */
function xcodeCommands(dir: string): ProjectCommands | null {
  const c = xcodeContainer(dir);
  if (!c) return null;
  const app = path.basename(c.rel).replace(/\.(xcworkspace|xcodeproj)$/, '');
  const schemes = sharedSchemes(dir, c.rel);
  const pbx = projectFiles(dir, c.rel);
  const scheme = schemes.find((s) => s.tests && s.name === app) ?? schemes.find((s) => s.tests) ?? schemes.find((s) => s.name === app) ?? schemes[0];
  const name = scheme?.name ?? app;
  const tests = scheme ? scheme.tests : /com\.apple\.product-type\.bundle\.(?:unit-test|ui-testing)/.test(pbx);
  const packages = /XCRemoteSwiftPackageReference/.test(pbx) ? ` -packageCachePath ${XCODE_BUILD_DIR}/packages` : '';
  const base = `-${c.kind} ${word(c.rel)} -scheme ${word(name)}`;
  const into = `-derivedDataPath ${XCODE_BUILD_DIR}${packages}`;
  const pods = path.dirname(c.rel);
  return {
    ...(has(path.join(dir, pods), 'Podfile') ? { setup: pods === '.' ? 'pod install' : `pod install --project-directory=${word(pods)}` } : {}),
    ...(tests ? { test: `xcodebuild test ${base} -destination 'platform=iOS Simulator,id=${IPHONE_SLOT}' ${into}` } : {}),
    build: `xcodebuild build ${base} -destination 'generic/platform=iOS Simulator' ${into}`,
  };
}

/**
 * A Swift package on its own: built and tested by Swift itself. Swift reads the package's manifest in a sandbox of its
 * own, which cannot start inside squad-kit's guard (seen on a Mac): there the guard is the sandbox, so Swift's is off.
 */
function swiftCommands(dir: string): ProjectCommands | null {
  if (!has(dir, 'Package.swift')) return null;
  return { ...(fs.existsSync(path.join(dir, 'Tests')) ? { test: 'swift test --disable-sandbox' } : {}), build: 'swift build --disable-sandbox' };
}

/** A Python project: its requirements, and how the entry file it has starts. */
function pythonCommands(dir: string): ProjectCommands | null {
  const reqs = has(dir, 'requirements.txt');
  const pyproject = has(dir, 'pyproject.toml');
  const manage = has(dir, 'manage.py');
  const entry = ['app.py', 'main.py', 'server.py', 'wsgi.py', 'asgi.py'].find((f) => has(dir, f));
  if (!reqs && !pyproject && !manage && !entry) return null;
  const text = `${read(path.join(dir, 'requirements.txt'))}\n${read(path.join(dir, 'pyproject.toml'))}`;
  const entered = entry ? read(path.join(dir, entry)) : '';
  const tests = has(dir, 'conftest.py') || /\bpytest\b/i.test(text) || fs.existsSync(path.join(dir, 'tests'));
  const out: ProjectCommands = {
    ...(reqs ? { setup: 'pip install -r requirements.txt' } : pyproject ? { setup: 'pip install -e .' } : {}),
    ...(manage ? { test: 'python manage.py test' } : tests ? { test: 'python -m pytest' } : {}),
    ...(/\bruff\b/i.test(text) ? { lint: 'ruff check .' } : /\bflake8\b/i.test(text) ? { lint: 'flake8' } : {}),
  };
  if (manage) return { ...out, start: 'python manage.py runserver', url: 'http://localhost:8000' };
  if (entry && (/\bfastapi\b/i.test(text) || /\bFastAPI\(/.test(entered))) return { ...out, start: `uvicorn ${entry.replace(/\.py$/, '')}:app`, url: 'http://localhost:8000' };
  if (entry && (/\bflask\b/i.test(text) || /\bFlask\(/.test(entered))) return { ...out, start: `python ${entry}`, url: at(portInFiles(dir) ?? 5000)! };
  if (entry && /__main__/.test(entered)) {
    const url = at(portInFiles(dir));
    return { ...out, start: `python ${entry}`, ...(url ? { url } : {}) };
  }
  return out;
}

/** True when a file directly in a folder, or one down, matches. */
function anyFile(dir: string, test: (name: string) => boolean): boolean {
  const list = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return list(dir).some((e) => (e.isFile() ? test(e.name) : e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && list(path.join(dir, e.name)).some((x) => x.isFile() && test(x.name))));
}

function otherCommands(dir: string): ProjectCommands | null {
  if (has(dir, 'go.mod')) return { ...(anyFile(dir, (f) => f.endsWith('_test.go')) ? { test: 'go test ./...' } : {}), lint: 'go vet ./...', build: 'go build ./...' };
  if (has(dir, 'Cargo.toml')) return { test: 'cargo test', build: 'cargo build' };
  if (has(dir, 'pom.xml')) return { test: 'mvn test', build: 'mvn package' };
  if (has(dir, 'gradlew')) return { test: './gradlew test', build: './gradlew build' };
  if (anyFile(dir, (f) => f.endsWith('.csproj') || f.endsWith('.sln'))) return { ...(anyFile(dir, (f) => /tests?\.csproj$/i.test(f)) ? { test: 'dotnet test' } : {}), build: 'dotnet build' };
  const apple = xcodeCommands(dir) ?? swiftCommands(dir);
  if (apple) return apple;
  if (has(dir, 'Makefile')) {
    const targets = read(path.join(dir, 'Makefile'));
    const target = (name: string) => new RegExp(`^${name}\\s*:`, 'm').test(targets);
    const out: ProjectCommands = { ...(target('test') ? { test: 'make test' } : {}), ...(target('lint') ? { lint: 'make lint' } : {}), ...(target('build') ? { build: 'make build' } : {}) };
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/* ── a new phone app ───────────────────────────────────── */

/**
 * How a new phone app's first code is made, by its own tool, never written by hand: the Architect plans it with these,
 * filling in <org> and <name>, and the Builder runs it. Flutter makes it in the copy's own folder; Expo in a new folder,
 * whose files the Builder moves to the top.
 */
export const FLUTTER_CREATE = 'flutter create --org <org> --project-name <name> --platforms ios,android,web .';
export const EXPO_CREATE = 'npx create-expo-app@latest <name> --template blank-typescript --no-install';

/**
 * What kind of phone app saved commands are for, when the files do not say yet: a new project's first story saves its
 * commands with its plan, before the Builder makes the app, so what the app needs is known before the build. A Flutter
 * app is made for both phones and the web; an Expo app for both phones, and the web when it starts there.
 */
export function kindsOfCommands(c: ProjectCommands): { kinds: ProjectKind[]; platforms: Platform[] } {
  const all = Object.values(c).filter((v): v is string => typeof v === 'string').join('\n');
  const web = (re: RegExp): Platform[] => (re.test(c.start ?? '') ? ['web'] : []);
  if (/(?:^|[\s;&|(])flutter\s/m.test(all)) return { kinds: ['flutter'], platforms: ['ios', 'android', ...web(/-d web-server\b/)] };
  if (/\bexpo\s|\breact-native\s/.test(all)) return { kinds: ['react-native'], platforms: ['ios', 'android', ...web(/--web\b/)] };
  return { kinds: [], platforms: [] };
}

/* ── a start that opens a window ───────────────────────── */

/** One command of a line: "cd app && flutter run" is two. */
const partsOfLine = (command: string) => command.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);

/**
 * True when a start command opens a window or a phone instead of serving the app on a port: Flutter on any device but
 * its web server (with none named, it picks one: often Chrome or the desktop), Expo for a phone or without its web,
 * Expo's and React Native's run on a phone, a package script named ios or android, and `open`. squad-kit starts the
 * apps it runs with no window, so it never runs one of these (startApp in engine/checks.ts).
 */
export function opensAWindow(command: string | undefined): boolean {
  return partsOfLine(command ?? '').some((part) => {
    const flutter = /(?:^|\s)flutter\s+run\b(.*)$/.exec(part);
    if (flutter) {
      const device = /(?:^|\s)(?:-d|--device-id)(?:=|\s+)?(\S+)/.exec(flutter[1]!)?.[1]?.replace(/^['"]|['"]$/g, '');
      return device !== 'web-server';
    }
    const expo = /(?:^|\s)expo\s+start\b(.*)$/.exec(part);
    if (expo) return /(?:^|\s)(?:--ios|--android|-i|-a)\b/.test(expo[1]!) || !/(?:^|\s)(?:--web|-w)\b/.test(expo[1]!);
    if (/(?:^|\s)expo\s+run:(?:ios|android)\b|(?:^|\s)react-native\s+run-(?:ios|android)\b/.test(part)) return true;
    if (/^(?:npm|pnpm|bun)\s+run\s+(?:ios|android)\b|^(?:yarn|pnpm)\s+(?:run\s+)?(?:ios|android)\b/.test(part)) return true;
    return /^(?:open|xdg-open)\s/.test(part);
  });
}

/**
 * The commands a read of the project handed in, made safe to run: a start that opens a window (opensAWindow) becomes the
 * start squad-kit finds in the project's files, with its address, or goes when it finds none; Flutter's plain
 * `flutter analyze` becomes the found one, where Flutter's style hints never fail the check. Each change says why, for
 * the log.
 */
export function fromTheRead(dir: string, given: ProjectCommands): { commands: ProjectCommands; changed: string[] } {
  const commands = { ...given };
  const changed: string[] = [];
  const found = findCommands(dir);
  if (opensAWindow(commands.start)) {
    const was = commands.start!;
    delete commands.start;
    delete commands.url;
    if (found.start && !opensAWindow(found.start)) {
      commands.start = found.start;
      if (found.url) commands.url = found.url;
    }
    changed.push(`The read's start command opens a window (${was}), so squad-kit ${commands.start ? `starts the app with ${commands.start} instead, with no window` : 'left it out: it found no start with no window in the project'}.`);
  }
  if (commands.lint?.trim() === 'flutter analyze' && found.lint && found.lint !== commands.lint) {
    changed.push(`The read's lint command (${commands.lint}) fails on Flutter's style hints, so squad-kit uses ${found.lint}.`);
    commands.lint = found.lint;
  }
  return { commands, changed };
}

/** What the project's own files say about how to test and run it. Empty when they say nothing. */
export function findCommands(dir: string): ProjectCommands {
  const dart = dartCommands(dir);
  if (dart) return dart;
  const scripts = scriptsOf(dir);
  if (scripts) return nodeCommands(dir, scripts);
  return pythonCommands(dir) ?? otherCommands(dir) ?? {};
}

/**
 * The test command to save, given one the setup step found: a project with a separate browser or e2e test script gets
 * it too ("npm test && npm run test:e2e"). A command that already names it, or runs it, stays as it is.
 */
export function withBrowserTests(dir: string, test: string | undefined): string | undefined {
  const scripts = scriptsOf(dir);
  const command = test?.trim();
  if (!scripts || !command) return command || undefined;
  const browser = browserScript(scripts);
  if (!browser || command.includes(browser) || RUNS_BROWSER.test(command)) return command;
  // "npm test" that already runs them, by itself or through the other script.
  const usesTestScript = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b(?!:)/.test(command);
  if (usesTestScript && (RUNS_BROWSER.test(scripts.test ?? '') || (scripts.test ?? '').includes(browser))) return command;
  return `${command} && ${runnerOf(dir).run(browser)}`;
}
