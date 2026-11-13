import type { HostNote } from '../code-host/types.js';
import { githubApi } from './auth.js';
import { paged } from './pulls.js';
import { signedInAs } from './sign-in.js';

/**
 * What the repo's owners wrote on a pull request squad-kit sent to their repo: notes on lines, reviews and comments.
 * Only people who can change the repo count (its owner, members and collaborators): anyone else's words, a bot's, and
 * the signed-in person's own (squad-kit's answers among them) are left out.
 */

const OWNERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

interface By {
  user?: { login: string; type?: string } | null;
  author_association?: string;
}

interface RawLine extends By {
  id: number;
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

export async function ownerNotesOf(repo: string, n: number): Promise<HostNote[]> {
  const me = (await signedInAs()).toLowerCase();
  const theirs = (x: By) => Boolean(x.user && x.user.login.toLowerCase() !== me && x.user.type !== 'Bot' && OWNERS.has(x.author_association ?? ''));
  const [lines, reviews, comments] = await Promise.all([
    paged<RawLine>(`/repos/${repo}/pulls/${n}/comments`),
    paged<RawReview>(`/repos/${repo}/pulls/${n}/reviews`),
    paged<RawComment>(`/repos/${repo}/issues/${n}/comments`),
  ]);
  const out: HostNote[] = [];
  for (const c of lines.filter(theirs)) {
    const line = c.line ?? c.original_line ?? undefined;
    out.push({ id: `line:${c.id}`, kind: 'line', who: c.user!.login, text: c.body, file: c.path, ...(line ? { line } : {}), url: c.html_url, at: c.created_at });
  }
  for (const r of reviews.filter(theirs)) {
    const changes = r.state === 'CHANGES_REQUESTED';
    const text = (r.body ?? '').trim();
    // An approval, or a review whose words are all on its lines (listed above), says nothing more here.
    if (!changes && (r.state !== 'COMMENTED' || !text)) continue;
    out.push({ id: `review:${r.id}`, kind: 'review', who: r.user!.login, text: text || 'Asked for changes.', url: r.html_url, at: r.submitted_at ?? '', ...(changes ? { changes } : {}) });
  }
  for (const c of comments.filter(theirs)) out.push({ id: `comment:${c.id}`, kind: 'comment', who: c.user!.login, text: c.body, url: c.html_url, at: c.created_at });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** One line of the owner's words to quote back, as plain text. */
function quoteOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const one = first.replace(/[<>`*_[\]]/g, '').trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/** The answer: in the note's own thread for a note on a line, else on the pull request, quoting what it answers. */
export async function answerOwnerNote(repo: string, n: number, note: Pick<HostNote, 'id' | 'kind' | 'text'>, text: string): Promise<void> {
  const id = note.id.split(':')[1];
  if (note.kind === 'line') {
    await githubApi(`/repos/${repo}/pulls/${n}/comments/${id}/replies`, { method: 'POST', body: { body: text } });
    return;
  }
  const quote = quoteOf(note.text);
  await githubApi(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body: `${quote ? `> ${quote}\n\n` : ''}${text}` } });
}
