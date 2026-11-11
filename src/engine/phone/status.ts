import { squadHome } from '../../core/home.js';
import type { PhoneSize, PhoneState } from '../../modules/phone/types.js';
import { savedDevices } from './devices.js';
import { stepTimes, type PhoneStep } from './times.js';
import { IDLE_MS, keptUp, lastUsed, phoneInUse, stopPhones } from './turn.js';
import { closeDrivers, readyToTap } from './session.js';
import { everyPhone, phoneFor } from './which.js';
import { tapTools } from './plan.js';
import { withPhone } from './turn.js';
import type { PhoneSystem } from '../tools/which-phone.js';
import { PhoneError } from '../../modules/phone/types.js';

/**
 * squad-kit's own phones for people, iPhone and Android: which ones it made, whether each runs, and when it shuts down
 * by itself; and Stop, which shuts them down now. The same on the board (/api/v1/phone) and in the terminal
 * (`squad phone`).
 */

export interface PhoneLine {
  size: PhoneSize;
  /** squad-kit's name for it: "squad-kit iPhone", "squad-kit Android phone". */
  name: string;
  /** The real device: "iPhone 16 Pro", "Pixel 9". */
  model: string;
  /** Its system's name: "iOS", "Android". */
  system: string;
  runtime: string;
  id: string;
  state: PhoneState | 'gone';
  /** Taking pictures for a story now. */
  inUse: boolean;
  /** Something else keeps it up, like an open Simulator window: squad-kit leaves it. */
  keptUp: boolean;
  lastUsed?: string;
  /** When it shuts down by itself, while it runs unused. */
  offAt?: string;
}

export interface PhoneView {
  /** Why none of squad-kit's phones can run on this computer: "An iPhone simulator needs a Mac." */
  notHere?: string;
  devices: PhoneLine[];
  /** How long each long step takes on this computer, in seconds, for the first phone: the first guess until measured. */
  times: Record<PhoneStep, number>;
  /** The same for each phone that has devices here, by its word: { "iPhone": {...}, "Android phone": {...} }. */
  timesBy: Record<string, Record<PhoneStep, number>>;
  /** Unused this many minutes, a phone shuts down by itself. */
  idleMinutes: number;
}

/** squad-kit's phones now. */
export async function phoneView(): Promise<PhoneView> {
  const phones = everyPhone();
  const home = squadHome();
  const timesBy: Record<string, Record<PhoneStep, number>> = {};
  const base = { times: stepTimes(home, phones[0]), idleMinutes: Math.round(IDLE_MS / 60_000) };
  const here = phones.filter((p) => !p.notHere());
  if (!here.length) return { notHere: phones[0]!.notHere()!, devices: [], timesBy, ...base };
  const used = lastUsed(home);
  const busy = phoneInUse();
  const devices: PhoneLine[] = [];
  for (const phone of here) {
    const saved = savedDevices(home, phone);
    if (!saved.length) continue;
    timesBy[phone.words.phone] = stepTimes(home, phone);
    const states = new Map((await phone.devices().catch(() => [])).map((d) => [d.id, d.state]));
    for (const d of saved) {
      const state = states.get(d.id) ?? 'gone';
      const last = used[d.id];
      const off = state === 'booted' && last && !busy ? new Date(Date.parse(last) + IDLE_MS).toISOString() : undefined;
      devices.push({ size: d.size, name: d.name, model: d.model, system: phone.system, runtime: d.runtime, id: d.id, state, inUse: busy && state === 'booted', keptUp: keptUp(d.id), ...(last ? { lastUsed: last } : {}), ...(off ? { offAt: off } : {}) });
    }
  }
  return { devices, timesBy, ...base };
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Start: squad-kit's phone comes up now, hidden, with Maestro ready on it, so a story's first pictures wait for nothing.
 * It shuts down by itself when unused, as always. The iPhone, or Android.
 */
export async function startPhoneNow(system: PhoneSystem = 'ios'): Promise<PhoneView & { message: string }> {
  const phone = phoneFor(system);
  const word = phone.words.phone;
  const away = phone.notHere();
  if (away) return { ...(await phoneView()), message: `${away} There is nothing to start here.` };
  try {
    await withPhone(phone, 'phone', async (turn) => {
      const tools = tapTools();
      if (tools) await readyToTap(phone, turn.device.id, tools);
    });
  } catch (err) {
    throw new Error(err instanceof PhoneError ? err.message : `squad-kit's ${word} did not start.`);
  }
  return { ...(await phoneView()), message: `squad-kit's ${word} is up, hidden, ready for the pictures. It shuts down by itself when it has been unused for ${Math.round(IDLE_MS / 60_000)} minutes.` };
}

/** Stop: squad-kit's phones shut down now, with what happened in one plain sentence. */
export async function stopPhoneNow(): Promise<PhoneView & { message: string }> {
  const phones = everyPhone();
  const here = phones.filter((p) => !p.notHere());
  if (!here.length) return { ...(await phoneView()), message: `${phones[0]!.notHere()} There is nothing to stop here.` };
  const r = await stopPhones(here);
  if (!r.busy) await closeDrivers();
  const words = (id: string) => {
    for (const p of here) {
      const d = savedDevices(squadHome(), p).find((x) => x.id === id);
      if (d) return p.words[d.size];
    }
    return 'phone';
  };
  // The phone a story uses now: the one that has devices here, when only one has.
  const made = here.filter((p) => savedDevices(squadHome(), p).length);
  const busyWord = made.length === 1 ? made[0]!.words.phone : 'phone';
  const message = r.busy
    ? `squad-kit's ${busyWord} is taking pictures for a story now. It shuts down by itself when it has been unused for ${Math.round(IDLE_MS / 60_000)} minutes.`
    : r.left.length
      ? `Something else keeps squad-kit's ${list([...new Set(r.left.map(words))])} open, like an open window, so squad-kit left it. Close that window to shut it down.`
      : r.stopped.length
        ? `squad-kit shut down its ${list([...new Set(r.stopped.map(words))])}.`
        : `squad-kit's phones are not running.`;
  return { ...(await phoneView()), message };
}
