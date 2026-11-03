import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { addActivity, listTickets, now, readMeta, updateTicket, type BoardPaths } from '../board/store.js';
import { isMine, ownerOf } from '../board/owner.js';
import type { OwnerDeleted, Ticket } from '../board/types.js';
import { commitArgsFor, git, isAncestor, isRepo } from './git.js';
import { docsInGit, docsRepo, squadInRepo } from './project-git.js';

/**
 * A ticket its owner deleted on their computer, seen from a teammate's (ADR-001: you see a teammate's work when they
 * push). Only the owner may delete a ticket. Their delete shows on the remote in one of two ways: the note it leaves
 * on the ticket's branch when the branch stays there, or the branch gone while the ticket never reached the base. The
 * teammate's board then shows "Deleted by <owner>", and Remove from my board cleans that computer only.
 */

/** The note the owner's delete leaves in the ticket's folder on its pushed branch, in place of the ticket's files. */
export const DELETED_NOTE = 'deleted.md';

function branchOf(t: Pick<Ticket, 'id' | 'branch'>): string {
  return t.branch ?? `squad/${t.id.toLowerCase()}`;
}

/** Merged or released: its files are in the base, so it was never deleted, whatever happened to its branch. */
function merged(t: Ticket): boolean {
  return Boolean(t.mergedAt) || t.stage === 'done' || t.stage === 'release';
}

function noteText(t: Pick<Ticket, 'id' | 'title'>, by: string, at: string): string {
  return `${yaml.dump({ deleted: { id: t.id, by, at } }, { lineWidth: 200 }).replace(/^/, '---\n')}---\n\n${by} deleted ${t.id} "${t.title}" on their computer. squad-kit left this note so the team's boards show it as deleted. The code on this branch is kept as it was.\n`;
}

/** The owner's note on a branch, or null. */
function readNote(repo: string, ref: string, file: string): { by: string; at: string } | null {
  const text = git(repo, ['cat-file', 'blob', `${ref}:${file}`], { allowFail: true });
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!head) return null;
  try {
    const d = (yaml.load(head) as { deleted?: { by?: unknown; at?: unknown } } | null)?.deleted;
    return typeof d?.by === 'string' && d.by.trim() ? { by: d.by.trim(), at: typeof d.at === 'string' ? d.at : now() } : null;
  } catch {
    return null;
  }
}

/**
 * The commit that tells the team: the remote branch as it is, with the ticket's folder replaced by the note. Built
 * on the remote's tip, never on this computer's branch, so it carries nothing that was not pushed already. Made with
 * a separate index, so neither the person's checkout nor the ticket's copy is touched. Null when the branch has no
 * ticket folder, or carries the note already.
 */
