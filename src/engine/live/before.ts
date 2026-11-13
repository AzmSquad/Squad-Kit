import fs from 'node:fs';
import path from 'node:path';
import { addActivity, readTicket } from '../../board/store.js';
import type { ProofShot, Ticket } from '../../board/types.js';
import { runCommand, tail } from '../checks.js';
import { samePicture, shotSizeOf } from '../proof-check.js';
import type { ShotSize } from '../shots.js';
import { addSnapshot, dropSnapshot } from '../git.js';
import { repoFor } from '../repos.js';
import { appCopyOf } from '../copies.js';
import { explainError } from '../../board/problem.js';
import { runsEnded } from '../leftovers.js';
import { makeMain } from '../proof-verdict.js';
import { BEFORE_SHOTS_MS } from './limits.js';
import { projectRoot, STOPPED } from './shared.js';
import type { LiveSquad } from './squad.js';

/** The "before" screenshots, taken beside the build, and pairing them with the "after" ones. */
export const beforePart = {
  /** The main after is the very same picture as the before, where both were taken of the screen. */
  sameAsBefore(this: LiveSquad, p: ProofShot): boolean {
    if (p.beforeLabel !== 'Before' || !p.before || !p.after || p.before === p.after) return false;
    try {
      return samePicture(fs.readFileSync(path.join(this.bp.proofDir, p.before)), fs.readFileSync(path.join(this.bp.proofDir, p.after)));
    } catch {
      // A picture removed meanwhile is missing from the proof, which says so on its own.
      return false;
    }
  },

  /**
   * The before pairs with the main picture, and an after the same as the before shows nothing: when the main one is the
   * same and another of the row's is not, that other one becomes the main one. No picture is lost, and a retake that
   * adds a real change is not held back by the old main picture.
   */
  pairWithBefore(this: LiveSquad, row: ProofShot): void {
    if (!row.more?.length || !this.sameAsBefore(row)) return;
    const at = row.more.findIndex((m) => !this.sameAsBefore({ ...row, after: m.after }));
    if (at >= 0) makeMain(row, at);
  },

  /** The size of each "done when"'s before picture, by its words, so the after picture it pairs with can match. */
  beforeSizes(this: LiveSquad, t: Ticket): Record<string, ShotSize | 'tablet'> {
    const rows = (t.proof ?? []).filter((p) => p.before && p.beforeLabel !== 'New screen');
    return Object.fromEntries(rows.flatMap((p) => {
      const size = shotSizeOf(path.join(this.bp.proofDir, p.before));
      return size ? [[p.criterion, size]] : [];
    }));
  },

  /** True when two saved pictures are the same file, or have the very same bytes. */
  sameFile(this: LiveSquad, a: string, b: string): boolean {
    if (a === b) return true;
    try {
      return fs.readFileSync(path.join(this.bp.proofDir, a)).equals(fs.readFileSync(path.join(this.bp.proofDir, b)));
    } catch {
      return false;
    }
  },

  /**
   * The "before" screenshots, beside the build: from a copy of the code at the ticket's base, so they show the app as
   * it was while the Builder changes the ticket's own copy. They stop after 8 minutes, or on the ticket's Stop, and
   * say so when they could not be taken. The copy is removed after.
   */
  shootBefore(this: LiveSquad, id: string): void {
    const key = `__before:${id}`;
    if (this.running.has(key)) return;
    let ended = () => {};
    this.beforeShotsOf.set(id, new Promise<void>((resolve) => (ended = resolve)));
    this.launch(key, () =>
      this.beforeShots(id, key).finally(() => {
        this.beforeShotsOf.delete(id);
        ended();
      }),
    );
  },

  async beforeShots(this: LiveSquad, id: string, key: string): Promise<void> {
    // Their own Stop: the ticket's Stop (whichever step runs then), the board closing, or the time running out.
    const own = this.stops.get(key)!;
    let cutOff = false;
    const timer = setTimeout(() => {
      cutOff = true;
      own.abort();
    }, BEFORE_SHOTS_MS);
    const t = readTicket(this.bp, id)!;
    const repo = appCopyOf(this.meta(), t)?.repo ?? repoFor(this.meta(), t);
    const root = path.join(projectRoot(this.bp), repo.path);
    let dir: string | null = null;
    try {
      dir = await addSnapshot(root, `${id.toLowerCase()}-before`, t.baseCommit!, { signal: own.signal });
      const setup = repo.commands.setup?.trim();
      if (setup) {
        const r = await runCommand(dir, setup, BEFORE_SHOTS_MS, { signal: own.signal, onHealed: (detail) => this.healed(id, detail), ...(this.guardFor(dir, id) ? { guard: this.guardFor(dir, id)! } : {}) });
        if (own.signal.aborted) throw new Error(STOPPED);
        if (!r.ok) throw new Error(`setting up a copy of the code as it was failed (${setup}): ${tail(r.output, 3)}`);
      }
      const left = (await this.screens(id, 'before', { cwd: dir, job: key, signal: own.signal })).problems;
      if (left.length) this.update(id, (x) => addActivity(x, 'tester', `Left out before screenshots that did not pass squad-kit's check: ${left.map((b) => b.text).join(' ')}`));
    } catch (err) {
      // A Stop, or the board closing, says so elsewhere.
      if (cutOff || !own.signal.aborted) {
        // The exact words go to the app log; the activity says it plainly.
        const e = explainError(err);
        if (!cutOff) this.log('warn', `Could not take the before screenshots: ${[e.what, e.detail].filter(Boolean).join(': ')}`, id);
        this.update(id, (x) =>
          addActivity(x, 'tester', cutOff ? 'Stopped the before screenshots after 8 minutes, so the proof shows the screens after the change only' : 'Could not take the before screenshots, so the proof shows the screens after the change only'),
        );
      }
    } finally {
      clearTimeout(timer);
      if (dir) {
        // Nothing the before screenshots started outlives their copy.
        await runsEnded([dir], 6000);
        await this.clearCopies([dir], {}, id).catch(() => undefined);
        await dropSnapshot(root, dir);
      }
    }
  },
};
