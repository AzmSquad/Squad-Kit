import type { Ticket } from '../../board/types.js';
import type { ContributionState, OwnerNote } from '../../board/contribution-types.js';
import { OWNER_CLOSED, OWNER_FIXING, OWNER_LEFT_CLOSED, OWNER_MERGED, OWNER_NOTES, OWNER_WAITS } from './words.js';

/**
 * A story's pull request as the board and `squad pr <story>` show it, from the story's own record (no call to the code
 * host): where it went, where it stands in plain words, the owner's notes with where each stands, and what the person
 * can do now, each with its terminal command.
 */

export interface PullRequestView {
  ticket: string;
  pr?: { id: number; url: string; host: string; repo: string };
  /** own: the project's own repo, squad-kit merges it. owner: someone else's repo, its owner merges it. */
  to: 'own' | 'owner' | 'none';
  into?: string;
  base?: string;
  state: 'none' | 'open' | 'merged' | ContributionState;
  line: string;
  notes: OwnerNote[];
  lookedAt?: string;
  since?: string;
  /** The buttons that work now, each with its terminal command. */
  actions: { id: 'fix' | 'leave' | 'check' | 'send-again' | 'leave-closed'; name: string; command: string }[];
}

const LINES: Record<ContributionState, string> = { waiting: OWNER_WAITS, notes: OWNER_NOTES, fixing: OWNER_FIXING, merged: OWNER_MERGED, closed: OWNER_CLOSED };

export function pullRequestView(t: Ticket): PullRequestView {
  const c = t.contribution;
  const pr = t.pr ?? t.clashedPr;
  const base = { ticket: t.id, ...(pr ? { pr } : {}) };
  if (!c) {
    if (!pr) return { ...base, to: 'none', state: 'none', line: `${t.id} has no pull request.`, notes: [], actions: [] };
    const merged = Boolean(t.mergedAt);
    return {
      ...base,
      to: 'own',
      state: merged ? 'merged' : 'open',
      line: merged ? `Pull request ${pr.id} is merged.` : `Pull request ${pr.id} is open, not merged yet.`,
      notes: [],
      actions: merged ? [] : [{ id: 'check', name: 'Check again', command: `squad check-merge ${t.id}` }],
    };
  }
  const closedLeft = c.state === 'closed' && t.waiting?.kind !== 'stuck';
  const actions: PullRequestView['actions'] = [];
  if (c.state === 'notes') actions.push({ id: 'fix', name: 'Fix these', command: `squad pr ${t.id} --fix` }, { id: 'leave', name: 'Answer them yourself', command: `squad pr ${t.id} --leave` });
  if (c.state === 'waiting' || c.state === 'notes') actions.push({ id: 'check', name: 'Check again', command: `squad check-merge ${t.id}` });
  if (c.state === 'closed' && !closedLeft) {
    const at = (name: string) => t.stuck?.options.findIndex((o) => o.name === name) ?? -1;
    actions.push({ id: 'send-again', name: 'Send it again', command: `squad decide ${t.id} ${at('Send it again') + 1}` }, { id: 'leave-closed', name: 'Leave it closed', command: `squad pr ${t.id} --leave-closed` });
  }
  return {
    ...base,
    to: 'owner',
    into: c.into,
    base: c.base,
    state: c.state,
    line: closedLeft ? OWNER_LEFT_CLOSED : LINES[c.state],
    notes: c.notes ?? [],
    ...(c.lookedAt ? { lookedAt: c.lookedAt } : {}),
    since: c.since,
    actions,
  };
}
