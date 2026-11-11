import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BoardPaths } from '../src/board/store.js';
import type { DetectHost, Ran } from '../src/engine/tools/detect.js';
import type { ToolSource } from '../src/engine/tools/get.js';
import type { ToolsView } from '../src/engine/tools/index.js';

/**
 * The Tools page through its REST calls and `squad tools`, and the first blocks: a Flutter story on a computer without
 * Flutter waits with a plain message before its build and its checks, never fails, and goes on by itself once
 * Flutter is there. The computer is made up; no real AI, no download and no install.
 */

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, structured: { summary: 'done' }, sessionId: opts.resume ?? opts.sessionId }) as RunResult,
}));

const { readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { buildPaths } = await import('../src/core/paths.js');
const { zip } = await import('../src/core/zip.js');
const { mountToolsApi } = await import('../src/console/api/tools.js');
const { toolsWith } = await import('../src/commands/tools.js');
const tools = await import('../src/engine/tools/index.js');

let tmp: string;
let bp: BoardPaths;
/** Whether the made-up Mac has Flutter now. */
let hasFlutter = false;

const FLUTTER_JSON = JSON.stringify({ frameworkVersion: '3.47.0', channel: 'stable', dartSdkVersion: '3.10.0' });

function fakeMac(): DetectHost {
  const files = (): Record<string, string> => (hasFlutter ? { '/sdk/flutter/bin/flutter': '', '/sdk/flutter/bin/cache/flutter.version.json': FLUTTER_JSON } : {});
  const answers: Record<string, Ran> = {
    'xcode-select -p': { ok: true, out: '/Applications/Xcode.app/Contents/Developer\n', err: '' },
    'xcodebuild -version': { ok: true, out: 'Xcode 27.2\nBuild version 27B52\n', err: '' },
    'xcrun simctl list runtimes -j': { ok: true, out: JSON.stringify({ runtimes: [{ name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true }] }), err: '' },
  };
  return {
    system: 'mac',
    home: '/Users/nobody',
    get env() {
      return { PATH: hasFlutter ? '/sdk/flutter/bin' : '/nowhere' };
    },
    run: async (cmd, args) => answers[`${path.basename(cmd)} ${args.join(' ')}`] ?? { ok: false, out: '', err: 'not found' },
    exists: (p) => p in files(),
    read: (p) => files()[p] ?? null,
    real: (p) => p,
    list: () => [],
    writable: () => true,
  };
}

/** Made-up archives in the layout of the real ones: Maestro's own folder, and a Java runtime in its release folder. */
const ARCHIVES = {
  maestro: { version: '2.12.1', data: zip([{ name: 'maestro/bin/maestro', data: '#!/bin/sh\necho 2.12.1\n' }]), bin: ['maestro', 'bin', 'maestro'] },
  java: { version: '21.0.5+11', data: zip([{ name: 'jdk-21.0.5+11-jre/bin/java', data: '#!/bin/sh\n' }]), bin: ['jdk-21.0.5+11-jre', 'bin', 'java'] },
};
async function* body(data: Buffer): AsyncIterable<Uint8Array> {
  yield data;
}
const fakeSource = async (id: string): Promise<ToolSource> => {
  const a = ARCHIVES[id as keyof typeof ARCHIVES];
  return {
    version: a.version,
    file: `${id}.zip`,
    pack: 'zip',
    sha256: async () => createHash('sha256').update(a.data).digest('hex'),
    open: async () => ({ body: body(a.data), size: a.data.length }),
    binary: (dir) => (fs.existsSync(path.join(dir, ...a.bin)) ? path.join(dir, ...a.bin) : null),
  };
};

function app(): Hono {
  const a = new Hono();
  mountToolsApi(a, { paths: buildPaths(bp.root), source: fakeSource });
  return a;
}

const call = async <T>(a: Hono, method: string, at: string): Promise<{ status: number; data: T }> => {
  const res = await a.request(`/api/v1${at}`, { method });
  return { status: res.status, data: (await res.json()) as T };
};

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-api-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.SQUAD_KIT_HOME);
  bp = makeNewProject({ name: 'Wasl', where: tmp, idea: 'A phone app' }).bp;
  fs.writeFileSync(path.join(bp.root, 'pubspec.yaml'), 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.mkdirSync(path.join(bp.root, 'ios'));
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done', empty: false, summary: 'A phone app.' } });
  hasFlutter = false;
  tools.useDetectHost(fakeMac());
  await tools.checkTools();
});

