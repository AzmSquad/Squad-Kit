import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Found, FoundBook } from '../src/engine/tools/detect.js';

/**
 * How a story's pictures are taken: on squad-kit's own iPhone when the app is an iPhone app and its tools are ready;
 * of the web version, said in one plain line, when they are missing and the app has one; else the story waits for
 * the tools, and never takes its proof without pictures. A web project keeps its browser pictures as before.
 */

// On any computer, CI's Linux too, the phone is a Mac's: a fake that says it is here.
vi.mock('../src/modules/registry.js', async (orig) => {
  const { fakePhone } = await import('./fakes/phone.js');
  const phone = fakePhone({ notHere: null });
  return { ...(await orig<typeof import('../src/modules/registry.js')>()), shotPhone: () => phone.module };
});

const { boardPaths } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { useDetectHost } = await import('../src/engine/tools/index.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const { picturesWay, picturesHold, iphoneApp, phoneApp, tapTools, untilGot, useGetSource, WEB_VERSION } = await import('../src/engine/phone/plan.js');
const { GetTrouble, setTrouble } = await import('../src/engine/tools/get.js');

let tmp: string;
let home: string;

const ready: Record<string, Found> = {
  flutter: { state: 'found', version: '3.44.8', where: '/fl' },
  xcode: { state: 'found', version: '27.2' },
  simulator: { state: 'found', version: '27.2' },
  cocoapods: { state: 'found', version: '1.16.2' },
  java: { state: 'found', version: '21.0.5' },
  maestro: { state: 'found', version: '2.12.1', where: '/Users/pm/.local/bin/maestro' },
  'android-studio': { state: 'missing' },
  docker: { state: 'missing' },
};

function found(over: Record<string, Found> = {}, system: FoundBook['system'] = 'mac'): void {
  writeFound({ at: new Date().toISOString(), system, tools: { ...ready, ...over } as FoundBook['tools'] }, home);
  useDetectHost(null);
}

/** A Flutter app with iPhone and, when asked, web folders. */
function flutterApp(web: boolean): ReturnType<typeof boardPaths> {
  const root = path.join(tmp, 'app');
  fs.mkdirSync(path.join(root, 'ios'), { recursive: true });
  if (web) fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  return boardPaths(path.join(root, '.squad'));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-plan-')));
  home = path.join(tmp, 'home');
  process.env.SQUAD_KIT_HOME = home;
  // Never the internet: a get squad-kit starts by itself here finds no download.
  useGetSource(async () => {
    throw new GetTrouble('No downloads in tests.');
  });
});
afterEach(async () => {
  await untilGot();
  useGetSource(null);
  setTrouble('maestro');
  setTrouble('java');
  useDetectHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('how the pictures are taken', () => {
  it("on squad-kit's own iPhone when the tools are ready, with Maestro from where the check found it", async () => {
    const bp = flutterApp(true);
    found();
    const way = await picturesWay(bp, {}, true);
    expect(way).toEqual({ way: 'phone', kind: 'flutter', dir: path.join(tmp, 'app'), system: 'ios', tools: { maestro: '/Users/pm/.local/bin/maestro' } });
    expect(picturesHold(bp, {}, false)).toBeNull();
  });

  it("squad-kit's own Maestro and Java come first, with Java's home for Maestro", () => {
    found();
    for (const [id, version, binary] of [['maestro', '2.12.1', 'bin/maestro'], ['java', '21.0.5', 'Contents/Home/bin/java']] as const) {
      const dir = path.join(home, 'tools', id, version);
      fs.mkdirSync(path.dirname(path.join(dir, binary)), { recursive: true });
      fs.writeFileSync(path.join(dir, binary), '');
      fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ version, binary }));
    }
    expect(tapTools()).toEqual({ maestro: path.join(home, 'tools', 'maestro', '2.12.1', 'bin', 'maestro'), javaHome: path.join(home, 'tools', 'java', '21.0.5', 'Contents', 'Home') });
  });

  it('of the web version when Xcode is missing, said in one plain line, with the Tools page line', async () => {
    const bp = flutterApp(true);
    found({ xcode: { state: 'missing' }, simulator: { state: 'missing', note: 'It comes with Xcode.' } });
    expect(await picturesWay(bp, {}, true)).toEqual({ way: 'web', line: 'iPhone pictures need Xcode. squad-kit took pictures of the web version meanwhile.', link: '/tools#xcode' });
    expect(WEB_VERSION).toBe('Web version');
  });

  it('names what is missing or too old, and a Mac on Windows', async () => {
    const bp = flutterApp(true);
    found({ maestro: { state: 'missing' }, java: { state: 'missing' } });
    // squad-kit tries to get them itself first; once that did not work, the web version stands in.
    expect((await picturesWay(bp, {}, true)).way).toBe('wait');
    await untilGot();
    expect(((await picturesWay(bp, {}, true)) as { line: string }).line).toBe('iPhone pictures need Maestro and Java. squad-kit took pictures of the web version meanwhile.');
    found({ flutter: { state: 'found', version: '3.27.3', where: '/fl' } });
    expect(((await picturesWay(bp, {}, true)) as { line: string }).line).toBe('iPhone pictures need a newer Flutter. squad-kit took pictures of the web version meanwhile.');
    found({ xcode: { state: 'not-here' }, simulator: { state: 'not-here' }, cocoapods: { state: 'not-here' } }, 'windows');
    expect(((await picturesWay(bp, {}, true)) as { line: string }).line).toBe('iPhone pictures need a Mac. squad-kit took pictures of the web version meanwhile.');
  });

  it('with no web version either, no pictures: the story waits for the tools with the reason, and never goes on without them', async () => {
    const bp = flutterApp(false);
    found({ xcode: { state: 'missing' }, simulator: { state: 'missing' } });
    const way = await picturesWay(bp, {}, false);
    expect(way.way).toBe('wait');
    const block = picturesHold(bp, {}, false)!;
    expect(block.action).toBe('pictures');
    expect(block.text).toBe("squad-kit can't take the phone pictures yet: Xcode and iPhone simulator aren't on this computer.");
    expect(block.status).toBe("Waits for Xcode and iPhone simulator on this computer. Goes on by itself once they're there");
    expect(block.link).toBe('/tools#xcode');
    // A web version to show meanwhile: nothing waits.
    expect(picturesHold(bp, {}, true)).toBeNull();
  });

  it('a web project keeps its browser pictures as before; an Android-only phone app goes to the Android phone', async () => {
    const web = path.join(tmp, 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    found({ xcode: { state: 'missing' } });
    expect(await picturesWay(boardPaths(path.join(web, '.squad')), {}, true)).toEqual({ way: 'browser' });
    const android = path.join(tmp, 'android');
    fs.mkdirSync(path.join(android, 'android'), { recursive: true });
    fs.writeFileSync(path.join(android, 'pubspec.yaml'), 'dependencies:\n  flutter:\n    sdk: flutter\n');
    expect(iphoneApp(boardPaths(path.join(android, '.squad')))).toBeNull();
    expect(phoneApp(boardPaths(path.join(android, '.squad')))).toEqual({ dir: android, kind: 'flutter', system: 'android' });
    // Its Android tools are not here: it waits for them, with the line of the Tools page; Xcode is never asked for.
    const hold = picturesHold(boardPaths(path.join(android, '.squad')), {}, false);
    expect(hold?.tools.map((t) => t.id)).toEqual(['android']);
    expect(hold?.link).toBe('/tools#android');
    found({ xcode: { state: 'missing' }, android: { state: 'found', version: 'Android 16', where: '/sdk' } });
    expect(await picturesWay(boardPaths(path.join(android, '.squad')), {}, false)).toMatchObject({ way: 'phone', system: 'android', kind: 'flutter' });
  });

  it("reads the story's own copy: an iPhone app the story adds is found there", () => {
    const bp = flutterApp(false);
    seedDemoBoard(bp, { speed: 50 });
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(path.join(copy, 'App.xcodeproj'), { recursive: true });
    fs.rmSync(path.join(tmp, 'app', 'pubspec.yaml'));
    expect(iphoneApp(bp, { worktree: copy })).toEqual({ dir: copy, kind: 'ios' });
  });
});
