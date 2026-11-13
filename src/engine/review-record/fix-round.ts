import fs from 'node:fs';
import { addActivity, readMeta, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { ReviewRound } from '../../board/review-types.js';
import { commitHooks, commitLater, conventionalWords, git, gitLater, keepsCommitRules, somethingToSave, stageAllLater } from '../git.js';
import { copiesOf, type CopyOf } from '../copies.js';
import { leaveProjectFiles } from '../project-git.js';
import { writeLog } from '../../core/app-log.js';
import { readDiff, touchedNotes } from './git-fixed.js';
import { notePrefix } from './notes.js';
import { stateOf } from './state.js';

/**
 * The Builder's next round after a review, saved so each note can be traced to the commit that fixed it: the fix the
 * Reviewer asked for, or a change you asked for with Something's wrong while a note was still open. squad-kit saves the
 * work as the Reviewer read it, the Builder works, squad-kit saves that, and git says which notes it touched. The
 * project's own commit hooks look at all of it at Looks right (hookOwed), so nothing here waits on them.
 */

/** What a save found in each copy, by its folder: the commit it is at, and whether this save made it. */
interface Saved {
  copy: CopyOf;
  at: string;
  made: boolean;
}

/**
 * Saves what is in each copy now. A copy git cannot save in is left out: its notes stay open, and the story goes on.
 * `hooks`: a copy has commit hooks, which have not looked at what was saved.
 */
async function saveCopies(bp: BoardPaths, t: Ticket, words: { plain: string; rule: string }): Promise<{ copies: Map<string, Saved>; hooks: boolean }> {
  const copies = new Map<string, Saved>();
  let hooks = false;
  for (const [i, c] of copiesOf(readMeta(bp), t).entries()) {
    if (!fs.existsSync(c.dir)) continue;
    try {
      // The board's own files from other stories never travel on this one (as with any work saved before Looks right).
      if (i === 0) leaveProjectFiles(bp, t, c.repo.base);
      await stageAllLater(c.dir);
      const made = somethingToSave(c.dir);
      if (made) {
        await commitLater(c.dir, keepsCommitRules(c.dir) ? words.rule : words.plain);
        hooks ||= commitHooks(c.dir).length > 0;
      }
      copies.set(c.dir, { copy: c, at: git(c.dir, ['rev-parse', 'HEAD']), made });
    } catch (err) {
      writeLog({ level: 'warn', ticket: t.id, text: `Could not save the review round's work in ${c.dir}, so its notes stay open: ${(err as Error).message}` });
    }
  }
  return { copies, hooks };
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Runs the Builder's round (`fix`) after the story's last review round, with the work saved before and after it when a
 * note of that round is open. git compares the commit the Reviewer read with the copy's last commit, the Builder's own
 * commits too. A note whose lines that changed is fixed in that commit when its round asked for the change; the
 * Reviewer's next round can still reopen it (prompt.ts). A note about a whole file, or one of an approved round that a
 * change you asked for touched, waits for the Reviewer's next round to say. Nothing here stops the story.
 */
export async function fixRound(bp: BoardPaths, id: string, fix: () => Promise<unknown>): Promise<void> {
  const t0 = requireTicket(bp, id);
  const round = t0.review?.rounds.at(-1);
  const open = round ? round.notes.filter((note) => stateOf(t0, round, note) === 'open') : [];
  // Nothing of the last round is open (or there was no review yet): a plain Builder round, saved at Looks right as usual.
  if (!round || !open.length) {
    await fix();
    return;
  }
  const n = round.n;
  const read = await saveCopies(bp, t0, {
    plain: `Work so far on ${t0.title} (${t0.id}), as the Reviewer read it in round ${n}`,
    rule: conventionalWords('chore', `work so far, as the Reviewer read it in round ${n}`, t0.id),
  });
  await fix();
  const t = requireTicket(bp, id);
  const done = await saveCopies(bp, t, { plain: `The Builder's changes after review round ${n} (${t.id})`, rule: conventionalWords('fix', `changes after review round ${n}`, t.id) });
  const moved = [...done.copies.values()].filter((d) => read.copies.get(d.copy.dir) && read.copies.get(d.copy.dir)!.at !== d.at);
  const touched = new Map<number, string>();
  for (const d of moved) {
    const files = readDiff(await gitLater(d.copy.dir, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', read.copies.get(d.copy.dir)!.at, d.at], { allowFail: true }));
    const prefix = notePrefix(t, d.copy.repo.path);
    const here = open.filter((note) => note.file?.startsWith(prefix)).map((note) => ({ ...note, file: note.file!.slice(prefix.length) }));
    for (const k of touchedNotes(here, files)) touched.set(k, short(d.at));
  }
  const label = (c: CopyOf) => c.repo.path || '.';
  updateTicket(bp, id, (x) => {
    const r = x.review?.rounds.find((y) => y.n === n);
    if (!r) return;
    r.read = Object.fromEntries([...read.copies.values()].map((d) => [label(d.copy), short(d.at)]));
    if (moved.length) r.fix = Object.fromEntries(moved.map((d) => [label(d.copy), short(d.at)]));
    let fixed = 0;
    for (const note of r.notes) {
      const commit = touched.get(note.n);
      if (!commit) continue;
      if (r.approved || !note.line) note.touched = commit;
      else {
        note.fixed = { commit, by: 'git' };
        fixed += 1;
      }
    }
    // Saved here without the project's commit hooks: they look at the whole change at Looks right.
    if (read.hooks || done.hooks) x.hookOwed = true;
    if (moved.length) addActivity(x, 'squad', fixLine(r, open.length, fixed, touched.size - fixed));
  });
}

function fixLine(r: ReviewRound, total: number, fixed: number, touched: number): string {
  const notes = (k: number) => `${k} ${k === 1 ? 'note' : 'notes'}`;
  const said = [`${fixed} of ${notes(total)} changed where they point`, ...(touched ? [`${notes(touched)} more touched, for the Reviewer to call`] : [])];
  return `Saved the Builder's changes after review round ${r.n} as ${Object.values(r.fix ?? {}).join(', ')}: ${said.join('; ')}. The Reviewer checks them in its next round`;
}
