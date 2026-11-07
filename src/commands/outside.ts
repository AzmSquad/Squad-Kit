import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { createTicket } from '../board/actions.js';
import { bringBack, checkOutside, recordApproval, workOutside } from '../board/outside.js';
import { outsideWords } from '../board/outside-step.js';
import { readMeta, requireTicket, ticketDir } from '../board/store.js';
import { copiesOf } from '../engine/copies.js';
import { LiveSquad } from '../engine/live.js';
import { reposOf } from '../engine/repos.js';
import { lookAtFiles, outsidePrompt, whereAndNext, writeGuide } from '../engine/outside-guide.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

/** `squad outside new`: a story a conversation outside squad-kit makes. The squad keeps off it until it comes back. */
export async function runOutsideNew(words: string[], opts: { ask?: string; bug?: boolean }): Promise<void> {
  const bp = board();
  const title = words.join(' ').trim();
  if (!title) throw new Error('Give it a short title: squad outside new "Sign in with a phone number"');
  if (readMeta(bp).engine !== 'live') throw new Error('The sample board has no real project to work on outside.');
  const t = createTicket(bp, { title, ask: opts.ask, kind: opts.bug ? 'bug' : 'feature', outside: true });
  writeGuide(bp);
  ui.success(`${t.id} is made. The squad keeps off it until it comes back.`);
  out(`  Its folder: ${ticketDir(bp, t.id)}`);
  out(`  Next: ${cmd(`squad outside show ${t.id}`)}`);
}

/** `squad outside prompt`: the words to paste in a conversation in any AI tool. Changes nothing on the story. */
export async function runOutsidePrompt(ticketId?: string): Promise<void> {
  const bp = board();
  out(outsidePrompt(bp, ticketId ? requireTicket(bp, ticketId) : undefined));
}

/** `squad outside start`: the squad stops on the story, and the words for the conversation. */
export async function runOutsideStart(ticketId: string): Promise<void> {
  const bp = board();
  const t = await workOutside(bp, ticketId);
  ui.success(`${t.id} is yours to work on outside squad-kit. The squad waits.`);
  out();
  out(outsidePrompt(bp, t));
}

/** `squad outside show`: where the story is, what comes next, and which of its files is wrong. Exits with 1 when one is. */
export async function runOutsideShow(ticketId: string): Promise<void> {
  const bp = board();
  const { ticket: t, problems } = lookAtFiles(bp, ticketId);
  out();
  if (t) {
    const { done, next } = whereAndNext(readMeta(bp), t);
    out(`  ${kleur.bold(t.id)}: ${t.title}`);
    out(`  ${t.takenOver?.free ? 'In a conversation outside squad-kit. The squad waits.' : t.status}`);
    if (t.outside) out(`  ${outsideWords(t.outside)}${t.outside.checked ? ', checked by squad-kit' : ''}.`);
    for (const d of done) out(`  ${d}`);
    if (t.takenOver?.free) out(`  Next: ${next}`);
  }
  if (problems.length) {
    out();
    out(`  ${kleur.red('These need fixing:')}`);
    for (const p of problems) out(`    ${kleur.bold(p.file)}: ${p.problem}`);
    process.exitCode = 1;
  } else if (t) out(`  Its files are in the right shape.`);
  out();
}

/** `squad outside copy`: the story's own copy of the code, made the way the squad makes it. */
export async function runOutsideCopy(ticketId: string, repo?: string): Promise<void> {
  const bp = board();
  const before = requireTicket(bp, ticketId);
  if (!before.takenOver?.free) throw new Error(`${before.id} is not in a conversation outside squad-kit. Start with: squad outside start ${before.id}`);
  const known = reposOf(readMeta(bp)).map((r) => r.path);
  if (repo && !known.includes(repo)) throw new Error(`There is no repo "${repo}" in this project. Its repos: ${known.join(', ')}.`);
  const t = await new LiveSquad(bp).copyForOutside(before.id, repo);
  ui.success(`Work only in this copy, on the branch ${t.branch}:`);
  for (const c of copiesOf(readMeta(bp), t)) out(`  ${c.dir}`);
  if (t.setupTrouble) ui.warning(`Setting up the copy failed on this computer (${t.setupTrouble.command}). Sort that out first:\n${t.setupTrouble.output}`);
}

/** `squad outside approved`: the person said yes in the conversation. */
export async function runOutsideApproved(ticketId: string, what: string): Promise<void> {
  if (what !== 'spec' && what !== 'design') throw new Error('Say which: squad outside approved <ticket> spec, or design.');
  const t = recordApproval(board(), ticketId, what);
  ui.success(`The ${what} of ${t.id} is approved.`);
}

/** `squad outside back`: back to the board, at its real step. */
export async function runOutsideBack(ticketId: string): Promise<void> {
  const t = await bringBack(board(), ticketId);
  ui.success(`${t.id} is back on the board. ${t.status}.`);
  if (t.outside && !t.outside.checked && t.waiting?.kind === 'proof') ui.info(`squad-kit has not checked this work. The person can ask it to: ${cmd(`squad outside check ${t.id}`)}`);
}

/** `squad outside check`: squad-kit's own checks, review and proof, on work done outside. */
export async function runOutsideCheck(ticketId: string): Promise<void> {
  const t = checkOutside(board(), ticketId);
  ui.success(`squad-kit runs its own checks, review and proof on ${t.id}. Follow it: ${cmd(`squad watch ${t.id}`)}`);
}
