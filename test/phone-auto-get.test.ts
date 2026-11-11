import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectHost, Ran } from '../src/engine/tools/detect.js';
import type { ToolSource } from '../src/engine/tools/get.js';

/**
 * squad-kit gets Maestro (and Java for it) by itself the first time a phone app's pictures need it, once Xcode is
 * ready, with the Tools page's own Get: the story waits for that short download, its line saying the progress and the
 * time left, and goes on once it is there. A get that did not work is not tried again by itself. The Mac and the
 * downloads are made up: nothing is downloaded and nothing real runs.
 */

// On any computer, CI's Linux too, the phone is a Mac's: a fake that says it is here.
vi.mock('../src/modules/registry.js', async (orig) => {
  const { fakePhone } = await import('./fakes/phone.js');
  const phone = fakePhone({ notHere: null });
  return { ...(await orig<typeof import('../src/modules/registry.js')>()), shotPhone: () => phone.module };
});

const { boardPaths } = await import('../src/board/store.js');
const { zip } = await import('../src/core/zip.js');
const tools = await import('../src/engine/tools/index.js');
const { gettingNow, lastTrouble, setTrouble, GetTrouble } = await import('../src/engine/tools/get.js');
const { picturesHold, picturesWay, useGetSource, untilGot } = await import('../src/engine/phone/plan.js');

let tmp: string;
let home: string;
let bp: ReturnType<typeof boardPaths>;
let xcode = true;

/** A Mac with Flutter, CocoaPods and, unless told otherwise, Xcode with an iPhone simulator; no Maestro, no Java. */
function fakeMac(): DetectHost {
  const files: Record<string, string> = { '/sdk/flutter/bin/flutter': '', '/sdk/flutter/bin/cache/flutter.version.json': JSON.stringify({ frameworkVersion: '3.44.8' }), '/sdk/flutter/bin/pod': '' };
  const answers: Record<string, Ran> = {
    'xcode-select -p': xcode ? { ok: true, out: '/Applications/Xcode.app/Contents/Developer\n', err: '' } : { ok: false, out: '', err: 'no developer tools' },
    'xcodebuild -version': { ok: true, out: 'Xcode 27.2\nBuild version 27B52\n', err: '' },
    'xcrun simctl list runtimes -j': { ok: true, out: JSON.stringify({ runtimes: [{ name: 'iOS 27.2', version: '27.2', platform: 'iOS', isAvailable: true }] }), err: '' },
    'pod --version': { ok: true, out: '1.16.2\n', err: '' },
  };
  return {
    system: 'mac',
    home: '/Users/nobody',
    env: { PATH: '/sdk/flutter/bin' },
    run: async (cmd, args) => answers[`${path.basename(cmd)} ${args.join(' ')}`] ?? { ok: false, out: '', err: 'not found' },
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    real: (p) => p,
    list: () => [],
    writable: () => true,
  };
}

/** Made-up downloads in the layout of the real ones. */
const ARCHIVES = {
  maestro: { version: '2.12.1', data: zip([{ name: 'maestro/bin/maestro', data: '#!/bin/sh\necho 2.12.1\n' }]), bin: ['maestro', 'bin', 'maestro'] },
  java: { version: '21.0.5+11', data: zip([{ name: 'jdk-21.0.5+11-jre/Contents/Home/bin/java', data: '#!/bin/sh\n' }]), bin: ['jdk-21.0.5+11-jre', 'Contents', 'Home', 'bin', 'java'] },
};
async function* body(data: Buffer): AsyncIterable<Uint8Array> {
  yield data;
}
let asked: string[];
const fakeSource = async (id: string): Promise<ToolSource> => {
  asked.push(id);
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

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-get-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
  const root = path.join(tmp, 'app');
  for (const d of ['ios', 'web']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  bp = boardPaths(path.join(root, '.squad'));
  xcode = true;
  asked = [];
  tools.useDetectHost(fakeMac());
  useGetSource(fakeSource);
  await tools.checkTools();
});
afterEach(async () => {
  await untilGot();
  useGetSource(null);
  tools.useDetectHost(null);
  setTrouble('maestro');
  setTrouble('java');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Maestro, got by squad-kit itself', () => {
  it('the first time the pictures need it: the story waits with the progress and the time left, then takes them on the iPhone', async () => {
    // Even with a web version to show, this short download is worth the wait.
    const block = picturesHold(bp, {}, true)!;
    expect(gettingNow()?.tool).toBe('maestro');
    expect(block.status).toMatch(/^Waits for Maestro and Java, which squad-kit is getting now \(.*(seconds|minutes) left\)\. Goes on by itself once they're there$/);
    expect(tools.waitsForTools(block.status)).toBe(true);
    expect(block.text).toContain('squad-kit is getting Maestro and Java now');
    // The Tools page shows the same download on Maestro's line.
    expect((await tools.projectTools(bp)).lines.find((l) => l.id === 'maestro')?.state).toBe('getting');
    await untilGot();
    // Checked again after: both are squad-kit's own now, and the pictures go to the iPhone.
    await tools.checkTools();
    expect(asked).toEqual(['maestro', 'java']);
    expect(picturesHold(bp, {}, true)).toBeNull();
    const way = await picturesWay(bp, {}, true);
    expect(way.way).toBe('phone');
    expect((way as { tools: { maestro: string; javaHome?: string } }).tools).toEqual({
      maestro: path.join(home, 'tools', 'maestro', '2.12.1', 'maestro', 'bin', 'maestro'),
      javaHome: path.join(home, 'tools', 'java', '21.0.5+11', 'jdk-21.0.5+11-jre', 'Contents', 'Home'),
    });
  });

  it('never while Xcode is missing: the web version stands in, as before', async () => {
    xcode = false;
    tools.useDetectHost(fakeMac());
    await tools.checkTools();
    expect(picturesHold(bp, {}, true)).toBeNull();
    expect(gettingNow()).toBeNull();
    expect((await picturesWay(bp, {}, true)).way).toBe('web');
    expect(asked).toEqual([]);
  });

  it('a get that did not work is not tried again by itself: the Tools line says why, with Get it', async () => {
    useGetSource(async () => {
      throw new GetTrouble("squad-kit could not reach Maestro's official download. Check the internet connection, then press Get it again.");
    });
    picturesHold(bp, {}, true);
    await untilGot();
    expect(lastTrouble('maestro')).toContain('could not reach');
    useGetSource(fakeSource);
    // With a web version, its pictures meanwhile; without one, the story waits for Maestro.
    expect(picturesHold(bp, {}, true)).toBeNull();
    expect((await picturesWay(bp, {}, true)).way).toBe('web');
    expect(picturesHold(bp, {}, false)?.status).toBe("Waits for Maestro and Java on this computer. Goes on by itself once they're there");
    expect(asked).toEqual([]);
  });
});
