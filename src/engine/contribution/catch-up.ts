import { addActivity, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions/errors.js';
import { forkHostFor, repoHostFor } from '../../modules/registry.js';
import { baseTurn, fetchedTip, git, isAncestor, moveBase } from '../git.js';
import { mapAfterMerge, repoTarget } from '../sync.js';

/**
 * Bring it up to date: the person's copy of the main repo (their fork) takes the main repo's newest work, by the code
 * host's own sync, and then their computer's base moves forward to it. Only ever forward: a copy or a base with changes
 * of its own is said in plain words and left as it is. Nothing is forced, deleted or rewritten.
 */

export interface RepoPlace {
  dir: string;
  remote: string;
  base: string;
  url: string;
}

export interface CaughtUp {
  /** Commits the copy took from the main repo. */
  took: number;
  /** The computer's base moved. */
  moved: boolean;
  line: string;
}

/** The computer's base, forward to the copy's newest. */
async function baseForward(bp: BoardPaths, p: RepoPlace): Promise<boolean> {
  const env = repoHostFor(bp, p.url)?.gitEnv() ?? {};
  const tip = await fetchedTip(p.dir, p.remote, p.base, { env });
  const here = git(p.dir, ['rev-parse', '--verify', '-q', `refs/heads/${p.base}`], { allowFail: true });
  if (here === tip) return false;
  if (here && !isAncestor(p.dir, here, tip)) throw new BoardActionError(`${p.base} on this computer has changes that your copy on the code host does not have, so squad-kit leaves it as it is. Nothing was changed.`);
  const r = await baseTurn(p.dir, () => moveBase(p.dir, p.base, tip));
  if (!r.moved) throw new BoardActionError(`Your copy is up to date, but ${p.base} on this computer has changes of yours in the same files, so it did not move. Save or undo them, then try again.`);
  return true;
}

export async function catchUp(bp: BoardPaths, p: RepoPlace): Promise<CaughtUp> {
  const host = forkHostFor(p.url);
  const copy = host?.forks.repoName(p.url);
  if (!host || !copy) throw new BoardActionError('This repo is not on a code host squad-kit can bring up to date.');
  const info = await host.forks.repoInfo(copy);
  if (!info.parent) throw new BoardActionError(`${copy} is not a copy of another repo, so there is nothing to bring in.`);
  const { behind, ahead } = await host.forks.compareFork(copy, info.parent, p.base);
  if (ahead > 0) throw new BoardActionError(`${p.base} of your copy ${copy} has ${ahead === 1 ? 'a change' : `${ahead} changes`} that ${info.parent} does not have. squad-kit never forces it: bring them into ${info.parent} by a pull request, or ask an engineer.`);
  if (behind > 0) await host.forks.syncFork(copy, p.base);
  const moved = await baseForward(bp, p);
  // New code on the base: the project's map is read again, as after any merge.
  if (moved) mapAfterMerge(bp);
  const took = behind ? `Your copy ${copy} took ${behind === 1 ? 'one change' : `${behind} changes`} from ${info.parent}` : `Your copy ${copy} was up to date with ${info.parent}`;
  return { took: behind, moved, line: `${took}${moved ? `, and ${p.base} on this computer moved forward to it.` : '.'}` };
}

/** After the owner merged: the person's copy and base catch up, when they only fell behind. Said on the story. */
export async function catchUpAfterMerge(bp: BoardPaths, id: string): Promise<void> {
  const target = repoTarget(bp, requireTicket(bp, id));
  if (!target) return;
  let line: string;
  try {
    line = (await catchUp(bp, target)).line;
  } catch (err) {
    line = `Your copy was not brought up to date: ${(err as Error).message}`;
  }
  updateTicket(bp, id, (x) => addActivity(x, 'release', line.replace(/\.$/, '')));
}
