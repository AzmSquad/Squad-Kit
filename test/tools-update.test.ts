import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { BoardPaths } from '../src/board/store.js';
import type { System } from '../src/engine/tools/catalog.js';
import type { DetectHost, Found, FoundBook, Ran } from '../src/engine/tools/detect.js';
import type { PlaceKinds } from '../src/engine/tools/kinds.js';
import type { RunUpdate } from '../src/engine/tools/update.js';
import type { ToolsView } from '../src/engine/tools/index.js';

/**
 * Update Flutter: squad-kit updates the person's own Flutter only when that is safe and only after their OK, with
 * Flutter's own `flutter upgrade`. The computer, git and Flutter are all made up: nothing real runs, nothing is
 * downloaded, and no real Flutter is touched.
 */

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { buildPaths } = await import('../src/core/paths.js');
const { mountToolsApi } = await import('../src/console/api/tools.js');
const { toolsWith } = await import('../src/commands/tools.js');
const { gettingNow, lastTrouble, startGets, setTrouble } = await import('../src/engine/tools/get.js');
const { DOCTOR_LIMIT_MS, FIRST_STEP, LET_GO_MS, UPDATE_LIMIT_MS, flutterUpdateLook, managedByOf, startUpdate, updateGuess, updateTool, usefulLine, useUpdateRun } = await import('../src/engine/tools/update.js');
const tools = await import('../src/engine/tools/index.js');

const ok = (out = ''): Ran => ({ ok: true, out, err: '' });
const no = (err = ''): Ran => ({ ok: false, out: '', err });

/** The answers of a plain, clean copy of Flutter's own repository on its stable channel. */
const CLEAN = (sdk: string): Record<string, Ran> => ({
  [`git -C ${sdk} remote get-url origin`]: ok('https://github.com/flutter/flutter.git\n'),
  [`git -C ${sdk} symbolic-ref -q HEAD`]: ok('refs/heads/stable\n'),
  [`git -C ${sdk} status --porcelain`]: ok(''),
});

let ran: { key: string; env?: NodeJS.ProcessEnv }[];

/** A made-up computer with a Flutter folder at `sdk`. */
function host(o: { sdk: string; system?: System; git?: boolean; writable?: boolean; answers?: Record<string, Ran> }): DetectHost {
  return {
    system: o.system ?? 'mac',
    home: '/Users/pm',
    env: {},
    async run(cmd, args, opts) {
      const key = `${path.basename(cmd)} ${args.join(' ')}`;
      ran.push({ key, ...(opts?.env ? { env: opts.env } : {}) });
      return { ...CLEAN(o.sdk), ...o.answers }[key] ?? no(`${cmd}: not found`);
    },
    exists: (p) => o.git !== false && p === path.join(o.sdk, '.git'),
    read: () => null,
    real: (p) => p,
    list: () => [],
    writable: () => o.writable !== false,
  };
}

let tmp: string;

beforeEach(() => {
  ran = [];
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-update-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.SQUAD_KIT_HOME);
});

