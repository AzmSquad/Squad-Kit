import type { ItemStage } from '../tracker/types.js';
import type { Status } from './context.js';

/**
 * squad-kit's four stages on a Jira workflow, by Jira's own status categories (to do, in progress, done). Resolved
 * (accepted and merged) is a review-like status in the in-progress category, such as In Review, when the workflow
 * has one, and Done when it has not. Closed (released) is Done. An issue only moves forward, a step at a time when its
 * workflow has no direct way (sideways to another status of the same place, such as QA, when that is the only way on),
 * and never to a done status that means it was dropped (Won't do, Cancelled). A step that asks for more on its own
 * screen comes last.
 */

interface Step {
  id: string;
  to: Status;
  /** Jira shows a screen on this step, which may ask for a field squad-kit cannot fill in. */
  screen?: boolean;
}

const REVIEW = /review|merged|release/i;
const DROPPED = /won'?t|cancel|reject|declin|duplicate|invalid|abandon|obsolete/i;
const BEST: Record<number, RegExp> = { 0: /^(to ?do|open|backlog|new)$/i, 1: /^in progress$/i, 2: /review/i, 3: /^(done|closed|resolved|released|complete[d]?|finished)$/i };

/** How far along a status is: 0 to do, 1 in progress, 2 in review (in progress, its work finished), 3 done. */
export function rankOf(s: Status): number {
  if (s.category === 'done') return 3;
  if (s.category === 'indeterminate') return REVIEW.test(s.name) ? 2 : 1;
  return 0;
}

/**
 * How far a stage takes an issue in this workflow. Resolved without its work merged yet (a pull request that waits)
 * goes to review when there is one, else only to in progress: done only once the work is in.
 */
export function goalOf(stage: ItemStage, workflow: Status[], merged?: boolean): number {
  const review = workflow.some((s) => rankOf(s) === 2);
  if (stage === 'not-started') return 0;
  if (stage === 'in-progress') return 1;
  if (stage === 'resolved') return review ? 2 : merged === false ? 1 : 3;
  return 3;
}

/**
 * The transition to take next on the way to the goal: the furthest that does not pass it, the best named first, one
 * without a screen before one with. With none forward, a sideways one to a status of the same place not visited yet.
 */
export function nextStep(steps: Step[], from: Status, goal: number, visited: Set<string> = new Set()): Step | null {
  const now = rankOf(from);
  const usable = steps.filter((t) => !(rankOf(t.to) === 3 && DROPPED.test(t.to.name)));
  const forward = usable.filter((t) => rankOf(t.to) > now && rankOf(t.to) <= goal);
  const sideways = usable.filter((t) => rankOf(t.to) === now && !visited.has(t.to.name) && t.to.name !== from.name);
  const score = (t: Step) => rankOf(t.to) * 10 + (BEST[rankOf(t.to)]!.test(t.to.name.trim()) ? 2 : 0) + (t.screen ? 0 : 1);
  const best = (list: Step[]) => [...list].sort((a, b) => score(b) - score(a))[0] ?? null;
  return best(forward) ?? best(sideways);
}

/** The workflow's own name for a goal, for plain words: "Done", "In Review". */
export function goalName(workflow: Status[], goal: number): string {
  const at = workflow.filter((s) => rankOf(s) === goal && !DROPPED.test(s.name));
  return (at.find((s) => BEST[goal]!.test(s.name.trim())) ?? at[0])?.name ?? ['To Do', 'In Progress', 'In Review', 'Done'][goal]!;
}
