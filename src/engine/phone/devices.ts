import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import { PhoneError, type PhoneDevice, type PhoneModule, type PhoneRuntime, type PhoneSize } from '../../modules/phone/types.js';

/**
 * squad-kit's own phones: one "squad-kit iPhone" and one "squad-kit iPad", made once on the newest system this computer
 * has, then used again by the id saved in squad-kit's folder (phones/devices.json). squad-kit touches only these, by
 * their exact id, and never looks for a device by its name: nobody else's simulator is started, stopped or changed.
 */

export interface OwnDevice {
  size: PhoneSize;
  id: string;
  /** squad-kit's own name for it: "squad-kit iPhone". */
  name: string;
  /** The real device it is, for the pictures' label: "iPhone 16 Pro". */
  model: string;
  /** Its system version: "18.2". */
  runtime: string;
  runtimeId: string;
  createdAt: string;
}

export function phonesHome(home = squadHome()): string {
  return path.join(home, 'phones');
}

function devicesFile(home = squadHome()): string {
  return path.join(phonesHome(home), 'devices.json');
}

/** squad-kit's devices, as saved. */
export function savedDevices(home = squadHome()): OwnDevice[] {
  try {
    const j = JSON.parse(fs.readFileSync(devicesFile(home), 'utf8')) as { devices?: OwnDevice[] };
    return (j.devices ?? []).filter((d) => d && typeof d.id === 'string' && (d.size === 'phone' || d.size === 'tablet'));
  } catch {
    return [];
  }
}

function saveDevices(list: OwnDevice[], home = squadHome()): void {
  const file = devicesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ devices: list }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** "squad-kit iPhone", "squad-kit iPad". */
export function ownName(phone: PhoneModule, size: PhoneSize): string {
  return `squad-kit ${phone.words[size]}`;
}

/** The device squad-kit makes for a size on a system: a Pro iPhone without Max, and an iPad Air, the newest it can run. */
export function pickModel(runtime: PhoneRuntime, size: PhoneSize): { id: string; name: string } | null {
  const fits = runtime.models.filter((m) => m.size === size);
  const best = size === 'phone' ? fits.find((m) => /\bPro$/.test(m.name)) : fits.find((m) => /^iPad Air\b/.test(m.name));
  return best ?? fits[0] ?? null;
}

/**
 * The system squad-kit makes a device on: the one asked for ("18.2"), else the newest this computer has that can make
 * a device of this size. Null when there is none.
 */
export function pickRuntime(runtimes: PhoneRuntime[], size: PhoneSize, wanted?: string): PhoneRuntime | null {
  const able = runtimes.filter((r) => pickModel(r, size));
  if (wanted) return able.find((r) => r.version === wanted || r.id === wanted) ?? null;
  return able[0] ?? null;
}

/**
 * squad-kit's own device of a size, made when it has none yet: the saved one is used again while it is still on this
 * computer and on a system it can run (the one asked for, when one is). Returns it with its state now.
 */
export async function ownDevice(phone: PhoneModule, size: PhoneSize, o: { runtime?: string; home?: string } = {}): Promise<OwnDevice & { state: PhoneDevice['state'] }> {
  const home = o.home ?? squadHome();
  const [runtimes, devices] = await Promise.all([phone.runtimes(), phone.devices()]);
  const here = new Map(devices.map((d) => [d.id, d]));
  const usable = new Set(runtimes.map((r) => r.id));
  const saved = savedDevices(home);
  const wanted = o.runtime ? pickRuntime(runtimes, size, o.runtime) : null;
  if (o.runtime && !wanted) throw new PhoneError(`This Mac has no iOS ${o.runtime} for the ${phone.words[size]}.`, `No iOS ${o.runtime} runtime that can make a ${size} in: ${runtimes.map((r) => r.version).join(', ') || 'none'}`);
  // Only by its saved id: a device of the same name made by anybody else is never taken for squad-kit's.
  const keep = saved.find((d) => d.size === size && here.has(d.id) && usable.has(d.runtimeId) && (!wanted || d.runtimeId === wanted.id));
  if (keep) return { ...keep, state: here.get(keep.id)!.state };
  const runtime = wanted ?? pickRuntime(runtimes, size);
  if (!runtime) throw new PhoneError(`This Mac has no iOS simulator that can run an ${phone.words[size]} yet.`, `No runtime with a ${size} model in: ${runtimes.map((r) => r.version).join(', ') || 'none'}`);
  const model = pickModel(runtime, size)!;
  const name = ownName(phone, size);
  const id = await phone.create(name, model.id, runtime.id);
  const made: OwnDevice = { size, id, name, model: model.name, runtime: runtime.version, runtimeId: runtime.id, createdAt: new Date().toISOString() };
  // Saved devices that are gone from this computer leave the list; the others stay, to be used again.
  saveDevices([...savedDevices(home).filter((d) => here.has(d.id) && d.id !== id), made], home);
  return { ...made, state: 'shutdown' };
}

/** True when an id is one of squad-kit's own devices: nothing else is ever started, stopped or changed. */
export function isOwn(id: string, home = squadHome()): boolean {
  return savedDevices(home).some((d) => d.id === id);
}
