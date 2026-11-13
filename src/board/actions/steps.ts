import { addActivity, listTickets, readMeta, requireTicket, updateTicket, type BoardPaths } from '../store.js';
import type { Ticket } from '../types.js';
import { writeLog } from '../../core/app-log.js';
import { localSetupFor } from '../../engine/sync.js';
import { endProcessTree } from '../../engine/watchdog.js';
import { BoardActionError } from './errors.js';
import { isSaving } from './save.js';
import { changeNeedsYou } from './change.js';

export function stopTicket(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.live && !t.squad) throw new BoardActionError(`${t.id} is not running right now.`);
    t.stopRequested = true;
    t.status = 'Stopping…';
    addActivity(t, 'you', 'Pressed Stop');
  });
}

/**
 * The watchdog says a step looks stuck on a command: end that command (and what it started). The role gets an error
 * back and carries on, with its conversation intact.
 */
export function endStuckCommand(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.quiet?.pid) throw new BoardActionError(`${t.id} has no stuck command to end.`);
    endProcessTree(t.quiet.pid);
    writeLog({ level: 'info', project: readMeta(bp).project, ticket: t.id, text: `Ended the stuck command: ${t.quiet.command ?? 'a command'} (process ${t.quiet.pid})` });
    addActivity(t, 'you', 'Ended the stuck command');
    delete t.quiet;
  });
}

/**
 * "Give it 10 more minutes": the step is slow but fine. squad-kit stays quiet about it for that long, then asks again
 * if it is still slow. The step's hard limit stays.
 */
export function keepWaiting(bp: BoardPaths, id: string, minutes = 10): Ticket {
  const m = Math.round(minutes);
  if (!Number.isFinite(m) || m < 1 || m > 120) throw new BoardActionError('Give it between 1 and 120 more minutes.');
  return updateTicket(bp, id, (t) => {
    if (!t.quiet && !(t.live || t.squad)) throw new BoardActionError(`${t.id} is not running right now.`);
    t.quietSnoozedUntil = new Date(Date.now() + m * 60_000).toISOString();
    addActivity(t, 'you', `Gave it ${m} more minute${m === 1 ? '' : 's'}`);
    delete t.quiet;
  });
}

/** "Stop and try again": the running step stops, then starts again at once. The work so far is kept. */
export function restartStep(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.live && !t.squad) throw new BoardActionError(`${t.id} is not running right now.`);
    if (t.waiting) throw new BoardActionError(`${t.id} waits for you, so no step is running to try again.`);
    t.stopRequested = true;
    t.retryOnStop = true;
    t.status = 'Stopping, then trying again…';
    addActivity(t, 'you', 'Pressed Stop and try again');
  });
}

/**
 * Everything that needs the person: open questions, plans, proof, decisions, changes, and steps that look stuck. A proof
 * being saved after Looks right needs nobody any more.
 */
export function inbox(bp: BoardPaths): Ticket[] {
  return listTickets(bp).filter((t) => !isSaving(bp, t.id) && (t.waiting || t.quiet?.kind === 'stuck' || t.outdated?.length || changeNeedsYou(t) || t.testChange?.ask));
}

/** Run the setup again in the person's own checkout, for example after it failed. */
export function setUpLocalCopy(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  if (t.localSetup?.status === 'pending' || t.localSetup?.status === 'running') return t;
  const ls = t.localSetup ?? localSetupFor(bp, t);
  if (!ls) throw new BoardActionError('There is no setup command, or your checkout is on another branch.');
  return updateTicket(bp, id, (x) => {
    x.localSetup = { dir: ls.dir, command: ls.command, status: 'pending' };
  });
}
