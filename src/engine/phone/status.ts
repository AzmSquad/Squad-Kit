import { squadHome } from '../../core/home.js';
import { shotPhone } from '../../modules/registry.js';
import type { PhoneSize, PhoneState } from '../../modules/phone/types.js';
import { savedDevices } from './devices.js';
import { stepTimes, type PhoneStep } from './times.js';
import { IDLE_MS, keptUp, lastUsed, phoneInUse, stopPhones } from './turn.js';
import { closeDrivers } from './session.js';

/**
 * squad-kit's own phones for people: which ones it made, whether each runs, and when it shuts down by itself; and Stop,
 * which shuts them down now. The same on the board (/api/v1/phone) and in the terminal (`squad phone`).
 */

export interface PhoneLine {
  size: PhoneSize;
  /** squad-kit's name for it: "squad-kit iPhone". */
  name: string;
  /** The real device: "iPhone 16 Pro". */
  model: string;
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
  /** Why squad-kit's phone can't run on this computer: "An iPhone simulator needs a Mac." */
  notHere?: string;
  devices: PhoneLine[];
  /** How long each long step takes on this computer, in seconds: the first guess until squad-kit measured it here. */
  times: Record<PhoneStep, number>;
  /** Unused this many minutes, a phone shuts down by itself. */
  idleMinutes: number;
}

/** squad-kit's phones now. */
export async function phoneView(): Promise<PhoneView> {
  const phone = shotPhone();
  const home = squadHome();
  const base = { times: stepTimes(home), idleMinutes: Math.round(IDLE_MS / 60_000) };
  const notHere = phone.notHere();
  if (notHere) return { notHere, devices: [], ...base };
  const saved = savedDevices(home);
  const states = saved.length ? new Map((await phone.devices().catch(() => [])).map((d) => [d.id, d.state])) : new Map<string, PhoneState>();
  const used = lastUsed(home);
  const busy = phoneInUse();
  return {
    devices: saved.map((d) => {
      const state = states.get(d.id) ?? 'gone';
      const last = used[d.id];
      const off = state === 'booted' && last && !busy ? new Date(Date.parse(last) + IDLE_MS).toISOString() : undefined;
      return { size: d.size, name: d.name, model: d.model, runtime: d.runtime, id: d.id, state, inUse: busy && state === 'booted', keptUp: keptUp(d.id), ...(last ? { lastUsed: last } : {}), ...(off ? { offAt: off } : {}) };
    }),
    ...base,
  };
}

/** Stop: squad-kit's phones shut down now, with what happened in one plain sentence. */
export async function stopPhoneNow(): Promise<PhoneView & { message: string }> {
  const phone = shotPhone();
  const word = phone.words.phone;
  if (phone.notHere()) return { ...(await phoneView()), message: `${phone.notHere()} There is nothing to stop here.` };
  const r = await stopPhones(phone);
  if (!r.busy) closeDrivers();
  const message = r.busy
    ? `squad-kit's ${word} is taking pictures for a story now. It shuts down by itself when it has been unused for ${Math.round(IDLE_MS / 60_000)} minutes.`
    : r.left.length
      ? `Something else keeps squad-kit's ${word} open, like a Simulator window, so squad-kit left it. Close that window to shut it down.`
      : r.stopped.length
        ? `squad-kit shut down its ${[...new Set(r.stopped.map((id) => phone.words[savedDevices().find((d) => d.id === id)?.size ?? 'phone']))].join(' and ')}.`
        : `squad-kit's phones are not running.`;
  return { ...(await phoneView()), message };
}
