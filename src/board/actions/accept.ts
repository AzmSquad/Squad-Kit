import { addActivity, now, readMeta, updateTicket, writeRelease, type BoardPaths } from '../store.js';
import path from 'node:path';
import type { Ticket } from '../types.js';
import { outsideWords } from '../outside-step.js';
import { commitWithoutCheck, hooksStillOwed } from '../../engine/release.js';
import { MergeClash, mergeWouldClash, cutOffWords, repairCopyLink, settleCopy } from '../../engine/git.js';
import { repoFor } from '../../engine/repos.js';
import { writeLog } from '../../core/app-log.js';
import { localSetupFor, mapAfterMerge, mergeLocally, opensPullRequest } from '../../engine/sync.js';
import { looksRightNow, noteLooksRight } from '../../engine/review-record/commit-body.js';
import { leaveProjectFiles, stageTicketDocs } from '../../engine/project-git.js';
import { clearStaleStop } from '../stale-stop.js';
import { copyViews } from '../../engine/copies.js';
import { repoLabel } from '../parts.js';
import { bringInAgain } from '../bring-in.js';
import { SELF_MERGED, isSelfProject } from '../../engine/self-project.js';
import { actionFailed, BoardActionError } from './errors.js';
import { clashed, takeSaved } from './save.js';
import { ensureDraftRelease } from './release.js';

/** A merge that could not move the person's own checkout of the base: it goes in once that copy is free. */
export const CHECKOUT_WAITS = 'Waits to merge: your own copy of the code has changes in the same files';

const CHECKOUT_LATER = 'It goes in once your own copy of the code is free of changes in the same files. squad-kit tries again every few minutes';

/**
 * Looks right: commit, merge or pull request, and the draft release. `byItself` is the squad's own accept on the
 * Builds by itself track (board/auto.ts): the same steps, with the squad as the actor and this line on the record.
 */
export function acceptProof(bp: BoardPaths, ticket: Ticket, byItself?: string, opts: { noHooks?: boolean } = {}): Ticket {
  const looksRight = looksRightNow(bp, byItself);
  let commit: string | null = null;
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  const views = copyViews(readMeta(bp), ticket);
  if (readMeta(bp).engine === 'live') {
    try {
      for (const view of views) {
        repairCopy(bp, view);
        // The accepted ticket's documents go in the same commit as its code, when the project keeps them in git.
        // The hooks run in one place, beside everything else (saveBeside). Past here they had their say, or the person went past them.
        const saved = takeSaved(bp, ticket.id, views.length > 1 ? view.repo : undefined);
        // That save carried the ticket's documents and all there was: nothing is left to look at here.
        if (saved !== undefined) {
          commit = saved ?? commit;
          continue;
        }
        leaveProjectFiles(bp, view, repoFor(readMeta(bp), view).base);
        stageTicketDocs(bp, { ...view, stage: 'release', release: release.version, waiting: null, hookOwed: undefined });
        if (!opts.noHooks && hooksStillOwed(view)) throw new BoardActionError(`The project's own check has not looked at ${ticket.id} yet, so it cannot be accepted. Press Looks right.`);
        commit = commitWithoutCheck(view) ?? commit;
      }
    } catch (err) {
      if (err instanceof BoardActionError) throw err;
      throw actionFailed(bp, ticket.id, 'squad-kit could not save the change, so the proof stays as it is. Press Looks right to try again.', err);
    }
  }
  const openPr = !ticket.pr && opensPullRequest(bp, ticket);
  // Merge on accept: without a pull request host the branch merges into the base right here, so the next tickets
  // build on it. With a code host module the live squad opens the PR and merges it.
  let merged: ReturnType<typeof mergeLocally> = null;
  if (readMeta(bp).engine === 'live' && !openPr && !ticket.mergedAt) {
    const meta = readMeta(bp);
    try {
      // Across parts, every merge is tried first: if one clashes, nothing moves in any of them.
      if (views.length > 1) {
        for (const view of views) {
          const repo = repoFor(meta, view);
          if (view.branch && mergeWouldClash(path.join(bp.root, repo.path), repo.base, view.branch)) throw new MergeClash(`In ${repoLabel(meta, repo.path) ?? repo.path}: ${view.branch} clashes with changes already in ${repo.base}.`);
        }
      }
      for (const view of views) {
        const one = mergeLocally(bp, view, looksRight);
        // Moved only when every one of them moved. A merge already in is skipped next time, so Try again finishes the rest.
        merged = !merged || !one ? (merged ?? one) : { ...one, moved: merged.moved && one.moved, ...(merged.note ? { note: merged.note } : {}) };
      }
    } catch (err) {
      // Only a real clash is a clash card, and the newest code comes in by itself first (board/bring-in.ts). Anything
      // else (an older git) leaves the proof waiting, with git's reason.
      if (err instanceof MergeClash) {
        clashed(bp, ticket.id, commit, err.message, byItself);
        return bringInAgain(bp, ticket.id);
      }
      throw actionFailed(bp, ticket.id, 'The change is saved, but it could not be merged, so the proof stays as it is. An engineer can see why in squad-kit\'s log.', err);
    }
  }
  if (!release.tickets.includes(ticket.id)) release.tickets.push(ticket.id);
  writeRelease(bp, release);
  // New code on the base: the architecture page reads it again.
  if (merged?.moved) mapAfterMerge(bp);
  // The exact words are for engineers. The squad tries again by itself (engine/sync.ts recheckMerge).
  else if (merged?.note) writeLog({ level: 'warn', project: readMeta(bp).project, ticket: ticket.id, text: merged.note });
  return updateTicket(bp, ticket.id, (t) => {
    t.waiting = null;
    // Accepted: a stop it went past is over.
    clearStaleStop(t);
    t.stage = 'release';
    t.live = openPr;
    t.progress = undefined;
    t.release = release.version;
    const into = merged?.moved ? merged : null;
    // squad-kit's own code goes out by pull request, never in a release from here (engine/self-project.ts).
    const own = isSelfProject(bp);
    t.status = openPr
      ? 'Opening the pull request'
      : into
        ? `Merged into ${into.base} · ${own ? SELF_MERGED : `goes out in ${release.version}`}`
        : merged
          ? CHECKOUT_WAITS
          : `Ready for ${release.version}`;
    if (into) {
      t.mergedAt = now();
      const ls = localSetupFor(bp, t);
      if (ls) t.localSetup = ls;
    }
    t.squad = openPr ? { phase: 'publish', nextAt: now() } : null;
    noteLooksRight(t, looksRight);
    if (byItself) addActivity(t, 'squad', byItself);
    else if (t.outside && !t.outside.checked) addActivity(t, 'you', `Looks right, with no check by squad-kit. ${outsideWords(t.outside)}`);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', 'Saved the change');
    if (merged) addActivity(t, 'release', merged.moved ? `Merged into ${merged.base}` : CHECKOUT_LATER);
    if (!own) addActivity(t, 'release', `Added to release ${release.version}`);
  });
}

/**
 * A project folder that moved leaves the ticket's copy with a dead link to its repo: mended before git works there, with
 * whatever a crash left in it.
 */
export function repairCopy(bp: BoardPaths, t: Ticket): void {
  if (!t.worktree || !repairCopyLink(path.join(bp.root, repoFor(readMeta(bp), t).path), t.worktree)) return;
  const onDisk = settleCopy(t.worktree);
  if (onDisk) updateTicket(bp, t.id, (x) => addActivity(x, 'squad', cutOffWords(onDisk)));
}
