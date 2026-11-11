import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePhone } from './fakes/phone.js';
import type { Ran, SimRun } from '../src/modules/ios-simulator/index.js';

/**
 * squad-kit's own phones: a "squad-kit iPhone" and a "squad-kit iPad", made once on the newest iOS and used again by
 * their saved id, never by their name, so nobody else's simulator is taken for squad-kit's. And the simulator module
 * itself: every command names a device by its exact id, starts it hidden, and opens the app in the language asked.
 */

const { ownDevice, savedDevices, isOwn, pickModel } = await import('../src/engine/phone/devices.js');
const { iosSimulatorWith, runtimesOf, devicesOf, languageArgs } = await import('../src/modules/ios-simulator/index.js');

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-devices-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("squad-kit's own devices", () => {
  it('makes its iPhone once, on the newest iOS, as a Pro without Max, and uses it again by its saved id', async () => {
    const f = fakePhone();
    const first = await ownDevice(f.module, 'phone');
    expect(first).toMatchObject({ name: 'squad-kit iPhone', model: 'iPhone 18 Pro', runtime: '27.2', state: 'shutdown' });
    expect(f.calls).toEqual([`create squad-kit iPhone iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2`]);
    const again = await ownDevice(f.module, 'phone');
    expect(again.id).toBe(first.id);
    expect(f.calls).toHaveLength(1);
    expect(savedDevices().map((d) => d.id)).toEqual([first.id]);
    expect(isOwn(first.id)).toBe(true);
  });

  it('never takes somebody else\'s device for its own, even with the very same name', async () => {
    const theirs = { id: 'AAAAAAAA-0000-0000-0000-000000000001', name: 'squad-kit iPhone', state: 'booted' as const, runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2' };
    const f = fakePhone({ devices: [theirs] });
    const mine = await ownDevice(f.module, 'phone');
    expect(mine.id).not.toBe(theirs.id);
    expect(isOwn(theirs.id)).toBe(false);
    expect(f.calls.filter((c) => c.includes(theirs.id))).toEqual([]);
  });

  it('makes a new one when its saved device is gone from this computer, and forgets the gone one', async () => {
    const f = fakePhone();
    const first = await ownDevice(f.module, 'phone');
    f.devices.splice(0);
    const next = await ownDevice(f.module, 'phone');
    expect(next.id).not.toBe(first.id);
    expect(savedDevices().map((d) => d.id)).toEqual([next.id]);
  });

  it('makes them on the iOS asked for, with the iPad Air it can run there', async () => {
    const f = fakePhone();
    expect(await ownDevice(f.module, 'phone', { runtime: '18.2' })).toMatchObject({ model: 'iPhone 16 Pro', runtime: '18.2' });
    expect(await ownDevice(f.module, 'tablet', { runtime: '18.2' })).toMatchObject({ name: 'squad-kit iPad', model: 'iPad Air 11-inch (M2)', runtime: '18.2' });
    // The newest iOS has its own iPhone; the one on 18.2 stays saved for when it is asked again.
    const newest = await ownDevice(f.module, 'phone');
    expect(newest.runtime).toBe('18.2');
    expect(savedDevices()).toHaveLength(2);
    await expect(ownDevice(f.module, 'phone', { runtime: '16.0' })).rejects.toThrow('This Mac has no iOS 16.0 for the iPhone.');
    expect(pickModel({ id: 'x', version: '1', models: [{ id: 'm', name: 'iPhone SE', size: 'phone' }] }, 'phone')).toEqual({ id: 'm', name: 'iPhone SE', size: 'phone' });
  });
});

describe('the iPhone simulator module', () => {
  const ID = '5527D1B5-EBE4-4BFE-A20C-E6875652FD56';

  function recorded(answers: Record<string, Ran> = {}): { run: SimRun; ran: string[] } {
    const ran: string[] = [];
    return {
      ran,
      run: async (file, args) => {
        const key = `${file} ${args.join(' ')}`;
        ran.push(key);
        return answers[key] ?? { ok: true, out: '', err: '' };
      },
    };
  }

  it('starts a device hidden by its exact id, and opens the app in Arabic or English', async () => {
    const r = recorded();
    const sim = iosSimulatorWith(r.run, 'darwin');
    await sim.boot(ID);
    await sim.launch(ID, 'dev.test.app', { language: 'ar' });
    await sim.launch(ID, 'dev.test.app', { language: 'en' });
    await sim.shutdown(ID);
    expect(r.ran).toEqual([
      `xcrun simctl boot ${ID}`,
      `xcrun simctl bootstatus ${ID}`,
      `xcrun simctl launch ${ID} dev.test.app -AppleLanguages (ar) -AppleLocale ar_SA`,
      `xcrun simctl launch ${ID} dev.test.app -AppleLanguages (en) -AppleLocale en_US`,
      `xcrun simctl shutdown ${ID}`,
    ]);
    // Never the Simulator window, never "booted" or a name for a device.
    expect(r.ran.some((c) => c.startsWith('open '))).toBe(false);
    await expect(sim.shutdown('booted')).rejects.toThrow('squad-kit only uses its own iPhone, by its exact id.');
    await expect(sim.boot('squad-kit iPhone')).rejects.toThrow('by its exact id');
    expect(languageArgs()).toEqual([]);
  });

  it('a device already up, or already down, is fine', async () => {
    const r = recorded({
      [`xcrun simctl boot ${ID}`]: { ok: false, out: '', err: 'Unable to boot device in current state: Booted' },
      [`xcrun simctl shutdown ${ID}`]: { ok: false, out: '', err: 'Unable to shutdown device in current state: Shutdown' },
      [`xcrun simctl terminate ${ID} dev.test.app`]: { ok: false, out: '', err: 'found nothing to terminate' },
    });
    const sim = iosSimulatorWith(r.run, 'darwin');
    await sim.boot(ID);
    await sim.shutdown(ID);
    await sim.terminate(ID, 'dev.test.app');
  });

  it('says plainly that an iPhone simulator needs a Mac, and runs nothing on Windows or Linux', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const r = recorded();
      const sim = iosSimulatorWith(r.run, platform);
      expect(sim.notHere()).toBe('An iPhone simulator needs a Mac.');
      expect(await sim.devices()).toEqual([]);
      expect(await sim.runtimes()).toEqual([]);
      expect(r.ran).toEqual([]);
    }
  });

  it("reads simctl's own lists: iOS versions newest first with what each can make, and every device's state", () => {
    const runtimes = runtimesOf(
      JSON.stringify({
        runtimes: [
          { identifier: 'r18', version: '18.2', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'p16', name: 'iPhone 16 Pro', productFamily: 'iPhone' }, { identifier: 'a', name: 'iPad Air 11-inch (M2)', productFamily: 'iPad' }] },
          { identifier: 'r27', version: '27.2', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'p18', name: 'iPhone 18 Pro', productFamily: 'iPhone' }] },
          { identifier: 'r27b', version: '27.2', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [] },
          { identifier: 'w', version: '11.0', platform: 'watchOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'w1', name: 'Apple Watch', productFamily: 'Apple Watch' }] },
        ],
      }),
    );
    expect(runtimes.map((r) => r.id)).toEqual(['r27', 'r18']);
    expect(runtimes[1]!.models.map((m) => m.size)).toEqual(['phone', 'tablet']);
    const devices = devicesOf(JSON.stringify({ devices: { r18: [{ udid: ID, name: 'squad-kit iPhone', state: 'Booted' }, { udid: 'X', name: 'Theirs', state: 'Shutdown' }] } }));
    expect(devices).toEqual([
      { id: ID, name: 'squad-kit iPhone', state: 'booted', runtime: 'r18' },
      { id: 'X', name: 'Theirs', state: 'shutdown', runtime: 'r18' },
    ]);
  });

  it("reads the built app's id and its own link names from its Info.plist", async () => {
    const r = recorded({ 'plutil -convert json -o - /c/Runner.app/Info.plist': { ok: true, out: JSON.stringify({ CFBundleIdentifier: 'dev.test.app', CFBundleURLTypes: [{ CFBundleURLSchemes: ['wasl', 'bad scheme'] }] }), err: '' } });
    expect(await iosSimulatorWith(r.run, 'darwin').appInfo('/c/Runner.app')).toEqual({ appId: 'dev.test.app', schemes: ['wasl'] });
  });
});