afterEach(() => {
  useUpdateRun(null);
  setTrouble('flutter');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('whether squad-kit can update Flutter itself', () => {
  const SDK = '/Users/pm/development/flutter';
  const found = (where = SDK): Found => ({ state: 'found', version: '3.27.3', where });
  const look = (o: Partial<Parameters<typeof host>[0]> = {}, where = SDK) => flutterUpdateLook(host({ sdk: where, ...o }), found(where));

  it("a clean copy of Flutter's own repository, on its stable channel, that this user may change: yes", async () => {
    expect(await look()).toEqual({});
    // Only three short git commands that read, with no lock taken and no question asked.
    expect(ran.map((r) => r.key)).toEqual([`git -C ${SDK} remote get-url origin`, `git -C ${SDK} symbolic-ref -q HEAD`, `git -C ${SDK} status --porcelain`]);
    for (const r of ran) expect(r.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    // Its address over ssh is Flutter's own too.
    expect(await look({ answers: { [`git -C ${SDK} remote get-url origin`]: ok('git@github.com:flutter/flutter.git\n') } })).toEqual({});
    expect(await look({ answers: { [`git -C ${SDK} symbolic-ref -q HEAD`]: ok('refs/heads/beta\n') } })).toEqual({});
  });

  it('each reason it is not safe, in one plain line', async () => {
    const cases: [Partial<Parameters<typeof host>[0]>, string][] = [
      [{ git: false }, 'this Flutter was not installed the usual way, so it cannot update itself'],
      [{ writable: false }, "your Flutter folder needs your computer's password to change"],
      [{ answers: { [`git -C ${SDK} remote get-url origin`]: ok('https://gitee.com/mirrors/flutter.git\n') } }, "this Flutter does not come from Flutter's own site"],
      [{ answers: { [`git -C ${SDK} remote get-url origin`]: no('error: No such remote') } }, "this Flutter does not come from Flutter's own site"],
      [{ answers: { [`git -C ${SDK} symbolic-ref -q HEAD`]: no() } }, 'your Flutter is set to stay on one version'],
      [{ answers: { [`git -C ${SDK} symbolic-ref -q HEAD`]: ok('refs/heads/my-fix\n') } }, "your Flutter follows a branch of its own, my-fix, not one of Flutter's channels"],
      [{ answers: { [`git -C ${SDK} status --porcelain`]: ok(' M packages/flutter/lib/src/widgets/text.dart\n') } }, 'your Flutter folder has changes of its own'],
      [{ answers: { [`git -C ${SDK} status --porcelain`]: ok('?? notes.txt\n') } }, 'your Flutter folder has changes of its own'],
      [{ answers: { [`git -C ${SDK} status --porcelain`]: no('fatal: detected dubious ownership') } }, 'it could not look inside your Flutter folder'],
      [{ system: 'windows' }, 'on Windows, you update Flutter yourself for now'],
    ];
    for (const [o, why] of cases) expect((await look(o))?.cant, why).toBe(`squad-kit can't update it here: ${why}.`);
  });

  it('another tool looks after it: Homebrew, FVM or a snap, and nothing runs to find out', async () => {
    const brew = '/opt/homebrew/Caskroom/flutter/3.27.3/flutter';
    expect(await look({}, brew)).toEqual({ managedBy: 'homebrew', cant: "squad-kit can't update it here: Homebrew looks after this Flutter, and updates it itself." });
    expect((await look({}, '/Users/pm/fvm/versions/3.27.3'))?.managedBy).toBe('fvm');
    expect((await look({}, '/Users/pm/shop/.fvm/flutter_sdk'))?.cant).toContain('FVM looks after this Flutter');
    expect((await look({}, '/home/pm/snap/flutter/common/flutter'))?.cant).toContain('a snap package looks after this Flutter');
    expect(ran).toEqual([]);
    expect(managedByOf('/Users/pm/development/flutter')).toBeUndefined();
  });

  it('a Flutter that is not found has nothing to look at', async () => {
    expect(await flutterUpdateLook(host({ sdk: SDK }), { state: 'missing' })).toBeUndefined();
  });
});

describe('the Flutter line when it is too old', () => {
  const APP: PlaceKinds[] = [{ place: '.', kinds: ['flutter'], platforms: ['ios', 'android'] }];
  const book = (flutter: Found, system: System = 'mac'): FoundBook => ({ at: '2026-11-10T15:00:00.000Z', system, tools: { flutter, xcode: { state: 'found', version: '27.2' } } });
  const old = (update: Found['update']): Found => ({ state: 'found', version: '3.27.3', where: '/Users/pm/flutter', update });
  const flutterLine = (b: FoundBook) => tools.linesFor(APP, b, b.system).find((l) => l.id === 'flutter')!;

  it('safe: Update Flutter with its warning, and the update steps to do it yourself', () => {
    const l = flutterLine(book(old({})));
    expect(l.state).toBe('too-old');
    expect(l.update).toEqual({
      warning: 'This updates Flutter for every Flutter project on this Mac, not only this one. Older projects may need small changes to build again. It downloads about 1 GB and takes about 5 minutes.',
      seconds: 300,
      command: 'squad tools update flutter',
    });
    expect(l.cantUpdate).toBeUndefined();
    expect(l.steps).toEqual(['Open a terminal.', 'Run: flutter upgrade', 'Come back here and press Check again.']);
    // On Linux it says this computer.
    expect(flutterLine(book(old({}), 'linux')).update?.warning).toContain('every Flutter project on this computer, not only this one');
  });

  it('the expected time is the one measured on this computer, once there is one', () => {
    fs.mkdirSync(path.join(process.env.SQUAD_KIT_HOME!, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'tools', 'times.json'), JSON.stringify({ 'flutter-update': 130 }));
    expect(updateGuess('flutter')).toBe(130);
    const l = flutterLine(book(old({})));
    expect(l.update).toMatchObject({ seconds: 130 });
    expect(l.update?.warning).toContain('takes about 2 minutes.');
  });

  it('not safe: the reason, and the steps for the tool that looks after it', () => {
    const changes = flutterLine(book(old({ cant: "squad-kit can't update it here: your Flutter folder has changes of its own." })));
    expect(changes.update).toBeUndefined();
    expect(changes.cantUpdate).toBe("squad-kit can't update it here: your Flutter folder has changes of its own.");
    expect(changes.steps).toEqual(['Open a terminal.', 'Run: flutter upgrade', 'Come back here and press Check again.']);
    const brew = flutterLine(book(old({ managedBy: 'homebrew', cant: 'x' })));
    expect(brew.steps).toEqual(['Open a terminal.', 'Run: brew upgrade --cask flutter', 'Come back here and press Check again.']);
    const fvm = flutterLine(book(old({ managedBy: 'fvm', cant: 'x' })));
    expect(fvm.steps).toEqual(['Open a terminal.', 'Run: fvm install stable', 'Run: fvm global stable', 'Come back here and press Check again.']);
  });

  it('missing keeps the install steps; ready and not looked at yet offer nothing', () => {
    const missing = flutterLine(book({ state: 'missing' }));
    expect(missing.steps[0]).toBe("Open Flutter's official install page.");
    // On Mac and Linux, Check again sees a new install; Windows still needs squad-kit opened again.
    expect(missing.steps.at(-1)).toBe('Come back here and press Check again.');
    expect(flutterLine(book({ state: 'missing' }, 'windows')).steps.at(-1)).toContain('Close squad-kit and open it again');
    expect(missing.update).toBeUndefined();
    expect(flutterLine(book({ ...old({}), version: '3.47.0' }))).toMatchObject({ state: 'ready' });
    expect(flutterLine(book({ ...old({}), version: '3.47.0' })).update).toBeUndefined();
    expect(flutterLine(book(old(undefined))).update).toBeUndefined();
  });
});

describe('the update itself', () => {
  const SDK = '/Users/pm/flutter';
  const ended = () => new Promise<void>((r) => (done = r));
  let done: () => void = () => undefined;

  it('runs flutter upgrade in its own folder, with no questions, shows each step, and checks again after', async () => {
    const seen: string[] = [];
    let asked: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null = null;
    const run: RunUpdate = async (cmd, args, opts) => {
      asked = { cmd, args, cwd: opts.cwd, env: opts.env };
      seen.push(gettingNow()!.words!);
      opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
      seen.push(gettingNow()!.words!);
      opts.onLine('Downloading Darwin arm64 Dart SDK from Flutter engine 4cf269e...');
      opts.onLine('Building flutter tool...');
      seen.push(gettingNow()!.words!);
      // Steps only go forward.
      opts.onLine('Downloading Material fonts...');
      opts.onLine('Doctor summary (to see all details, run flutter doctor -v):');
      seen.push(gettingNow()!.words!);
      return { code: 0 };
    };
    const end = ended();
    const g = startUpdate('flutter', SDK, { run, system: 'mac', after: () => done() });
    expect(g).toMatchObject({ tool: 'flutter', name: 'Flutter', step: 'update', words: FIRST_STEP, secondsLeft: 300, total: 300 });
    await end;
    expect(asked).toEqual({ cmd: path.join(SDK, 'bin', 'flutter'), args: ['upgrade'], cwd: SDK, env: expect.objectContaining({ FLUTTER_SUPPRESS_ANALYTICS: 'true', CI: 'true', NO_COLOR: '1' }) });
    expect(seen).toEqual([FIRST_STEP, 'Downloading the new Flutter', 'Getting Flutter ready', 'Checking the new Flutter']);
    expect(gettingNow()).toBeNull();
    expect(lastTrouble('flutter')).toBeUndefined();
    // The time it took here is the next guess.
    expect(updateGuess('flutter')).toBeLessThan(300);
  });

  it('a failed update says what Flutter said last, never a stack trace, and nothing else is left', async () => {
    const run: RunUpdate = async (_c, _a, opts) => {
      opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
      opts.onLine("fatal: unable to access 'https://github.com/flutter/flutter.git/': Could not resolve host: github.com");
      opts.onLine('Unhandled exception:');
      opts.onLine('#0      _runGit (package:flutter_tools/src/version.dart:812:5)');
      opts.onLine('  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current');
      opts.onLine('100  1024k  100  1024k    0     0  1234k      0 --:--:-- --:--:-- --:--:-- 1234k');
      opts.onLine('\x1b[31m\x1b[0m');
      return { code: 1 };
    };
    const end = ended();
    startUpdate('flutter', SDK, { run, after: () => done() });
    await end;
    expect(lastTrouble('flutter')).toBe(`The update of Flutter did not finish. Flutter said: "fatal: unable to access 'https://github.com/flutter/flutter.git/': Could not resolve host: github.com" Try again, or do it yourself with the steps.`);
  });

  it('the last useful line is a real one', () => {
    expect(usefulLine("fatal: unable to access 'https://github.com/flutter/flutter.git/': Could not resolve host: github.com")).toContain('Could not resolve host');
    expect(usefulLine('#0      main (package:flutter_tools/executable.dart:9:3)')).toBeNull();
    expect(usefulLine('Unhandled exception:')).toBeNull();
    expect(usefulLine('    at Object.<anonymous> (/x.js:1:1)')).toBeNull();
    expect(usefulLine('100  1024k  100  1024k    0     0  1234k      0 --:--:-- --:--:-- --:--:-- 1234k')).toBeNull();
    expect(usefulLine('════════════════')).toBeNull();
    expect(usefulLine('\x1b[1mBuilding flutter tool...\x1b[0m')).toBe('Building flutter tool...');
    expect(usefulLine('x'.repeat(400))).toHaveLength(240);
  });

  it('stops at its time limit, and says so plainly', async () => {
    expect(UPDATE_LIMIT_MS).toBe(30 * 60_000);
    let stopped = false;
    const run: RunUpdate = (_c, _a, opts) =>
      new Promise((resolve) => {
        opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
        opts.signal.addEventListener('abort', () => {
          stopped = true;
          resolve({ code: null });
        });
      });
    const end = ended();
    startUpdate('flutter', SDK, { run, limitMs: 50, after: () => done() });
    await end;
    expect(stopped).toBe(true);
    expect(lastTrouble('flutter')).toBe('The update of Flutter took more than 1 second, so squad-kit stopped it. Check the internet connection, then try again, or do it yourself with the steps.');
  });

  it('can be stopped from outside, and one update or download runs at a time', async () => {
    const stop = new AbortController();
    const run: RunUpdate = (_c, _a, opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ code: null })));
    const end = ended();
    startUpdate('flutter', SDK, { run, signal: stop.signal, after: () => done() });
    expect(() => startGets(['maestro'])).toThrow('squad-kit is updating Flutter now. One at a time: try again once it is done.');
    stop.abort();
    await end;
    expect(lastTrouble('flutter')).toBe('The update of Flutter was stopped before the end. Try again, or do it yourself with the steps.');
  });

  /** Flutter's version before the update, then after it, as a limit stopped it. */
  const versions = (before: string, after: string) => async (_sdk: string, when: 'before' | 'after') => (when === 'before' ? before : after);
  /** A made-up update that brings the new Flutter in, then hangs in Flutter's own check until it is stopped. */
  const hangsInDoctor: RunUpdate = (_c, _a, opts) =>
    new Promise((resolve) => {
      opts.onLine('Upgrading Flutter to 3.47.9 from 3.27.3 in /Users/pm/flutter...');
      opts.onLine('Building flutter tool...');
      opts.onLine('Flutter 3.47.9 • channel stable • https://github.com/flutter/flutter.git');
      opts.onLine('Running flutter doctor...');
      opts.signal.addEventListener('abort', () => resolve({ code: null }));
    });

  it("a check of its own that hangs: its own short limit ends it, and a newer Flutter means the update is done", async () => {
    expect(DOCTOR_LIMIT_MS).toBe(5 * 60_000);
    const end = ended();
    const t0 = Date.now();
    startUpdate('flutter', SDK, { run: hangsInDoctor, doctorMs: 50, version: versions('3.27.3', '3.47.9'), after: () => done() });
    await end;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(lastTrouble('flutter')).toBeUndefined();
  });

  it('the same check with no newer Flutter is a plain failure', async () => {
    const end = ended();
    startUpdate('flutter', SDK, { run: hangsInDoctor, doctorMs: 50, version: versions('3.27.3', '3.27.3'), after: () => done() });
    await end;
    expect(lastTrouble('flutter')).toBe('The update of Flutter did not finish: its own check took more than 1 second, so squad-kit stopped it. Try again, or do it yourself with the steps.');
  });

  it('the overall limit: no newer Flutter fails as before, a newer one is done', async () => {
    const hangs: RunUpdate = (_c, _a, opts) =>
      new Promise((resolve) => {
        opts.onLine('Upgrading Flutter to 3.47.9 from 3.27.3 in /Users/pm/flutter...');
        opts.signal.addEventListener('abort', () => resolve({ code: null }));
      });
    let end = ended();
    startUpdate('flutter', SDK, { run: hangs, limitMs: 50, version: versions('3.27.3', '3.27.3'), after: () => done() });
    await end;
    expect(lastTrouble('flutter')).toBe('The update of Flutter took more than 1 second, so squad-kit stopped it. Check the internet connection, then try again, or do it yourself with the steps.');
    end = ended();
    startUpdate('flutter', SDK, { run: hangs, limitMs: 50, version: versions('3.27.3', '3.47.9'), after: () => done() });
    await end;
    expect(lastTrouble('flutter')).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('ends when its program ends, even when something it started holds the output, and that ends too', async () => {
    useUpdateRun(null);
    // A made-up flutter in a folder of its own: it leaves a child behind on the same output, as a daemon would.
    const sdk = path.join(tmp, 'flutter');
    const pidFile = path.join(tmp, 'left.pid');
    fs.mkdirSync(path.join(sdk, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'bin', 'flutter'), `#!/bin/sh\necho "Upgrading Flutter to 9.9.9 from 1.0.0"\nsleep 60 &\necho $! > "${pidFile}"\necho "Flutter 9.9.9 • channel stable"\nexit 0\n`, { mode: 0o755 });
    const t0 = Date.now();
    await updateTool('flutter', sdk, { system: 'mac', version: versions('1.0.0', '9.9.9') });
    expect(Date.now() - t0).toBeLessThan(LET_GO_MS + 3000);
    const left = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(left, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it('a program that does not start says so', async () => {
    const end = ended();
    startUpdate('flutter', SDK, { run: async () => ({ code: null, error: 'spawn ENOENT' }), after: () => done() });
    await end;
    expect(lastTrouble('flutter')).toBe("squad-kit could not start Flutter's update. Do it yourself with the steps.");
  });
});

/* ── through the board's REST call and `squad tools update` ── */

describe('Update Flutter on a project', () => {
  const SDK = '/Users/pm/flutter';
  let bp: BoardPaths;
  let version: string;
  let dirty: boolean;
  let runs: string[][];

  function fakeMac(): DetectHost {
    const files = (): Record<string, string> => ({ [`${SDK}/bin/flutter`]: '', [`${SDK}/bin/cache/flutter.version.json`]: JSON.stringify({ frameworkVersion: version }), [`${SDK}/.git`]: '' });
    const answers = (): Record<string, Ran> => ({
      'xcode-select -p': ok('/Applications/Xcode.app/Contents/Developer\n'),
      'xcodebuild -version': ok('Xcode 27.2\nBuild version 27B52\n'),
      'xcrun simctl list runtimes -j': ok(JSON.stringify({ runtimes: [{ name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true }] })),
      ...CLEAN(SDK),
      ...(dirty ? { [`git -C ${SDK} status --porcelain`]: ok(' M bin/flutter\n') } : {}),
    });
    return {
      system: 'mac',
      home: '/Users/pm',
      env: { PATH: `${SDK}/bin` },
      run: async (cmd, args) => answers()[`${path.basename(cmd)} ${args.join(' ')}`] ?? no('not found'),
      exists: (p) => p in files(),
      read: (p) => files()[p] ?? null,
      real: (p) => p,
      list: () => [],
      writable: () => true,
    };
  }

  /** A made-up flutter upgrade: it brings Flutter 3.47.0. */
  const fakeUpgrade: RunUpdate = async (cmd, args, opts) => {
    runs.push([cmd, ...args]);
    opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
    version = '3.47.0';
    return { code: 0 };
  };

  function app(): Hono {
    const a = new Hono();
    mountToolsApi(a, { paths: buildPaths(bp.root) });
    return a;
  }

  const call = async <T>(a: Hono, method: string, at: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const res = await a.request(`/api/v1${at}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, data: (await res.json()) as T };
  };

  /** Reads the page until nothing runs any more. */
  const settle = async (a: Hono): Promise<ToolsView> => {
    let v = (await call<ToolsView>(a, 'GET', '/tools')).data;
    for (let i = 0; i < 100 && (v.getting || v.checking); i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      v = (await call<ToolsView>(a, 'GET', '/tools')).data;
    }
    return v;
  };

  const flutterOf = (v: ToolsView) => v.lines.find((l) => l.id === 'flutter')!;

  beforeEach(async () => {
    version = '3.27.3';
    dirty = false;
    runs = [];
    bp = makeNewProject({ name: 'Wasl', where: tmp, idea: 'A phone app' }).bp;
    fs.writeFileSync(path.join(bp.root, 'pubspec.yaml'), 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.mkdirSync(path.join(bp.root, 'ios'));
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false, summary: 'A phone app.' } });
    tools.useDetectHost(fakeMac());
    useUpdateRun(fakeUpgrade);
    await tools.checkTools();
  });

  afterEach(() => {
    tools.useDetectHost(null);
  });

  it('REST: without the OK it says the warning and changes nothing; with it, Flutter is updated and turns Ready', async () => {
    const a = app();
    const before = flutterOf((await call<ToolsView>(a, 'GET', '/tools')).data);
    expect(before).toMatchObject({ state: 'too-old', update: { command: 'squad tools update flutter' } });

    const refused = await call<{ error: string }>(a, 'POST', '/tools/flutter/update');
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe(`${before.update!.warning} squad-kit updates it only after you say OK.`);
    expect((await call<{ error: string }>(a, 'POST', '/tools/flutter/update', { ok: 'yes' })).status).toBe(400);
    expect(runs).toEqual([]);

    const started = await call<ToolsView>(a, 'POST', '/tools/flutter/update', { ok: true });
    expect(started.status).toBe(200);
    expect(flutterOf(started.data)).toMatchObject({ state: 'updating', getting: { step: 'update' } });
    // While it runs, the steps that need Flutter wait: building too.
    expect(flutterOf(started.data).blocks).toEqual(['build', 'checks', 'pictures', 'start-app', 'try-it']);
    const after = await settle(a);
    expect(flutterOf(after)).toMatchObject({ state: 'ready', version: '3.47.0', blocks: [] });
    expect(runs).toEqual([[path.join(SDK, 'bin', 'flutter'), 'upgrade']]);

    const again = await call<{ error: string }>(a, 'POST', '/tools/flutter/update', { ok: true });
    expect(again.data.error).toBe('Flutter 3.47.0 is new enough already, so there is nothing to update.');
  });

  it("REST: a tool squad-kit can't update, and a Flutter that is not safe to update, say why", async () => {
    const a = app();
    const xcode = await call<{ error: string }>(a, 'POST', '/tools/xcode/update', { ok: true });
    expect(xcode.status).toBe(400);
    expect(xcode.data.error).toBe("squad-kit can't update Xcode itself. The Tools page shows the steps.");

    // Changes made after the last check are seen right before: nothing runs.
    dirty = true;
    const late = await call<{ error: string }>(a, 'POST', '/tools/flutter/update', { ok: true });
    expect(late.data.error).toBe("squad-kit can't update it here: your Flutter folder has changes of its own. The Tools page shows the steps.");
    expect(runs).toEqual([]);

    // After Check again, the line itself says so, with the steps and no button.
    const checked = flutterOf((await call<ToolsView>(a, 'POST', '/tools/check')).data);
    expect(checked).toMatchObject({ state: 'too-old', cantUpdate: "squad-kit can't update it here: your Flutter folder has changes of its own." });
    expect(checked.update).toBeUndefined();
  });

  it('a failed update stays on the line with its steps, and Update Flutter is offered again', async () => {
    useUpdateRun(async (_c, _a, opts) => {
      opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
      opts.onLine('error: Your local changes to the following files would be overwritten by checkout:');
      return { code: 1 };
    });
    const a = app();
    await call<ToolsView>(a, 'POST', '/tools/flutter/update', { ok: true });
    const l = flutterOf(await settle(a));
    expect(l).toMatchObject({ state: 'too-old', version: '3.27.3' });
    expect(l.trouble).toBe('The update of Flutter did not finish. Flutter said: "error: Your local changes to the following files would be overwritten by checkout:" Try again, or do it yourself with the steps.');
    expect(l.steps).toEqual(['Open a terminal.', 'Run: flutter upgrade', 'Come back here and press Check again.']);
    expect(l.update).toBeDefined();
  });

  describe('squad tools update flutter', () => {
    let printed: string;
    const plain = () => printed.replace(/\x1b\[[0-9;]*m/g, '');
    beforeEach(() => {
      printed = '';
      const keep = (s: string | Uint8Array) => {
        printed += String(s);
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(keep);
      vi.spyOn(process.stderr, 'write').mockImplementation(keep);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('squad tools shows the update first, and the steps to do it yourself', async () => {
      expect(await toolsWith(bp, null, undefined, undefined)).toBe(true);
      expect(plain()).toContain('! Flutter  Too old: found 3.27.3, needs 3.44.8 or newer (Xcode 27 needs it for iPhone builds)');
      expect(plain()).toContain('squad-kit can update it: squad tools update flutter');
      expect(plain()).toContain('Or do it yourself:\n        1. Open a terminal.\n        2. Run: flutter upgrade\n        3. Come back here and press Check again.');
    });

    it('with --yes: the warning, then the update runs here when squad-kit is not open', async () => {
      expect(await toolsWith(bp, null, 'update', 'flutter', { yes: true })).toBe(true);
      expect(plain()).toContain('This updates Flutter for every Flutter project on this Mac, not only this one.');
      expect(plain()).toContain('Flutter 3.47.0 is ready.');
      expect(runs).toHaveLength(1);
    });

    it('says one outcome only: ready, with no failure of another tool beside it; or the failure, never ready with it', async () => {
      setTrouble('java', 'squad-kit could not get Java. Try again.');
      expect(await toolsWith(bp, null, 'update', 'flutter', { yes: true })).toBe(true);
      expect(plain()).toContain('Flutter 3.47.0 is ready.');
      expect(plain()).not.toContain('could not get Java');
      setTrouble('java');
      // An update that brings the new Flutter but does not finish: the failure alone.
      printed = '';
      version = '3.27.3';
      await tools.checkTools();
      useUpdateRun(async (cmd, args, opts) => {
        runs.push([cmd, ...args]);
        opts.onLine('Upgrading Flutter to 3.47.0 from 3.27.3 in /Users/pm/flutter...');
        version = '3.47.0';
        return { code: 1 };
      });
      expect(await toolsWith(bp, null, 'update', 'flutter', { yes: true })).toBe(false);
      expect(plain()).toContain('The update of Flutter did not finish.');
      expect(plain()).not.toContain('is ready');
    });

    it('without --yes it asks; no leaves Flutter as it is', async () => {
      const asked: string[] = [];
      const ask = async (q: string) => {
        asked.push(q);
        return false;
      };
      expect(await toolsWith(bp, null, 'update', 'flutter', { ask })).toBe(true);
      expect(asked).toEqual(['Update Flutter for all projects?']);
      expect(plain()).toContain('Not now. Flutter stays as it is.');
      expect(runs).toEqual([]);
    });

    it('without --yes and with no one to ask, it says how to say OK, and nothing runs', async () => {
      await expect(toolsWith(bp, null, 'update', 'flutter')).rejects.toThrow('squad-kit updates Flutter only after you say OK. To say it here: squad tools update flutter --yes');
      expect(runs).toEqual([]);
    });

    it("yes goes through the open board's REST call, with the OK in it", async () => {
      const a = app();
      const asked: string[] = [];
      const api = {
        call: async <T>(method: 'GET' | 'POST' | 'PUT', at: string, payload?: unknown): Promise<T> => {
          asked.push(`${method} ${at}${payload !== undefined ? ` ${JSON.stringify(payload)}` : ''}`);
          return (await call<T>(a, method, at, payload)).data;
        },
      };
      expect(await toolsWith(bp, api, 'update', 'flutter', { ask: async () => true })).toBe(true);
      expect(asked).toContain('POST /tools/flutter/update {"ok":true}');
      expect(runs).toHaveLength(1);
      await expect(toolsWith(bp, api, 'update', undefined)).rejects.toThrow('Say which tool');
    });
  });
});
