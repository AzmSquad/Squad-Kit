import type { HostNote } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';
import { paged } from './pulls.js';
import { signedInAs } from './sign-in.js';

/**
 * What the repo's owners wrote on a pull request squad-kit sent to their repo: notes on lines, reviews and comments.
 * Only people who can change the repo count: GitHub's own answer for each one (write, maintain or admin), asked once per
 * person per look. When GitHub does not tell the person this (no push to that repo), their role on the pull request
 * stands in. Anyone else's words, a bot's, and the signed-in person's own (squad-kit's answers among them) are left out.
 */

const WRITE = new Set(['admin', 'maintain', 'write']);
const OWNERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

interface By {
  user?: { login: string; type?: string } | null;
  author_association?: string;
}

interface RawLine extends By {
  id: number;
  in_reply_to_id?: number;
  body: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
  html_url: string;
  created_at: string;
}

interface RawReview extends By {
  id: number;
  body?: string | null;
  state: string;
  html_url: string;
  submitted_at?: string;
}

interface RawComment extends By {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
}

/** Whether a person can change the repo, asked once per look. */
function writers(repo: string): (x: By) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (x) => {
    const login = x.user!.login;
    if (!known.has(login)) {
      known.set(
        login,
        githubApi<{ permission?: string; role_name?: string }>(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`).then(
          (p) => WRITE.has(p.role_name ?? '') || WRITE.has(p.permission ?? ''),
          (err: unknown) => {
            if (err instanceof ModuleError && (err.status === 403 || err.status === 404)) return OWNERS.has(x.author_association ?? '');
            throw err;
          },
        ),
      );
    }
    return known.get(login)!;
  };
}

export async function ownerNotesOf(repo: string, n: number): Promise<HostNote[]> {
  const me = (await signedInAs()).toLowerCase();
  const canWrite = writers(repo);
  const others = (x: By) => Boolean(x.user && x.user.login.toLowerCase() !== me && x.user.type !== 'Bot');
  const theirs = async <T extends By>(xs: T[]): Promise<T[]> => {
    const ok = await Promise.all(xs.map((x) => (others(x) ? canWrite(x) : false)));
    return xs.filter((_, i) => ok[i]);
  };
  const [lines, reviews, comments] = await Promise.all([
    paged<RawLine>(`/repos/${repo}/pulls/${n}/comments`),
    paged<RawReview>(`/repos/${repo}/pulls/${n}/reviews`),
    paged<RawComment>(`/repos/${repo}/issues/${n}/comments`),
  ]);
  const out: HostNote[] = [];
  for (const c of await theirs(lines)) {
    const line = c.line ?? c.original_line ?? undefined;
    out.push({ id: `line:${c.id}`, kind: 'line', who: c.user!.login, text: c.body, file: c.path, ...(line ? { line } : {}), url: c.html_url, at: c.created_at, ...(c.in_reply_to_id ? { thread: `line:${c.in_reply_to_id}` } : {}) });
  }
  for (const r of await theirs(reviews)) {
    const changes = r.state === 'CHANGES_REQUESTED';
    const text = (r.body ?? '').trim();
    // An approval, or a review whose words are all on its lines (listed above), says nothing more here.
    if (!changes && (r.state !== 'COMMENTED' || !text)) continue;
    out.push({ id: `review:${r.id}`, kind: 'review', who: r.user!.login, text: text || 'Asked for changes.', url: r.html_url, at: r.submitted_at ?? '', ...(changes ? { changes } : {}) });
  }
  for (const c of await theirs(comments)) out.push({ id: `comment:${c.id}`, kind: 'comment', who: c.user!.login, text: c.body, url: c.html_url, at: c.created_at });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** One line of the owner's words to quote back, as plain text that pings nobody again. */
function quoteOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const one = first.replace(/[<>`*_[\]]/g, '').replace(/@(?=[\w-])/g, '@​').trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/** The answer: in its thread for a note on a line (on the thread's first note), else on the pull request, quoting it. */
export async function answerOwnerNote(repo: string, n: number, note: Pick<HostNote, 'id' | 'kind' | 'text' | 'thread'>, text: string): Promise<void> {
  if (note.kind === 'line') {
    const first = (note.thread ?? note.id).split(':')[1];
    await githubApi(`/repos/${repo}/pulls/${n}/comments/${first}/replies`, { method: 'POST', body: { body: text } });
    return;
  }
  const quote = quoteOf(note.text);
  await githubApi(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body: `${quote ? `> ${quote}\n\n` : ''}${text}` } });
}
