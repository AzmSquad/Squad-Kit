import { addActivity, listReleases, now, requireTicket, updateTicket, writeRelease, type BoardPaths } from '../../board/store.js';
import type { OwnerNote } from '../../board/contribution-types.js';
import type { Contribution as Into, PullRequest, RepoHost } from '../../modules/code-host/types.js';
import { git } from '../git.js';
import { OWNER_WAITS } from './words.js';

/**
 * The pull request went to someone else's repo (publishTicket): its owner merges it, never squad-kit. The story waits
 * for the owner, out of this project's next release (it goes out in theirs). Sent again after Fix these, the same pull
 * request has the fix, and each note the Builder fixed is answered "Fixed in <commit>".
 */

/** The notes fixed in this round, and those fixed before whose answer did not get through. */
const toAnswer = (n: OwnerNote) => n.state === 'fixing' || (n.state === 'fixed' && !n.answered);

/** Answers the fixed notes; the ids that got through. Never throws: the next look answers the rest. */
export async function answerFixed(host: RepoHost, prId: number, notes: OwnerNote[], commit: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!host.answerNote) return done;
  for (const n of notes.filter(toAnswer)) {
    try {
      await host.answerNote(prId, n, `Fixed in ${n.fixedIn ?? commit}.`);
      done.add(n.id);
    } catch {
      // Answered on the next look.
    }
  }
  return done;
}

export async function sentToOwner(bp: BoardPaths, id: string, host: RepoHost, pr: PullRequest, into: Into, copy: { dir: string; branch: string }): Promise<{ clash: false }> {
  const commit = git(copy.dir, ['rev-parse', '--short', copy.branch], { allowFail: true }) || copy.branch;
  const before = requireTicket(bp, id).contribution;
  // Sent again after the owner closed it: a new pull request, not a fix to the old one.
  const fix = before && before.state !== 'closed';
  const answered = await answerFixed(host, pr.id, before?.notes ?? [], commit);
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  updateTicket(bp, id, (x) => {
    const notes = (x.contribution?.notes ?? []).map((n): OwnerNote => (toAnswer(n) ? { ...n, state: 'fixed', fixedIn: n.fixedIn ?? commit, answered: answered.has(n.id) } : n));
    const fixed = notes.filter((n) => answered.has(n.id)).length;
    x.contribution = { into: into.into, base: into.base, state: 'waiting', since: now(), ...(x.contribution?.lookedAt ? { lookedAt: x.contribution.lookedAt } : {}), ...(notes.length ? { notes } : {}) };
    x.release = undefined;
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    x.status = OWNER_WAITS;
    addActivity(
      x,
      'release',
      fix
        ? `Sent the fix to pull request ${pr.id} in ${into.into}${fixed ? `, and answered ${fixed === 1 ? 'the note' : `${fixed} notes`} "Fixed in ${commit}"` : ''}. It waits for the owner to merge it`
        : `Opened pull request ${pr.id} in ${into.into}, into ${into.base}. Its owner merges it, never squad-kit: the story waits, and squad-kit watches it on ${host.label}`,
    );
  });
  return { clash: false };
}
