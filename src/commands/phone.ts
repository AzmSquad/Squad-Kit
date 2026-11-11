import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { buildPaths, findSquadRoot } from '../core/paths.js';
import { boardPaths } from '../board/store.js';
import { phoneView, startPhoneNow, stopPhoneNow, type PhoneView } from '../engine/phone/status.js';
import { boardApi, type BoardApi } from './app.js';

/**
 * `squad phone`: squad-kit's own phones on this computer, iPhone and Android, the ones it runs hidden for the Tester's
 * pictures. `start <phone>` brings one up hidden now, with Maestro ready; `stop` shuts them down now. Only squad-kit's own devices, never anybody else's. With a board open the command is the
 * board's own REST call, so both see the same; without it, the work runs here.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);

const STATE_WORDS: Record<string, string> = { booted: 'running', booting: 'starting', shutdown: 'shut down', 'shutting-down': 'shutting down', gone: 'no longer on this computer', other: 'not ready' };

/** "at 14:05". */
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export function printPhones(v: PhoneView): void {
  if (v.notHere) {
    out(v.notHere);
    return;
  }
  if (!v.devices.length) out("squad-kit has not made its phones on this computer yet. It makes them the first time a story's pictures need one.");
  for (const d of v.devices) {
    const state = d.state === 'booted' ? kleur.green(STATE_WORDS[d.state]!) : kleur.gray(STATE_WORDS[d.state] ?? d.state);
    out(`${kleur.bold(d.name)}  ${d.model}, ${d.system} ${d.runtime}  ${state}`);
    if (d.inUse) out('  Taking pictures for a story now.');
    else if (d.keptUp) out('  Something else keeps it open, like an open window, so squad-kit leaves it.');
    else if (d.offAt) out(kleur.gray(`  Shuts down by itself at ${clock(d.offAt)}, when unused for ${v.idleMinutes} minutes.`));
    out(kleur.gray(`  Its id: ${d.id}`));
  }
  out();
  const by = Object.entries(v.timesBy ?? {});
  for (const [word, t] of by.length ? by : [['phone', v.times] as const]) out(kleur.gray(`On this computer, the ${word}: building the app about ${t.build} s, starting the phone about ${t.boot} s, putting the app on it about ${t.install} s.`));
  if (v.devices.some((d) => d.state === 'booted')) out(`To shut them down now: ${kleur.green('squad phone stop')}`);
}

/** The open board of the project in this folder, when there is one. */
function openApi(): BoardApi | null {
  const root = findSquadRoot();
  if (!root) return null;
  try {
    return boardApi(boardPaths(buildPaths(root).squadDir));
  } catch {
    return null;
  }
}

/** One `squad phone` call: through the open board's API when there is one, here otherwise. True when it did what was asked. */
export async function phoneWith(api: BoardApi | null, action: string | undefined, phone?: string): Promise<boolean> {
  const what = (action ?? 'status').trim().toLowerCase();
  if (what === 'status' || what === 'show') {
    printPhones(api ? await api.call<PhoneView>('GET', '/phone') : await phoneView());
    return true;
  }
  if (what === 'start') {
    const which = (phone ?? 'iphone').trim().toLowerCase();
    if (which !== 'android' && which !== 'iphone') throw new Error(`squad phone start ${which}: say android or iphone.`);
    const r = api ? await api.call<PhoneView & { message: string }>('POST', '/phone/start', { phone: which }) : await startPhoneNow(which === 'android' ? 'android' : 'ios');
    ui.info(r.message);
    printPhones(r);
    return true;
  }
  if (what === 'stop') {
    const r = api ? await api.call<PhoneView & { message: string }>('POST', '/phone/stop') : await stopPhoneNow();
    ui.info(r.message);
    printPhones(r);
    return true;
  }
  throw new Error(`squad phone ${what}: there is no such action. Use squad phone, squad phone start android, or squad phone stop.`);
}

/** `squad phone [status | start <android|iphone> | stop]` */
export async function runPhone(action: string | undefined, phone?: string): Promise<void> {
  const ok = await phoneWith(openApi(), action, phone);
  if (!ok) process.exitCode = 1;
}