afterEach(() => {
  tools.useDetectHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the Tools page over REST', () => {
  it('lists what this Flutter project needs, Required first, and Check again finds a new install', async () => {
    const a = app();
    const first = await call<ToolsView>(a, 'GET', '/tools');
    expect(first.status).toBe(200);
    expect(first.data.summary).toBe('This project has a Flutter app for iPhone.');
    const flutter = first.data.lines.find((l) => l.id === 'flutter')!;
    expect(flutter).toMatchObject({ priority: 'required', state: 'missing', installer: 'you', blocks: ['build', 'checks', 'pictures', 'start-app', 'try-it'] });
    expect(first.data.lines.map((l) => l.id)).toEqual(['git', 'ai-tool', 'flutter', 'xcode', 'simulator', 'cocoapods', 'maestro', 'java']);

    hasFlutter = true;
    const again = await call<ToolsView>(a, 'POST', '/tools/check');
    expect(again.data.lines.find((l) => l.id === 'flutter')).toMatchObject({ state: 'ready', version: '3.47.0', blocks: [] });
  });

  it('Get it gets Maestro into squad-kit\'s own folder, and says no for a tool only you can install', async () => {
    const a = app();
    const started = await call<ToolsView>(a, 'POST', '/tools/maestro/get');
    expect(started.status).toBe(200);
    expect(started.data.lines.find((l) => l.id === 'maestro')?.state).toBe('getting');
    let v = started.data;
    for (let i = 0; i < 100 && (v.getting || v.checking || v.lines.find((l) => l.id === 'maestro')?.state !== 'ready'); i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      v = (await call<ToolsView>(a, 'GET', '/tools')).data;
    }
    expect(v.lines.find((l) => l.id === 'maestro')).toMatchObject({ state: 'ready', version: '2.12.1' });
    expect(fs.existsSync(path.join(process.env.SQUAD_KIT_HOME!, 'tools', 'maestro', '2.12.1', 'ready.json'))).toBe(true);
    // This computer had no Java, so squad-kit got its own with Maestro.
    expect(v.lines.find((l) => l.id === 'java')).toMatchObject({ state: 'ready', version: '21.0.5+11' });

    const xcode = await call<{ error: string }>(a, 'POST', '/tools/xcode/get');
    expect(xcode.status).toBe(400);
    expect(xcode.data.error).toBe("squad-kit can't get Xcode itself: it comes from the App Store and needs your Apple ID. The Tools page shows the steps.");
    const again = await call<{ error: string }>(a, 'POST', '/tools/maestro/get');
    expect(again.data.error).toBe('Maestro 2.12.1 is here already, so there is nothing to get.');
  });
});

describe('squad tools', () => {
  let printed: string;
  /** What the terminal shows, without its colors. */
  const plain = () => printed.replace(/\x1b\[[0-9;]*m/g, '');
  beforeEach(() => {
    printed = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      printed += String(s);
      return true;
    });
  });

  it('prints the page here when squad-kit is not open', async () => {
    expect(await toolsWith(bp, null, undefined, undefined)).toBe(true);
    expect(plain()).toContain('This project has a Flutter app for iPhone.');
    expect(plain()).toContain('Required');
    expect(plain()).toContain('✗ Flutter  Missing');
    expect(plain()).toContain('Stops now: Building, Checks, Phone pictures, Start, Try it yourself. Everything else keeps working.');
    expect(plain()).toContain('Official page: https://docs.flutter.dev/get-started/install');
    expect(plain()).toContain('squad-kit gets it: squad tools get maestro');
  });

  it("goes through the open board's REST call, the same as the button", async () => {
    const a = app();
    const asked: string[] = [];
    const api = {
      call: async <T>(method: 'GET' | 'POST' | 'PUT', at: string): Promise<T> => {
        asked.push(`${method} ${at}`);
        return (await call<T>(a, method, at)).data;
      },
    };
    hasFlutter = true;
    expect(await toolsWith(bp, api, 'check', undefined)).toBe(true);
    expect(asked).toEqual(['POST /tools/check']);
    expect(plain()).toContain('✓ Flutter  Ready, 3.47.0');
    await expect(toolsWith(bp, api, 'get', undefined)).rejects.toThrow('Say which tool');
  });
});

