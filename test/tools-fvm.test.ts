import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths } from '../src/board/store.js';
import type { DetectHost, Ran } from '../src/engine/tools/detect.js';
import type { RunUpdate } from '../src/engine/tools/update.js';

/**
 * FVM, which runs the Flutter version a project pins: squad-kit finds it and its version, a project that pins its
 * Flutter with it (a .fvmrc, or commands that run fvm) needs FVM 3 or newer, and a Homebrew copy that is too old is
 * updated with Homebrew itself, after the person's OK. The computer and Homebrew are made up: nothing real runs.
 */

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { detectAll, fvmVersionOf } = await import('../src/engine/tools/detect.js');
const { BREW_ENV, brewUpdateLook, startUpdate, updateTool, useUpdateRun } = await import('../src/engine/tools/update.js');
const { gettingNow, lastTrouble, setTrouble } = await import('../src/engine/tools/get.js');
const tools = await import('../src/engine/tools/index.js');

const CELLAR_FVM = '/usr/local/Cellar/fvm/2.4.1/bin/fvm';
let fvmVersion = '2.4.1';
let ran: string[];

/** A Mac with Flutter, and FVM from Homebrew: /usr/local/bin/fvm links into Homebrew's Cellar. */
function mac(o: { brew?: boolean; writable?: boolean } = {}): DetectHost {
  const files: Record<string, string> = { '/usr/local/bin/fvm': '', '/usr/local/bin/brew': '', '/sdk/flutter/bin/flutter': '', '/sdk/flutter/version': '3.47.9' };
  return {
    system: 'mac',
    home: '/Users/pm',
    env: { PATH: '/usr/local/bin:/sdk/flutter/bin' },
    async run(cmd, args): Promise<Ran> {
      const key = `${path.basename(cmd)} ${args.join(' ')}`;
      ran.push(key);
      if (key === 'fvm --version') return { ok: true, out: `${fvmVersion}\n`, err: '' };
      return { ok: false, out: '', err: 'not found' };
    },
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    real: (p) => (p === '/usr/local/bin/fvm' && o.brew !== false ? CELLAR_FVM : p),
    list: () => [],
    writable: () => o.writable !== false,
  };
}

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  ran = [];
  fvmVersion = '2.4.1';
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-fvm-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.SQUAD_KIT_HOME);
  bp = makeNewProject({ name: 'Shop', where: tmp, idea: 'A phone app' }).bp;
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done', empty: true, summary: 'A phone app.' } });
});

afterEach(() => {
  tools.useDetectHost(null);
  useUpdateRun(null);
  setTrouble('fvm');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('finding FVM', () => {
  it('reads its version as FVM 2, 3 and 4 print it', () => {
    expect(fvmVersionOf('2.4.1\n')).toBe('2.4.1');
    expect(fvmVersionOf('3.2.1')).toBe('3.2.1');
    expect(fvmVersionOf('A new version of FVM is available: 4.3.2\n4.0.0\n')).toBe('4.0.0');
    expect(fvmVersionOf('fvm: command not found')).toBeNull();
  });

  it("finds it with its version, and that Homebrew looks after this copy", async () => {
    const book = await detectAll(mac(), path.join(tmp, 'home'));
    expect(book.tools.fvm).toEqual({ state: 'found', where: '/usr/local/bin/fvm', version: '2.4.1', managedBy: 'homebrew' });
    expect((await detectAll(mac({ brew: false }), path.join(tmp, 'home'))).tools.fvm).toEqual({ state: 'found', where: '/usr/local/bin/fvm', version: '2.4.1' });
  });
});

describe('a project that pins its Flutter with FVM', () => {
  const pinned = () => fs.writeFileSync(path.join(bp.root, '.fvmrc'), JSON.stringify({ flutter: '3.47.9' }));

  it('a .fvmrc beside plain flutter commands only recommends FVM: it stops nothing', async () => {
    pinned();
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'flutter test' } });
    tools.useDetectHost(mac());
    await tools.checkTools();
    const fvm = (await tools.projectTools(bp)).lines.find((l) => l.id === 'fvm')!;
    expect(fvm).toMatchObject({ priority: 'recommended', state: 'too-old', blocks: [] });
    expect(tools.blockedBy(bp, 'build')).toBeNull();
  });

  it('commands that run fvm need FVM 3 or newer: FVM 2 is too old, and squad-kit can update a Homebrew copy after your OK', async () => {
    pinned();
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'fvm flutter test', lint: 'fvm flutter analyze' } });
    tools.useDetectHost(mac());
    await tools.checkTools();
    const v = await tools.projectTools(bp);
    const fvm = v.lines.find((l) => l.id === 'fvm')!;
    expect(fvm).toMatchObject({ priority: 'required', state: 'too-old', version: '2.4.1', needs: '3', blocks: ['build', 'checks', 'start-app'], usedFor: 'Building, Checks, Start' });
    expect(fvm.update).toEqual({
      warning: 'This updates FVM for every project that uses FVM on this Mac, not only this one. Older projects may need small changes to build again. It downloads about 300 MB and takes about 5 minutes.',
      seconds: 300,
      command: 'squad tools update fvm',
    });
    expect(fvm.steps).toEqual(['Open a terminal.', 'Run: brew upgrade fvm', 'Come back here and press Check again.']);
    // A story waits before the Builder starts, with what is wrong in plain words.
    const b = tools.blockedBy(bp, 'build');
    expect(b).toMatchObject({ text: "squad-kit can't build this story yet: FVM 2.4.1 is too old: it needs 3 or newer.", status: "Waits for a newer FVM on this computer. Goes on by itself once it's there", link: '/tools#fvm' });
  });

  it('a project whose commands run fvm needs it too, before it has any file', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'fvm flutter test', build: 'fvm flutter build web' } });
    fvmVersion = '3.2.1';
    tools.useDetectHost(mac());
    await tools.checkTools();
    const v = await tools.projectTools(bp);
    expect(v.summary).toBe('This project has a Flutter app for iPhone and Android and a Flutter version pinned with FVM.');
    expect(v.lines.find((l) => l.id === 'fvm')).toMatchObject({ state: 'ready', version: '3.2.1', blocks: [] });
  });

  it("a copy Homebrew did not install, or a Homebrew folder that needs a password: the steps, and why squad-kit can't", () => {
    const found = { state: 'found' as const, where: '/usr/local/bin/fvm', version: '2.4.1' };
    expect(brewUpdateLook(mac({ brew: false }), found)).toEqual({ cant: "squad-kit can't update it here: it was not installed with Homebrew, so you update it the way you installed it." });
    expect(brewUpdateLook(mac({ writable: false }), { ...found, managedBy: 'homebrew' })).toEqual({ managedBy: 'homebrew', cant: "squad-kit can't update it here: your Homebrew folder needs your computer's password to change." });
    expect(brewUpdateLook(mac(), { ...found, managedBy: 'homebrew' })).toEqual({ managedBy: 'homebrew' });
  });
});

