import { useSyncExternalStore } from 'react';

/**
 * Whether the app still answers. The page is only a view: when the app stops (its terminal closed, a crash) nothing
 * else on the page would change, so the person would wait for nothing. Every call to the app reports here, and a slow
 * look at /healthz covers the pages that poll nothing. One failed call is not enough: a sleeping laptop or a restart
 * can miss one.
 */

export type Reach = 'up' | 'down' | 'link-old';

let state: Reach = 'up';
let failures = 0;
/** A restart the person asked for: the page says so itself, and comes back by itself. */
let restarting = false;
const listeners = new Set<() => void>();

function set(next: Reach): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function noteAnswer(status: number): void {
  failures = 0;
  set(status === 401 ? 'link-old' : 'up');
}

/** Two calls in a row with no answer, and the app counts as stopped. */
export function noteNoAnswer(): void {
  failures += 1;
  if (failures >= 2) set('down');
}

/** A look at the app got through, which says nothing about this page's link: it only ends "down". */
export function noteAlive(): void {
  failures = 0;
  if (state === 'down') set('up');
}

/** The person asked for a restart or an update: no message about it until it should have come back. */
export function expectRestart(on: boolean): void {
  restarting = on;
  for (const l of listeners) l();
}

export function currentReach(): Reach {
  return restarting && state === 'down' ? 'up' : state;
}

/** For tests. */
export function resetReach(): void {
  state = 'up';
  failures = 0;
  restarting = false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReach(): Reach {
  return useSyncExternalStore(subscribe, currentReach);
}
