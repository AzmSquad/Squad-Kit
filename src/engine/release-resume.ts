import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import type { UnpushedRelease } from '../board/types.js';
import { repoHostFor } from '../modules/registry.js';
import { git, isAncestor, netGit, removeWorktree } from './git.js';
import { moveLocalBase, type ReleaseLog } from './release.js';

/**
 * A release cut off half-way (the app closed or the computer restarted while it went out) never stays half-done. As
 * it goes, the release writes down what it did, repo by repo, in a file on this computer. On the next start, or the
 * next press of Release, that file says where it stopped: a repo whose base reached its remote is finished (the tag is
 * pushed and the local base moved), and a repo that did not is rolled back (its local tag and release branch go), so
 * the release can simply go out again.
 */

export interface RepoJournal {
  /** The repo's folder in the project, '.' for the project itself. */
  repo: string;
  base: string;
  remote?: string;
  /** The release's own copy and branch. */
  dir?: string;
  branch?: string;
  /** The release commit, which the tag points at. */
  commit?: string;
  tag?: string;
  /** What goes to the base: the release commit, or the commit after it that brings back work left out. */
  head?: string;
  pushed?: boolean;
  moved?: boolean;
}

export interface ReleaseJournal {
  version: string;
  pid: number;
  at: string;
  /** The tickets the release sends. */
  tickets: string[];
  /** Pull requests the code host merged for the release: their tickets are in the base now, whatever happens next. */
  prMerged?: string[];
  repos: RepoJournal[];
}

function journalFile(bp: BoardPaths): string {
  return path.join(bp.localDir, 'release-going.json');
}

export function readJournal(bp: BoardPaths): ReleaseJournal | null {
  try {
    const j = JSON.parse(fs.readFileSync(journalFile(bp), 'utf8')) as ReleaseJournal;
    return j?.version ? j : null;
  } catch {
    return null;
  }
}

function writeJournal(bp: BoardPaths, j: ReleaseJournal): void {
  fs.mkdirSync(bp.localDir, { recursive: true });
  const tmp = `${journalFile(bp)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  fs.renameSync(tmp, journalFile(bp));
}

export function startJournal(bp: BoardPaths, version: string, tickets: string[]): void {
  writeJournal(bp, { version, pid: process.pid, at: new Date().toISOString(), tickets, repos: [] });
}

/** Writes down one step of one repo. Nothing happens without a journal (a release started before this kept none). */
export function noteRepo(bp: BoardPaths, repo: string, patch: Partial<RepoJournal> & { base: string }): void {
  const j = readJournal(bp);
  if (!j) return;
  const at = j.repos.findIndex((r) => r.repo === repo);
  if (at < 0) j.repos.push({ repo, ...patch });
  else j.repos[at] = { ...j.repos[at]!, ...patch };
  writeJournal(bp, j);
}

export function notePrMerged(bp: BoardPaths, id: string): void {
  const j = readJournal(bp);
  if (!j) return;
  j.prMerged = [...new Set([...(j.prMerged ?? []), id])];
  writeJournal(bp, j);
}

export function clearJournal(bp: BoardPaths): void {
  fs.rmSync(journalFile(bp), { force: true });
}

/** True when the process that wrote the journal still runs: its release is still going out. */
export function journalAlive(j: ReleaseJournal): boolean {
  if (j.pid === process.pid) return false;
  try {
    process.kill(j.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SettledRepo {
  repo: string;
  /** Its base reached the remote (or, with no remote, the release commit was made): the release is out there. */
  reached: boolean;
  unpushed?: UnpushedRelease;
  log: ReleaseLog;
}

/** Finishes or rolls back each repo of a cut-off release, by what really happened in git. */
export function settleRepos(bp: BoardPaths, j: ReleaseJournal): SettledRepo[] {
  return j.repos.map((r) => {
    const root = path.join(bp.root, r.repo);
    const log: ReleaseLog = [];
    let reached = false;
    let unpushed: UnpushedRelease | undefined;
    const url = r.remote ? git(root, ['config', '--get', `remote.${r.remote}.url`], { allowFail: true }) : '';
    const env = url ? (repoHostFor(bp, url)?.gitEnv() ?? {}) : {};
    if (r.head && r.remote) {
      netGit(root, ['fetch', r.remote, r.base], { env, allowFail: true });
      const there = git(root, ['rev-parse', '--verify', '-q', `refs/remotes/${r.remote}/${r.base}`], { allowFail: true });
      reached = Boolean(r.pushed) || Boolean(there && isAncestor(root, r.head, there));
    } else if (r.head) reached = true;
    if (reached) {
      if (r.tag && r.remote) {
        try {
          netGit(root, ['push', r.remote, `refs/tags/${r.tag}`], { env });
        } catch (err) {
          unpushed = { repo: r.repo, remote: r.remote, base: r.base, commit: r.head!, tag: r.tag, error: (err as Error).message, plain: "The release reached your team's shared copy of the code, but its version mark did not. Press Send again." };
        }
      }
      const keep = path.relative(root, bp.squadDir);
      moveLocalBase(root, r.base, r.head!, j.version, keep && !keep.startsWith('..') ? keep : undefined, log);
      log.unshift({ ok: true, text: r.remote ? `It had reached your team's shared copy of the code already, so squad-kit finished it${unpushed ? ', except its version mark: press Send again' : ''}` : 'Its release commit was made already, so squad-kit finished it' });
    } else {
      // Nothing reached the remote: the tag made here goes, so the release can go out again as if it never started.
      const tagged = r.tag ? git(root, ['rev-parse', '--verify', '-q', `refs/tags/${r.tag}^{commit}`], { allowFail: true }) : '';
      if (r.tag && tagged && tagged === r.commit) git(root, ['tag', '-d', r.tag], { allowFail: true });
      log.push({ ok: true, text: `Nothing had reached ${r.remote ?? 'the remote'} yet, so squad-kit undid it: ${r.base} and the tags are as they were` });
    }
    if (r.dir) {
      removeWorktree(root, r.dir);
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
    git(root, ['worktree', 'prune'], { allowFail: true });
    // Rolled back, or finished with the local base moved: the release branch goes. One the log says to merge stays.
    if (r.branch && (!reached || isAncestor(root, r.head!, r.base))) git(root, ['branch', '-D', r.branch], { allowFail: true });
    return { repo: r.repo, reached, ...(unpushed ? { unpushed } : {}), log };
  });
}
