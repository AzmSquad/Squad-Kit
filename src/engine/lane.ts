import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, gitLater, stageAllLater } from './git.js';
import { HOOK_PACKAGE_KEYS } from './hook-files.js';

/**
 * Agents stay in their lane. A rule for an agent's tools can be got around with the shell, so squad-kit also looks at
 * the ticket's copy after a step: the files later sessions load as instructions or settings go back to how they were,
 * a step that may not change the code gets all its changes put back, and the branch and its last commit must still
 * be where squad-kit left them.
 */

/** A protected file as it was: its bytes and whether it can run (a hook that cannot is skipped without a word), or where a link pointed. */
type Kept = { data: Buffer; mode: number } | { link: string };

export interface Lane {
  dir: string;
  head: string;
  branch: string;
  /** The protected names, as AgentRun.protectedFiles gives them. */
  names: string[];
  kept: Map<string, Kept>;
  /** The hook settings in the copy's package.json, as they were. */
  hookSettings?: string;
  /** Every file in the copy as a git tree, when the whole copy must stay as it was. */
  tree?: string;
  /** The copy's `.git` file as it was: it says where git's folder and settings are. */
  gitLink?: Buffer;
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
export async function watchLane(dir: string, names: string[], wholeCopy = false): Promise<Lane> {
  const settings = hookSettings(dir);
  const link = gitLinkOf(dir);
  const lane: Lane = { dir, ...placeOf(dir), names, kept: await readKept(dir, names), ...(settings ? { hookSettings: settings } : {}), ...(link ? { gitLink: link } : {}) };
  if (wholeCopy) {
    const tree = await treeOf(dir);
    if (tree) lane.tree = tree;
  }
  return lane;
}

/**
 * After the step: puts back what it may not change, and says whether the branch moved. Files in `skip` (the proof
 * folder) may change. On a moved branch the code is left as it is, for the person to see; protected files still go back.
 */
export async function checkLane(lane: Lane, skip: string[] = []): Promise<LaneCheck> {
  const out: LaneCheck = { restored: [], putBack: [] };
  const { dir } = lane;
  if (!fs.existsSync(dir)) return out;
  // First of all: every git below would believe it.
  const relinked = putGitLinkBack(lane);
  const { head, branch } = placeOf(dir);
  if (relinked) out.moved = "the copy's link to its git folder was changed";
  else if (branch !== lane.branch) out.moved = branch ? `the copy is on ${branch}, not ${lane.branch}` : `the copy left ${lane.branch}`;
  else if (head !== lane.head) out.moved = `${branch || 'HEAD'} moved from ${head8(lane.head)} to ${head8(head)}`;
  if (lane.tree && !out.moved) out.putBack = await putTreeBack(dir, lane.tree, skip);
  out.restored = [...putKeptBack(dir, lane.kept, await readKept(dir, lane.names)), ...putSettingsBack(dir, lane.hookSettings)];
  return out;
}

/** The `.git` file of a copy, which a command must not change. A person's own checkout has a folder there instead. */
function gitLinkOf(dir: string): Buffer | undefined {
  try {
    const file = path.join(dir, '.git');
    return fs.lstatSync(file).isFile() ? fs.readFileSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/** Puts the `.git` file back when a step changed it. True when it had to. */
function putGitLinkBack(lane: Lane): boolean {
  if (!lane.gitLink || gitLinkOf(lane.dir)?.equals(lane.gitLink)) return false;
  const file = path.join(lane.dir, '.git');
  fs.rmSync(file, { force: true, recursive: true });
  fs.writeFileSync(file, lane.gitLink);
  return true;
}

function readPackage(dir: string): Record<string, unknown> | null {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as unknown;
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The hook settings of the copy's package.json, in one string to compare. Undefined when it has none. */
function hookSettings(dir: string): string | undefined {
  const pkg = readPackage(dir);
  const kept = Object.fromEntries(HOOK_PACKAGE_KEYS.filter((k) => pkg?.[k] !== undefined).map((k) => [k, pkg![k]]));
  return Object.keys(kept).length ? JSON.stringify(kept) : undefined;
}

/** Only the hook settings go back: the rest of package.json is the step's work. The ones it changed, by name. */
function putSettingsBack(dir: string, before: string | undefined): string[] {
  const after = hookSettings(dir);
  if (after === before) return [];
  const pkg = readPackage(dir);
  if (!pkg) return [];
  const was = (before ? JSON.parse(before) : {}) as Record<string, unknown>;
  const now = (after ? JSON.parse(after) : {}) as Record<string, unknown>;
  const changed = HOOK_PACKAGE_KEYS.filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
  for (const k of changed) {
    if (was[k] === undefined) delete pkg[k];
    else pkg[k] = was[k];
  }
  const file = path.join(dir, 'package.json');
  const indent = /^\{\r?\n([ \t]+)/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '  ';
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
  return changed.map((k) => `package.json (${k})`);
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
 * What a hook manager's install makes in an ignored folder of its own. It comes new from the person's checkout before
 * every commit (bringHookRunner), so there is nothing to watch: an `npm install` that makes it changes no check.
 */
const HOOK_RUNNER = /(?:^|\/)\.husky\/_\//;

/**
 * The protected files in the copy. At its top, ignored files count too (a local settings file usually is ignored);
 * deeper down only the files git sees, so installed packages never count. A name that starts with "/" is only at the top.
 */
async function protectedPaths(dir: string, names: string[]): Promise<string[]> {
  const top = names.map((n) => n.replace(/^\//, '').replace(/\/$/, ''));
  const deep = names.filter((n) => !n.startsWith('/')).map((n) => (n.endsWith('/') ? `:(glob)**/${n}**` : `:(glob)**/${n}`));
  const ls = async (args: string[]) => listed(await gitLater(dir, ['ls-files', '-z', '--cached', '--others', ...args], { allowFail: true }));
  return [...new Set([...(await ls(['--', ...top])), ...(deep.length ? await ls(['--exclude-standard', '--', ...deep]) : [])])].filter((f) => !HOOK_RUNNER.test(f));
}

async function readKept(dir: string, names: string[]): Promise<Map<string, Kept>> {
  const kept = new Map<string, Kept>();
  if (!names.length) return kept;
  for (const rel of await protectedPaths(dir, names)) {
    const file = path.join(dir, rel);
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) kept.set(rel, { link: fs.readlinkSync(file) });
      else if (st.isFile()) kept.set(rel, { data: fs.readFileSync(file), mode: st.mode & 0o777 });
    } catch {
      // Listed by git but not on disk: it was not there.
    }
  }
  return kept;
}

function same(a: Kept | undefined, b: Kept | undefined): boolean {
  if (!a || !b) return a === b;
  if ('link' in a || 'link' in b) return 'link' in a && 'link' in b && a.link === b.link;
  return a.data.equals(b.data) && a.mode === b.mode;
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
    else {
      fs.writeFileSync(file, was.data);
      fs.chmodSync(file, was.mode);
    }
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

/**
 * Every file git sees in the copy (tracked, and new ones not ignored) as a tree, without touching its index. The same
 * tree twice is the same code, which tells whether an app kept running still shows the copy as it is.
 */
export async function treeOf(dir: string): Promise<string | undefined> {
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
    await stageAllLater(dir, env);
    return (await gitLater(dir, ['write-tree'], { env })) || undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function putTreeBack(dir: string, before: string, skip: string[]): Promise<string[]> {
  const after = await treeOf(dir);
  if (!after || after === before) return [];
  const rows = listed(git(dir, ['diff', '--name-status', '--no-renames', '-z', before, after]));
  const added: string[] = [];
  const back: string[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const rel = rows[i + 1]!;
    if (skip.some((s) => isWithin(s, path.join(dir, rel)))) continue;
    (rows[i] === 'A' ? added : back).push(rel);
  }
  for (const rel of added) removeFile(dir, rel);
  for (let i = 0; i < back.length; i += 100) {
    await gitLater(dir, ['restore', `--source=${before}`, '--worktree', '--', ...back.slice(i, i + 100)], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  }
  return [...back, ...added].sort();
}

function isWithin(folder: string, file: string): boolean {
  const r = path.relative(folder, file);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