describe('updating FVM with Homebrew', () => {
  it('runs brew upgrade fvm with the Homebrew that installed it, with no questions, and says each step', async () => {
    let asked: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const seen: string[] = [];
    let now = '2.4.1';
    const run: RunUpdate = async (cmd, args, opts) => {
      if (args[0] === '--version') {
        opts.onLine(now);
        return { code: 0 };
      }
      asked = { cmd, args, env: opts.env };
      now = '4.3.2';
      for (const l of ['==> Auto-updating Homebrew...', '==> Fetching fvm', '==> Downloading https://ghcr.io/v2/homebrew/core/fvm/blobs/sha256:1', '==> Upgrading fvm', '  2.4.1 -> 4.3.2', '==> Summary', '🍺  /usr/local/Cellar/fvm/4.3.2: 8 files, 12MB']) opts.onLine(l);
      return { code: 0 };
    };
    const r = await updateTool('fvm', '/usr/local/bin/fvm', { run, onStep: (w) => seen.push(w) });
    expect(r.seconds).toBeGreaterThanOrEqual(0);
    expect(asked!.args).toEqual(['upgrade', 'fvm']);
    expect(asked!.env).toMatchObject(BREW_ENV);
    expect(seen).toEqual(["Getting Homebrew's list of new versions", 'Downloading the new FVM', 'Installing the new FVM', 'Checking the new FVM']);
  });

  it("a failed update says Homebrew's last line, and the line keeps it as its trouble", async () => {
    const run: RunUpdate = async (_c, args, opts) => {
      if (args[0] === '--version') {
        opts.onLine('2.4.1');
        return { code: 0 };
      }
      opts.onLine('==> Fetching fvm');
      opts.onLine('Error: fvm: Failed to download resource "dart-sdk"');
      return { code: 1 };
    };
    await expect(updateTool('fvm', '/usr/local/bin/fvm', { run })).rejects.toThrow('The update of FVM did not finish. Homebrew said: "Error: fvm: Failed to download resource "dart-sdk"" Try again, or do it yourself with the steps.');
    let done: () => void = () => undefined;
    const ended = new Promise<void>((r) => (done = r));
    const g = startUpdate('fvm', '/usr/local/bin/fvm', { run, after: () => done() });
    expect(g).toMatchObject({ tool: 'fvm', name: 'FVM', step: 'update', words: 'Looking for the new FVM' });
    await ended;
    expect(gettingNow()).toBeNull();
    expect(lastTrouble('fvm')).toContain('The update of FVM did not finish.');
  });

  it('Homebrew with nothing newer to give: said, never a quiet success', async () => {
    const run: RunUpdate = async (_c, args, opts) => {
      opts.onLine(args[0] === '--version' ? '2.4.1' : 'Warning: fvm 2.4.1 already installed');
      return { code: 0 };
    };
    await expect(updateTool('fvm', '/usr/local/bin/fvm', { run })).rejects.toThrow('Homebrew finished, but FVM is still 2.4.1: Homebrew had no newer FVM to give here. Do it yourself with the steps.');
  });
});
