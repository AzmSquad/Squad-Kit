import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.js';

/**
 * Agents stay in their lane. A rule for an agent's tools can be got around with the shell, so squad-kit also looks at
 * the ticket's copy after a step: the files later sessions load as instructions or settings go back to how they were,
 * a step that may not change the code gets all its changes put back, and the branch and its last commit must still
 * be where squad-kit left them.
 */

/** A protected file as it was: its bytes, or where a link pointed. */
type Kept = { data: Buffer } | { link: string };

export interface Lane {
  dir: string;
  head: string;
  branch: string;
  /** The protected names, as AgentRun.protectedFiles gives them. */
  names: string[];
  kept: Map<string, Kept>;
  /** Every file in the copy as a git tree, when the whole copy must stay as it was. */
  tree?: string;
}

export interface LaneCheck {
  /** Protected files put back, as paths in the copy. */
  restored: string[];
  /** Other files put back, when the whole copy was watched. */
  putBack: string[];
  /** What happened to the branch, in words, when it moved. */
  moved?: string;
}

/** The copy before a step. `wholeCopy` watches every file git sees, not just the protected ones. */
export function watchLane(dir: string, names: string[], wholeCopy = false): Lane {
  const lane: Lane = { dir, ...placeOf(dir), names, kept: readKept(dir, names) };
  if (wholeCopy) {
    const tree = treeOf(dir);
    if (tree) lane.tree = tree;
  }
  return lane;
}

/**
 * After the step: puts back what it may not change, and says whether the branch moved. Files in `skip` (the proof
 * folder) may change. On a moved branch the code is left as it is, for the person to see; protected files still go back.
 */
export function checkLane(lane: Lane, skip: string[] = []): LaneCheck {
  const out: LaneCheck = { restored: [], putBack: [] };
  const { dir } = lane;
  if (!fs.existsSync(dir)) return out;
  const { head, branch } = placeOf(dir);
  if (branch !== lane.branch) out.moved = branch ? `the copy is on ${branch}, not ${lane.branch}` : `the copy left ${lane.branch}`;
  else if (head !== lane.head) out.moved = `${branch || 'HEAD'} moved from ${head8(lane.head)} to ${head8(head)}`;
  if (lane.tree && !out.moved) out.putBack = putTreeBack(dir, lane.tree, skip);
  out.restored = putKeptBack(dir, lane.kept, readKept(dir, lane.names));
  return out;
}

/** The last commit and the branch the copy is on (empty when it is on none). */
function placeOf(dir: string): { head: string; branch: string } {
  const [head = '', name = ''] = git(dir, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { allowFail: true }).split('\n');
  return { head, branch: name === 'HEAD' ? '' : name };
}

function head8(sha: string): string {
  return sha ? sha.slice(0, 8) : 'nothing';
}

function listed(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/**
 * The protected files in the copy. At its top, ignored files count too (a local settings file usually is ignored);
 * deeper down only the files git sees, so installed packages never count.
 */
function protectedPaths(dir: string, names: string[]): string[] {
  const top = names.map((n) => n.replace(/\/$/, ''));
  const deep = names.map((n) => (n.endsWith('/') ? `:(glob)**/${n}**` : `:(glob)**/${n}`));
  const ls = (args: string[]) => listed(git(dir, ['ls-files', '-z', '--cached', '--others', ...args], { allowFail: true }));
  return [...new Set([...ls(['--', ...top]), ...ls(['--exclude-standard', '--', ...deep])])];
}

function readKept(dir: string, names: string[]): Map<string, Kept> {
  const kept = new Map<string, Kept>();
  if (!names.length) return kept;
  for (const rel of protectedPaths(dir, names)) {
    const file = path.join(dir, rel);
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) kept.set(rel, { link: fs.readlinkSync(file) });
      else if (st.isFile()) kept.set(rel, { data: fs.readFileSync(file) });
    } catch {
      // Listed by git but not on disk: it was not there.
    }
  }
  return kept;
}

function same(a: Kept | undefined, b: Kept | undefined): boolean {
  if (!a || !b) return a === b;
  if ('link' in a || 'link' in b) return 'link' in a && 'link' in b && a.link === b.link;
  return a.data.equals(b.data);
}

function putKeptBack(dir: string, before: Map<string, Kept>, after: Map<string, Kept>): string[] {
  const added = [...after.keys()].filter((rel) => !before.has(rel));
  const changed = [...before.keys()].filter((rel) => !same(before.get(rel), after.get(rel)));
  // New files go first: a new link in the way must never let a file be written somewhere else.
  for (const rel of added) removeFile(dir, rel);
  for (const rel of changed) {
    const was = before.get(rel)!;
    const file = path.join(dir, rel);
    makeParents(dir, rel);
    fs.rmSync(file, { force: true, recursive: true });
    if ('link' in was) fs.symlinkSync(was.link, file);
    else fs.writeFileSync(file, was.data);
  }
  return [...changed, ...added].sort();
}

/** The folders above a file in the copy, as real folders: a link put in their place is removed first. */
function makeParents(dir: string, rel: string): void {
  let at = dir;
  for (const part of path.dirname(rel).split(path.sep).filter((p) => p && p !== '.')) {
    at = path.join(at, part);
    try {
      if (!fs.lstatSync(at).isDirectory()) fs.rmSync(at, { force: true });
    } catch {
      // Not there yet.
    }
    fs.mkdirSync(at, { recursive: true });
  }
}

/** Removes a file the step added, and the folders it leaves empty. */
function removeFile(dir: string, rel: string): void {
  fs.rmSync(path.join(dir, rel), { force: true, recursive: true });
  for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) {
    try {
      fs.rmdirSync(path.join(dir, d));
    } catch {
      break;
    }
  }
}

/** Every file git sees in the copy (tracked, and new ones not ignored) as a tree, without touching its index. */
function treeOf(dir: string): string | undefined {
  const tmp = path.join(os.tmpdir(), `squad-index-${randomUUID()}`);
  try {
    // A copy of the real index, so only the files that changed are read again. It keeps the index's own time: git
    // reads a file again when it changed in the same moment the index was written, and a new time would hide that.
    const index = path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']));
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp);
      const st = fs.statSync(index);
      fs.utimesSync(tmp, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: tmp };
    git(dir, ['add', '-A'], { env });
    return git(dir, ['write-tree'], { env }) || undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function putTreeBack(dir: string, before: string, skip: string[]): string[] {
  const after = treeOf(dir);
  if (!after || after === before) return [];
  const rows = listed(git(dir, ['diff', '--name-status', '--no-renames', '--no-ext-diff', '-z', before, after]));
  const added: string[] = [];
  const back: string[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const rel = rows[i + 1]!;
    if (skip.some((s) => isWithin(s, path.join(dir, rel)))) continue;
    (rows[i] === 'A' ? added : back).push(rel);
  }
  for (const rel of added) removeFile(dir, rel);
  for (let i = 0; i < back.length; i += 100) {
    git(dir, ['restore', `--source=${before}`, '--worktree', '--', ...back.slice(i, i + 100)], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  }
  return [...back, ...added].sort();
}

function isWithin(folder: string, file: string): boolean {
  const r = path.relative(folder, file);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
