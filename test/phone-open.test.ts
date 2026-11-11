import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePhone, type FakePhone } from './fakes/phone.js';
import type { BuildRun } from '../src/engine/phone/build.js';

/**
 * An app opened on squad-kit's iPhone for a person (Start, Try it yourself): each step with the time left, the one
 * window squad-kit opens, the person holding the phone so stories' pictures wait with a plain line, giving it back after
 * the yield time, seeing a window the person closed and never opening it again, and Stop shutting the phone down. The
 * phone and the build are fakes: no simulator, no window.
 */

const h = vi.hoisted(() => ({ phone: null as FakePhone | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotPhone: () => h.phone!.module,
}));

const { PhoneOpen } = await import('../src/engine/phone/open.js');
const { useBuildRun } = await import('../src/engine/phone/build.js');
const desk = await import('../src/engine/phone/turn.js');
const { appLanguages, arbLanguage } = await import('../src/engine/phone/languages.js');

let tmp: string;
let dir: string;
let release: (() => void) | null;

/** A build that makes the app where Flutter would, and waits while `release` is held. */
const build: BuildRun = async (cmd, args, o) => {
  if (release !== null) await new Promise<void>((r) => (release = r));
  fs.mkdirSync(path.join(o.cwd, 'build', 'ios', 'iphonesimulator', 'Runner.app'), { recursive: true });
  return { ok: true, output: '' };
};

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-open-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  dir = path.join(tmp, 'app');
  fs.mkdirSync(path.join(dir, 'ios'), { recursive: true });
  h.phone = fakePhone();
  release = null;
  useBuildRun(build);
  desk.resetDesk();
  // Looks again after a real moment, so the window's watch gets its turn.
  desk.useDeskHost({ freeBytes: async () => 8 * 1024 ** 3, load: () => 1, cores: () => 10, alive: () => false, sleep: () => new Promise((r) => setTimeout(r, 5)) });
});
afterEach(() => {
  useBuildRun(null);
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const open = (o: { language?: string; yieldAfterMs?: number; onEnd?: (w: string) => void; by?: string; again?: string } = {}) =>
  new PhoneOpen({ dir, kind: 'flutter', by: o.by ?? 'Your apps', again: o.again ?? 'Start', yieldAfterMs: o.yieldAfterMs ?? 60_000, watchMs: 20, ...(o.language ? { language: o.language } : {}), ...(o.onEnd ? { onEnd: o.onEnd } : {}) });

describe('an app opened on the iPhone for a person', () => {
  it('shows each step with the time left, then runs on the device, in the window, in the language asked', async () => {
    release = () => undefined;
    const p = open({ language: 'ar' });
    await until(() => p.view().step === 'build');
    // Build 5 minutes, start the phone 1 minute, put the app on it 15 seconds, open it 5 seconds: the first guesses.
    expect(p.view()).toMatchObject({ state: 'starting', step: 'build', line: 'Building the app for the iPhone, about 6 minutes left' });
    release!();
    release = null;
    await p.settled;
    const id = h.phone!.devices[0]!.id;
    expect(p.view()).toMatchObject({ state: 'running', device: 'iPhone 18 Pro', language: 'ar' });
    expect(h.phone!.calls).toEqual([
      `create squad-kit iPhone iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2`,
      `boot ${id}`,
      `install ${id} ${path.join(dir, 'build', 'ios', 'iphonesimulator', 'Runner.app')}`,
      `terminate ${id} dev.test.app`,
      `launch ${id} dev.test.app ar`,
      // The one window squad-kit opens: the person asked to see the app.
      `window ${id}`,
    ]);
    expect(desk.phoneHold()).toMatchObject({ by: 'Your apps' });
    await p.stop();
  });

  it("while the person holds the phone, a story's pictures wait with a plain line; when they close the window, squad-kit sees it and never opens it again", async () => {
    const ended: string[] = [];
    const p = open({ by: 'Try it yourself', again: 'Try it yourself', onEnd: (w) => ended.push(w) });
    await p.settled;
    const id = h.phone!.devices[0]!.id;
    const lines: string[] = [];
    let took = false;
    const pictures = desk.withPhone(h.phone!.module, 'phone', async () => void (took = true), { say: (t) => lines.push(t), who: 'WA-3' });
    await until(() => lines.length > 0);
    expect(lines).toEqual(["squad-kit's iPhone is open in Try it yourself. The pictures wait until you close it."]);
    expect(desk.phoneHold()?.wanted).toBe('WA-3');
    expect(took).toBe(false);
    // The person closes the Simulator window.
    h.phone!.windows.delete(id);
    await pictures;
    expect(took).toBe(true);
    expect(ended).toEqual(['You closed the iPhone window, so squad-kit stopped the app.']);
    expect(p.view()).toMatchObject({ state: 'stopped', ended: 'You closed the iPhone window, so squad-kit stopped the app.' });
    expect(h.phone!.calls.filter((c) => c.startsWith('window'))).toHaveLength(1);
    expect(desk.phoneHold()).toBeNull();
  });

  it('a phone left open gives way to a waiting story after the yield time, and says so', async () => {
    const ended: string[] = [];
    const p = open({ yieldAfterMs: 0, onEnd: (w) => ended.push(w) });
    await p.settled;
    const id = h.phone!.devices[0]!.id;
    await desk.withPhone(h.phone!.module, 'phone', async () => undefined, { who: 'WA-4' });
    expect(ended).toEqual(['squad-kit closed the app on its iPhone: a story needs the iPhone for its pictures. Press Start again later.']);
    expect(h.phone!.calls.filter((c) => c === `terminate ${id} dev.test.app`)).toHaveLength(2);
  });

  it('Stop closes the app and shuts the iPhone down; opening another app replaces the first, said plainly', async () => {
    const ended: string[] = [];
    const first = open({ onEnd: (w) => ended.push(w) });
    await first.settled;
    const second = open({ by: 'Try it yourself' });
    await second.settled;
    expect(ended).toEqual(['squad-kit closed the app on its iPhone, as you opened another one there.']);
    expect(desk.phoneHold()).toMatchObject({ by: 'Try it yourself' });
    const id = h.phone!.devices[0]!.id;
    await second.stop();
    expect(second.view().state).toBe('stopped');
    expect(h.phone!.calls.slice(-2)).toEqual([`terminate ${id} dev.test.app`, `shutdown ${id}`]);
    expect(h.phone!.devices[0]!.state).toBe('shutdown');
    expect(desk.phoneHold()).toBeNull();
  });

  it("a build that does not work says so plainly, and holds nothing", async () => {
    useBuildRun(async () => ({ ok: false, output: 'Error (Xcode): no such module' }));
    const p = open();
    await p.settled;
    expect(p.view()).toMatchObject({ state: 'failed', error: 'The app did not build for the iPhone.' });
    expect(p.view().detail).toContain('no such module');
    expect(desk.phoneHold()).toBeNull();
    expect(h.phone!.calls.some((c) => c.startsWith('window'))).toBe(false);
  });
});

describe("the languages an app comes in, from its own files", () => {
  it("Flutter's translation files, in lib/l10n or where l10n.yaml says; English first", () => {
    fs.mkdirSync(path.join(dir, 'lib', 'l10n'), { recursive: true });
    for (const f of ['app_ar.arb', 'app_en.arb']) fs.writeFileSync(path.join(dir, 'lib', 'l10n', f), '{}');
    expect(appLanguages(dir, 'flutter')).toEqual(['en', 'ar']);
    fs.writeFileSync(path.join(dir, 'l10n.yaml'), 'arb-dir: lib/i18n\n');
    fs.mkdirSync(path.join(dir, 'lib', 'i18n'), { recursive: true });
    for (const f of ['intl_fr.arb', 'intl_en_US.arb', 'intl_ur.arb']) fs.writeFileSync(path.join(dir, 'lib', 'i18n', f), '{}');
    expect(appLanguages(dir, 'flutter')).toEqual(['en', 'fr', 'ur']);
    expect(arbLanguage('app_en_US.arb')).toBe('en');
  });

  it("an iPhone app's .lproj folders, never inside its packages; nothing to pick with one language, or for React Native", () => {
    for (const l of ['Base', 'en', 'ar']) fs.mkdirSync(path.join(dir, 'App', `${l}.lproj`), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Pods', 'Lib', 'fr.lproj'), { recursive: true });
    expect(appLanguages(dir, 'ios')).toEqual(['en', 'ar']);
    expect(appLanguages(dir, 'react-native')).toEqual([]);
    fs.rmSync(path.join(dir, 'App', 'ar.lproj'), { recursive: true });
    expect(appLanguages(dir, 'ios')).toEqual([]);
  });
});
