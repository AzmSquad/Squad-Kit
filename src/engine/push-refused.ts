import type { CheckResult } from './checks.js';

/**
 * A push squad-kit refused (noPushEnv in engine/sandbox.ts): a story's commands and the agents push only into a temp
 * folder. A test that pushes anywhere else fails with git's own words for it, which say nothing about the story's code.
 */

/** What a refused push prints: git finds no helper for the address squad-kit sent it to. */
export const PUSH_REFUSED = /remote[- ]helper[^\n]*squad-kit-no-push|remote-squad-kit-no-push/;

/** The one plain sentence the person sees when a check stopped on it. */
export const GUARD_BLOCKED_PUSH =
  "A test tried to push code outside a temp folder, and squad-kit blocked it: a story never pushes. That is not a bug in this story's code, so the Builder did not try to fix it.";

/**
 * The first failed check squad-kit refused a push for, inside the guard or outside it (the same setting goes with both).
 * Never one you already chose to continue past.
 */
export function pushBlockedByGuard<T extends CheckResult>(ran: T[], continued: (r: T) => boolean = () => false): T | null {
  return ran.find((r) => !r.ok && PUSH_REFUSED.test(r.output) && !continued(r)) ?? null;
}
