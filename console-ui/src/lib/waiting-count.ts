import { useBreakdownWaits } from '../components/BreakdownWaits';
import { useBoard } from './data';
import { waitingCount } from './waiting';

/**
 * The one number of things that need a press from the person (lib/waiting.ts), as the top bar, the side menu, the
 * lead's head and its popup all show it. The lead's own answers and the morning brief count the same way on the server
 * (src/engine/lead/waiting.ts).
 */
export function useWaitingCount(): number {
  const board = useBoard();
  const breakdowns = useBreakdownWaits().length;
  return waitingCount(board.data?.ready ? board.data.tickets : [], breakdowns);
}
