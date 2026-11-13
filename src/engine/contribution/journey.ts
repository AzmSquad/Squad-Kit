import { listTickets, readMeta, requireTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { isMine } from '../../board/owner.js';
import { isSelfProject } from '../self-project.js';
import { contributeChecklist } from './checklist.js';

/**
 * Where a contribution to squad-kit's own code stands, for the bar on every page of it and for `squad contribute`: set
 * up, the idea, built and checked, the pull request, the owner's review, merged. Read from the stories' own records;
 * only "Set up" asks the code host, through the checklist, and only before the first story.
 */

export const JOURNEY_STEPS = ['Set up', 'Your idea', 'Built and checked', 'Pull request', "Owner's review", 'Merged'] as const;

export interface Journey {
  self: boolean;
  /** The step it is at, 0 to 5, or 6 once the owner merged it: every step done. */
  at: number;
  steps: readonly string[];
  /** The story it follows, when there is one. */
  ticket?: string;
  /** Its pull request was closed by the owner without merging: the owner's review ended there. */
  closed?: true;
  line: string;
}

/** A story's step. */
export function storyStep(t: Ticket): number {
  const c = t.contribution;
  if (c?.state === 'merged') return 6;
  if (c) return 4;
  if (t.pr) return t.mergedAt ? 6 : 3;
  // Merged on this computer with no pull request: it goes as one next (the send-as box), unless it was released here.
  if (t.mergedAt) return t.stage === 'done' ? 6 : 3;
  if (t.squad?.phase === 'publish') return 3;
  return t.stage === 'implement' || t.stage === 'test' || t.stage === 'review' || t.waiting?.kind === 'proof' ? 2 : 1;
}

const lastAt = (t: Ticket) => t.activity.at(-1)?.at ?? t.createdAt;
const closed = (t: Ticket) => t.contribution?.state === 'closed';
/** Closed by the owner, and the person chose Leave it closed: the story ends there. */
const leftClosed = (t: Ticket) => closed(t) && t.waiting?.kind !== 'stuck';

const KEEP_MS = 60_000;
const setUp = new Map<string, { at: number; done: boolean }>();

/** Nothing left on the checklist that squad-kit or the person must do. Kept a minute: it asks the code host. */
async function setUpDone(bp: BoardPaths): Promise<boolean> {
  const k = setUp.get(bp.squadDir);
  if (k && Date.now() - k.at < KEEP_MS) return k.done;
  const done = await contributeChecklist(bp)
    .then((c) => c.ready)
    .catch(() => false);
  setUp.set(bp.squadDir, { at: Date.now(), done });
  return done;
}

/** The next look at the checklist asks again: after Make my copy or Bring it up to date. */
export function forgetSetUp(bp: BoardPaths): void {
  setUp.delete(bp.squadDir);
}

function said(at: number, ticket?: string, isClosed?: boolean): string {
  if (isClosed) return `${ticket ?? 'Your story'}: the owner closed its pull request without merging it.`;
  if (at >= JOURNEY_STEPS.length) return `${ticket ?? 'Your story'} is merged by the owner. Every step is done.`;
  return `${JOURNEY_STEPS[at]}${ticket ? ` (${ticket})` : ''}: step ${at + 1} of ${JOURNEY_STEPS.length}.`;
}

function ofStory(t: Ticket): Journey {
  const at = storyStep(t);
  return { self: true, at, steps: JOURNEY_STEPS, ticket: t.id, ...(closed(t) ? { closed: true as const } : {}), line: said(at, t.id, closed(t)) };
}

/**
 * The step of one story, or of the project: the person's open story that moved last, else their newest one (a story
 * left closed ends there and is not followed); with no story to follow, Set up until the checklist is done, then Your
 * idea.
 */
export async function journeyOf(bp: BoardPaths, ticketId?: string): Promise<Journey> {
  const steps = JOURNEY_STEPS;
  if (!isSelfProject(bp)) return { self: false, at: 0, steps, line: "This project is not squad-kit's own code." };
  if (ticketId) return ofStory(requireTicket(bp, ticketId));
  const meta = readMeta(bp);
  const mine = listTickets(bp).filter((t) => !t.archived && !leftClosed(t) && isMine(t, meta));
  const byLast = [...mine].sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const t = byLast.find((x) => storyStep(x) < steps.length) ?? byLast[0];
  if (t) return ofStory(t);
  const at = (await setUpDone(bp)) ? 1 : 0;
  return { self: true, at, steps, line: said(at) };
}