describe('a story waits for its tools, and goes on by itself', () => {
  type Squad = { tick(): void; launch(key: string, run: () => Promise<void>): void };
  const squadOf = () => {
    const squad = new LiveSquad(bp) as unknown as Squad;
    const ran: string[] = [];
    squad.launch = (key) => void ran.push(key);
    return { squad, ran: () => ran.filter((k) => !k.startsWith('__')) };
  };
  const story = (phase: string) => {
    const t = createTicket(bp, { title: 'Sign up' });
    return updateTicket(bp, t.id, (x) => {
      x.stage = 'implement';
      x.status = 'Building';
      x.squad = { phase, nextAt: new Date(0).toISOString() };
    });
  };

  it('before its build: a plain message, a line in its activity, the link, and nothing failed', async () => {
    const t = story('build');
    const { squad, ran } = squadOf();
    squad.tick();
    expect(ran()).toEqual([]);
    const held = readTicket(bp, t.id)!;
    expect(held.status).toBe("Waits for Flutter on this computer. Goes on by itself once it's there");
    expect(held.waiting).toBeNull();
    expect(held.stuck).toBeUndefined();
    expect(held.activity[0]?.text).toBe("squad-kit can't build this story yet: Flutter isn't on this computer. It waits, and goes on by itself once the tool is there");
    // Said once, not on every turn.
    squad.tick();
    expect(readTicket(bp, t.id)!.activity.filter((a) => a.text.includes("isn't on this computer"))).toHaveLength(1);
    // The board reads it with what it waits for, and the link to its line.
    expect(tools.toolWaitOf(bp, held).toolWait).toMatchObject({ action: 'build', link: '/tools#flutter', tools: [{ id: 'flutter', name: 'Flutter', state: 'missing' }] });

    // Flutter installed, Check again: the build starts by itself.
    hasFlutter = true;
    await tools.checkTools();
    squad.tick();
    expect(ran()).toEqual([t.id]);
    expect(readTicket(bp, t.id)!.activity[0]?.text).toBe('The tools it needs are on this computer now, so it goes on');
  });

  it('before its checks too, and only the steps that need the tool wait', async () => {
    const checks = story('test');
    const plan = story('plan-write');
    const { squad, ran } = squadOf();
    squad.tick();
    expect(ran()).toEqual([plan.id]);
    expect(readTicket(bp, checks.id)!.status).toBe("Waits for Flutter on this computer. Goes on by itself once it's there");
    expect(readTicket(bp, checks.id)!.activity[0]?.text).toContain("squad-kit can't run this story's checks yet: Flutter isn't on this computer.");
  });

  it('a project that needs nothing more never waits', () => {
    fs.rmSync(path.join(bp.root, 'pubspec.yaml'));
    fs.writeFileSync(path.join(bp.root, 'package.json'), '{}');
    const t = story('build');
    const { squad, ran } = squadOf();
    squad.tick();
    expect(ran()).toEqual([t.id]);
  });

  it("with nothing checked yet, it waits for the check, then decides", async () => {
    fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'tools', 'found.json'));
    hasFlutter = true;
    const t = story('build');
    const { squad, ran } = squadOf();
    squad.tick();
    expect(readTicket(bp, t.id)!.status).toBe(tools.TOOLS_CHECKING);
    expect(ran()).toEqual([]);
    await tools.checkTools();
    squad.tick();
    expect(ran()).toEqual([t.id]);
  });
});
