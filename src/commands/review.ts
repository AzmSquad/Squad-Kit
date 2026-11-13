import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { requireTicket } from '../board/store.js';
import { whenWords } from '../board/review-doc.js';
import { reviewView, commitWords, countWords, type ReviewView } from '../engine/review-record/view.js';
import { goPast, writeReviewAgain } from '../engine/review-record/actions.js';
import { approvalWords, oneLine, reasonWords, stateWords } from '../engine/review-record/words.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const grey = (s: string) => kleur.gray(s);

const STATE_COLOR = { fixed: kleur.green, past: kleur.yellow, open: kleur.white } as const;

/** The review as the terminal prints it: what the Changes tab shows. */
export function reviewLines(v: ReviewView): string[] {
  if (!v.rounds.length) return ['  No review yet.'];
  const lines = [`  ${kleur.bold('The review')}  ${grey(`${v.rounds.length} ${v.rounds.length === 1 ? 'round' : 'rounds'} · notes ${countWords(v)} · Builder changes after review: ${commitWords(v.fixes.length)}`)}`];
  if (v.old) lines.push(grey('  Kept the old way: the latest notes only, with no file or line.'));
  for (const r of v.rounds) {
    lines.push('', `  ${kleur.bold(`Round ${r.n}`)}  ${grey(`${whenWords(r.at)} · ${r.approved ? 'approved' : 'changes asked'}${r.fix.length ? ` · the Builder's fix ${r.fix.join(', ')}` : ''}`)}`);
    if (!r.notes.length) lines.push(grey('    No new notes.'));
    for (const n of r.notes) {
      lines.push(`    ${n.n}. ${oneLine(n, 200)}`);
      lines.push(`       ${STATE_COLOR[n.state](stateWords(n))}${n.state === 'past' ? grey(` ${reasonWords(n)}`) : ''}`);
    }
  }
  if (v.looksRight) lines.push('', `  ${approvalWords(v.looksRight)}`);
  if (v.posted) lines.push(v.posted.ok ? grey(`  In pull request ${v.posted.pr}, ${whenWords(v.posted.at)}`) : kleur.yellow(`  Not in pull request ${v.posted.pr} yet: ${v.posted.why ?? ''}`));
  return lines;
}

/**
 * `squad review <story>`: the review round by round, the same as the Changes tab. `--past <n> --reason "<why>"` goes past
 * one open note; `--write` writes the review into the pull request again.
 */
export async function runReview(id: string, opts: { past?: string; reason?: string; write?: boolean }): Promise<void> {
  const bp = board();
  if (opts.past !== undefined) {
    const n = Number(opts.past);
    if (!Number.isInteger(n) || n < 1) throw new Error('--past takes a note number, like --past 3.');
    goPast(bp, id, n, opts.reason ?? '');
    ui.success(`Went past note ${n}. Your reason is on the record.`);
    return;
  }
  if (opts.write) {
    const p = await writeReviewAgain(bp, id);
    if (p.ok) ui.success(`Wrote the review into pull request ${p.pr}.`);
    else ui.warning(`Not written: ${p.why ?? 'the code host said no.'} The merge is not affected.`);
    return;
  }
  const t = requireTicket(bp, id);
  out();
  out(`  ${kleur.bold(t.id)} ${t.title}`);
  for (const l of reviewLines(reviewView(t))) out(l);
  out();
}
