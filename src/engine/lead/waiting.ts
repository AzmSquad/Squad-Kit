import { inbox } from '../../board/actions.js';
import { breakdownWaits } from '../../board/requirements.js';
import type { BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';

/**
 * What needs a press from the person, by the one rule the board counts with: an open story (on the board, not released
 * and not archived) that waits for them, and a requirements breakdown whose Analyst has questions. A released story
 * that still has something to say, such as a decision that came after its plan, is news: it is shown in "What's new"
 * and never counted. The top bar, the side menu, the lead's head, its answers and the morning brief say this number.
 */

/** The open stories that wait for the person. */
export function pressNeeded(bp: BoardPaths): Ticket[] {
  return inbox(bp).filter((t) => t.stage !== 'done' && !t.archived);
}

/** Released stories with news. Never part of the count. */
export function releasedNews(bp: BoardPaths): Ticket[] {
  return inbox(bp).filter((t) => t.stage === 'done' && !t.archived);
}

/** How many things need the person now. */
export function waitingCount(bp: BoardPaths): number {
  return pressNeeded(bp).length + breakdownWaits(bp).length;
}