export function deleteNoteCommit(repo: string, tip: string, squad: string, t: Pick<Ticket, 'id' | 'title'>, by: string, at: string): string | null {
  const folder = `${squad}/tickets/${t.id}`;
  if (!git(repo, ['ls-tree', '--name-only', tip, '--', `${folder}/`], { allowFail: true })) return null;
  if (readNote(repo, tip, `${folder}/${DELETED_NOTE}`)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-note-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    const file = path.join(tmp, DELETED_NOTE);
    fs.writeFileSync(file, noteText(t, by, at), 'utf8');
    git(repo, ['read-tree', tip], { env });
    git(repo, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', folder], { env });
    const blob = git(repo, ['hash-object', '-w', file]);
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${folder}/${DELETED_NOTE}`], { env });
    const tree = git(repo, ['write-tree'], { env });
    return git(repo, [...commitArgsFor(repo), 'commit-tree', tree, '-p', tip, '-m', `${t.id}: deleted by ${by}`], { env });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The ticket branches the remotes have, as last fetched: branch name → its remote refs. */
function remoteBranches(repo: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ref of git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/squad/*'], { allowFail: true }).split('\n').filter(Boolean)) {
    const branch = ref.replace(/^refs\/remotes\/[^/]+\//, '');
    out.set(branch, [...(out.get(branch) ?? []), ref]);
  }
  return out;
}

function hasFile(repo: string, ref: string, file: string): boolean {
  return Boolean(git(repo, ['rev-parse', '--verify', '-q', `${ref}:${file}`], { allowFail: true }));
}

/**
 * Looks at every ticket that is someone else's: a note from its owner's delete on its branch, or (only right after a
 * fetch that worked, and only for a ticket this board saw on the remote) its branch gone while no base has it, marks
 * it "Deleted by <owner>". A ticket whose branch comes back is theirs again. Never changes a file of the project;
 * returns the tickets it marked.
 */
export function spotOwnerDeletes(bp: BoardPaths, opts: { fetched: boolean }): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp)) return [];
  const meta = readMeta(bp);
  const squad = squadInRepo(bp, repo);
  const base = meta.git?.base || 'main';
  const bases = [`refs/heads/${base}`, ...git(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${base}`], { allowFail: true }).split('\n').filter(Boolean)];
  const pushed = remoteBranches(repo);
  const marked: string[] = [];
  for (const t of listTickets(bp)) {
    if (isMine(t, meta) || t.archived || t.deleting || merged(t)) continue;
    const branch = branchOf(t);
    const folder = `${squad}/tickets/${t.id}`;
    const refs = pushed.get(branch) ?? [];
    const note = refs.map((r) => readNote(repo, r, `${folder}/${DELETED_NOTE}`)).find(Boolean) ?? null;
    let found: OwnerDeleted | null = null;
    if (note) {
      found = { by: note.by, at: note.at, how: 'note', branch };
    } else if (refs.some((r) => hasFile(repo, r, `${folder}/ticket.md`)) || bases.some((b) => hasFile(repo, b, `${folder}/ticket.md`))) {
      // On the remote as a ticket: it was seen there, and a branch that came back makes it theirs again.
      const seen = refs[0]?.replace(/^refs\/remotes\//, '') ?? base;
      if (t.seenOn !== seen || t.ownerDeleted?.how === 'gone') {
        updateTicket(bp, t.id, (x) => {
          x.seenOn = seen;
          if (x.ownerDeleted?.how === 'gone') {
            delete x.ownerDeleted;
            x.status = `With ${ownerOf(x)}`;
            addActivity(x, 'squad', `${branch} is back on the remote, so ${ownerOf(x)} still has it`);
          }
        });
      }
      continue;
    } else if (opts.fetched && t.seenOn && !refs.length) {
      found = { by: ownerOf(t), at: now(), how: 'gone', branch };
    }
    if (!found || (t.ownerDeleted && t.ownerDeleted.how === found.how && t.ownerDeleted.by === found.by)) continue;
    const mark = found;
    updateTicket(bp, t.id, (x) => {
      x.ownerDeleted = mark;
      x.status = `Deleted by ${mark.by}`;
      x.waiting = null;
      x.live = false;
      x.squad = null;
      addActivity(
        x,
        'squad',
        mark.how === 'note'
          ? `${mark.by} deleted it on their computer. Remove it from your board when you like: that cleans this computer only`
          : `${branch} is gone from the remote and ${x.id} never reached ${base}, so ${mark.by} deleted it. Remove it from your board when you like: that cleans this computer only`,
      );
    });
    marked.push(t.id);
  }
  return marked;
}

/** What Remove from my board does with this computer's copy and branch of someone else's ticket. */
export interface LocalCopy {
  /** The ticket's copy of the code, when it can go: nothing in it is uncommitted. */
  copy?: string;
  /** Its branch here, when it can go: every commit on it is on a remote or in the base. */
  branch?: string;
  /** What stays, and why, in plain words. */
  kept: string[];
}

/**
 * Never someone's unpushed work: the copy goes only with nothing uncommitted in it, and the branch only when each of
 * its commits is on a remote or in the base. Anything else stays, with the command to remove it by hand.
 */
export function localCopy(dir: string, t: Ticket, base: string, copyDir: string): LocalCopy {
  const out: LocalCopy = { kept: [] };
  if (!isRepo(dir)) return out;
  const branch = branchOf(t);
  const hasCopy = fs.existsSync(copyDir);
  const dirty = hasCopy && Boolean(git(copyDir, ['status', '--porcelain'], { allowFail: true }));
  if (hasCopy && !dirty) out.copy = copyDir;
  if (dirty) out.kept.push(`Its copy of the code at ${copyDir}, because it has changes that are not committed`);
  const tip = git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true });
  if (!tip) return out;
  const safe = Boolean(git(dir, ['for-each-ref', '--count=1', '--contains', tip, '--format=%(refname)', 'refs/remotes/'], { allowFail: true })) || isAncestor(dir, tip, base);
  if (safe && !dirty) out.branch = branch;
  else if (!dirty) out.kept.push(`The branch ${branch} on this computer, because it has commits that are on no remote. If you no longer need them: git branch -D ${branch}`);
  return out;
}
