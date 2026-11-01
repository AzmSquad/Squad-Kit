import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from './store.js';

/** The console writes its pid here while its squad runs, so terminal commands don't run a second one. */
function lockFile(bp: BoardPaths): string {
  return bp.pidFile;
}

export function claimSquad(bp: BoardPaths): () => void {
  fs.mkdirSync(bp.localDir, { recursive: true });
  fs.writeFileSync(lockFile(bp), String(process.pid), 'utf8');
  return () => {
    try {
      if (fs.readFileSync(lockFile(bp), 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile(bp));
    } catch {
      // Already gone.
    }
  };
}

export function squadRunsElsewhere(bp: BoardPaths): boolean {
  try {
    const pid = Number(fs.readFileSync(lockFile(bp), 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
