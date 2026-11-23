import fs from 'node:fs';
import path from 'node:path';
import { copyGitDir, copyTurn, repairCopyLink, worktreeRoot } from './git.js';

/**
 * A copy folder this repo does not know (#34): its `.git` file points at a git folder that is gone, or at another
 * repo's, as when the project was set up again in the same place. git cannot work in it and its code may be old, so it
 * is moved aside (never deleted: its files may be someone's work) and a new copy can be made. Gives where it went, or
 * null when the folder is not there, is this repo's copy, or could be linked to it again.
 */
export function setAsideStrayCopy(root: string, dir: string): string | null {
  if (!fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isFile()) return null;
  if (copyGitDir(root, dir)) return null;
  if (repairCopyLink(root, dir) && copyGitDir(root, dir)) return null;
  const aside = path.join(path.dirname(dir), '.set-aside', `${path.basename(dir)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(aside), { recursive: true });
  fs.renameSync(dir, aside);
  return aside;
}

/**
 * Before a ticket's new copy is made where addWorktree makes it: a copy left there by an earlier set-up of the project
 * is moved aside in the copy's own turn, so it is never taken for this ticket's copy and reused.
 */
export function clearStrayCopy(projectRoot: string, ticketId: string, at?: string): Promise<string | null> {
  const dir = at ?? path.join(worktreeRoot(projectRoot), ticketId.toLowerCase());
  return copyTurn(dir, async () => setAsideStrayCopy(projectRoot, dir));
}
