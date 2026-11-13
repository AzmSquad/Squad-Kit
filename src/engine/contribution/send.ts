import { addActivity, listReleases, now, requireTicket, updateTicket, writeRelease, type BoardPaths } from '../../board/store.js';
import type { OwnerNote } from '../../board/contribution-types.js';
import type { Contribution as Into, PullRequest, RepoHost } from '../../modules/code-host/types.js';
import { ModuleError } from '../../modules/errors.js';
import { git } from '../git.js';
import { readDiff, touchedNotes } from '../review-record/git-fixed.js';
import { asks, OWNER_WAITS } from './words.js';

/**
 * squad-kit's own code sent its pull request to the main repo (publish.ts): its owner merges it, never squad-kit. The
 * story waits for the owner, out of this project's release (it goes out in theirs). Sent again after Fix these, the same
 * pull request has the fix, and squad-kit answers "Fixed in <commit>" only on the notes whose lines git shows the fix
 * changed, as for the Reviewer's notes (ADR-007). A question, a note with no place, or one whose lines did not change is
 * left to the person, with why. A new pull request (Send it again) never answers a note of an older one.
 */

/** Answers these fixed notes. The ids answered, and the ones the code host says are gone, with why. Never throws. */
export async function answerFixed(host: RepoHost, prId: number, notes: OwnerNote[]): Promise<{ answered: Set<string>; gone: Map<string, string> }> {
  const answered = new Set<string>();
  const gone = new Map<string, string>();
  if (!host.answerNote) return { answered, gone };
  for (const n of notes) {
    try {
      await host.answerNote(prId, n, `Fixed in ${n.fixedIn}.`);
      answered.add(n.id);
    } catch (err) {
      // Deleted, or refused for good: never asked again. Anything else is answered on the next look.
      if (err instanceof ModuleError && (err.status === 404 || err.status === 422)) gone.set(n.id, `squad-kit could not answer it on ${host.label}: its comment is gone or closed there.`);
    }
  }
  return { answered, gone };
}

/** The notes of this fix round whose place git shows the fix changed, by id. */
function changedByFix(dir: string, from: string | undefined, to: string, notes: OwnerNote[]): Set<string> {
  if (!from) return new Set();
  const diff = git(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', from, to], { allowFail: true });
  const touched = touchedNotes(notes.map((n, i) => ({ n: i, file: n.file, line: n.line })), readDiff(diff));
  return new Set(notes.filter((_, i) => touched.has(i)).map((n) => n.id));
}

/** Why a note of the fix round gets no "Fixed in", or null when it does. */
function notFixed(n: OwnerNote, changed: Set<string>, label: string): string | null {
  if (asks(n)) return `It asks a question: answer it yourself on ${label}.`;
  if (!n.file) return `squad-kit cannot tell from the code whether this is done: answer it yourself on ${label}.`;
  return changed.has(n.id) ? null : `The fix did not change its lines: answer it yourself on ${label}.`;
}

export async function sentToOwner(bp: BoardPaths, id: string, host: RepoHost, pr: PullRequest, into: Into, copy: { dir: string; branch: string }): Promise<{ clash: false }> {
  const full = git(copy.dir, ['rev-parse', copy.branch], { allowFail: true });
  const commit = full.slice(0, 7) || copy.branch;
  const before = requireTicket(bp, id).contribution;
  // Sent again after the owner closed it: a new pull request, not a fix to the old one.
  const fix = before?.state === 'fixing';
  const round = (before?.notes ?? []).filter((n) => n.state === 'fixing' && n.pr === pr.id);
  const changed = changedByFix(copy.dir, before?.sent, full || copy.branch, round);
  const settle = new Map(round.map((n) => [n.id, notFixed(n, changed, host.label)]));
  const fixed = round.filter((n) => settle.get(n.id) === null).map((n) => ({ ...n, fixedIn: commit }));
  const { answered, gone } = await answerFixed(host, pr.id, fixed);
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  updateTicket(bp, id, (x) => {
    const notes = (x.contribution?.notes ?? []).map((n): OwnerNote => {
      if (n.pr !== pr.id && (n.state === 'new' || n.state === 'fixing')) return { ...n, state: 'left', why: 'Its pull request was closed, so squad-kit did not answer it.' };
      if (n.pr !== pr.id || n.state !== 'fixing') return n;
      const why = settle.get(n.id) ?? gone.get(n.id);
      return why ? { ...n, state: 'left', why } : { ...n, state: 'fixed', fixedIn: commit, answered: answered.has(n.id) };
    });
    const said = notes.filter((n) => answered.has(n.id)).length;
    x.contribution = {
      into: into.into,
      base: into.base,
      state: 'waiting',
      since: now(),
      ...(full ? { sent: full } : {}),
      ...(x.contribution?.lookedAt ? { lookedAt: x.contribution.lookedAt } : {}),
      ...(notes.length ? { notes } : {}),
      ...(x.contribution?.seen ? { seen: x.contribution.seen } : {}),
    };
    x.release = undefined;
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    x.status = OWNER_WAITS;
    addActivity(
      x,
      'release',
      fix
        ? `Sent the fix to pull request ${pr.id} in ${into.into}${said ? `, and answered ${said === 1 ? 'the note' : `${said} notes`} "Fixed in ${commit}"` : ''}. It waits for the owner to merge it`
        : `Opened pull request ${pr.id} in ${into.into}, into ${into.base}. Its owner merges it, never squad-kit: the story waits, and squad-kit watches it on ${host.label}`,
    );
  });
  return { clash: false };
}
