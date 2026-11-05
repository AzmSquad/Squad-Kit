import { BoardActionError, restartStep } from '../board/actions.js';
import { isUp } from '../board/apps.js';
import { writeLog } from '../core/app-log.js';
import { addActivity, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { QuietPort, Ticket } from '../board/types.js';
import { repoFor } from './repos.js';
import { endPid, portTaken, squadKitOn, whoListens } from './run-app.js';

/**
 * "Stop it and try again" on the Looks stuck card. A step that needs the app (the Tester's, or squad-kit starting the
 * app for it) goes quiet while a program holds the app's port and the app never answers. When squad-kit itself started
 * that program, it may stop it, after the person confirms, and start the step again. A program of the person's own is
 * never stopped. The words here reach the person: the port and the process are in the card's details for engineers.
 */

/** The port in an app's address, or null when it names none. */
export function portOf(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** The step running now needs the app: the Tester's, or squad-kit starting the app for it. */
function needsApp(t: Ticket): boolean {
  return t.clock?.who === 'tester' || /^Starting the app/.test(t.status);
}

/** What holds the app's port while the app does not answer, or null when the port is not the problem. */
export async function lookAtPort(bp: BoardPaths, t: Ticket): Promise<QuietPort | null> {
  if (!needsApp(t)) return null;
  const url = repoFor(readMeta(bp), t).commands.url;
  const port = portOf(url);
  if (!url || !port || !(await portTaken(port)) || (await isUp(url))) return null;
  const ours = squadKitOn(bp, port);
  const holder = ours?.holder ?? whoListens(port);
  return { port, ours: Boolean(ours), ...(holder ? { pid: holder.pid, ...(holder.program ? { program: holder.program } : {}) } : {}), ...(ours?.app ? { app: ours.app } : {}) };
}

const LOOK_MS = 20_000;
const looked = new Map<string, number>();

/**
 * While a ticket looks stuck or slow, looks at the app's port now and then and keeps what it found on the card. Runs
 * beside the watchdog and never holds it up; never throws.
 */
export function watchPort(bp: BoardPaths, id: string, now = Date.now()): void {
  const key = `${bp.root}:${id}`;
  if (now - (looked.get(key) ?? 0) < LOOK_MS) return;
  looked.set(key, now);
  const t = readTicket(bp, id);
  if (!t?.quiet) return;
  void lookAtPort(bp, t)
    .then((port) => {
      const same = (a?: QuietPort | null, b?: QuietPort | null) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (same(readTicket(bp, id)?.quiet?.port, port)) return;
      updateTicket(bp, id, (x) => {
        if (!x.quiet) return;
        if (port) x.quiet.port = port;
        else delete x.quiet.port;
      });
    })
    .catch(() => undefined);
}

/**
 * Stop it and try again: stops the program on the port, only when squad-kit started it (checked again now, by its
 * process group, never from what the card said), then the step starts again with the work so far.
 */
export async function freePortAndRetry(bp: BoardPaths, id: string, opts: { waitMs?: number } = {}): Promise<Ticket> {
  const t = requireTicket(bp, id);
  const port = t.quiet?.port?.port;
  if (!port) throw new BoardActionError(`${t.id} is not held up by another program.`);
  const ours = squadKitOn(bp, port);
  if (!ours) {
    throw new BoardActionError(
      whoListens(port)
        ? 'squad-kit did not start the program in the way, so it leaves it alone. Close it yourself, then press Stop and try again.'
        : 'Nothing squad-kit started is in the way now. Press Stop and try again.',
    );
  }
  await endPid(ours.group);
  const until = Date.now() + (opts.waitMs ?? 3000);
  while ((await portTaken(port)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const what = ours.app ? `your app ${ours.app}` : 'a program squad-kit started earlier';
  if (await portTaken(port)) throw new BoardActionError(`squad-kit stopped ${what}, but something is still in the way. Press Stop and try again in a moment.`);
  // The port and the process are for engineers.
  writeLog({ level: 'info', project: readMeta(bp).project, ticket: t.id, text: `Freed port ${port}: stopped ${ours.holder.program || 'a program'} (process ${ours.holder.pid}), which squad-kit started` });
  updateTicket(bp, t.id, (x) => {
    addActivity(x, 'you', `Stopped ${what}, which was in the way`);
    delete x.quiet;
  });
  const now = requireTicket(bp, t.id);
  return now.live || now.squad ? restartStep(bp, t.id) : now;
}
