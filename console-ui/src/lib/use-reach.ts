import { useSyncExternalStore } from 'react';
import { currentReach, subscribeReach, type Reach } from './reach';

/** Apart from reach.ts: the project's type check reads that file through its test, before the screens' packages are installed. */
export function useReach(): Reach {
  return useSyncExternalStore(subscribeReach, currentReach);
}
