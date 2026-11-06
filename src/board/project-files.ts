import fs from 'node:fs';
import path from 'node:path';
import { SQUAD_DIR } from '../core/paths.js';
import { git } from '../engine/git.js';
import { repoPaths } from './parts.js';
import { readMeta, writeMeta, type BoardPaths } from './store.js';
import type { BoardMeta, ProjectFile } from './types.js';

/**
 * The files an engineer names so agents keep off them. A local file is one git does not carry, like .env.dev: squad-kit
 * puts it in each story's copy for the project's own tests and app, and no agent can read it. A locked file is in git,
 * like docker-compose.yml: agents can read it and never change it. The team shares only the names. The values stories
 * use stay on this computer, in squad-kit's own folder, and never pass through the app.
 */

const DOCKER_FILE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$|^Dockerfile(?:[.-][\w.-]+)?$|\.dockerfile$/i;
const MAX_DOCKER_FILES = 30;

export type FileKind = 'local' | 'locked';

export interface LocalFileView extends ProjectFile {
  /** squad-kit has values for stories. */
  ready: boolean;
  /** The person's own folder has this file, to start from. */
  inFolder: boolean;
  /** Where the values stories use are kept: an engineer edits the file there. */
  storyFile: string;
}

export interface ProjectFilesView {
  local: LocalFileView[];
  locked: ProjectFile[];
  repos: string[];
  /** Docker files in git that are not locked yet. */
  docker: ProjectFile[];
}

export const storyFilesDir = (bp: BoardPaths): string => path.join(bp.localDir, 'story-files');

export const storyFile = (bp: BoardPaths, f: ProjectFile): string => path.join(storyFilesDir(bp), f.repo === '.' ? '_project' : f.repo, f.path);

const same = (a: ProjectFile, b: ProjectFile): boolean => a.repo === b.repo && a.path === b.path;

const literal = (file: string): string => `:(literal)${file}`;

function isTracked(bp: BoardPaths, f: ProjectFile): boolean {
  return git(path.join(bp.root, f.repo), ['ls-files', '--', literal(f.path)], { allowFail: true }) !== '';
}

/** A file an engineer named, as a plain path inside one of the repos, or a plain sentence on what is wrong with it. */
function fileFrom(bp: BoardPaths, meta: BoardMeta, repo: string | undefined, file: string | undefined): ProjectFile {
  const repos = repoPaths(meta);
  const r = repo?.trim() || (repos.length === 1 ? repos[0]! : '');
  if (!repos.includes(r)) throw new Error(r ? `There is no code repo at ${r}. The repos: ${repos.join(', ')}.` : `Say which repo it is in: ${repos.join(', ')}.`);
  const text = (file ?? '').trim().replace(/\\/g, '/');
  const parts = text.split('/').filter((x) => x && x !== '.');
  if (!parts.length) throw new Error("Write the file's path inside the repo, like .env.dev.");
  if (text.startsWith('/') || /^[a-z]:/i.test(text) || parts.includes('..')) throw new Error('The file must be inside the repo, like public/config.js.');
  if (parts.includes('.git') || parts.includes(SQUAD_DIR)) throw new Error(`Agents already cannot change ${text}.`);
  const clean = parts.join('/');
  const onDisk = path.join(bp.root, r, clean);
  if (text.endsWith('/') || (fs.existsSync(onDisk) && fs.statSync(onDisk).isDirectory())) throw new Error(`${clean} is a folder. Name each file in it.`);
  return { repo: r, path: clean };
}

const listed = (meta: BoardMeta, kind: FileKind): ProjectFile[] => (kind === 'local' ? meta.localFiles : meta.lockedFiles) ?? [];

function withList(meta: BoardMeta, kind: FileKind, files: ProjectFile[]): BoardMeta {
  const next: BoardMeta = { ...meta };
  const key = kind === 'local' ? 'localFiles' : 'lockedFiles';
  if (files.length) next[key] = files;
  else delete next[key];
  return next;
}

function added(meta: BoardMeta, kind: FileKind, f: ProjectFile): BoardMeta {
  return withList(meta, kind, [...listed(meta, kind).filter((x) => !same(x, f)), f]);
}

