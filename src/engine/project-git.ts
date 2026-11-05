import fs from 'node:fs';
import path from 'node:path';
import { listDecisions, listReleases, listTickets, readMeta, splitTicket, ticketDir, type BoardPaths } from '../board/store.js';
import { decisionDoc, releaseDoc } from '../board/docs.js';
import type { Release, Ticket } from '../board/types.js';
import { commitArgsFor, git, isRepo, latestBase, remotes } from './git.js';
import { repoFor } from './repos.js';
import { BREAKDOWN_ID, breakdownDir } from '../board/requirements-paths.js';

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
export function squadInRepo(bp: BoardPaths, repo: string): string {
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

/** The newest base the branch meets: the remote's copy as last fetched (the team's merges) with work accepted here. */
function newestBase(bp: BoardPaths, t: Ticket, base: string): string {
  try {
    return latestBase(t.worktree!, base, repoFor(readMeta(bp), t).remote || remotes(t.worktree!)[0]).sha;
  } catch {
    return base;
  }
}

interface BreakdownCopy {
  folder: string;
  way: 'now' | 'base';
  /** The newest base, which 'base' takes the folder from. */
  from: string;
}

/**
 * A story's branch carries its breakdown's folder (`.squad/requirements/BR-1/`, the document and its parts), so the
 * breakdown is in git once its first story merges. Stories build side by side, so a branch never brings a copy that
 * could clash with another story's: it brings the folder as it is now while the newest base has none yet, or still
 * has the copy the branch started from ('now'). Otherwise it keeps the newest base's copy ('base'), and a later story
 * or the release brings the newer one. The newest base is the remote's when the team moved it on, so a story merged
 * from another computer counts too.
 */
function breakdownCopy(bp: BoardPaths, t: Ticket, squad: string, base: string): BreakdownCopy | null {
  if (!t.breakdown || !t.worktree || !BREAKDOWN_ID.test(t.breakdown.id)) return null;
  const folder = path.posix.join(squad, 'requirements', t.breakdown.id);
  const tree = (ref: string) => git(t.worktree!, ['rev-parse', '-q', '--verify', `${ref}:${folder}`], { allowFail: true });
  const from = newestBase(bp, t, base);
  const atBase = tree(from);
  if (!atBase) return { folder, way: 'now', from };
  const fork = git(t.worktree, ['merge-base', from, 'HEAD'], { allowFail: true });
  return { folder, way: fork && tree(fork) === atBase ? 'now' : 'base', from };
}

/** The breakdown's folder in the ticket's copy, as it is now or as the newest base has it, staged. */
function writeBreakdownCopy(bp: BoardPaths, t: Ticket, copy: BreakdownCopy): void {
  const to = path.join(t.worktree!, copy.folder);
  fs.rmSync(to, { recursive: true, force: true });
  git(t.worktree!, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', copy.folder], { allowFail: true });
  if (copy.way === 'base') git(t.worktree!, ['checkout', copy.from, '--', copy.folder]);
  else if (fs.existsSync(breakdownDir(bp, t.breakdown!.id))) fs.cpSync(breakdownDir(bp, t.breakdown!.id), to, { recursive: true });
}

/**
 * Writes a ticket's documents as they are now (and the decisions it made, and a story's breakdown) into its own copy
 * and stages them, so the next commit there carries them. Returns the staged paths, or nothing when documents do not
 * go into git.
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
  const base = repoFor(readMeta(bp), t).base;
  const copy = breakdownCopy(bp, t, squad, base);
  if (copy) {
    writeBreakdownCopy(bp, t, copy);
    if (fs.existsSync(path.join(t.worktree, copy.folder))) paths.push(copy.folder);
  }
  git(t.worktree, ['add', '-f', '--', ...paths]);
  return paths;
}

/**
 * A hand over in a project that has not released yet: its base has no settings, rules or knowledge in git, so a
 * fresh clone would know nothing of the board. The ticket's branch carries them, with the decisions the ticket
 * follows, and stages them. Once the base has them (after the first release), a clone gets them from there.
 */
export function stageProjectFiles(bp: BoardPaths, t: Ticket, baseRef: string): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp) || !t.worktree || !fs.existsSync(t.worktree)) return [];
  const squad = squadInRepo(bp, repo);
  if (git(t.worktree, ['ls-tree', '--name-only', baseRef, '--', `${squad}/config.yaml`], { allowFail: true })) return [];
  const into = (rel: string) => path.join(t.worktree!, squad, rel);
  const paths: string[] = [];
  if (fs.existsSync(bp.configFile)) {
    write(into('config.yaml'), fs.readFileSync(bp.configFile, 'utf8'));
    paths.push(`${squad}/config.yaml`);
  }
  for (const sub of ['rules', 'knowledge']) {
    const from = path.join(bp.squadDir, sub);
    if (!fs.existsSync(from)) continue;
    // The tracker's wiki is copied again from the tracker on each computer.
    fs.cpSync(from, into(sub), { recursive: true, filter: (f) => path.relative(bp.wikiDir, f).startsWith('..') });
    paths.push(`${squad}/${sub}`);
  }
  for (const d of listDecisions(bp).filter((x) => t.follows?.includes(x.id) && x.from !== t.id)) {
    write(into(path.posix.join('decisions', `${d.id}.md`)), decisionDoc(d));
    paths.push(`${squad}/decisions/${d.id}.md`);
  }
  if (paths.length) git(t.worktree, ['add', '-f', '--', ...paths]);
  return paths;
}

