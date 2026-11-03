import { BoardActionError, restartStep } from '../board/actions.js';
import { isUp } from '../board/apps.js';
import { addActivity, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { QuietPort, Ticket } from '../board/types.js';
import { repoFor } from './repos.js';
import { endPid, portTaken, squadKitOn, whoListens } from './run-app.js';

/**
 * "Free the port and try again" on the Looks stuck card. A step that needs the app (the Tester's, or squad-kit
 * starting the app for it) goes quiet while a program holds the app's port and the app never answers. When squad-kit
 * itself started that program, it may stop it, after the person confirms, and start the step again. A program of the
 * person's own is never stopped: the card names it and says to close it.
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

/** "node (process 4123)". */
function named(p: Pick<QuietPort, 'program' | 'pid'>): string {
  return [p.program || 'a program', p.pid ? `(process ${p.pid})` : ''].filter(Boolean).join(' ');
}

/**
 * Free the port and try again: stops the program on the port, only when squad-kit started it (checked again now, by
 * its process group, never from what the card said), then the step starts again with the work so far.
 */
export async function freePortAndRetry(bp: BoardPaths, id: string, opts: { waitMs?: number } = {}): Promise<Ticket> {
  const t = requireTicket(bp, id);
  const port = t.quiet?.port?.port;
  if (!port) throw new BoardActionError(`${t.id} is not waiting on a busy port.`);
  const ours = squadKitOn(bp, port);
  if (!ours) {
    const other = whoListens(port);
    throw new BoardActionError(
      other
        ? `Port ${port} is used by ${named(other)}, which squad-kit did not start, so squad-kit leaves it alone. Close it yourself, then press Stop and try again.`
        : `Nothing squad-kit started is on port ${port} now. Press Stop and try again.`,
    );
  }
  await endPid(ours.group);
  const until = Date.now() + (opts.waitMs ?? 3000);
  while ((await portTaken(port)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const what = ours.app ? `your app ${ours.app}` : named(ours.holder);
  if (await portTaken(port)) throw new BoardActionError(`squad-kit stopped ${what}, but port ${port} is still in use. Press Stop and try again in a moment.`);
  updateTicket(bp, t.id, (x) => {
    addActivity(x, 'you', `Freed port ${port}: stopped ${what}, which squad-kit started`);
    delete x.quiet;
  });
  const now = requireTicket(bp, t.id);
  return now.live || now.squad ? restartStep(bp, t.id) : now;
}
