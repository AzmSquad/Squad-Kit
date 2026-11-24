import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { BoardPaths } from '../src/board/store.js';
import type { ToolsView } from '../src/engine/tools/index.js';

/**
 * A new Flutter project in a folder of its own, before its first story makes the app (a shop app): the Tools page reads what
 * it needs from its saved commands, Flutter, FVM, and Android's build tools for the check that builds the Android app,
 * and the person may skip Android builds on this computer, from the page, its REST call or `squad tools skip android`.
 * The computer is made up: nothing real runs.
 */

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { buildPaths } = await import('../src/core/paths.js');
const { mountToolsApi } = await import('../src/console/api/tools.js');
const { toolsWith } = await import('../src/commands/tools.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const { androidSkip } = await import('../src/engine/tools/android-builds.js');
const { placesWithKinds } = await import('../src/engine/tools/places.js');
const tools = await import('../src/engine/tools/index.js');

let tmp: string;
let home: string;
let bp: BoardPaths;

const COMMANDS = { setup: 'fvm install && fvm flutter pub get', lint: 'fvm flutter analyze', build: 'fvm flutter build apk --debug', test: 'flutter test' };

function found(android: Record<string, unknown>): void {
  writeFound(
    {
      at: new Date().toISOString(),
      system: 'mac',
      tools: {
        flutter: { state: 'found', version: '3.47.9', where: '/sdk/flutter' },
        fvm: { state: 'found', version: '3.2.1', where: '/usr/local/bin/fvm' },
        java: { state: 'found', version: '19.0.2', where: '/jdk/bin/java' },
        xcode: { state: 'found', version: '27.2', where: '/Applications/Xcode.app' },
        simulator: { state: 'found', version: '27.0' },
        cocoapods: { state: 'found', version: '1.16.2', where: '/usr/local/bin/pod' },
        maestro: { state: 'found', version: '2.12.1', where: '/m' },
        android: android as never,
      },
    },
    home,
  );
}

const call = async <T>(a: Hono, method: string, at: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const res = await a.request(`/api/v1${at}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: res.status, data: (await res.json()) as T };
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-android-skip-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
  fs.mkdirSync(home);
  bp = makeNewProject({ name: 'Shop', where: tmp, idea: 'A phone app' }).bp;
  // The app's own repo, with only its README so far.
  fs.mkdirSync(path.join(bp.root, 'project'), { recursive: true });
  fs.writeFileSync(path.join(bp.root, 'project', 'README.md'), '# Shop\n');
  writeMeta(bp, { ...readMeta(bp), engine: 'live', scan: { status: 'done', empty: true }, commands: {}, repos: [{ path: 'project', base: 'main', remote: 'origin', commands: COMMANDS }] });
  found({ state: 'missing' });
  tools.useDetectHost({ system: 'mac', home: '/Users/nobody', env: { PATH: '/nowhere' }, run: async () => ({ ok: false, out: '', err: '' }), exists: () => false, read: () => null, real: (p) => p, list: () => [], writable: () => true });
});

afterEach(() => {
  tools.useDetectHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a new Flutter repo, before its first story', () => {
  it('is a Flutter app for both phones that pins its Flutter with FVM, from its saved commands', () => {
    expect(placesWithKinds(bp.root, readMeta(bp))).toEqual([{ place: 'project', part: 'Project', kinds: ['flutter', 'fvm'], platforms: ['ios', 'android'] }]);
  });

  it("a part with no app files in a repo whose app is already there stays as it is: only a new repo takes its commands' kind", () => {
    fs.mkdirSync(path.join(bp.root, 'project', 'app'), { recursive: true });
    fs.writeFileSync(path.join(bp.root, 'project', 'app', 'pubspec.yaml'), 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.mkdirSync(path.join(bp.root, 'project', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(bp.root, 'project', 'scripts', 'seed.py'), 'print(1)\n');
    const parts = [
      { id: 'app', name: 'App', repo: 'project', folder: 'app', needs: [] },
      { id: 'scripts', name: 'Scripts', repo: 'project', folder: 'scripts', needs: [] },
    ];
    writeMeta(bp, { ...readMeta(bp), parts });
    const places = placesWithKinds(bp.root, readMeta(bp));
    expect(places.find((p) => p.part === 'App')?.kinds).toEqual(['flutter', 'fvm']);
    // The scripts folder is not made a Flutter app: it only needs FVM, as the repo's commands run it.
    expect(places.find((p) => p.part === 'Scripts')).toEqual({ place: 'project/scripts', part: 'Scripts', kinds: ['fvm'], platforms: [] });
  });

  it('the Tools page lists Flutter, FVM, and Android for the check that builds the Android app', async () => {
    const v = await tools.projectTools(bp);
    expect(v.summary).toBe('This project has a Flutter app for iPhone and Android and a Flutter version pinned with FVM.');
    const ids = v.lines.map((l) => l.id);
    for (const id of ['flutter', 'fvm', 'android', 'java']) expect(ids).toContain(id);
    const android = v.lines.find((l) => l.id === 'android')!;
    expect(android).toMatchObject({ priority: 'required', state: 'missing', blocks: ['checks'], skip: { command: 'squad tools skip android' } });
    expect(android.actions).toContain('checks');
    expect(android.skipped).toBeUndefined();
  });

  it("Android Studio's SDK that builds apps: the check runs with it, and nothing waits", async () => {
    found({ state: 'missing', builds: '/Users/pm/Library/Android/sdk', note: 'Your Android SDK lacks the command-line tools.' });
    const android = (await tools.projectTools(bp)).lines.find((l) => l.id === 'android')!;
    expect(android.blocks).toEqual([]);
    // Skip stays offered: the tools are here, and a build may still not run on this computer.
    expect(android.skip).toEqual({ command: 'squad tools skip android' });
  });
});

describe('Skip Android builds', () => {
  const app = () => {
    const a = new Hono();
    mountToolsApi(a, { paths: buildPaths(bp.root) });
    return a;
  };

  it('over REST: the line says it is skipped, by whom, with the way back; and back on again', async () => {
    const a = app();
    const skipped = await call<ToolsView>(a, 'POST', '/tools/android/skip', { skip: true });
    expect(skipped.status).toBe(200);
    const line = skipped.data.lines.find((l) => l.id === 'android')!;
    expect(line.skipped).toMatchObject({ command: 'squad tools unskip android' });
    expect(line.blocks).toEqual([]);
    expect(line.skip).toBeUndefined();
    expect(androidSkip(bp)).not.toBeNull();
    const back = await call<ToolsView>(a, 'POST', '/tools/android/skip', { skip: false });
    expect(back.data.lines.find((l) => l.id === 'android')).toMatchObject({ blocks: ['checks'] });
    expect(androidSkip(bp)).toBeNull();
    // Only Android builds can be skipped.
    const other = await call<{ error: string }>(a, 'POST', '/tools/flutter/skip', { skip: true });
    expect(other.status).toBe(400);
    expect(other.data.error).toBe('Only Android builds can be skipped here, not "flutter". Use: squad tools skip android');
  });

  it('squad tools skip android, here with squad-kit closed, and unskip', async () => {
    let printed = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      printed += String(s);
      return true;
    });
    expect(await toolsWith(bp, null, 'skip', 'android')).toBe(true);
    expect(androidSkip(bp)).not.toBeNull();
    expect(await toolsWith(bp, null, 'show', undefined)).toBe(true);
    expect(printed.replace(/\x1b\[[0-9;]*m/g, '')).toContain('Turn them back on: squad tools unskip android');
    expect(await toolsWith(bp, null, 'unskip', 'android')).toBe(true);
    expect(androidSkip(bp)).toBeNull();
    vi.restoreAllMocks();
  });
});
