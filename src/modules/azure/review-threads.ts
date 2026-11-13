import type { PullRequestReview, ReviewThread, ReviewThreadState } from '../code-host/types.js';
import type { Azure } from './client.js';

/**
 * The review in an Azure Repos pull request: one comment thread per note, on its file and its line on the right side,
 * with Azure's own status (active, fixed, closed), and one closed thread that says who pressed Looks right. squad-kit
 * signs in with the project's token, so it never votes: that stays the person's, in Azure.
 */

/** squad-kit's mark on its own threads, so a second write finds them. Azure keeps a thread's properties as given. */
const KEY = 'squadKit.note';

const STATUS: Record<ReviewThreadState, string> = { open: 'active', fixed: 'fixed', past: 'closed' };

interface RawThread {
  id: number;
  isDeleted?: boolean;
  properties?: Record<string, { $value?: unknown } | undefined>;
}

function keyOf(t: RawThread): string | undefined {
  const v = t.properties?.[KEY]?.$value;
  return typeof v === 'string' ? v : undefined;
}

/** Where the thread sits: the file (Azure paths start with a slash), and its line on the right side when there is one. */
function contextOf(th: Pick<ReviewThread, 'file' | 'line'>): Record<string, unknown> | undefined {
  if (!th.file) return undefined;
  const filePath = `/${th.file.replace(/^\/+/, '')}`;
  if (!th.line) return { filePath };
  const at = { line: th.line, offset: 1 };
  return { filePath, rightFileStart: at, rightFileEnd: at };
}

function newThread(key: string, text: string, status: string, context?: Record<string, unknown>): Record<string, unknown> {
  return {
    comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
    status,
    ...(context ? { threadContext: context } : {}),
    properties: { [KEY]: { $type: 'System.String', $value: key } },
  };
}

export async function postReviewThreads(az: Azure, repo: string, prId: number, review: PullRequestReview): Promise<{ threads: number }> {
  const base = `_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads`;
  const found = new Map<string, RawThread>();
  for (const t of (await az.call<{ value?: RawThread[] }>('GET', base))?.value ?? []) {
    const key = keyOf(t);
    if (key && !t.isDeleted) found.set(key, t);
  }
  // Written before: a thread is left as it is, whatever a person did with it since (resolved, reopened, replied).
  for (const th of review.threads) if (!found.has(th.key)) await az.call('POST', base, newThread(th.key, th.text, STATUS[th.state], contextOf(th)));
  const ok = review.approval;
  // Closed from the start: it says who pressed Looks right, and needs nobody to resolve it.
  if (ok && !found.has(ok.key)) await az.call('POST', base, newThread(ok.key, ok.text, 'closed'));
  return { threads: review.threads.length };
}
