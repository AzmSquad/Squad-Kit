import { closeDrivers } from './session.js';
import { stopPhones } from './turn.js';

/**
 * squad-kit ending (Ctrl-C, a stop signal, a restart): the Maestro sessions close, squad-kit's own phones shut down,
 * iPhone and Android, and what they started beside them (its own adb server, only when squad-kit started it) stops,
 * in that order, within QUIT_MS. Nobody else's simulator, emulator or adb is touched. squad-kit then ends, whatever is
 * left: a phone that did not answer stays with its exact process noted in squad-kit's folder, for the next start.
 */

/** How long squad-kit gives its phones to shut down as it ends. */
export const QUIT_MS = 20_000;

let ending: Promise<void> | null = null;

export function phonesQuit(ms = QUIT_MS): Promise<void> {
  if (ending) return ending;
  const work = (async () => {
    await closeDrivers();
    await stopPhones(undefined, { quitting: true });
  })().catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((r) => (timer = setTimeout(r, ms)));
  ending = Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
    ending = null;
  });
  return ending;
}
