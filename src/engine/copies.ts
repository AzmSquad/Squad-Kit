import path from 'node:path';
import { partsOf, repoLabel } from '../board/parts.js';
import type { BoardMeta, RepoInfo, Ticket } from '../board/types.js';
import { worktreeRoot } from './git.js';
import { repoFor, reposOf } from './repos.js';

/**
 * A story's copies of the code. On a project with one repo, `Ticket.worktree` is the only copy and the folder agents work
 * in. On a workspace of several repos, a story gets a folder of its own, with one copy for each repo it changes, side by
 * side under the repo's own name: `Ticket.worktree` is the first of them, and `Ticket.copies` holds the others.
 */

export interface CopyOf {
  repo: RepoInfo;
  dir: string;
  baseCommit?: string;
  /** What a person calls it: the part's name, or the repo's folder before the Architect named the parts. */
  label: string;
}

/** Every copy the story has now, the first one first. None before the story has any. */
export function copiesOf(meta: BoardMeta, t: Ticket): CopyOf[] {
  if (!t.worktree) return [];
  const first = repoFor(meta, t);
  const named = (repo: RepoInfo, dir: string, baseCommit?: string): CopyOf => ({ repo, dir, ...(baseCommit ? { baseCommit } : {}), label: repoLabel(meta, repo.path) ?? repo.path });
  return [
    named(first, t.worktree, t.baseCommit),
    ...(t.copies ?? []).map((c) => named(reposOf(meta).find((r) => r.path === c.repo) ?? { path: c.repo, base: first.base, remote: '', commands: {} }, c.dir, c.baseCommit)),
  ];
}

/** The folder agents work in: the story's folder on a workspace, else its one copy. */
export function workFolder(t: Pick<Ticket, 'storyDir' | 'worktree'>): string | undefined {
  return t.storyDir ?? t.worktree;
}

/** Where a story's copy of a repo goes on a workspace. It keeps the repo's name, so what a repo's own files name still works. */
export function storyCopyDir(root: string, id: string, repo: string): string {
  return path.join(worktreeRoot(root), id.toLowerCase(), repo);
}

/** The repos a story's parts are in, in the order the Architect gave them. */
export function reposOfParts(meta: BoardMeta, parts: string[] | undefined): string[] {
  const known = partsOf(meta);
  const repos = (parts ?? []).map((id) => known.find((p) => p.id === id && !p.shared && !p.off)?.repo).filter((r): r is string => Boolean(r));
  return [...new Set(repos)].filter((r) => reposOf(meta).some((x) => x.path === r));
}

/** The first copy that can start an app, for the steps that open one. Running every part together comes with the product run. */
export function appCopyOf(meta: BoardMeta, t: Ticket): CopyOf | undefined {
  const copies = copiesOf(meta, t);
  return copies.find((c) => c.repo.commands.start?.trim() && c.repo.commands.url?.trim()) ?? copies[0];
}
