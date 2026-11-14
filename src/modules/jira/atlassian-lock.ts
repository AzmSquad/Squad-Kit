import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readyPrivateFolder } from '../../core/home.js';
import { ATLASSIAN_FOLDER } from './atlassian-store.js';

/**
 * The lock in squad-kit's Atlassian folder (ADR-012): one squad-kit on this computer (the board, a terminal) changes the
 * sign-in at a time. Atlassian rotates the refresh token, so two refreshes with the same one would leave one of them
 * refused; a site picked or a Disconnect must never land in the middle of a refresh either. The lock holds its
 * squad-kit's process id. It is taken over only when that process has stopped, or when it is minutes old (no refresh
 * takes that long); and whoever made it reads it back a moment later, so of two squad-kits taking over a stale lock at
 * once, only one goes on.
 */

const LOCK = 'refresh.lock';
/** A lock this old is taken over even when its squad-kit still runs: a refresh is cut off long before. */
const OLD_MS = 5 * 60_000;
/** Made: read back after this long. */
const SETTLE_MS = 50;
const WINDOWS = process.platform === 'win32';
/** Windows answers these while another program has the file open or is taking it away: the lock is busy. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ownerOf(file: string): string {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** A squad-kit still runs with this process id (one of another user's answers EPERM: it runs). */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What stands at the lock's place may be taken away: not a plain file (a folder, a link), very old, or held by a
 * squad-kit that has stopped. A lock just made, its owner not written yet, is never stale.
 */
function stale(file: string): boolean {
  const there = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!there) return false;
  if (!there.isFile() || Date.now() - there.mtimeMs > OLD_MS) return true;
  const owner = ownerOf(file);
  return owner !== '' && !running(Number(owner.split(' ')[0]));
}

/**
 * Holds the lock, waiting up to `waitMs` for another squad-kit to finish. Gives the release (which takes away only this
 * lock, never one taken over since, nor a folder made anew after a Disconnect), or null when it could not be had.
 */
export async function holdRefreshLock(waitMs: number): Promise<(() => void) | null> {
  const file = path.join(readyPrivateFolder(ATLASSIAN_FOLDER), LOCK);
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const until = Date.now() + waitMs;
  for (;;) {
    let made = false;
    try {
      const fd = fs.openSync(file, NEW, 0o600);
      try {
        fs.writeFileSync(fd, mine);
      } finally {
        fs.closeSync(fd);
      }
      made = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') readyPrivateFolder(ATLASSIAN_FOLDER);
      else if (code !== 'EEXIST' && code !== 'EISDIR' && !(WINDOWS && BUSY.has(code))) throw err;
      else if (stale(file)) {
        fs.rmSync(file, { recursive: true, force: true });
        continue;
      }
    }
    if (made) {
      await sleep(SETTLE_MS);
      if (ownerOf(file) === mine) {
        return () => {
          if (ownerOf(file) === mine) fs.rmSync(file, { force: true });
        };
      }
    }
    if (Date.now() >= until) return null;
    await sleep(100);
  }
}