export function addLocalFile(bp: BoardPaths, repo: string | undefined, file: string | undefined): ProjectFile {
  const meta = readMeta(bp);
  const f = fileFrom(bp, meta, repo, file);
  if (isTracked(bp, f)) throw new Error(`${f.path} is in git, so every copy has it. Lock it instead, or take it out of git first.`);
  // Never in a commit: git must already leave it out.
  if (!git(path.join(bp.root, f.repo), ['check-ignore', '--', f.path], { allowFail: true })) throw new Error(`git would save ${f.path}. Add it to the repo's .gitignore first.`);
  writeMeta(bp, added(withList(meta, 'locked', listed(meta, 'locked').filter((x) => !same(x, f))), 'local', f));
  return f;
}

export function addLockedFile(bp: BoardPaths, repo: string | undefined, file: string | undefined): ProjectFile {
  const meta = readMeta(bp);
  const f = fileFrom(bp, meta, repo, file);
  if (!isTracked(bp, f)) throw new Error(`${f.path} is not in git. A file git does not carry is a local file.`);
  writeMeta(bp, added(meta, 'locked', f));
  return f;
}

function dockerFiles(bp: BoardPaths, meta: BoardMeta): ProjectFile[] {
  const out: ProjectFile[] = [];
  for (const repo of repoPaths(meta)) {
    const files = git(path.join(bp.root, repo), ['ls-files', '-z'], { allowFail: true }).split('\0').filter(Boolean);
    for (const file of files) if (DOCKER_FILE.test(path.basename(file)) && !listed(meta, 'locked').some((x) => same(x, { repo, path: file }))) out.push({ repo, path: file });
  }
  return out.slice(0, MAX_DOCKER_FILES);
}

/** Locks every Docker file in git: changed in a story, one could mount any folder of this computer into a container. */
export function lockDockerFiles(bp: BoardPaths): ProjectFile[] {
  const meta = readMeta(bp);
  const found = dockerFiles(bp, meta);
  if (!found.length) throw new Error('There is no Docker file to lock.');
  writeMeta(bp, withList(meta, 'locked', [...listed(meta, 'locked'), ...found]));
  return found;
}

/** Takes a file off the lists, by its path. A local file's story values go with it. */
export function removeProjectFile(bp: BoardPaths, repo: string | undefined, file: string | undefined): ProjectFile {
  const meta = readMeta(bp);
  const f = fileFrom(bp, meta, repo, file);
  const kind: FileKind | undefined = listed(meta, 'local').some((x) => same(x, f)) ? 'local' : listed(meta, 'locked').some((x) => same(x, f)) ? 'locked' : undefined;
  if (!kind) throw new Error(`${f.path} is not on the list.`);
  writeMeta(bp, withList(meta, kind, listed(meta, kind).filter((x) => !same(x, f))));
  if (kind === 'local') fs.rmSync(storyFile(bp, f), { force: true });
  return f;
}

/** Starts a local file's story values from the file in the person's own folder. Only the person can choose this. */
export function useMyFile(bp: BoardPaths, repo: string | undefined, file: string | undefined): ProjectFile {
  const meta = readMeta(bp);
  const f = fileFrom(bp, meta, repo, file);
  if (!listed(meta, 'local').some((x) => same(x, f))) throw new Error(`${f.path} is not a local file yet.`);
  const from = path.join(bp.root, f.repo, f.path);
  if (!fs.existsSync(from)) throw new Error(`There is no ${f.path} in your folder.`);
  const to = storyFile(bp, f);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o600);
  return f;
}

export function projectFilesView(bp: BoardPaths): ProjectFilesView {
  const meta = readMeta(bp);
  return {
    local: listed(meta, 'local').map((f) => ({ ...f, ready: fs.existsSync(storyFile(bp, f)), inFolder: fs.existsSync(path.join(bp.root, f.repo, f.path)), storyFile: storyFile(bp, f) })),
    locked: listed(meta, 'locked'),
    repos: repoPaths(meta),
    docker: dockerFiles(bp, meta),
  };
}

/** The paths no agent may change, each from the top of a copy, as the lane check and the file rules take them. */
export function offLimits(meta: BoardMeta): string[] {
  return [...listed(meta, 'local'), ...listed(meta, 'locked')].map((f) => f.path);
}
