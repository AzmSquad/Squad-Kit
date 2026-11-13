import { readMeta, type BoardPaths } from '../store.js';
import type { Ticket, TrackerEvent } from '../types.js';
import { writeLog } from '../../core/app-log.js';
import { trackerModule } from '../../modules/registry.js';

export class BoardActionError extends Error {
  constructor(
    message: string,
    /** The action takes a second yes: the message says what it does. */
    readonly asks?: 'whole-redo',
  ) {
    super(message);
    this.name = 'BoardActionError';
  }
}

/** A button failed on something technical: the person reads the plain words, and the exact error goes to the log. */
export function actionFailed(bp: BoardPaths, id: string, plain: string, err: unknown): BoardActionError {
  writeLog({ level: 'error', project: readMeta(bp).project, ticket: id, text: `${plain} ${(err as Error).message}` });
  return new BoardActionError(plain);
}

/** Queue an update for the tracker. The live squad sends it, so this never waits on the network. */
export function tellLater(t: Ticket, engine: string, event: TrackerEvent): void {
  if (engine !== 'live') return;
  if (event.kind !== 'file-bug' && !trackerModule(t.source.type)) return;
  t.trackerQueue = [...(t.trackerQueue ?? []), event];
}
