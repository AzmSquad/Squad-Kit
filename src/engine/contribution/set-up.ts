import type { BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions/errors.js';
import { bringCopyUpToDate, contributeChecklist, makeMyCopy, type Checklist } from './checklist.js';
import { forgetSetUp } from './journey.js';

/**
 * The assistant's buttons that change the person's copy: Make my copy, Bring it up to date, and "Do both for me". One
 * runs at a time per project, so a second press, or a page loaded again while GitHub makes the copy, waits its turn in
 * plain words instead of running the same git steps twice.
 */

const busy = new Set<string>();

export async function oneAtATime<T>(bp: BoardPaths, run: () => Promise<T>): Promise<T> {
  if (busy.has(bp.squadDir)) throw new BoardActionError('squad-kit is already making your copy or bringing it up to date. Wait a moment, then look again.');
  busy.add(bp.squadDir);
  try {
    return await run();
  } finally {
    busy.delete(bp.squadDir);
    forgetSetUp(bp);
  }
}

const item = (c: Checklist, id: string) => c.items.find((i) => i.id === id);

/**
 * "Do both for me": makes the person's own copy when it is missing, then brings their copy and this computer's base up
 * to date. Each part is the same as its own button; nothing is forced. When the copy is made but bringing it up to date
 * fails, the copy is said with the reason, never hidden behind an error.
 */
export async function setUpForMe(bp: BoardPaths): Promise<{ line: string; checklist: Checklist }> {
  const before = await contributeChecklist(bp);
  if (item(before, 'sign-in')?.state !== 'done') throw new BoardActionError('Sign in first: the checklist shows how.');
  const lines: string[] = [];
  if (item(before, 'copy')?.state === 'todo') lines.push((await makeMyCopy(bp)).line);
  const now = lines.length ? await contributeChecklist(bp) : before;
  const up = item(now, 'up-to-date');
  if (up?.action?.id === 'sync') {
    try {
      lines.push((await bringCopyUpToDate(bp)).line);
    } catch (err) {
      if (!lines.length) throw err;
      lines.push(`It was not brought up to date: ${(err as Error).message}`);
    }
  } else if (up?.state === 'blocked' && up.count) lines.push(up.line);
  const after = lines.length ? await contributeChecklist(bp) : now;
  return { line: lines.length ? lines.join(' ') : 'Nothing to do: your copy is set up.', checklist: after };
}
