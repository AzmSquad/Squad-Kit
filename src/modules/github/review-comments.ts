import type { PullRequestReview, ReviewThread } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi, githubGraphql } from './auth.js';
import { getPull, paged } from './pulls.js';

/**
 * The review in a GitHub pull request (ADR-007): each note a review comment on its file and line, on the right side;
 * on the whole file when GitHub has no such line in the change; on the pull request itself when the file is not in
 * it, naming the file. A fixed note's thread, and one gone past, are resolved. Each carries an unseen mark with its key,
 * so a second write finds it and adds nothing; what a person did with a thread since stays as they left it.
 */

/** squad-kit's own mark: a hidden line GitHub does not show. Keys are squad-kit's ("RO-5#3"). */
const mark = (key: string) => `<!-- squad-kit:${key.replace(/[^\w#.:-]/g, '')} -->`;
const MARKED = /<!-- squad-kit:([\w#.:-]+) -->/g;

interface RawComment {
  id: number;
  body?: string;
}

/** The keys already written into the pull request, from both kinds of comment. */
async function writtenKeys(repo: string, n: number): Promise<Set<string>> {
  const [lines, comments] = await Promise.all([paged<RawComment>(`/repos/${repo}/pulls/${n}/comments`), paged<RawComment>(`/repos/${repo}/issues/${n}/comments`)]);
  const keys = new Set<string>();
  for (const c of [...lines, ...comments]) for (const m of (c.body ?? '').matchAll(MARKED)) keys.add(m[1]!);
  return keys;
}

const noPlace = (err: unknown) => err instanceof ModuleError && err.status === 422;

/** One note, as close to its place as GitHub takes it. Returns the review comment's id when it is one. */
async function postOne(repo: string, n: number, sha: string, th: ReviewThread): Promise<number | null> {
  const text = `${th.text}\n\n${mark(th.key)}`;
  if (th.file) {
    const at = { body: text, commit_id: sha, path: th.file };
    if (th.line) {
      try {
        return (await githubApi<RawComment>(`/repos/${repo}/pulls/${n}/comments`, { method: 'POST', body: { ...at, line: th.line, side: 'RIGHT' } })).id;
      } catch (err) {
        if (!noPlace(err)) throw err;
      }
    }
    try {
      return (await githubApi<RawComment>(`/repos/${repo}/pulls/${n}/comments`, { method: 'POST', body: { ...at, subject_type: 'file' } })).id;
    } catch (err) {
      if (!noPlace(err)) throw err;
    }
  }
  const where = th.file ? `\`${th.file.replace(/`/g, '')}\`${th.line ? ` line ${th.line}` : ''}\n\n` : '';
  await githubApi(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body: `${where}${text}` } });
  return null;
}

/** Resolves the threads of these review comments. A refusal changes nothing: each comment says where it stands. */
async function resolve(repo: string, n: number, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const [owner, name] = repo.split('/');
  const q = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`;
  try {
    const data = await githubGraphql<{ repository: { pullRequest: { reviewThreads: { nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[] } } } }>(q, { owner, name, n });
    const wanted = new Set(ids);
    for (const t of data.repository.pullRequest.reviewThreads.nodes) {
      if (t.isResolved || !wanted.has(t.comments.nodes[0]?.databaseId ?? -1)) continue;
      await githubGraphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id: t.id });
    }
  } catch {
    // Left open: its words say Fixed or Went past.
  }
}

export async function postReviewComments(repo: string, n: number, review: PullRequestReview): Promise<{ threads: number }> {
  const sha = (await getPull(repo, n)).head.sha;
  const found = await writtenKeys(repo, n);
  const settled: number[] = [];
  for (const th of review.threads) {
    if (found.has(th.key)) continue;
    const id = await postOne(repo, n, sha, th);
    if (id && th.state !== 'open') settled.push(id);
  }
  await resolve(repo, n, settled);
  const ok = review.approval;
  if (ok && !found.has(ok.key)) await githubApi(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body: `${ok.text}\n\n${mark(ok.key)}` } });
  return { threads: review.threads.length };
}
