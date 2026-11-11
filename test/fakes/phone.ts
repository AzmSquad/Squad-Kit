import { randomUUID } from 'node:crypto';
import type { AppOnPhone, PhoneDevice, PhoneModule, PhoneRuntime } from '../../src/modules/phone/types.js';
import { pngBytes } from '../support/png.js';

/**
 * A made-up iPhone simulator for tests: devices in memory, every command written down, nothing real started. A device
 * in `keepUp` comes back up after a shutdown, like one an open Simulator window shows.
 */

export interface FakePhone {
  module: PhoneModule;
  devices: PhoneDevice[];
  /** Every command, like "boot <id>" or "launch <id> dev.test.app ar". */
  calls: string[];
  keepUp: Set<string>;
  app: AppOnPhone;
  /** The devices a window shows now: a person closes one by taking it out. */
  windows: Set<string>;
}

export const RUNTIMES: PhoneRuntime[] = [
  {
    id: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
    version: '27.2',
    models: [
      { id: 'iPhone-18-Pro', name: 'iPhone 18 Pro', size: 'phone' },
      { id: 'iPhone-18-Pro-Max', name: 'iPhone 18 Pro Max', size: 'phone' },
      { id: 'iPad-Air-13-M4', name: 'iPad Air 13-inch (M4)', size: 'tablet' },
      { id: 'iPad-Air-11-M4', name: 'iPad Air 11-inch (M4)', size: 'tablet' },
    ],
  },
  {
    id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
    version: '18.2',
    models: [
      { id: 'iPhone-16-Pro-Max', name: 'iPhone 16 Pro Max', size: 'phone' },
      { id: 'iPhone-16-Pro', name: 'iPhone 16 Pro', size: 'phone' },
      { id: 'iPad-Air-11-M2', name: 'iPad Air 11-inch (M2)', size: 'tablet' },
    ],
  },
];

/** Google's emulator, as squad-kit's Android module gives it: one system image, Pixel 9 and Pixel Tablet. */
export const ANDROID_RUNTIMES: PhoneRuntime[] = [
  {
    id: 'system-images;android-36;google_apis;arm64-v8a',
    version: '16',
    models: [
      { id: 'pixel_9', name: 'Pixel 9', size: 'phone' },
      { id: 'pixel_tablet', name: 'Pixel Tablet', size: 'tablet' },
    ],
  },
];

/**
 * The same made-up phone as Android's emulator: its own words, its window opens only by starting again (which loses
 * what was put on it after the snapshot), and Maestro knows it by a serial.
 */
export function fakeAndroid(o: { devices?: PhoneDevice[]; app?: AppOnPhone } = {}): FakePhone {
  const f = fakePhone({ ...o, runtimes: ANDROID_RUNTIMES, app: o.app ?? { appId: 'dev.test.app', schemes: [] } });
  const m = f.module;
  let n = 0;
  const create = m.create.bind(m);
  const boot = m.boot.bind(m);
  f.module = {
    ...m,
    name: 'fake-android',
    label: 'Android emulator',
    words: { phone: 'Android phone', tablet: 'Android tablet' },
    system: 'Android',
    windowRestarts: true,
    times: { build: { key: 'android-build', guess: 540 }, boot: { key: 'android-boot', guess: 40 }, install: { key: 'android-install', guess: 5 }, 'first-run': { key: 'maestro-first-android', guess: 30 } },
    async create(name, model, runtime) {
      await create(name, model, runtime);
      // Named like squad-kit's own AVDs, by name, not a made-up id.
      const id = `squad-kit-android-${n++ === 0 && /phone$/.test(name) ? 'phone' : /tablet$/.test(name) ? 'tablet' : 'phone'}`;
      f.devices[f.devices.length - 1]!.id = id;
      return id;
    },
    async boot(id) {
      await boot(id);
      f.windows.delete(id);
    },
    async openWindow(id) {
      f.calls.push(`window ${id}`);
      f.devices.find((d) => d.id === id)!.state = 'booted';
      f.windows.add(id);
    },
    tapId: (id) => `emulator-${id.endsWith('tablet') ? 5562 : 5560}`,
    tapEnv: () => ({ ANDROID_HOME: '/sk/sdk', HOME: '/sk/phones/android' }),
    async release() {
      f.calls.push('release');
    },
  };
  return f;
}

export function fakePhone(o: { devices?: PhoneDevice[]; notHere?: string | null; runtimes?: PhoneRuntime[]; app?: AppOnPhone } = {}): FakePhone {
  const devices = [...(o.devices ?? [])];
  const calls: string[] = [];
  const keepUp = new Set<string>();
  const windows = new Set<string>();
  const app = o.app ?? { appId: 'dev.test.app', schemes: [] };
  const find = (id: string) => {
    const d = devices.find((x) => x.id === id);
    if (!d) throw new Error(`no device ${id}`);
    return d;
  };
  const module: PhoneModule = {
    name: 'fake-phone',
    label: 'iPhone simulator',
    words: { phone: 'iPhone', tablet: 'iPad' },
    system: 'iOS',
    notHere: () => o.notHere ?? null,
    runtimes: async () => o.runtimes ?? RUNTIMES,
    devices: async () => devices.map((d) => ({ ...d })),
    async create(name, model, runtime) {
      const id = randomUUID().toUpperCase();
      calls.push(`create ${name} ${model} ${runtime}`);
      devices.push({ id, name, state: 'shutdown', runtime });
      return id;
    },
    async boot(id) {
      calls.push(`boot ${id}`);
      find(id).state = 'booted';
    },
    async install(id, path) {
      calls.push(`install ${id} ${path}`);
    },
    appInfo: async () => app,
    async launch(id, appId, l = {}) {
      calls.push(`launch ${id} ${appId} ${l.language ?? ''}`.trim());
    },
    async openLink(id, url) {
      calls.push(`openurl ${id} ${url}`);
    },
    async screenshot(id) {
      calls.push(`screenshot ${id}`);
      return pngBytes(402, 874);
    },
    async terminate(id, appId) {
      calls.push(`terminate ${id} ${appId}`);
    },
    async shutdown(id) {
      calls.push(`shutdown ${id}`);
      if (!keepUp.has(id)) find(id).state = 'shutdown';
    },
    async openWindow(id) {
      calls.push(`window ${id}`);
      windows.add(id);
    },
    windowShows: async (id) => windows.has(id) && find(id).state === 'booted',
  };
  return { module, devices, calls, keepUp, app, windows };
}