/**
 * Before the ticket's branch meets the base (accepted, or the base brought in), the project files a hand over
 * carried leave it again. They reach the base with the release, as always, so they never clash with it. The
 * ticket's own folder and its own decisions stay.
 */
export function leaveProjectFiles(bp: BoardPaths, t: Ticket, base: string): string[] {
  const repo = docsRepo(bp);
  if (!repo || !t.worktree || !fs.existsSync(t.worktree)) return [];
  const squad = squadInRepo(bp, repo);
  const fork = git(t.worktree, ['merge-base', base, 'HEAD'], { allowFail: true });
  if (!fork) return [];
  const own = new Set(listDecisions(bp).filter((d) => d.from === t.id).map((d) => `${squad}/decisions/${d.id}.md`));
  // A story's breakdown stays too, as the base has it when the base has a newer copy, so the two never clash on it.
  const copy = breakdownCopy(bp, t, squad, base);
  const carried = git(t.worktree, ['diff', '--name-only', '--diff-filter=A', fork, 'HEAD', '--', squad], { allowFail: true })
    .split('\n')
    .filter((f) => f && !f.startsWith(`${squad}/tickets/${t.id}/`) && !own.has(f) && !(copy && f.startsWith(`${copy.folder}/`)));
  if (carried.length) git(t.worktree, ['rm', '-q', '-f', '--', ...carried]);
  if (copy?.way === 'base' && git(t.worktree, ['rev-parse', '-q', '--verify', `HEAD:${copy.folder}`], { allowFail: true })) writeBreakdownCopy(bp, t, copy);
  return carried;
}

/** Commits a ticket's documents on its branch, at a big moment such as "spec and design approved". */
export function commitTicketDocs(bp: BoardPaths, t: Ticket, moment: string): string | null {
  const paths = stageTicketDocs(bp, t);
  if (!paths.length || !git(t.worktree!, ['diff', '--cached', '--name-only', '--', ...paths], { allowFail: true })) return null;
  // squad-kit's own bookkeeping: the project's commit hooks (tests, linters) are for code, and could wait forever.
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
  // The breakdowns of the released stories, as they are now.
  for (const id of new Set(released.map((t) => t.breakdown?.id).filter((x): x is string => Boolean(x) && BREAKDOWN_ID.test(x!)))) {
    const from = breakdownDir(bp, id);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(into(path.posix.join('requirements', id)), { recursive: true, force: true });
    fs.cpSync(from, into(path.posix.join('requirements', id)), { recursive: true });
  }
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
