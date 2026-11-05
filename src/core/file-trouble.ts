/**
 * Trouble with the computer's own files: a full disk, a read-only disk, a folder that moved. It says nothing about the
 * work, so it gets its own plain words and squad-kit waits it out instead of failing a step.
 */

const SPACE = new Set(['ENOSPC', 'EDQUOT']);
const FILE_CODES = new Set([...SPACE, 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

export function fileTroubleCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && FILE_CODES.has(code) ? code : null;
}

/** True for an error from the computer's files. A missing file alone may be anything: the caller checks further. */
export function isFileTrouble(err: unknown): boolean {
  return fileTroubleCode(err) !== null;
}

/** True when no file can be written at all, wherever the error happened. */
export function isDiskTrouble(err: unknown): boolean {
  const code = fileTroubleCode(err);
  return code !== null && (SPACE.has(code) || code === 'EROFS');
}

/** What the person reads, whichever call found it. */
export function fileTroubleWords(err: unknown): string {
  const code = fileTroubleCode(err);
  if (code && SPACE.has(code)) return 'The disk is full, so squad-kit cannot save its work. Free up some space. Nothing is lost, and squad-kit carries on by itself.';
  if (code === 'EROFS') return 'The disk cannot be written to right now, so squad-kit cannot save its work. Nothing is lost, and squad-kit carries on by itself once it can.';
  if (code === 'EIO') return 'The disk did not answer, so squad-kit cannot save its work. Check the disk. squad-kit carries on by itself once it can.';
  if (code === 'EACCES' || code === 'EPERM') return "squad-kit is not allowed to write in the project's folder, so it cannot save its work. Check the folder's permissions. It carries on by itself once it can.";
  return "The project's folder is not where it was, so squad-kit cannot save its work. Put the folder back, or add it again from Home. The work so far is kept.";
}

/** Said when a run stops because what it reports cannot be saved. */
export const COULD_NOT_SAVE = 'squad-kit could not save what the agent was doing, so it stopped the run. The work so far is kept.';

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
