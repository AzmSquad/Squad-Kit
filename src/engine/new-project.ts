import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSquadRoot } from '../core/paths.js';
import { skipFirstRead, startWithIdea } from '../board/first-run.js';
import { addBreakdown } from '../board/requirements-actions.js';
import type { UploadedFile } from '../board/actions.js';
import type { BoardPaths } from '../board/store.js';
import { isRepo } from './git.js';
import { prepareProject, type ReadyProject } from './setup.js';

/**
 * New project: a person with only a BRD or an idea gets a folder, git and a board in one step, with no terminal and no
 * technical question. What they gave goes in before the project's squad starts, so nothing is read or asked without it.
 * The app's button and `squad projects --new` both come here.
 */

export interface NewProjectInput {
  name?: string;
  /** The folder it goes in; Documents when left out. */
  where?: string;
  /** What they want to build. */
  idea?: string;
  /** The BRD as a file, or its pasted text. */
  file?: UploadedFile;
  text?: string;
  /** Screen mockups and other files that go with the BRD. */
  with?: UploadedFile[];
}

export interface NewProject extends ReadyProject {
  /** The page the person lands on, under the project's address. */
  opens: string;
}

const MAX_NAME = 80;

const isFolder = (dir: string) => fs.existsSync(dir) && fs.statSync(dir).isDirectory();

/** The project's name as a folder's: what a disk refuses goes, and so does a double quote, which the Mac guard cannot take. */
export function folderNameFor(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  return [...clean].slice(0, MAX_NAME).join('').trim();
}

/** Where a new project goes unless the person picks another place. */
export function defaultPlace(): string {
  const documents = path.join(os.homedir(), 'Documents');
  return isFolder(documents) ? documents : os.homedir();
}

/**
 * Why a new project cannot go in this folder, or null when it can. Inside a project, Add project would open that
 * project and not the new one. Inside a repo, its files would land in that repo's history.
 */
export function whyNotHere(dir: string): string | null {
  const project = findSquadRoot(dir);
  if (project) return `This folder is inside the project ${path.basename(project)}. Pick a place outside it.`;
  if (isRepo(dir)) return "This folder is inside another project's code. Pick a place outside it.";
  return null;
}

/** The new project's folder, once what the person gave is enough. Nothing is made here. */
export function newProjectFolder(input: NewProjectInput): string {
  const name = folderNameFor(input.name ?? '');
  if (!name) throw new Error('Give the project a name.');
  const brd = Boolean(input.file || input.text?.trim());
  if (!brd && !input.idea?.trim()) throw new Error('Add your BRD, or say what you want to build.');
  if (brd && input.idea?.trim()) throw new Error('Give a BRD or an idea, not both.');
  const place = path.resolve(input.where?.trim() || defaultPlace());
  if (!isFolder(place)) throw new Error(`There is no folder at ${place}.`);
  const why = whyNotHere(place);
  if (why) throw new Error(why);
  const dir = path.join(place, name);
  if (fs.existsSync(dir)) throw new Error(`${name} is there already. Pick another name, or press Add project to open it.`);
  return dir;
}

/** The BRD or the idea goes in, and says where the person lands. */
function startFrom(bp: BoardPaths, input: NewProjectInput): string {
  if (input.idea?.trim()) {
    startWithIdea(bp, input.idea);
    return '/setup';
  }
  const b = addBreakdown(bp, { ...(input.file ? { file: input.file } : {}), ...(input.text?.trim() ? { text: input.text } : {}), with: input.with ?? [] });
  skipFirstRead(bp);
  return `/requirements/${encodeURIComponent(b.id)}`;
}

/** A new project that failed half-way leaves nothing behind: the person fixes what was wrong and presses Create again. */
export function dropNewProject(dir: string, bp?: BoardPaths): void {
  fs.rmSync(dir, { recursive: true, force: true });
  if (bp) fs.rmSync(bp.localDir, { recursive: true, force: true });
}

/** Makes the project on disk, ready for its squad to start. Its squad is not started here. */
export function makeNewProject(input: NewProjectInput): NewProject {
  const dir = newProjectFolder(input);
  fs.mkdirSync(dir);
  let bp: BoardPaths | undefined;
  try {
    const ready = prepareProject(dir);
    bp = ready.bp;
    return { ...ready, opens: startFrom(ready.bp, input) };
  } catch (err) {
    dropNewProject(dir, bp);
    throw err;
  }
}
