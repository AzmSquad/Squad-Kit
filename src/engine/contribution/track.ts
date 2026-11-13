import type { BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { forkHostFor } from '../../modules/registry.js';
import { repoTarget } from '../sync.js';

/**
 * The pull request of a story sent to someone else's repo, step by step, for the story's page: Looks right, pushed to
 * the person's copy, opened into the owner's repo, the owner's review, merged. Read from the story's own record and
 * activity, with no call to the code host.
 */

export interface TrackStep {
  id: 'looks-right' | 'pushed' | 'opened' | 'review' | 'merged';
  /** closed: the owner closed the pull request without merging it, so the review ended there. */
  state: 'done' | 'now' | 'later' | 'closed';
  at?: string;
}

export interface PullRequestTrack {
  steps: TrackStep[];
  /** The person's own copy the branch went to, "owner/name", and the branch. */
  copy?: string;
  branch?: string;
  /** The code host, for people. */
  host?: string;
  /** What squad-kit did with the person's copy once the owner merged, as the story says it. */
  catchUp?: string;
}

const find = (t: Ticket, who: string, re: RegExp) => [...t.activity].reverse().find((a) => a.who === who && re.test(a.text));

export function pullRequestTrack(bp: BoardPaths, t: Ticket): PullRequestTrack | null {
  const c = t.contribution;
  if (!c || !t.pr) return null;
  const merged = c.state === 'merged';
  const shut = c.state === 'closed';
  const opened = find(t, 'release', /^Opened pull request \d+ in /);
  const looked = find(t, 'you', /Looks right/);
  const target = repoTarget(bp, t);
  const host = target ? forkHostFor(target.url) : null;
  const copy = target && host?.forks.repoName(target.url);
  const caught = merged ? find(t, 'release', /^Your copy /)?.text : undefined;
  const at = (x?: { at: string }) => (x ? { at: x.at } : {});
  return {
    steps: [
      { id: 'looks-right', state: 'done', ...at(looked) },
      { id: 'pushed', state: 'done', ...at(opened) },
      { id: 'opened', state: 'done', ...at(opened) },
      { id: 'review', state: merged ? 'done' : shut ? 'closed' : 'now', ...(shut ? { at: c.since } : {}) },
      { id: 'merged', state: merged ? 'done' : 'later', ...(merged ? { at: c.since } : {}) },
    ],
    ...(copy ? { copy } : {}),
    ...(t.branch ? { branch: t.branch } : {}),
    ...(host ? { host: host.label } : {}),
    ...(caught ? { catchUp: caught } : {}),
  };
}
