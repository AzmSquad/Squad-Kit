import { keepWaiting } from '../../board/actions.js';
import { addActivity, updateTicket, type BoardPaths } from '../../board/store.js';
import { allowsAlways } from './store.js';

/**
 * "Always allow" on giving more time: when a step is slower than usual but still working, squad-kit gives it 10 more
 * minutes itself, the same as the board's button, and a line on the story says so. A step that looks stuck still asks
 * the person, and the step's own hard limit stays.
 */

export const MORE_MINUTES = 10;

/** The line on the story. */
export const BY_ITSELF_LINE = `Gave it ${MORE_MINUTES} more minutes by itself: "Always allow" is on for giving more time`;

/** True when it gave the step more time. */
export function moreTimeByItself(bp: BoardPaths, id: string): boolean {
  if (!allowsAlways(bp, 'more_time')) return false;
  try {
    keepWaiting(bp, id, MORE_MINUTES);
    // The same as the button, but nobody pressed it: the line says who did it.
    updateTicket(bp, id, (t) => {
      const last = t.activity.at(-1);
      if (last?.who === 'you' && last.text.startsWith('Gave it')) t.activity.pop();
      addActivity(t, 'squad', BY_ITSELF_LINE);
    });
    return true;
  } catch {
    // The step ended meanwhile: nothing to give more time to.
    return false;
  }
}
