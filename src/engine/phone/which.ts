import { shotPhone } from '../../modules/registry.js';
import type { PhoneModule } from '../../modules/phone/types.js';
import { androidPlace } from '../tools/android.js';
import type { PhoneSystem } from '../tools/which-phone.js';
import { moduleOf, type OwnDevice } from './devices.js';

/**
 * The phone module for a phone, ready to use: Android's is told where squad-kit's Android tools and its own folder
 * are (engine/tools/android.ts), each time, so tools got a moment ago are used at once.
 */

export function phoneFor(system: PhoneSystem = 'ios'): PhoneModule {
  const phone = shotPhone(system);
  if (system === 'android') phone.useTools?.(androidPlace());
  return phone;
}

/** Every phone squad-kit can run, each once: what stops with the board, and what shuts down when unused. */
export function everyPhone(): PhoneModule[] {
  return [...new Set([phoneFor('ios'), phoneFor('android')])];
}

/** The phone module a saved device belongs to. */
export function phoneOfDevice(d: OwnDevice): PhoneModule | undefined {
  const all = everyPhone();
  return all.find((p) => p.name === moduleOf(d)) ?? (all.length === 1 ? all[0] : undefined);
}
