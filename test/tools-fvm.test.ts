import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths } from '../src/board/store.js';
import type { DetectHost, Ran } from '../src/engine/tools/detect.js';
import type { RunUpdate } from '../src/engine/tools/update.js';
import type { ToolSource } from '../src/engine/tools/get.js';

/**
 * FVM, which runs the Flutter version a project pins: squad-kit finds it and its version, commands that run fvm need
 * FVM 3 or newer, and squad-kit gets its own FVM with Get it: FVM's official release, checked against its pinned
 * SHA-256, used first by squad-kit's own commands, whatever FVM the person has. The computer is made up, and the
 * download is a made-up archive: nothing real runs or downloads.
 */

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { detectAll, fvmVersionOf } = await import('../src/engine/tools/detect.js');
const { startUpdate, useUpdateRun } = await import('../src/engine/tools/update.js');
const { fvmSource, getTool, gettingNow, noteTime, setTrouble } = await import('../src/engine/tools/get.js');
const { ownTool } = await import('../src/engine/tools/detect.js');
const { withOwnPrograms } = await import('../src/engine/agent-env.js');
const { ownToolReads } = await import('../src/engine/android-env.js');
const { zip } = await import('../src/core/zip.js');
const tools = await import('../src/engine/tools/index.js');

const CELLAR_FVM = '/usr/local/Cellar/fvm/2.4.1/bin/fvm';
let fvmVersion = '2.4.1';
let ran: string[];

/** A Mac with Flutter, and FVM from Homebrew: /usr/local/bin/fvm links into Homebrew's Cellar. */
function mac(o: { brew?: boolean; writable?: boolean; arch?: string } = {}): DetectHost {
  const files: Record<string, string> = { '/usr/local/bin/fvm': '', '/usr/local/bin/brew': '', '/sdk/flutter/bin/flutter': '', '/sdk/flutter/version': '3.47.9' };
  return {
    system: 'mac',
    // An Intel Mac unless a test says: Homebrew in /usr/local is the right one for it.
    arch: o.arch ?? 'x64',
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

  it("commands that run fvm need FVM 3 or newer: FVM 2 is too old, and squad-kit gets its own with Get it", async () => {
    pinned();
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'fvm flutter test', lint: 'fvm flutter analyze' } });
    tools.useDetectHost(mac());
    await tools.checkTools();
    const v = await tools.projectTools(bp);
    const fvm = v.lines.find((l) => l.id === 'fvm')!;
    expect(fvm).toMatchObject({ priority: 'required', state: 'too-old', version: '2.4.1', needs: '3', blocks: ['build', 'checks', 'start-app'], usedFor: 'Building, Checks, Start', installer: 'squad-kit', command: 'squad tools get fvm' });
    // No update of the person's own FVM: squad-kit's own is the way, and theirs stays as it is.
    expect(fvm.update).toBeUndefined();
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

});

describe("squad-kit's own FVM", () => {
  /** A made-up release archive in the real layout: one program, fvm/fvm. */
  const archive = (() => {
    const data = zip([{ name: 'fvm/fvm', data: '#!/bin/sh\necho 4.3.2\n' }, { name: 'fvm/src/LICENSE', data: 'MIT' }]);
    return { data, sha: createHash('sha256').update(data).digest('hex') };
  })();
  const fake = (): ToolSource => ({
    version: '4.3.2',
    file: 'fvm-4.3.2-macos-arm64.zip',
    pack: 'zip',
    sha256: async () => archive.sha,
    open: async () => ({ body: (async function* () { yield archive.data; })(), size: archive.data.length }),
    binary: fvmSource(fetch, 'mac', 'arm64').binary,
  });

  it("takes FVM's official release for this system and chip, pinned to its published SHA-256", async () => {
    const mac = fvmSource(fetch, 'mac', 'arm64');
    expect(mac).toMatchObject({ version: '4.3.2', file: 'fvm-4.3.2-macos-arm64.tar.gz', pack: 'tar.gz', size: 3_513_655 });
    expect(await mac.sha256(new AbortController().signal)).toBe('c9b1e67e5ff4ddae4710669ff9aa312f750947f68fac5b15fc5d248fb4419342');
    expect(fvmSource(fetch, 'windows', 'x64')).toMatchObject({ file: 'fvm-4.3.2-windows-x64.zip', pack: 'zip' });
    expect(fvmSource(fetch, 'linux', 'x64').file).toBe('fvm-4.3.2-linux-x64.tar.gz');
  });

  it('Get it puts it in squad-kit\'s own folder; then it is the FVM found, first on the commands\' PATH, and readable in the guard', async () => {
    const home = process.env.SQUAD_KIT_HOME!;
    const got = await getTool('fvm', fake(), { home, system: 'mac' });
    expect(got.binary).toBe(path.join(home, 'tools', 'fvm', '4.3.2', 'fvm', 'fvm'));
    expect(ownTool('fvm', home)).toMatchObject({ version: '4.3.2' });
    // Found as squad-kit's own, whatever FVM the person has on the PATH.
    expect((await detectAll(mac(), home)).tools.fvm).toEqual({ state: 'found', version: '4.3.2', where: got.binary, own: true });
    const env = withOwnPrograms({ PATH: '/usr/local/bin:/usr/bin' });
    expect(env.PATH).toBe([path.dirname(got.binary), '/usr/local/bin', '/usr/bin'].join(path.delimiter));
    expect(ownToolReads(home)).toContain(path.join(home, 'tools', 'fvm', '4.3.2'));
  });
});

describe('an update that runs long', () => {
  it('past its usual time it says "longer than usual", never "about 10 s left" for half an hour', async () => {
    // It took a second here last time, so this run is past its usual time at once.
    noteTime('flutter-update', 1, process.env.SQUAD_KIT_HOME!);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const run: RunUpdate = async () => {
      await held;
      return { code: 1 };
    };
    let done: () => void = () => undefined;
    const ended = new Promise<void>((r) => (done = r));
    startUpdate('flutter', '/Users/pm/flutter', { run, system: 'mac', version: async () => '3.27.3', after: () => done() });
    await new Promise((r) => setTimeout(r, 2300));
    expect(gettingNow()).toMatchObject({ tool: 'flutter', longer: true, secondsLeft: 0 });
    release();
    await ended;
    setTrouble('flutter');
  });
});
