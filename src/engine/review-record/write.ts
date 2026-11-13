import fs from 'node:fs';
import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import type { ReviewPosted } from '../../board/review-types.js';
import type { PullRequestReview, RepoHost, ReviewThread } from '../../modules/code-host/types.js';
import { writeLog } from '../../core/app-log.js';
import { plainWords } from '../../core/for-people.js';
import { whenWords } from '../../board/review-doc.js';
import { gitLater } from '../git.js';
import { repoFor } from '../repos.js';
import { plainMarkdown } from '../../core/safe-markdown.js';
import { notePrefix } from './notes.js';
import { lineNow } from './git-fixed.js';
import { reviewView, type NoteView, type ReviewView } from './view.js';
import { reasonWords, stateWords } from './words.js';

/**
 * The review written into the pull request through the code host module (ADR-007): a thread per note on its file and
 * line, with its state, and who pressed Looks right. The description already holds the record (pr-description.ts).
 * Writing it never stops or undoes the merge: a refusal is said on the story, with Write it again.
 */

/**
 * A thread's words: the Reviewer's note, and where it stands. The note and the reason are someone's own words, so they
 * go in as plain text. `elsewhere`: the file of a note that is not in this pull request's repo.
 */
function threadText(n: NoteView, elsewhere?: string): string {
  const head = `**Reviewer** · round ${n.round}${n.line && !elsewhere ? ` · line ${n.line}` : ''}${elsewhere ? ` · ${plainMarkdown(elsewhere)}` : ''}`;
  const state = n.state === 'fixed' ? stateWords(n).replace(/^Fixed in (\w+)$/, 'Fixed in `$1`') : n.state === 'past' ? `Went past. ${plainMarkdown(reasonWords(n))}` : 'Open';
  return `${head}\n\n${plainMarkdown(n.text)}\n\n${state}`;
}

/** Where a note's line is in the branch now: the Builder's later fixes may have moved it. `file` is from the repo. */
async function lineInBranch(dir: string | undefined, read: string | undefined, file: string, line: number): Promise<number> {
  if (!dir || !read || !fs.existsSync(dir)) return line;
  const diff = await gitLater(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', read, 'HEAD', '--', file], { allowFail: true });
  return lineNow(line, file, diff);
}

/**
 * The review as threads for the pull request of the story's repo. `prefix`: the repo's folder that notes start with on a
 * workspace of several repos (notes.ts notePrefix); a note on another repo's file goes in with no place, naming it.
 */
export async function reviewForHost(t: Ticket, prefix = '', v: ReviewView = reviewView(t)): Promise<PullRequestReview> {
  const threads: ReviewThread[] = [];
  for (const r of v.rounds) {
    const read = Object.values(t.review?.rounds.find((x) => x.n === r.n)?.read ?? {})[0];
    for (const n of r.notes) {
      const file = n.file?.startsWith(prefix) ? n.file.slice(prefix.length) : undefined;
      const line = file && n.line ? await lineInBranch(t.worktree, read, file, n.line) : undefined;
      threads.push({ key: `${t.id}#${n.n}`, ...(file ? { file } : {}), ...(line ? { line } : {}), text: threadText(n, file ? undefined : n.file), state: n.state });
    }
  }
  const ok = v.looksRight;
  const approval = ok
    ? ok.byItself
      ? `squad-kit accepted this by itself, on the Builds by itself track, ${whenWords(ok.at)}. No person approved it.`
      : `**${plainMarkdown(ok.by)}** pressed Looks right on the squad-kit board, ${whenWords(ok.at)}. squad-kit wrote this for them: it cannot approve in their name.`
    : undefined;
  return { threads, ...(approval ? { approval: { key: `${t.id}#looks-right`, text: approval } } : {}) };
}

/** Writes the review into the story's pull request, and says on the story how it went. Never throws. */
export async function writeReview(bp: BoardPaths, id: string, host: RepoHost, pr: { id: number }): Promise<ReviewPosted | null> {
  if (!host.postReview) return null;
  let posted: ReviewPosted;
  try {
    const t = requireTicket(bp, id);
    const { threads } = await host.postReview(pr.id, await reviewForHost(t, notePrefix(t, repoFor(readMeta(bp), t).path)));
    posted = { at: now(), ok: true, pr: pr.id, threads };
  } catch (err) {
    writeLog({ level: 'warn', project: readMeta(bp).project, ticket: id, text: `Could not write the review into pull request ${pr.id}: ${(err as Error).message}` });
    posted = { at: now(), ok: false, pr: pr.id, why: plainWords(err, `Writing the review into pull request ${pr.id}`) };
  }
  try {
    updateTicket(bp, id, (x) => {
      x.reviewPosted = posted;
      addActivity(
        x,
        'release',
        posted.ok
          ? `Wrote the review into pull request ${pr.id}: ${posted.threads === 1 ? 'one note' : `${posted.threads} notes`} on their files, and who pressed Looks right`
          : `Could not write the review into pull request ${pr.id} on ${host.label}: ${posted.why} The merge is not affected. Write it again from the Changes tab, or run squad review ${x.id} --write`,
      );
    });
  } catch {
    // The story was removed meanwhile.
  }
  return posted;
}
