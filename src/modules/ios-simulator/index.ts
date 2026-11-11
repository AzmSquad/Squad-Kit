import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { squadHome } from '../../core/home.js';
import { PhoneError, type PhoneDevice, type PhoneModel, type PhoneModule, type PhoneRuntime, type PhoneState } from '../phone/types.js';

/**
 * Apple's iPhone simulator, through Xcode's own `xcrun simctl`: squad-kit's devices are made, started hidden (never
 * the Simulator window, unless a person asks for it), given the app, and shut down, each by its exact id. Nothing here
 * looks for a device by its name, so nobody else's simulator is ever started, stopped or changed.
 */

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}

/** Runs one program and gives what it printed. Tests give a made-up one. */
export type SimRun = (file: string, args: string[], o?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Ran>;

const realRun: SimRun = (file, args, o = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: o.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', ...(o.signal ? { signal: o.signal } : {}) }, (err, out, errText) =>
      resolve({ ok: !err, out: String(out ?? ''), err: `${String(errText ?? '')}${err && !errText ? err.message : ''}` }),
    ).stdin?.end();
  });

const NEEDS_MAC = 'An iPhone simulator needs a Mac.';

/** The locale that goes with a language: Arabic as in Saudi Arabia, English as in the United States. */
const LOCALES: Record<string, string> = { ar: 'ar_SA', en: 'en_US', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', ur: 'ur_PK', tr: 'tr_TR' };

export function localeOf(language: string): string {
  const l = language.trim().toLowerCase().split(/[-_]/)[0] || 'en';
  return LOCALES[l] ?? `${l}_${l.toUpperCase()}`;
}

/** The arguments that open an app in a language: `-AppleLanguages "(ar)" -AppleLocale ar_SA`. */
export function languageArgs(language?: string): string[] {
  if (!language?.trim()) return [];
  const l = language.trim().toLowerCase().split(/[-_]/)[0]!;
  return ['-AppleLanguages', `(${l})`, '-AppleLocale', localeOf(l)];
}

const STATES: Record<string, PhoneState> = { Booted: 'booted', Booting: 'booting', Shutdown: 'shutdown', 'Shutting Down': 'shutting-down' };

/** `xcrun simctl list runtimes -j`: the iOS versions that can run, newest first, with the iPhones and iPads each can make. */
export function runtimesOf(text: string): PhoneRuntime[] {
  try {
    const j = JSON.parse(text) as { runtimes?: { identifier?: string; version?: string; platform?: string; name?: string; isAvailable?: boolean; supportedDeviceTypes?: { identifier?: string; name?: string; productFamily?: string }[] }[] };
    const out: PhoneRuntime[] = [];
    for (const r of j.runtimes ?? []) {
      if (!r.identifier || !r.version || r.isAvailable === false) continue;
      if (r.platform ? r.platform !== 'iOS' : !/^iOS\b/.test(r.name ?? '')) continue;
      const models: PhoneModel[] = (r.supportedDeviceTypes ?? []).flatMap((d) => {
        if (!d.identifier || !d.name) return [];
        const size = d.productFamily === 'iPad' || /^iPad\b/.test(d.name) ? 'tablet' : d.productFamily === 'iPhone' || /^iPhone\b/.test(d.name) ? 'phone' : null;
        return size ? [{ id: d.identifier, name: d.name, size }] : [];
      });
      // A build of a version made for one device only lists none it can make.
      if (models.length) out.push({ id: r.identifier, version: r.version, models });
    }
    const num = (v: string) => v.split('.').map(Number);
    return out.sort((a, b) => {
      const x = num(a.version);
      const y = num(b.version);
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
  } catch {
    return [];
  }
}

/** `xcrun simctl list devices -j`: every device on this computer, with its state. */
export function devicesOf(text: string): PhoneDevice[] {
  try {
    const j = JSON.parse(text) as { devices?: Record<string, { udid?: string; name?: string; state?: string; isAvailable?: boolean }[]> };
    return Object.entries(j.devices ?? {}).flatMap(([runtime, list]) =>
      list.flatMap((d) => (d.udid ? [{ id: d.udid, name: d.name ?? '', state: STATES[d.state ?? ''] ?? 'other', runtime }] : [])),
    );
  } catch {
    return [];
  }
}

/** A device id as simctl gives it: squad-kit never passes anything else, like "booted" or a name, to a command. */
const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function exact(id: string): string {
  if (!DEVICE_ID.test(id)) throw new PhoneError('squad-kit only uses its own iPhone, by its exact id.', `"${id}" is not a device id`);
  return id;
}

const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();

/** The simulator, behind squad-kit's phone interface, with the program runner given (tests give a made-up one). */
export function iosSimulatorWith(run: SimRun, platform: NodeJS.Platform = process.platform): PhoneModule {
  const simctl = async (args: string[], what: string, o: { timeoutMs?: number; signal?: AbortSignal; fine?: RegExp } = {}): Promise<string> => {
    const r = await run('xcrun', ['simctl', ...args], { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    if (r.ok || (o.fine && o.fine.test(`${r.err}\n${r.out}`))) return r.out;
    throw new PhoneError(what, `xcrun simctl ${args.join(' ')}: ${(r.err || r.out).trim().slice(-2000)}`);
  };
  return {
    name: 'ios-simulator',
    label: 'iPhone simulator',
    words: { phone: 'iPhone', tablet: 'iPad' },
    system: 'iOS',
    notHere: () => (platform === 'darwin' ? null : NEEDS_MAC),
    async runtimes() {
      if (platform !== 'darwin') return [];
      return runtimesOf(await simctl(['list', 'runtimes', '-j'], 'squad-kit could not read the iPhone simulators on this Mac.', { timeoutMs: 30_000 }));
    },
    async devices() {
      if (platform !== 'darwin') return [];
      return devicesOf(await simctl(['list', 'devices', '-j'], 'squad-kit could not read the iPhone simulators on this Mac.', { timeoutMs: 30_000 }));
    },
    async create(name, model, runtime) {
      const out = await simctl(['create', name, model, runtime], `squad-kit could not make its ${name}.`, { timeoutMs: 120_000 });
      const id = firstLine(out);
      if (!DEVICE_ID.test(id)) throw new PhoneError(`squad-kit could not make its ${name}.`, `xcrun simctl create gave "${id}"`);
      return id;
    },
    async boot(id, o = {}) {
      // Hidden: only the device starts, with no Simulator window. One already up is fine.
      await simctl(['boot', exact(id)], 'The iPhone simulator did not start.', { timeoutMs: o.timeoutMs ?? 300_000, ...(o.signal ? { signal: o.signal } : {}), fine: /current state: Booted/i });
      await simctl(['bootstatus', exact(id)], 'The iPhone simulator did not finish starting.', { timeoutMs: o.timeoutMs ?? 300_000, ...(o.signal ? { signal: o.signal } : {}) });
    },
    async install(id, app, o = {}) {
      await simctl(['install', exact(id), app], 'squad-kit could not put the app on the iPhone simulator.', { timeoutMs: 300_000, ...(o.signal ? { signal: o.signal } : {}) });
    },
    async appInfo(app) {
      const r = await run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')], { timeoutMs: 15_000 });
      let info: { CFBundleIdentifier?: string; CFBundleURLTypes?: { CFBundleURLSchemes?: string[] }[] } = {};
      try {
        info = JSON.parse(r.out) as typeof info;
      } catch {
        // Read below as missing.
      }
      if (!r.ok || !info.CFBundleIdentifier) throw new PhoneError('squad-kit could not read the app it built.', `plutil on ${path.join(app, 'Info.plist')}: ${(r.err || r.out).trim().slice(-1000)}`);
      const schemes = [...new Set((info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []).filter((s) => /^[a-z][a-z0-9+.-]*$/i.test(s)))];
      return { appId: info.CFBundleIdentifier, schemes };
    },
    async launch(id, appId, o = {}) {
      await simctl(['launch', exact(id), appId, ...languageArgs(o.language)], 'The app did not open on the iPhone simulator.', { timeoutMs: 120_000 });
    },
    async openLink(id, url) {
      await simctl(['openurl', exact(id), url], 'The app did not open its page on the iPhone simulator.', { timeoutMs: 60_000 });
    },
    async screenshot(id) {
      // Written in squad-kit's own folder, read, then removed: simctl writes pictures only to a file.
      const dir = path.join(squadHome(), 'phones', 'pictures');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${randomBytes(6).toString('hex')}.png`);
      try {
        await simctl(['io', exact(id), 'screenshot', '--type=png', file], 'squad-kit could not take the picture on the iPhone simulator.', { timeoutMs: 60_000 });
        return fs.readFileSync(file);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    async terminate(id, appId) {
      // An app that is not open is fine.
      await simctl(['terminate', exact(id), appId], 'The app did not close on the iPhone simulator.', { timeoutMs: 60_000, fine: /found nothing to terminate/i });
    },
    async shutdown(id) {
      await simctl(['shutdown', exact(id)], 'The iPhone simulator did not shut down.', { timeoutMs: 120_000, fine: /current state: Shutdown/i });
    },
    async openWindow(id) {
      const r = await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', exact(id)], { timeoutMs: 60_000 });
      if (!r.ok) throw new PhoneError('squad-kit could not open the iPhone window.', `open -a Simulator: ${(r.err || r.out).trim().slice(-1000)}`);
    },
    async windowShows(id) {
      // The device still up, and Apple's Simulator app still open: only looked at, never touched.
      const up = devicesOf((await run('xcrun', ['simctl', 'list', 'devices', '-j'], { timeoutMs: 30_000 })).out).find((d) => d.id === exact(id))?.state === 'booted';
      if (!up) return false;
      return (await run('pgrep', ['-x', 'Simulator'], { timeoutMs: 10_000 })).ok;
    },
  };
}

export const iosSimulator: PhoneModule = iosSimulatorWith(realRun);
