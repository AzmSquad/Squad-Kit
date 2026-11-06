import fs from 'node:fs';
import path from 'node:path';
import { repoPaths } from '../board/parts.js';
import { storyFile, storyFilesDir } from '../board/project-files.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import { markPlaced } from './git.js';
import { localEnvFiles } from './run-app.js';

/**
 * Local files in a story's copy. The project's own tests and app need them, and no agent may read them. A command can
 * still print or send what it reads, so stories use values kept for them on this computer, never the person's own file.
 */

/** The file's place in the copy, or null when a link on the way would send it somewhere else. */
function placeIn(dir: string, rel: string): string | null {
  let at = dir;
  for (const part of path.dirname(rel).split('/').filter((x) => x !== '.')) {
    at = path.join(at, part);
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  }
  return path.join(dir, rel);
}

/** Puts a repo's local files in its copy, again each time: a value may have changed, or a file gone. Says which have no values yet. */
export function placeStoryFiles(bp: BoardPaths, repo: string, dir: string): { placed: string[]; missing: string[] } {
  const out: { placed: string[]; missing: string[] } = { placed: [], missing: [] };
  for (const f of (readMeta(bp).localFiles ?? []).filter((x) => x.repo === repo)) {
    const from = storyFile(bp, f);
    const to = fs.existsSync(from) ? placeIn(dir, f.path) : null;
    if (!to) {
      out.missing.push(f.path);
      continue;
    }
    const data = fs.readFileSync(from);
    const was = fs.lstatSync(to, { throwIfNoEntry: false });
    if (was && (!was.isFile() || !fs.readFileSync(to).equals(data))) fs.rmSync(to, { recursive: true, force: true });
    if (!fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data, { mode: 0o600 });
    }
    out.placed.push(f.path);
  }
  markPlaced(dir, out.placed);
  return out;
}

/** The names of a repo's local files, for squad-kit's own copies that run the person's own version of the app. */
export function localFileNames(bp: BoardPaths, repo: string): string[] {
  return (readMeta(bp).localFiles ?? []).filter((f) => f.repo === repo).map((f) => f.path);
}

/**
 * What no agent may read, by exact path: every local file and untracked .env file in the person's folder, and the local
 * files in the copy the step works in. Nothing else in the copy changes: a Builder still reads a .env.example.
 */
export function hiddenFiles(bp: BoardPaths, cwd?: string): string[] {
  let local;
  let repos: string[];
  try {
    const meta = readMeta(bp);
    local = meta.localFiles ?? [];
    repos = repoPaths(meta);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const repo of repos) for (const f of localEnvFiles(path.join(bp.root, repo))) out.add(path.join(bp.root, repo, f));
  for (const f of local) {
    out.add(path.join(bp.root, f.repo, f.path));
    if (cwd) out.add(path.join(cwd, f.path));
    // A story's folder holds each repo's copy under the repo's name.
    if (cwd && f.repo !== '.') out.add(path.join(cwd, f.repo, f.path));
  }
  if (local.length) out.add(`${storyFilesDir(bp)}/**`);
  return [...out];
}
