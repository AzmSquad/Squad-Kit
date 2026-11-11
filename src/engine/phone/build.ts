import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import { treeOf } from '../lane.js';
import { endGroup } from '../process-group.js';
import { aboutWords, noteStep, stepSeconds } from './times.js';

/**
 * Builds the story's app for the iPhone simulator, in the story's own copy of the code, outside the agents' sandbox:
 * Flutter with `flutter build ios --simulator`, React Native and native iPhone apps with `xcodebuild` (after `pod install`
 * when there is a Podfile), into the copy's own build folder. It builds again only when the copy's code changed since
 * the last build, and keeps how long it took, so the next wait says "about N minutes" from this computer.
 */

export type PhoneKind = 'flutter' | 'react-native' | 'ios';

/** squad-kit's own build folder in a copy: Xcode's build files and the record of the last build. Git never sees it. */
export const BUILD_DIR = path.join('build', 'squad-kit-ios');
/** A build that takes longer than this is stopped. */
export const BUILD_MS = 40 * 60_000;

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
  /** Where the built app is, as a folder to look in for one `.app`. */
  products: string;
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

/** The app a build made: the one `.app` in its folder that is not a test runner. */
export function appIn(products: string): string | null {
  const apps = list(products).filter((n) => n.endsWith('.app') && !/Tests?(-Runner)?\.app$/.test(n));
  return apps.length ? path.join(products, apps[0]!) : null;
}

const recordFile = (dir: string) => path.join(dir, BUILD_DIR, 'built.json');

/** The last build in a copy, as saved. */
export function lastBuild(dir: string): Built | null {
  try {
    return JSON.parse(fs.readFileSync(recordFile(dir), 'utf8')) as Built;
  } catch {
    return null;
  }
}

/** squad-kit's build folder in a copy, which ignores itself: nothing in it ever shows as a change of the story. */
function ownFolder(dir: string): void {
  const own = path.join(dir, BUILD_DIR);
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

/**
 * The story's app, built for the iPhone simulator in its copy `dir`, or the last build when the copy's code is the same.
 * Says what it does and about how long it takes. Throws BuildFailed.
 */
export async function buildForPhone(dir: string, kind: PhoneKind, o: { say?(text: string): void; log?(text: string): void; signal?: AbortSignal; home?: string } = {}): Promise<Built> {
  const home = o.home ?? squadHome();
  const tree = await treeOf(dir);
  const last = lastBuild(dir);
  if (last && tree && last.tree === tree && fs.existsSync(last.app)) {
    o.log?.(`The app for the iPhone is built already from this code (${tree.slice(0, 12)}), so squad-kit uses it`);
    return last;
  }
  const plan = buildPlan(dir, kind);
  if (!plan) throw new BuildFailed("squad-kit could not find the app's iPhone project in this story's copy.", `No .xcworkspace or .xcodeproj in ${kind === 'react-native' ? path.join(dir, 'ios') : dir}`);
  ownFolder(dir);
  o.say?.(`Building the app for the iPhone, ${aboutWords(stepSeconds('build', home))}`);
  const t0 = Date.now();
  const env = { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true', LANG: process.env.LANG || 'en_US.UTF-8', COCOAPODS_DISABLE_STATS: 'true' };
  for (const s of plan.steps) {
    if (o.signal?.aborted) throw new Error('You stopped the squad.');
    o.log?.(`squad-kit runs ${s.what} in ${path.join(dir, s.cwd)}: ${s.cmd} ${s.args.join(' ')}`);
    const r = await runner(s.cmd, s.args, { cwd: path.join(dir, s.cwd), env, ...(o.signal ? { signal: o.signal } : {}), timeoutMs: BUILD_MS });
    if (o.signal?.aborted) throw new Error('You stopped the squad.');
    if (!r.ok) throw new BuildFailed('The app did not build for the iPhone.', `${s.cmd} ${s.args.join(' ')} in ${path.join(dir, s.cwd)}:\n${tail(r.output)}`);
  }
  const app = appIn(plan.products);
  if (!app) throw new BuildFailed('The app did not build for the iPhone.', `The build ended well, but no .app is in ${plan.products}`);
  const seconds = (Date.now() - t0) / 1000;
  noteStep('build', seconds, home);
  const built: Built = { app, ...(tree ? { tree } : {}), at: new Date().toISOString(), seconds: Math.round(seconds) };
  fs.writeFileSync(recordFile(dir), `${JSON.stringify(built, null, 2)}\n`);
  o.log?.(`squad-kit built the app for the iPhone in ${Math.round(seconds)} s: ${app}`);
  return built;
}
