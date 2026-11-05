import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import { asError, fileTroubleWords, isFileTrouble } from '../core/file-trouble.js';

/**
 * squad-kit cannot save its own files for a project: the disk is full, or the project's folder moved. A step that fails
 * here says nothing about the work, and its stop card could not be saved either. So the squad holds that project, the
 * person gets one plain banner on every page and one line in the terminal, and the work carries on by itself once a
 * small test write gets through.
 */

export interface SaveTrouble {
  since: string;
  /** What the person reads. */
  text: string;
  /** The exact error, for engineers. */
  detail: string;
}

const troubles = new Map<string, SaveTrouble & { root: string }>();
const checked = new Map<string, number>();

/** How often a held squad tries its test write. */
export const SAVE_CHECK_MS = 5000;

/** Room for one ticket's files: a disk with a few bytes left is still full. */
const TEST_WRITE = Buffer.alloc(64 * 1024, 32);

/** True when the board's own files can be written right now. Never makes a folder that moved away. */
export function canSave(bp: BoardPaths): boolean {
  if (!fs.existsSync(bp.squadDir)) return false;
  for (const dir of [bp.squadDir, bp.localDir]) {
    const file = path.join(dir, `.save-check-${process.pid}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, TEST_WRITE);
      fs.rmSync(file, { force: true });
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Nothing to clean.
      }
      return false;
    }
  }
  return true;
}

/**
 * True when this failure is about saving, and saving really does not work now. A missing file alone may be anything
 * (a file a step expected), so it counts only when the test write fails too.
 */
export function isSaveTrouble(bp: BoardPaths, err: unknown): boolean {
  if (!fs.existsSync(bp.squadDir)) return true;
  if (!isFileTrouble(err)) return false;
  return !canSave(bp);
}

/** Remembers the trouble and says so once. True the first time, so the caller writes its log line once. */
export function noteSaveTrouble(bp: BoardPaths, err: unknown): boolean {
  if (troubles.has(bp.squadDir)) return false;
  const e = asError(err);
  troubles.set(bp.squadDir, { root: bp.root, since: new Date().toISOString(), text: isFileTrouble(e) ? fileTroubleWords(e) : fileTroubleWords({ code: 'ENOENT' }), detail: e.message });
  checked.set(bp.squadDir, Date.now());
  return true;
}

export function saveTroubleOf(bp: BoardPaths): SaveTrouble | null {
  return troubles.get(bp.squadDir) ?? null;
}

/** Every project's trouble, for the banner. One disk full is many projects with one sentence. */
export function saveTroubles(): (SaveTrouble & { root: string })[] {
  return [...troubles.values(), ...turnTroubles.values()];
}

/* ── A squad whose turns keep failing ────────────────────── */

const turnTroubles = new Map<string, SaveTrouble & { root: string }>();

/** What the person reads when a project's squad cannot move and saving is not the reason. */
export const TURN_TROUBLE = "squad-kit ran into a problem it did not expect, so a project's squad cannot move right now. Your work is safe. Restart squad-kit. If this stays, use Report a problem.";

/**
 * A squad's turns keep failing on something other than saving (a file it cannot read, a bug), so nothing moves in that
 * project. The same banner says so. Its turns go on, and the first one that gets through ends it (endTurnTrouble).
 */
export function noteTurnTrouble(bp: BoardPaths, err: unknown): void {
  turnTroubles.set(bp.squadDir, { root: bp.root, since: new Date().toISOString(), text: TURN_TROUBLE, detail: asError(err).message });
}

export function endTurnTrouble(bp: BoardPaths): void {
  turnTroubles.delete(bp.squadDir);
}

/**
 * Called on each turn of a held squad. True while it must wait. False once the trouble is over; `fixed` says it just
 * ended, so the caller carries on what it cut off.
 */
export function stillHeld(bp: BoardPaths, at = Date.now()): { held: boolean; fixed: boolean } {
  if (!troubles.has(bp.squadDir)) return { held: false, fixed: false };
  if (at - (checked.get(bp.squadDir) ?? 0) < SAVE_CHECK_MS) return { held: true, fixed: false };
  checked.set(bp.squadDir, at);
  if (!canSave(bp)) return { held: true, fixed: false };
  troubles.delete(bp.squadDir);
  checked.delete(bp.squadDir);
  return { held: false, fixed: true };
}

/** A closed project holds nothing. */
export function forgetSaveTrouble(bp: BoardPaths): void {
  troubles.delete(bp.squadDir);
  checked.delete(bp.squadDir);
  turnTroubles.delete(bp.squadDir);
}
