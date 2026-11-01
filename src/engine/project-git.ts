import fs from 'node:fs';
import path from 'node:path';
import { listDecisions, listReleases, listTickets, readMeta, splitTicket, ticketDir, type BoardPaths } from '../board/store.js';
import { decisionDoc, releaseDoc } from '../board/docs.js';
import type { Release, Ticket } from '../board/types.js';
import { commitArgsFor, git, isRepo } from './git.js';

/**
 * The project's documents in git, for a project whose `.squad/` sits inside its one repo (ADR-001). squad-kit keeps
 * `.squad/` out of `git status` with git's local ignore list, and commits a ticket's documents on its own branch at
 * big moments, so they reach the base with its code through the pull request. A workspace of several repos keeps
 * `.squad/` in no repo, and "Put project documents in git" off commits nothing.
 */

/** The repo that holds `.squad/`, or null when it sits in no repo. */
export function docsRepo(bp: BoardPaths): string | null {
  return isRepo(bp.root) ? bp.root : null;
}

export function docsInGit(bp: BoardPaths): boolean {
  return docsRepo(bp) !== null && readMeta(bp).documentsInGit !== false;
}

/** `.squad/` as a path inside the repo, with forward slashes. */
function squadInRepo(bp: BoardPaths, repo: string): string {
  return path.relative(repo, bp.squadDir).split(path.sep).join('/');
}

/** Keeps `.squad/` out of `git status`, in git's local ignore list: it is never committed and .gitignore is not changed. */
export function hideSquadFromGit(bp: BoardPaths): void {
  const repo = docsRepo(bp);
  if (!repo) return;
  const common = git(repo, ['rev-parse', '--git-common-dir'], { allowFail: true });
  if (!common) return;
  const exclude = path.join(path.resolve(repo, common), 'info', 'exclude');
  const line = `/${squadInRepo(bp, repo)}/`;
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# squad-kit: the project's documents, committed by squad-kit itself\n${line}\n`, 'utf8');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A ticket's documents as they are now, and its own files (attachments, mockup) from its folder. */
function writeTicketFolder(bp: BoardPaths, t: Ticket, to: string): void {
  for (const [name, text] of Object.entries(splitTicket(bp, t).docs)) write(path.join(to, name), text);
  const own = ticketDir(bp, t.id);
  if (!fs.existsSync(own)) return;
  for (const entry of fs.readdirSync(own, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.cpSync(path.join(own, entry.name), path.join(to, entry.name), { recursive: true });
    else if (!entry.name.endsWith('.md')) fs.copyFileSync(path.join(own, entry.name), path.join(to, entry.name));
  }
}

/**
 * Writes a ticket's documents as they are now (and the decisions it made) into its own copy and stages them, so the
 * next commit there carries them. Returns the staged paths, or nothing when documents do not go into git.
 */
export function stageTicketDocs(bp: BoardPaths, t: Ticket): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp) || !t.worktree || !fs.existsSync(t.worktree)) return [];
  // The same files sit untracked in the person's checkout; ignored, git replaces them when the branch comes in.
  hideSquadFromGit(bp);
  const squad = squadInRepo(bp, repo);
  const folder = path.posix.join(squad, 'tickets', t.id);
  fs.rmSync(path.join(t.worktree, folder), { recursive: true, force: true });
  writeTicketFolder(bp, t, path.join(t.worktree, folder));
  const paths = [folder];
  for (const d of listDecisions(bp).filter((x) => x.from === t.id)) {
    const file = path.posix.join(squad, 'decisions', `${d.id}.md`);
    write(path.join(t.worktree, file), decisionDoc(d));
    paths.push(file);
  }
  git(t.worktree, ['add', '-f', '--', ...paths]);
  return paths;
}

/** Commits a ticket's documents on its branch, at a big moment such as "spec and design approved". */
export function commitTicketDocs(bp: BoardPaths, t: Ticket, moment: string): string | null {
  const paths = stageTicketDocs(bp, t);
  if (!paths.length || !git(t.worktree!, ['diff', '--cached', '--name-only', '--', ...paths], { allowFail: true })) return null;
  git(t.worktree!, [...commitArgsFor(t.worktree!), 'commit', '-m', `${t.id}: ${moment}`, '--', ...paths]);
  return git(t.worktree!, ['rev-parse', '--short', 'HEAD']);
}

/**
 * The release commit carries the project's shared files: every release (this one as it went out), the released
 * tickets' folders, the decisions they made and the ones found in the code, the rules, the knowledge and the
 * settings. What changed in them since the last release comes along too. Tickets still in progress come later,
 * with their own pull requests.
 */
export function stageReleaseDocs(bp: BoardPaths, dir: string, release: Release, tickets: Ticket[]): void {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp)) return;
  hideSquadFromGit(bp);
  const squad = squadInRepo(bp, repo);
  const into = (rel: string) => path.join(dir, squad, rel);
  for (const r of listReleases(bp).filter((x) => x.status === 'released')) write(into(path.posix.join('releases', `${r.version}.md`)), releaseDoc(r));
  write(into(path.posix.join('releases', `${release.version}.md`)), releaseDoc({ ...release, status: 'released' }));
  const going = tickets.map((t) => ({ ...t, stage: 'done' as const, release: release.version }));
  const released = [...going, ...listTickets(bp).filter((t) => t.stage === 'done' && !going.some((g) => g.id === t.id))];
  const ids = new Set(released.map((t) => t.id));
  for (const t of released) writeTicketFolder(bp, t, into(path.posix.join('tickets', t.id)));
  for (const d of listDecisions(bp)) {
    if (ids.has(d.from) || d.id.startsWith('STACK.') || fs.existsSync(into(path.posix.join('decisions', `${d.id}.md`)))) write(into(path.posix.join('decisions', `${d.id}.md`)), decisionDoc(d));
  }
  for (const sub of ['rules', 'knowledge']) {
    const from = path.join(bp.squadDir, sub);
    if (fs.existsSync(from)) fs.cpSync(from, into(sub), { recursive: true });
  }
  if (fs.existsSync(bp.configFile)) fs.copyFileSync(bp.configFile, into('config.yaml'));
  git(dir, ['add', '-f', '--', squad]);
}
